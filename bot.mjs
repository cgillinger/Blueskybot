// Import necessary modules
import { BskyAgent, RichText } from '@atproto/api';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import * as cheerio from 'cheerio';
import sharp from 'sharp';
import { fileURLToPath } from 'url';

// Load environment variables from .env file (for Bluesky credentials)
dotenv.config();

// Configuration constants
const POLL_INTERVAL_MS = 60 * 1000;              // 1 minute — RSS conditional requests make this cheap
const PUBLICATION_WINDOW_MS = 60 * 60 * 1000;    // 1 hour
const MAX_TRACKED_LINKS_PER_FEED = 100;
const FETCH_TIMEOUT_MS = 15_000;
const ALT_TEXT_FETCH_TIMEOUT_MS = 30_000; // 30s — Gemini vision calls are slow
const MAX_IMAGE_SIZE = 1_000_000;                 // 1 MB (Bluesky limit)

const ALT_TEXT_ENABLED = process.env.ALT_TEXT_ENABLED === 'true';
const ALT_TEXT_LANGUAGE = process.env.ALT_TEXT_LANGUAGE || 'en';
const ALT_TEXT_PROVIDER = process.env.ALT_TEXT_PROVIDER || 'gemini';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const ALT_IMAGE_MAX_DIMENSION = 256;  // was 512 — halves Gemini token cost

const ALT_TEXT_CONCURRENCY = 3;        // max parallel alt-text API calls
const ALT_TEXT_MAX_RETRIES = 5;        // max retry cycles before posting without alt text
const DEFERRED_ITEMS_FILE = 'deferredItems.json';

const SKIP_ALT_TEXT_PATTERNS = [
  /\/favicon/i,
  /\/logo[._-]/i,
  /\/icon[._-]/i,
  /\/apple-touch-icon/i,
  /\/site-icon/i,
  /\/brand[._-]/i,
];
const GENERIC_ALT_TEXT = 'Image';  // fallback for skipped images

// Rate limit configuration based on Bluesky's API documentation
const RATE_LIMIT_API_WINDOW_MS = 5 * 60 * 1000;  // 5 minutes
const MAX_API_CALLS_PER_5_MINUTES = 3000;
const MAX_CREATES_PER_HOUR = 1666;

// File paths
const FEEDS_FILE = 'feeds.txt';
const LAST_POSTED_LINKS_FILE = 'lastPostedLinks.json';

/**
 * Fetch with timeout to prevent hanging requests.
 */
export function fetchWithTimeout(url, options = {}) {
  // AbortSignal.timeout also covers reading the body (text()/arrayBuffer()),
  // so a server that stalls mid-response can't hang the poll loop.
  return fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

export function fetchWithAltTextTimeout(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(ALT_TEXT_FETCH_TIMEOUT_MS) });
}

/**
 * Fetch an image and return { imageData, contentType }.
 * Throws on non-2xx or non-image responses so error pages are never uploaded.
 */
async function fetchImage(imageUrl) {
  const response = await fetchWithTimeout(imageUrl);
  if (!response.ok) throw new Error(`Image fetch returned HTTP ${response.status}`);
  const contentType = response.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
  if (!contentType.startsWith('image/')) throw new Error(`Not an image (${contentType})`);
  const imageData = Buffer.from(await response.arrayBuffer());
  return { imageData, contentType };
}

/**
 * Validate URL scheme to prevent SSRF (only allow http/https).
 */
