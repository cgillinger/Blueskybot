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

// Define RSS feed URLs to monitor and optional titles for each
// If a title is provided for a feed, it will appear at the beginning of each post from that feed
const RSS_FEEDS = [
  { url: 'https://rss.app/feeds/JpaFNEN5QbpV7apK.xml', title: 'Tech News' },
  { url: 'https://www.svt.se/rss.xml', title: 'Sveriges Television' },
];

// File to store links to the last posted entries (to avoid duplicate posts)
const LAST_POSTED_LINKS_FILE = 'lastPostedLinks.json';

// Rate limit configuration based on Bluesky's documentation
const MAX_API_CALLS_PER_5_MINUTES = 3000;
const MAX_CREATES_PER_HOUR = 1666;
let apiCallCount = 0;
let createActionCount = 0;
let lastApiReset = Date.now();
let lastCreateReset = Date.now();

// Load last posted entries from file if it exists, otherwise return empty object
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

// Rate limiting function to avoid exceeding Bluesky's limits
async function rateLimit() {
  // Reset API call count every 5 minutes
  if (Date.now() - lastApiReset >= 5 * 60 * 1000) {
    apiCallCount = 0;
    lastApiReset = Date.now();
  }
  
  // Reset CREATE action count every hour
  if (Date.now() - lastCreateReset >= 60 * 60 * 1000) {
    createActionCount = 0;
    lastCreateReset = Date.now();
  }

  // Wait if API call limit is reached
  if (apiCallCount >= MAX_API_CALLS_PER_5_MINUTES) {
    const waitTime = 5 * 60 * 1000 - (Date.now() - lastApiReset);
    console.log(`API rate limit reached. Waiting ${Math.ceil(waitTime / 1000)} seconds.`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
    apiCallCount = 0;
    lastApiReset = Date.now();
  }

  // Wait if CREATE limit is reached
  if (createActionCount >= MAX_CREATES_PER_HOUR) {
    const waitTime = 60 * 60 * 1000 - (Date.now() - lastCreateReset);
    console.log(`CREATE limit reached. Waiting ${Math.ceil(waitTime / 1000)} seconds.`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
    createActionCount = 0;
    lastCreateReset = Date.now();
  }

  // Increment counters after a successful API call
  apiCallCount++;
  createActionCount++;
}

// Filter function to check if an entry was published within the last hour
function isPublishedWithinLastHour(pubDate) {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  return new Date(pubDate).getTime() >= oneHourAgo;
}

// Check if a link has already been posted to avoid duplicates
function isAlreadyPosted(feedUrl, link) {
  if (!lastPostedLinks[feedUrl]) {
    lastPostedLinks[feedUrl] = [];
  }
  return lastPostedLinks[feedUrl].includes(link);
}

// Record a link as posted to avoid duplicates
function recordPostedLink(feedUrl, link) {
  if (!lastPostedLinks[feedUrl]) {
    lastPostedLinks[feedUrl] = [];
  }
  lastPostedLinks[feedUrl].push(link);

  // Limit the history to the last 20 entries to avoid excessive memory usage
  if (lastPostedLinks[feedUrl].length > 20) {
    lastPostedLinks[feedUrl].shift();
  }
}

// Fetch metadata for a link, including title, description, and image (if available)
async function fetchEmbedCard(url) {
  try {
    await rateLimit(); // Check rate limits for API calls

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

    // If an image exists, upload it as a blob and add it to the card
    if (ogImage) {
      const imageResponse = await fetch(ogImage);
      const imageData = Buffer.from(await imageResponse.arrayBuffer());

      await rateLimit(); // Check rate limits for blob upload

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

// Process each RSS feed and post new entries from the last hour
async function processFeed(feed) {
  try {
    const { url: feedUrl, title: feedTitle } = feed;
    console.log(`Fetching RSS feed: ${feedUrl}`);
    const feedData = await parser.parseURL(feedUrl);
    let newPostsFound = false; // Track if any new posts were found

    for (const item of feedData.items) {
      // Check if the entry is from the last hour and hasn't been posted yet
      if (isPublishedWithinLastHour(item.pubDate) && !isAlreadyPosted(feedUrl, item.link)) {
        const embedCard = await fetchEmbedCard(item.link);
        await rateLimit(); // Check rate limits for posting

        // Construct the post text, adding the feed title if it exists
        const postText = `${feedTitle ? `${feedTitle}: ` : ''}${item.title}\n\n${item.link}`;

        await agent.post({
          text: postText,
          embed: embedCard || undefined,
          langs: ["sv"],
        });

        console.log(`Posted: ${postText}`);
        recordPostedLink(feedUrl, item.link); // Record the link as posted
        saveLastPostedLinks(); // Save updated links to avoid duplicates
        newPostsFound = true; // Mark that a new post was found
      }
    }

    // Print message if no new posts were found for this feed
    if (!newPostsFound) {
      console.log(`No new entries found for ${feedUrl} in the last hour.`);
    }
  } catch (error) {
    console.error("An error occurred while processing the feed:", error);
  }
}

// Log in and process each RSS feed
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

// Run the function immediately and repeat every 5 minutes
postLatestRSSItems();
setInterval(postLatestRSSItems, 5 * 60 * 1000); // Repeat every 5 minutes
