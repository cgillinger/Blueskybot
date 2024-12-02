// Import necessary modules
import { BskyAgent } from '@atproto/api';
import RSSParser from 'rss-parser';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import fs from 'fs';
import * as cheerio from 'cheerio';

// Load environment variables from .env file (for Bluesky credentials)
dotenv.config();

// Initialize Bluesky agent with service URL
const agent = new BskyAgent({ service: 'https://bsky.social' });

// Initialize RSS parser
const parser = new RSSParser();

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

// Rate limit configuration based on Bluesky's API documentation
const MAX_API_CALLS_PER_5_MINUTES = 3000;
const MAX_CREATES_PER_HOUR = 1666;
let apiCallCount = 0;
let createActionCount = 0;
let lastApiReset = Date.now();
let lastCreateReset = Date.now();

// Load last posted entries from file if it exists
function loadLastPostedLinks() {
  if (fs.existsSync(LAST_POSTED_LINKS_FILE)) {
    return JSON.parse(fs.readFileSync(LAST_POSTED_LINKS_FILE));
  }
  return {};
}

// Save last posted entries to file
function saveLastPostedLinks() {
  fs.writeFileSync(LAST_POSTED_LINKS_FILE, JSON.stringify(lastPostedLinks, null, 2));
}

// Global variable to store last posted entries
let lastPostedLinks = loadLastPostedLinks();

/**
 * Rate limiting function
 * Ensures the bot adheres to Bluesky's API rate limits by delaying requests when necessary.
 */
async function rateLimit() {
  if (Date.now() - lastApiReset >= 5 * 60 * 1000) {
    apiCallCount = 0;
    lastApiReset = Date.now();
  }
  if (Date.now() - lastCreateReset >= 60 * 60 * 1000) {
    createActionCount = 0;
    lastCreateReset = Date.now();
  }
  if (apiCallCount >= MAX_API_CALLS_PER_5_MINUTES) {
    const waitTime = 5 * 60 * 1000 - (Date.now() - lastApiReset);
    console.log(`API rate limit reached. Waiting ${Math.ceil(waitTime / 1000)} seconds.`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
    apiCallCount = 0;
    lastApiReset = Date.now();
  }
  if (createActionCount >= MAX_CREATES_PER_HOUR) {
    const waitTime = 60 * 60 * 1000 - (Date.now() - lastCreateReset);
    console.log(`CREATE limit reached. Waiting ${Math.ceil(waitTime / 1000)} seconds.`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
    createActionCount = 0;
    lastCreateReset = Date.now();
  }
  apiCallCount++;
  createActionCount++;
}

/**
 * Utility function: Check if an RSS entry was published within the last hour
 * @param {string} pubDate - The publication date of the RSS entry
 * @returns {boolean} True if published within the last hour, otherwise false
 */
function isPublishedWithinLastHour(pubDate) {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  return new Date(pubDate).getTime() >= oneHourAgo;
}

/**
 * Utility function: Check if a link has already been posted
 * @param {string} feedUrl - The RSS feed URL
 * @param {string} link - The link of the RSS entry
 * @returns {boolean} True if the link has already been posted, otherwise false
 */
function isAlreadyPosted(feedUrl, link) {
  if (!lastPostedLinks[feedUrl]) {
    lastPostedLinks[feedUrl] = [];
  }
  return lastPostedLinks[feedUrl].includes(link);
}

/**
 * Utility function: Record a link as posted
 * @param {string} feedUrl - The RSS feed URL
 * @param {string} link - The link of the RSS entry
 */
function recordPostedLink(feedUrl, link) {
  if (!lastPostedLinks[feedUrl]) {
    lastPostedLinks[feedUrl] = [];
  }
  lastPostedLinks[feedUrl].push(link);
  if (lastPostedLinks[feedUrl].length > 20) {
    lastPostedLinks[feedUrl].shift();
  }
}

/**
 * Fetch metadata for a link (title, description, and image) for embedding in posts
 * @param {string} url - The URL to fetch metadata for
 * @returns {object|null} Embed card object or null if fetching fails
 */
async function fetchEmbedCard(url) {
  try {
    await rateLimit();
    const response = await fetch(url);
    const html = await response.text();
    const $ = cheerio.load(html);

    const ogTitle = $('meta[property="og:title"]').attr('content') || "Link";
    const ogDescription = $('meta[property="og:description"]').attr('content') || "";
    const ogImage = $('meta[property="og:image"]').attr('content');

    const card = {
      "$type": "app.bsky.embed.external",
      "external": {
        "uri": url,
        "title": ogTitle,
        "description": ogDescription,
      },
    };

    if (ogImage) {
      const imageResponse = await fetch(ogImage);
      const imageData = Buffer.from(await imageResponse.arrayBuffer());
      await rateLimit();
      const uploadResponse = await agent.uploadBlob(imageData, "image/jpeg");
      card.external.thumb = {
        "$type": "blob",
        "ref": uploadResponse.data.blob.ref,
        "mimeType": "image/jpeg",
        "size": imageData.length,
      };
    }

    return card;
  } catch (error) {
    console.error("Failed to fetch metadata for URL:", error);
    return null;
  }
}

/**
 * Process a single RSS feed and post new entries from the last hour
 * @param {object} feed - The RSS feed configuration
 */
async function processFeed(feed) {
  try {
    const { url: feedUrl, title: feedTitle } = feed;
    console.log(`Fetching RSS feed: ${feedUrl}`);
    const feedData = await parser.parseURL(feedUrl);
    let newPostsFound = false;

    for (const item of feedData.items) {
      if (isPublishedWithinLastHour(item.pubDate) && !isAlreadyPosted(feedUrl, item.link)) {
        const embedCard = await fetchEmbedCard(item.link);
        await rateLimit();

        const postText = `${feedTitle ? `${feedTitle}: ` : ''}${item.title}\n\n${item.link}`;
        await agent.post({
          text: postText,
          embed: embedCard || undefined,
          langs: ["en"],
        });

        console.log(`Posted: ${postText}`);
        recordPostedLink(feedUrl, item.link);
        saveLastPostedLinks();
        newPostsFound = true;
      }
    }

    if (!newPostsFound) {
      console.log(`No new entries found for ${feedUrl} in the last hour.`);
    }
  } catch (error) {
    console.error("An error occurred while processing the feed:", error);
  }
}

/**
 * Main function to log in to Bluesky and process RSS feeds
 * Repeats every 5 minutes to ensure consistent updates.
 */
async function postLatestRSSItems() {
  try {
    console.log("Starting bot...");

    if (!process.env.BLUESKY_USERNAME || !process.env.BLUESKY_PASSWORD) {
      console.error("Error: Bluesky credentials are missing in the .env file.");
      return;
    }

    await agent.login({
      identifier: process.env.BLUESKY_USERNAME,
      password: process.env.BLUESKY_PASSWORD,
    });

    console.log("Logged in to Bluesky!");

    for (const feed of RSS_FEEDS) {
      await processFeed(feed);
    }
  } catch (error) {
    if (error.response && error.response.status === 429) {
      console.log('API rate limit exceeded. Waiting before retrying.');
    } else {
      console.error('An error occurred:', error);
    }
  }
}

// Start the bot immediately and repeat every 5 minutes
postLatestRSSItems();
setInterval(postLatestRSSItems, 5 * 60 * 1000);
