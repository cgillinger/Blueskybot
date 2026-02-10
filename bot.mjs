// Import necessary modules
import { BskyAgent } from '@atproto/api';
import RSSParser from 'rss-parser';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import * as cheerio from 'cheerio';

// Load environment variables from .env file (for Bluesky credentials)
dotenv.config();

// Configuration constants
const POLL_INTERVAL_MS = 5 * 60 * 1000;
const PUBLICATION_WINDOW_MS = 60 * 60 * 1000;
const MAX_TRACKED_LINKS_PER_FEED = 20;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_IMAGE_SIZE = 1_000_000; // 1 MB (Bluesky limit)

// Rate limit configuration based on Bluesky's API documentation
const MAX_API_CALLS_PER_5_MINUTES = 3000;
const MAX_CREATES_PER_HOUR = 1666;

/**
 * RSS feed configuration
 * Replace the placeholder URLs with the actual RSS feed URLs you want to monitor.
 * Optional `title` is used to prefix posts from each feed for easier identification.
 */
const RSS_FEEDS = [
  { url: 'https://example.com/rss-feed-1.xml', title: 'Example Feed 1' },
  { url: 'https://example.com/rss-feed-2.xml', title: 'Example Feed 2' },
];

// File to store links to the last posted entries (to avoid duplicate posts)
const LAST_POSTED_LINKS_FILE = 'lastPostedLinks.json';

// Initialize Bluesky agent with service URL
const agent = new BskyAgent({ service: 'https://bsky.social' });
const parser = new RSSParser();

// State
let lastPostedLinks = {};
let apiCallCount = 0;
let createActionCount = 0;
let lastApiReset = Date.now();
let lastCreateReset = Date.now();
let isLoggedIn = false;

/**
 * Fetch with timeout to prevent hanging requests.
 */
function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timeout));
}

/**
 * Validate URL scheme to prevent SSRF (only allow http/https).
 */