export function isValidHttpUrl(urlString) {
  try {
    const url = new URL(urlString);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// Provider registry — map prefix to async fetcher. Each fetcher must return
// an array of NormalizedItem (or null for "unchanged"). See providers/_template.mjs.
import rssFetcher from './providers/rss.mjs';
import srApiFetcher from './providers/sr-api.mjs';

const providers = {
  'rss': rssFetcher,
  'sr-api': srApiFetcher,
};

/**
 * Parse one feeds.txt line into a feed config.
 * - "proto://id | Title"  → { type: 'proto', id, title }       (when proto is not http/https)
 * - "https://url | Title" → { type: 'rss', url, title }
 */
export function parseFeedLine(line) {
  const [rawSource, rawTitle] = line.split('|').map(part => part.trim());
  const title = rawTitle || null;
  const prefixMatch = rawSource.match(/^([a-z][-a-z]*):\/\/(.+)$/);

  if (prefixMatch && prefixMatch[1] !== 'http' && prefixMatch[1] !== 'https') {
    return { type: prefixMatch[1], id: prefixMatch[2], title };
  }
  return { type: 'rss', url: rawSource, title };
}

/**
 * Load feeds from feeds.txt.
 * Format: one entry per line, optional title after " | ".
 * Lines starting with # and empty lines are ignored.
 */
export async function loadFeeds() {
  let content;
  try {
    content = await fs.readFile(FEEDS_FILE, 'utf-8');
  } catch {
    console.error(`Missing ${FEEDS_FILE} — copy feeds.txt.example to feeds.txt and add your feeds.`);
    process.exit(1);
  }

  const feeds = content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(parseFeedLine);

  if (feeds.length === 0) {
    console.error(`No feeds found in ${FEEDS_FILE}. Add at least one feed.`);
    process.exit(1);
  }

  return feeds;
}

// Initialize Bluesky agent with service URL
const agent = new BskyAgent({ service: 'https://bsky.social' });

// State
let lastPostedLinks = {};
let deferredItems = [];  // Array of { item, feedKey, feedTitle, retryCount, deferredAt }
let apiCallCount = 0;
let createActionCount = 0;
let lastApiReset = Date.now();
let lastCreateReset = Date.now();
let isLoggedIn = false;

// Cache for conditional HTTP requests (ETag / Last-Modified per feed URL)
const feedHttpCache = new Map();

// In-memory alt-text cache — maps imageUrl -> altText string
const altTextCache = new Map();
const ALT_TEXT_CACHE_MAX = 500;

export function getCachedAltText(imageUrl) {
  return altTextCache.get(imageUrl) || null;
}

export function setCachedAltText(imageUrl, altText) {
  if (altTextCache.size >= ALT_TEXT_CACHE_MAX) {
    const firstKey = altTextCache.keys().next().value;
    altTextCache.delete(firstKey);
  }
  altTextCache.set(imageUrl, altText);
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

/**
 * Write JSON via temp file + rename so a crash or container stop mid-write
 * can't leave a truncated file (which would reset state and cause reposts).
 */
async function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

// Save last posted entries to file
async function saveLastPostedLinks() {
  await writeJsonAtomic(LAST_POSTED_LINKS_FILE, lastPostedLinks);
}

async function loadDeferredItems() {
  try {
    const data = await fs.readFile(DEFERRED_ITEMS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function saveDeferredItems() {
  await writeJsonAtomic(DEFERRED_ITEMS_FILE, deferredItems);
}

/**
 * Rate limiting function
 * Ensures the bot adheres to Bluesky's API rate limits.
 * @param {boolean} isCreate - Whether this is a create action (post/upload)
 */
async function rateLimit(isCreate = false) {
  const now = Date.now();

  if (now - lastApiReset >= RATE_LIMIT_API_WINDOW_MS) {
    apiCallCount = 0;
    lastApiReset = now;
  }
  if (now - lastCreateReset >= PUBLICATION_WINDOW_MS) {
    createActionCount = 0;
    lastCreateReset = now;
  }

  if (apiCallCount >= MAX_API_CALLS_PER_5_MINUTES) {
    const waitTime = RATE_LIMIT_API_WINDOW_MS - (now - lastApiReset);
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
 * Check if an item was published within the publication window.
 */
function isPublishedWithinWindow(pubDate) {
  return new Date(pubDate).getTime() >= Date.now() - PUBLICATION_WINDOW_MS;
}

/**
 * Check if a link has already been posted (across ALL feeds).
 * Different feeds can contain the same article, so we check globally.
 */
function isAlreadyPosted(_feedKey, link) {
  return Object.values(lastPostedLinks).some(links => links.includes(link));
}

/**
 * Check if a link is already waiting in the alt-text retry queue.
 * Without this, every poll cycle would re-defer the same item, piling up
 * duplicate queue entries that each trigger their own alt-text API calls.
 */
function isDeferred(link) {
  return deferredItems.some(entry => entry.item.link === link);
}

/**
 * Record a link as posted.
 */
function recordPostedLink(feedKey, link) {
  if (!lastPostedLinks[feedKey]) {
    lastPostedLinks[feedKey] = [];
  }
  if (!lastPostedLinks[feedKey].includes(link)) {
    lastPostedLinks[feedKey].push(link);
  }
  if (lastPostedLinks[feedKey].length > MAX_TRACKED_LINKS_PER_FEED) {
    lastPostedLinks[feedKey].shift();
  }
}

/**
 * Remove a link from the posted list (rollback on failed post).
 */
function unrecordPostedLink(feedKey, link) {
  if (!lastPostedLinks[feedKey]) return;
  const idx = lastPostedLinks[feedKey].indexOf(link);
  if (idx !== -1) lastPostedLinks[feedKey].splice(idx, 1);
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
 * Scrape OG metadata from a URL. Returns { title, description, imageUrl } or null on failure.
 */
async function fetchOgMetadata(url) {
  try {
    const response = await fetchWithTimeout(url);
    const html = await response.text();
    const $ = cheerio.load(html);

    const title = $('meta[property="og:title"]').attr('content') || '';
    const description = $('meta[property="og:description"]').attr('content') || '';
    const imageUrl = $('meta[property="og:image"]').attr('content') || null;

    return { title, description, imageUrl: imageUrl && isValidHttpUrl(imageUrl) ? imageUrl : null };
  } catch (error) {
    console.error(`Failed to fetch OG metadata for ${url}: ${error.message}`);
    return null;
  }
}

/**
 * Resize an image so its longest side is ≤ maxDim and convert to JPEG.
 * The result is used only for the Gemini API call; the original is uploaded to Bluesky.
 * @returns {{ buffer: Buffer, mimeType: string }}
 */
async function resizeImageForAltText(imageBuffer, maxDim = ALT_IMAGE_MAX_DIMENSION) {
  try {
    const resized = await sharp(imageBuffer)
      .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return { buffer: resized, mimeType: 'image/jpeg' };
  } catch (err) {
    console.warn(`Image resize for alt text failed: ${err.message}`);
    return { buffer: imageBuffer, mimeType: 'image/jpeg' };
  }
}

/**
 * Ask Gemini 2.5 Flash to describe an image for visually impaired users.
 * Returns a trimmed string ≤ 300 chars, or '' on any error (graceful degradation).
 * Retries up to 3 times with exponential backoff on HTTP 429.
 */
async function generateAltTextGemini(imageBuffer, mimeType, fetchFn, retryDelayMs, context = '') {
  const base64Data = imageBuffer.toString('base64');
  let prompt = `Describe this image as alt text for visually impaired users. Write in ${ALT_TEXT_LANGUAGE}. Be concise, max 250 characters. Describe what is visible. Only name a person if you are highly confident in the identification. If unsure, describe their appearance instead. Never guess.`;
  if (context) {
    prompt += ` Context from the article: "${context}". Use this to identify people or events, but only describe what is actually visible in the image.`;
  }
  const requestBody = {
    contents: [{
      parts: [
        { inlineData: { mimeType, data: base64Data } },
        { text: prompt },
      ],
    }],
  };
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchFn(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
        body: JSON.stringify(requestBody),
      });

      if (response.status === 429) {
        const delayMs = Math.pow(2, attempt + 1) * retryDelayMs;
        console.warn(`Gemini rate limit (429). Retry ${attempt + 1}/3 in ${delayMs / 1000}s.`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }

      if (!response.ok) {
        console.warn(`Gemini returned HTTP ${response.status}. Skipping alt text.`);
        return '';
      }

      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        console.warn('Gemini returned no usable text. Skipping alt text.');
        return '';
      }
      return text.trim().slice(0, 300);
    } catch (err) {
      console.warn(`Gemini alt text error: ${err.message}`);
      return '';
    }
  }

  console.warn('Gemini rate limit persisted after 3 retries. Skipping alt text.');
  return '';
}

/**
 * Ask OpenAI gpt-4o-mini to describe an image for visually impaired users.
 * Returns a trimmed string ≤ 300 chars, or '' on any error (graceful degradation).
 * Retries up to 3 times with exponential backoff on HTTP 429.
 */
async function generateAltTextOpenAI(imageBuffer, mimeType, fetchFn, retryDelayMs, context = '') {
  const base64Data = imageBuffer.toString('base64');
  let prompt = `Describe this image as alt text for visually impaired users. Write in ${ALT_TEXT_LANGUAGE}. Be concise, max 250 characters. Describe what is visible. Only name a person if you are highly confident in the identification. If unsure, describe their appearance instead. Never guess.`;
  if (context) {
    prompt += ` Context from the article: "${context}". Use this to identify people or events, but only describe what is actually visible in the image.`;
  }

  const requestBody = {
    model: 'gpt-4o-mini',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Data}` } },
        { type: 'text', text: prompt },
      ],
    }],
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchFn('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify(requestBody),
      });

      if (response.status === 429) {
        const delayMs = Math.pow(2, attempt + 1) * retryDelayMs;
        console.warn(`OpenAI rate limit (429). Retry ${attempt + 1}/3 in ${delayMs / 1000}s.`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }
      if (!response.ok) {
        console.warn(`OpenAI returned HTTP ${response.status}. Skipping alt text.`);
        return '';
      }

      const data = await response.json();
      const text = data?.choices?.[0]?.message?.content;
      if (!text) {
        console.warn('OpenAI returned no usable text. Skipping alt text.');
        return '';
      }
      return text.trim().slice(0, 300);
    } catch (err) {
      console.warn(`OpenAI alt text error: ${err.message}`);
      return '';
    }
  }

  console.warn('OpenAI rate limit persisted after 3 retries. Skipping alt text.');
  return '';
}

/**
 * Dispatcher: generate alt text using the configured provider.
 * Returns a trimmed string ≤ 300 chars, or '' on any error (graceful degradation).
 *
 * @param {Buffer} imageBuffer
 * @param {string} mimeType
 * @param {Function} [fetchFn] - injectable for testing (defaults to fetchWithAltTextTimeout)
 * @param {number} [retryDelayMs] - base retry delay in ms; override in tests for speed
 */
export async function generateAltText(imageBuffer, mimeType, fetchFn = fetchWithAltTextTimeout, retryDelayMs = 1000, context = '') {
  const provider = process.env.ALT_TEXT_PROVIDER || 'gemini';
  if (provider === 'openai') {
    return generateAltTextOpenAI(imageBuffer, mimeType, fetchFn, retryDelayMs, context);
  }
  return generateAltTextGemini(imageBuffer, mimeType, fetchFn, retryDelayMs, context);
}

export { resizeImageForAltText };

/**
 * Returns true if the image URL matches a known non-content pattern
 * (favicon, logo, icon, etc.) that doesn't benefit from AI description.
 */
export function shouldSkipAltText(imageUrl) {
  if (!imageUrl) return false;
  return SKIP_ALT_TEXT_PATTERNS.some(pattern => pattern.test(imageUrl));
}

async function prefetchAltText(imageUrl, context = '') {
  if (!imageUrl || !isValidHttpUrl(imageUrl)) return null;

  try {
    if (shouldSkipAltText(imageUrl)) {
      console.log(`Skipping alt-text API for non-content image: ${imageUrl}`);
      const { imageData, contentType } = await fetchImage(imageUrl);
      if (imageData.length > MAX_IMAGE_SIZE) return null;

      let aspectRatio;
      try {
        const meta = await sharp(imageData).metadata();
        if (meta.width && meta.height) aspectRatio = { width: meta.width, height: meta.height };
      } catch {}

      return { altText: GENERIC_ALT_TEXT, imageData, contentType, aspectRatio };
    }

    const cached = getCachedAltText(imageUrl);
    if (cached) {
      console.log(`Alt-text cache hit for ${imageUrl}`);
      const { imageData, contentType } = await fetchImage(imageUrl);
      if (imageData.length > MAX_IMAGE_SIZE) return null;

      let aspectRatio;
      try {
        const meta = await sharp(imageData).metadata();
        if (meta.width && meta.height) aspectRatio = { width: meta.width, height: meta.height };
      } catch {}

      return { altText: cached, imageData, contentType, aspectRatio };
    }

    const { imageData, contentType } = await fetchImage(imageUrl);

    if (imageData.length > MAX_IMAGE_SIZE) {
      console.log(`Image too large (${imageData.length} bytes), cannot use for images embed.`);
      return null;
    }

    let aspectRatio;
    try {
      const meta = await sharp(imageData).metadata();
      if (meta.width && meta.height) aspectRatio = { width: meta.width, height: meta.height };
    } catch (metaErr) {
      console.warn(`Could not read image dimensions: ${metaErr.message}`);
    }

    const { buffer: resizedBuffer, mimeType: resizedMime } = await resizeImageForAltText(imageData);
    const altText = await generateAltText(resizedBuffer, resizedMime, undefined, undefined, context);

    if (altText) {
      setCachedAltText(imageUrl, altText);
    }

    return { altText, imageData, contentType, aspectRatio };
  } catch (err) {
    console.warn(`prefetchAltText failed for ${imageUrl}: ${err.message}`);
    return null;
  }
}

/**
 * Build the embed for a post from a NormalizedItem.
 * When ALT_TEXT_ENABLED and the item has an image: returns app.bsky.embed.images with AI alt text.
 * Otherwise: returns app.bsky.embed.external (link card with optional thumbnail).
 */
async function buildEmbedCard(item, url) {
  try {
    if (!isValidHttpUrl(url)) {
      console.error(`Skipping invalid URL: ${url}`);
      return null;
    }

    let title = item.title || '';
    let description = item.description || '';
    let imageUrl = item.imageUrl || null;

    // Fetch OG metadata once if the item is missing any of title/description/image
    let ogData = null;
    if (!title || !description || !imageUrl) {
      ogData = await fetchOgMetadata(url);
      if (ogData) {
        title = title || ogData.title;
        description = description || ogData.description;
        imageUrl = imageUrl || ogData.imageUrl;
      }
    }

    if (description.length > 300) {
      description = description.slice(0, 297) + '...';
    }

    // --- Images embed with Gemini alt text ---
    if (ALT_TEXT_ENABLED && imageUrl) {
      try {
        const { imageData, contentType } = await fetchImage(imageUrl);

        if (imageData.length > MAX_IMAGE_SIZE) {
          console.log(`Image too large (${imageData.length} bytes), falling back to embed.external without thumbnail.`);
        } else {
          let aspectRatio;
          try {
            const meta = await sharp(imageData).metadata();
            if (meta.width && meta.height) aspectRatio = { width: meta.width, height: meta.height };
          } catch (metaErr) {
            console.warn(`Could not read image dimensions: ${metaErr.message}`);
          }

          const { buffer: resizedBuffer, mimeType: resizedMime } = await resizeImageForAltText(imageData);
          const altTextContext = [item.title, item.description].filter(Boolean).join(' — ');
          const altText = await generateAltText(resizedBuffer, resizedMime, undefined, undefined, altTextContext);

          await rateLimit(true);
          const { data: { blob } } = await agent.uploadBlob(imageData, contentType);

          const imageEntry = { alt: altText, image: blob };
          if (aspectRatio) imageEntry.aspectRatio = aspectRatio;

          return {
            $type: 'app.bsky.embed.images',
            images: [imageEntry],
          };
        }
      } catch (imgError) {
        console.error(`Failed to build images embed: ${imgError.message}`);
      }
      // Alt-text path failed — return link card without thumbnail so the post still goes through
      return {
        $type: 'app.bsky.embed.external',
        external: { uri: url, title: title || 'Link', description },
      };
    }

    // --- Standard external link card ---
    const card = {
      $type: 'app.bsky.embed.external',
      external: { uri: url, title: title || 'Link', description },
    };

    if (imageUrl) {
      try {
        const { imageData, contentType } = await fetchImage(imageUrl);

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
    console.error(`Failed to build embed card for ${url}: ${error.message}`);
    return null;
  }
}

const MAX_POST_GRAPHEMES = 300;

/**
 * Build the post text "Feed: Title\n\nlink", shortening the title if needed
 * so the post stays within Bluesky's 300-grapheme limit (otherwise the post
 * is rejected and retried every cycle for an hour).
 */
export function buildPostText(feedTitle, title, link) {
  const prefix = feedTitle ? `${feedTitle}: ` : '';
  const suffix = `\n\n${link}`;
  const segmenter = new Intl.Segmenter();
  const graphemes = [...segmenter.segment(title || '')].map(s => s.segment);
  const count = str => [...segmenter.segment(str)].length;
  const budget = MAX_POST_GRAPHEMES - count(prefix) - count(suffix);
  if (graphemes.length <= budget) return `${prefix}${title || ''}${suffix}`;
  const shortTitle = budget > 1 ? graphemes.slice(0, budget - 1).join('').trimEnd() + '…' : '';
  return `${prefix}${shortTitle}${suffix}`;
}

function describeFeed(feed) {
  return feed.url || `${feed.type}://${feed.id}`;
}

/**
 * Process a single feed via its provider and post new items from the last hour.
 */
async function processFeed(feed) {
  const provider = providers[feed.type];
  if (!provider) {
    console.error(`Unknown provider type: ${feed.type}`);
    return;
  }

  const items = await provider(feed, feedHttpCache);
  if (!items) return;

  const feedKey = describeFeed(feed);

  const postable = items.filter(item =>
    item.link &&
    isPublishedWithinWindow(item.pubDate) &&
    !isAlreadyPosted(feedKey, item.link) &&
    !isDeferred(item.link)
  );

  if (postable.length === 0) return;

  // --- Phase 1: Parallel alt-text prefetch (bounded concurrency) ---
  const altTextResults = new Map(); // link -> prefetch result

  if (ALT_TEXT_ENABLED) {
    for (let i = 0; i < postable.length; i += ALT_TEXT_CONCURRENCY) {
      const batch = postable.slice(i, i + ALT_TEXT_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async item => {
          let resolvedImageUrl = item.imageUrl || null;
          if (!resolvedImageUrl) {
            const og = await fetchOgMetadata(item.link);
            resolvedImageUrl = og?.imageUrl || null;
            item._ogData = og;
          }
          const altTextContext = [item.title, item.description].filter(Boolean).join(' — ');
          const result = await prefetchAltText(resolvedImageUrl, altTextContext);
          item._resolvedImageUrl = resolvedImageUrl;
          return { link: item.link, result };
        })
      );
      for (const { link, result } of results) {
        altTextResults.set(link, result);
      }
    }
  }

  // --- Phase 2: Post sequentially, deferring on alt-text failure ---
  for (const item of postable) {
    recordPostedLink(feedKey, item.link);
    await saveLastPostedLinks();

    try {
      let embedCard;

      if (ALT_TEXT_ENABLED) {
        const prefetched = altTextResults.get(item.link);

        if (prefetched && prefetched.altText) {
          // Success — build images embed with prefetched data
          await rateLimit(true);
          const { data: { blob } } = await agent.uploadBlob(prefetched.imageData, prefetched.contentType);
          const imageEntry = { alt: prefetched.altText, image: blob };
          if (prefetched.aspectRatio) imageEntry.aspectRatio = prefetched.aspectRatio;
          embedCard = { $type: 'app.bsky.embed.images', images: [imageEntry] };
        } else if (prefetched && !prefetched.altText) {
          // Image fetched OK but alt text generation failed — DEFER
          console.warn(`Alt text failed for ${item.link}, deferring to retry queue.`);
          unrecordPostedLink(feedKey, item.link);
          await saveLastPostedLinks();
          deferredItems.push({
            // Keep the resolved (possibly OG-derived) image URL so the retry can find it
            item: { ...item, imageUrl: item._resolvedImageUrl, _ogData: undefined, _resolvedImageUrl: undefined },
            feedKey,
            feedTitle: feed.title,
            retryCount: 0,
            deferredAt: new Date().toISOString(),
          });
          await saveDeferredItems();
          continue;
        } else {
          // No image at all — post as external link card (no alt text needed)
          const ogData = item._ogData || await fetchOgMetadata(item.link);
          const title = item.title || ogData?.title || 'Link';
          let description = item.description || ogData?.description || '';
          if (description.length > 300) description = description.slice(0, 297) + '...';
          embedCard = {
            $type: 'app.bsky.embed.external',
            external: { uri: item.link, title, description },
          };
        }
      } else {
        embedCard = await buildEmbedCard(item, item.link);
      }

      await rateLimit(true);
      const postText = buildPostText(feed.title, item.title, item.link);
      const rt = new RichText({ text: postText });
      await rt.detectFacets(agent);
      await agent.post({
        text: rt.text,
        facets: rt.facets,
        embed: embedCard || undefined,
        langs: [ALT_TEXT_LANGUAGE],
      });
      console.log(`Posted: ${postText}`);
    } catch (postError) {
      console.error(`Failed to post ${item.link}: ${postError.message}`);
      unrecordPostedLink(feedKey, item.link);
      await saveLastPostedLinks();
    }
  }
}

async function processDeferredItems() {
  if (deferredItems.length === 0) return;

  console.log(`Processing ${deferredItems.length} deferred item(s)...`);
  const stillDeferred = [];

  for (const entry of deferredItems) {
    const { item, feedKey, feedTitle, retryCount } = entry;

    if (isAlreadyPosted(feedKey, item.link)) continue;

    const imageUrl = item.imageUrl || null;
    const altTextContext = [item.title, item.description].filter(Boolean).join(' — ');
    const prefetched = await prefetchAltText(imageUrl, altTextContext);

    if (prefetched && prefetched.altText) {
      recordPostedLink(feedKey, item.link);
      await saveLastPostedLinks();

      try {
        await rateLimit(true);
        const { data: { blob } } = await agent.uploadBlob(prefetched.imageData, prefetched.contentType);
        const imageEntry = { alt: prefetched.altText, image: blob };
        if (prefetched.aspectRatio) imageEntry.aspectRatio = prefetched.aspectRatio;

        await rateLimit(true);
        const postText = buildPostText(feedTitle, item.title, item.link);
        const rt = new RichText({ text: postText });
        await rt.detectFacets(agent);
        await agent.post({
          text: rt.text,
          facets: rt.facets,
          embed: { $type: 'app.bsky.embed.images', images: [imageEntry] },
          langs: [ALT_TEXT_LANGUAGE],
        });
        console.log(`Posted deferred item: ${postText}`);
      } catch (err) {
        console.error(`Failed to post deferred ${item.link}: ${err.message}`);
        unrecordPostedLink(feedKey, item.link);
        await saveLastPostedLinks();
        stillDeferred.push({ ...entry, retryCount: retryCount + 1 });
      }
    } else if (retryCount + 1 >= ALT_TEXT_MAX_RETRIES) {
      console.warn(`Max retries (${ALT_TEXT_MAX_RETRIES}) exhausted for ${item.link}. Posting without alt text.`);
      recordPostedLink(feedKey, item.link);
      await saveLastPostedLinks();

      try {
        let embedCard;
        if (prefetched) {
          await rateLimit(true);
          const { data: { blob } } = await agent.uploadBlob(prefetched.imageData, prefetched.contentType);
          const imageEntry = { alt: '', image: blob };
          if (prefetched.aspectRatio) imageEntry.aspectRatio = prefetched.aspectRatio;
          embedCard = { $type: 'app.bsky.embed.images', images: [imageEntry] };
        } else {
          let description = item.description || '';
          if (description.length > 300) description = description.slice(0, 297) + '...';
          embedCard = {
            $type: 'app.bsky.embed.external',
            external: { uri: item.link, title: item.title || 'Link', description },
          };
        }

        await rateLimit(true);
        const postText = buildPostText(feedTitle, item.title, item.link);
        const rt = new RichText({ text: postText });
        await rt.detectFacets(agent);
        await agent.post({
          text: rt.text,
          facets: rt.facets,
          embed: embedCard || undefined,
          langs: [ALT_TEXT_LANGUAGE],
        });
        console.log(`Posted (no alt text, retries exhausted): ${postText}`);
      } catch (err) {
        console.error(`Failed to post exhausted-retry ${item.link}: ${err.message}`);
        unrecordPostedLink(feedKey, item.link);
        await saveLastPostedLinks();
      }
    } else {
      console.log(`Alt text still failing for ${item.link} (retry ${retryCount + 1}/${ALT_TEXT_MAX_RETRIES}). Deferring again.`);
      stillDeferred.push({ ...entry, retryCount: retryCount + 1 });
    }
  }

  deferredItems = stillDeferred;
  await saveDeferredItems();
}

/**
 * Main function to process all feeds.
 * Maintains a persistent session across poll cycles.
 */
async function postLatestItems(feeds) {
  try {
    await ensureLoggedIn();

    // Process deferred items first (retry alt text)
    await processDeferredItems();

    for (const feed of feeds) {
      try {
        await processFeed(feed);
      } catch (error) {
        console.error(`Error processing feed ${describeFeed(feed)}: ${error.message}`);
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

/**
 * Scheduling loop using setTimeout chaining.
 */
async function runLoop(feeds) {
  while (true) {
    await postLatestItems(feeds);
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log('Bot starting up...');
  if (ALT_TEXT_ENABLED) {
    if (ALT_TEXT_PROVIDER === 'openai' && !OPENAI_API_KEY) {
      console.error('ALT_TEXT_PROVIDER=openai but OPENAI_API_KEY is not set.');
      process.exit(1);
    }
    if (ALT_TEXT_PROVIDER === 'gemini' && !GEMINI_API_KEY) {
      console.error('ALT_TEXT_ENABLED=true but GEMINI_API_KEY is not set.');
      process.exit(1);
    }
  }
  const feeds = await loadFeeds();
  console.log(`Loaded ${feeds.length} feed(s) from ${FEEDS_FILE}.`);
  lastPostedLinks = await loadLastPostedLinks();
  deferredItems = await loadDeferredItems();
  if (deferredItems.length > 0) {
    console.log(`${deferredItems.length} deferred item(s) loaded from previous run.`);
  }
  runLoop(feeds);
}