function isValidHttpUrl(urlString) {
  try {
    const url = new URL(urlString);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// Load last posted entries from file if it exists
async function loadLastPostedLinks() {
  try {
    const data = await fs.readFile(LAST_POSTED_LINKS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

// Save last posted entries to file
async function saveLastPostedLinks() {
  await fs.writeFile(LAST_POSTED_LINKS_FILE, JSON.stringify(lastPostedLinks, null, 2));
}

/**
 * Rate limiting function
 * Ensures the bot adheres to Bluesky's API rate limits.
 * @param {boolean} isCreate - Whether this is a create action (post/upload)
 */
async function rateLimit(isCreate = false) {
  const now = Date.now();

  if (now - lastApiReset >= POLL_INTERVAL_MS) {
    apiCallCount = 0;
    lastApiReset = now;
  }
  if (now - lastCreateReset >= PUBLICATION_WINDOW_MS) {
    createActionCount = 0;
    lastCreateReset = now;
  }

  if (apiCallCount >= MAX_API_CALLS_PER_5_MINUTES) {
    const waitTime = POLL_INTERVAL_MS - (now - lastApiReset);
    console.log(`API rate limit reached. Waiting ${Math.ceil(waitTime / 1000)}s.`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
    apiCallCount = 0;
    lastApiReset = Date.now();
  }

  if (isCreate && createActionCount >= MAX_CREATES_PER_HOUR) {
    const waitTime = PUBLICATION_WINDOW_MS - (now - lastCreateReset);
    console.log(`CREATE limit reached. Waiting ${Math.ceil(waitTime / 1000)}s.`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
    createActionCount = 0;
    lastCreateReset = Date.now();
  }

  apiCallCount++;
  if (isCreate) createActionCount++;
}

/**
 * Check if an RSS entry was published within the publication window.
 */
function isPublishedWithinWindow(pubDate) {
  return new Date(pubDate).getTime() >= Date.now() - PUBLICATION_WINDOW_MS;
}

/**
 * Check if a link has already been posted.
 */
function isAlreadyPosted(feedUrl, link) {
  return lastPostedLinks[feedUrl]?.includes(link) ?? false;
}

/**
 * Record a link as posted.
 */
function recordPostedLink(feedUrl, link) {
  if (!lastPostedLinks[feedUrl]) {
    lastPostedLinks[feedUrl] = [];
  }
  lastPostedLinks[feedUrl].push(link);
  if (lastPostedLinks[feedUrl].length > MAX_TRACKED_LINKS_PER_FEED) {
    lastPostedLinks[feedUrl].shift();
  }
}

/**
 * Ensure we have a valid Bluesky session. Logs in only when needed.
 */
async function ensureLoggedIn() {
  if (isLoggedIn && agent.session) return;

  if (!process.env.BLUESKY_USERNAME || !process.env.BLUESKY_PASSWORD) {
    throw new Error('Bluesky credentials missing in .env file.');
  }

  await agent.login({
    identifier: process.env.BLUESKY_USERNAME,
    password: process.env.BLUESKY_PASSWORD,
  });
  isLoggedIn = true;
  console.log('Logged in to Bluesky.');
}

/**
 * Fetch metadata for a link (title, description, and image) for embedding in posts.
 * Follows Bluesky's app.bsky.embed.external specification.
 * @param {string} url - The URL to fetch metadata for
 * @returns {object|null} Embed card object or null if fetching fails
 */
async function fetchEmbedCard(url) {
  try {
    if (!isValidHttpUrl(url)) {
      console.error(`Skipping invalid URL: ${url}`);
      return null;
    }

    await rateLimit();
    const response = await fetchWithTimeout(url);
    const html = await response.text();
    const $ = cheerio.load(html);

    const ogTitle = $('meta[property="og:title"]').attr('content') || 'Link';
    const ogDescription = $('meta[property="og:description"]').attr('content') || '';
    const ogImage = $('meta[property="og:image"]').attr('content');

    const card = {
      $type: 'app.bsky.embed.external',
      external: {
        uri: url,
        title: ogTitle,
        description: ogDescription,
      },
    };

    if (ogImage && isValidHttpUrl(ogImage)) {
      try {
        const imageResponse = await fetchWithTimeout(ogImage);
        const contentType = imageResponse.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
        const imageData = Buffer.from(await imageResponse.arrayBuffer());

        if (imageData.length > MAX_IMAGE_SIZE) {
          console.log(`Image too large (${imageData.length} bytes), skipping thumbnail.`);
        } else {
          await rateLimit(true);
          const uploadResponse = await agent.uploadBlob(imageData, contentType);
          card.external.thumb = uploadResponse.data.blob;
        }
      } catch (imgError) {
        console.error(`Failed to fetch/upload thumbnail: ${imgError.message}`);
      }
    }

    return card;
  } catch (error) {
    console.error(`Failed to fetch metadata for ${url}: ${error.message}`);
    return null;
  }
}

/**
 * Process a single RSS feed and post new entries from the last hour.
 */
async function processFeed(feed) {
  const { url: feedUrl, title: feedTitle } = feed;
  console.log(`Fetching RSS feed: ${feedUrl}`);

  const feedData = await parser.parseURL(feedUrl);
  let newPostsFound = false;

  for (const item of feedData.items) {
    if (!isPublishedWithinWindow(item.pubDate) || isAlreadyPosted(feedUrl, item.link)) {
      continue;
    }

    const embedCard = await fetchEmbedCard(item.link);
    await rateLimit(true);

    const postText = `${feedTitle ? `${feedTitle}: ` : ''}${item.title}\n\n${item.link}`;
    await agent.post({
      text: postText,
      embed: embedCard || undefined,
      langs: ['en'],
    });

    console.log(`Posted: ${postText}`);
    recordPostedLink(feedUrl, item.link);
    await saveLastPostedLinks();
    newPostsFound = true;
  }

  if (!newPostsFound) {
    console.log(`No new entries for ${feedUrl} in the last hour.`);
  }
}

/**
 * Main function to process RSS feeds.
 * Maintains a persistent session across poll cycles.
 */
async function postLatestRSSItems() {
  try {
    await ensureLoggedIn();

    for (const feed of RSS_FEEDS) {
      try {
        await processFeed(feed);
      } catch (error) {
        console.error(`Error processing feed ${feed.url}: ${error.message}`);
      }
    }
  } catch (error) {
    if (error?.status === 429) {
      console.log('Rate limit exceeded server-side. Waiting for next cycle.');
    } else if (error?.message?.includes('Authentication') || error?.message?.includes('token')) {
      console.error('Session expired, will re-login on next cycle.');
      isLoggedIn = false;
    } else {
      console.error('An error occurred:', error.message || error);
    }
  }
}

// Start the bot
console.log('Bot starting up...');
lastPostedLinks = await loadLastPostedLinks();
postLatestRSSItems();
setInterval(postLatestRSSItems, POLL_INTERVAL_MS);
