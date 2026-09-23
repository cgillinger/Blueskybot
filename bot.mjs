// Import necessary modules
import { BskyAgent, RichText } from '@atproto/api';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import * as cheerio from 'cheerio';
import sharp from 'sharp';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { fetchWithTimeout, isValidHttpUrl, truncateDescription } from './lib/utils.mjs';

// Re-exported for backwards compatibility with custom providers importing from bot.mjs
export { fetchWithTimeout, isValidHttpUrl };

// Load environment variables from .env file (for Bluesky credentials)
dotenv.config();

export const VERSION = createRequire(import.meta.url)('./package.json').version;

// Configuration constants
const POLL_INTERVAL_MS = 60 * 1000;              // 1 minute — RSS conditional requests make this cheap
const PUBLICATION_WINDOW_MS = 60 * 60 * 1000;    // 1 hour
const MAX_TRACKED_LINKS_PER_FEED = 100;
const ALT_TEXT_FETCH_TIMEOUT_MS = 30_000; // 30s — Gemini vision calls are slow
const MAX_IMAGE_SIZE = 1_000_000;                 // 1 MB (Bluesky limit)
const MAX_POST_GRAPHEMES = 300;                   // Bluesky post text limit

const ALT_TEXT_ENABLED = process.env.ALT_TEXT_ENABLED === 'true';
const ALT_TEXT_LANGUAGE = process.env.ALT_TEXT_LANGUAGE || 'en';
const ALT_TEXT_PROVIDER = process.env.ALT_TEXT_PROVIDER || 'gemini';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const ALT_IMAGE_MAX_DIMENSION = 256;  // was 512 — halves Gemini token cost
const ALT_TEXT_API_ATTEMPTS = 3;      // attempts per alt-text API call on HTTP 429

const ALT_TEXT_CONCURRENCY = 3;        // max parallel alt-text API calls
const ALT_TEXT_MAX_RETRIES = 5;        // max retry cycles before posting without alt text

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

// File paths — DATA_DIR lets Docker keep config and state on a mounted volume.
// Defaults to the working directory, which is where these files always lived.
const DATA_DIR = process.env.DATA_DIR || '.';
const FEEDS_FILE = path.join(DATA_DIR, 'feeds.txt');
const LAST_POSTED_LINKS_FILE = path.join(DATA_DIR, 'lastPostedLinks.json');
const DEFERRED_ITEMS_FILE = path.join(DATA_DIR, 'deferredItems.json');

export function fetchWithAltTextTimeout(url, options = {}) {
  return fetchWithTimeout(url, options, ALT_TEXT_FETCH_TIMEOUT_MS);
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
    console.error(`Missing ${FEEDS_FILE} — copy feeds.txt.example to ${FEEDS_FILE} and add your feeds.`);
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

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8'));
  } catch {
    return fallback;
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

const saveLastPostedLinks = () => writeJsonAtomic(LAST_POSTED_LINKS_FILE, lastPostedLinks);
const saveDeferredItems = () => writeJsonAtomic(DEFERRED_ITEMS_FILE, deferredItems);

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
    await sleep(waitTime);
    apiCallCount = 0;
    lastApiReset = Date.now();
  }

  if (isCreate && createActionCount >= MAX_CREATES_PER_HOUR) {
    const waitTime = PUBLICATION_WINDOW_MS - (now - lastCreateReset);
    console.log(`CREATE limit reached. Waiting ${Math.ceil(waitTime / 1000)}s.`);
    await sleep(waitTime);
    createActionCount = 0;
    lastCreateReset = Date.now();
  }

  apiCallCount++;
  if (isCreate) createActionCount++;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
function isAlreadyPosted(link) {
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
 * Download an image for upload to Bluesky.
 * Returns { imageData, contentType, aspectRatio }, or null if it exceeds Bluesky's size limit.
 * Throws on non-2xx or non-image responses so error pages are never uploaded.
 */
async function loadImage(imageUrl) {
  const response = await fetchWithTimeout(imageUrl);
  if (!response.ok) throw new Error(`Image fetch returned HTTP ${response.status}`);
  const contentType = response.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
  if (!contentType.startsWith('image/')) throw new Error(`Not an image (${contentType})`);
  const imageData = Buffer.from(await response.arrayBuffer());

  if (imageData.length > MAX_IMAGE_SIZE) {
    console.log(`Image too large (${imageData.length} bytes): ${imageUrl}`);
    return null;
  }

  let aspectRatio;
  try {
    const meta = await sharp(imageData).metadata();
    if (meta.width && meta.height) aspectRatio = { width: meta.width, height: meta.height };
  } catch (metaErr) {
    console.warn(`Could not read image dimensions: ${metaErr.message}`);
  }

  return { imageData, contentType, aspectRatio };
}

/**
 * Resize an image so its longest side is ≤ maxDim and convert to JPEG.
 * The result is used only for the alt-text API call; the original is uploaded to Bluesky.
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

export { resizeImageForAltText };

function buildAltTextPrompt(context) {
  let prompt = `Describe this image as alt text for visually impaired users. Write in ${ALT_TEXT_LANGUAGE}. Be concise, max 250 characters. Describe what is visible. Only name a person if you are highly confident in the identification. If unsure, describe their appearance instead. Never guess.`;
  if (context) {
    prompt += ` Context from the article: "${context}". Use this to identify people or events, but only describe what is actually visible in the image.`;
  }
  return prompt;
}

const ALT_TEXT_PROVIDERS = {
  gemini: {
    name: 'Gemini',
    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    headers: () => ({ 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY }),
    body: (base64Data, mimeType, prompt) => ({
      contents: [{
        parts: [
          { inlineData: { mimeType, data: base64Data } },
          { text: prompt },
        ],
      }],
    }),
    extractText: data => data?.candidates?.[0]?.content?.parts?.[0]?.text,
  },
  openai: {
    name: 'OpenAI',
    url: 'https://api.openai.com/v1/chat/completions',
    headers: () => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` }),
    body: (base64Data, mimeType, prompt) => ({
      model: 'gpt-4o-mini',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Data}` } },
          { type: 'text', text: prompt },
        ],
      }],
    }),
    extractText: data => data?.choices?.[0]?.message?.content,
  },
};

/**
 * Generate alt text using the configured provider (ALT_TEXT_PROVIDER: gemini | openai).
 * Returns a trimmed string ≤ 300 chars, or '' on any error (graceful degradation).
 * Retries up to 3 times with exponential backoff on HTTP 429.
 *
 * @param {Buffer} imageBuffer
 * @param {string} mimeType
 * @param {Function} [fetchFn] - injectable for testing (defaults to fetchWithAltTextTimeout)
 * @param {number} [retryDelayMs] - base retry delay in ms; override in tests for speed
 * @param {string} [context] - article title/description to help identify people and events
 */
export async function generateAltText(imageBuffer, mimeType, fetchFn = fetchWithAltTextTimeout, retryDelayMs = 1000, context = '') {
  const provider = process.env.ALT_TEXT_PROVIDER === 'openai'
    ? ALT_TEXT_PROVIDERS.openai
    : ALT_TEXT_PROVIDERS.gemini;
  const requestBody = provider.body(imageBuffer.toString('base64'), mimeType, buildAltTextPrompt(context));

  for (let attempt = 0; attempt < ALT_TEXT_API_ATTEMPTS; attempt++) {
    try {
      const response = await fetchFn(provider.url, {
        method: 'POST',
        headers: provider.headers(),
        body: JSON.stringify(requestBody),
      });

      if (response.status === 429) {
        const delayMs = Math.pow(2, attempt + 1) * retryDelayMs;
        console.warn(`${provider.name} rate limit (429). Retry ${attempt + 1}/${ALT_TEXT_API_ATTEMPTS} in ${delayMs / 1000}s.`);
        await sleep(delayMs);
        continue;
      }

      if (!response.ok) {
        console.warn(`${provider.name} returned HTTP ${response.status}. Skipping alt text.`);
        return '';
      }

      const text = provider.extractText(await response.json());
      if (!text) {
        console.warn(`${provider.name} returned no usable text. Skipping alt text.`);
        return '';
      }
      return text.trim().slice(0, 300);
    } catch (err) {
      console.warn(`${provider.name} alt text error: ${err.message}`);
      return '';
    }
  }

  console.warn(`${provider.name} rate limit persisted after ${ALT_TEXT_API_ATTEMPTS} retries. Skipping alt text.`);
  return '';
}

/**
 * Returns true if the image URL matches a known non-content pattern
 * (favicon, logo, icon, etc.) that doesn't benefit from AI description.
 */
export function shouldSkipAltText(imageUrl) {
  if (!imageUrl) return false;
  return SKIP_ALT_TEXT_PATTERNS.some(pattern => pattern.test(imageUrl));
}

function altTextContextFor(item) {
  return [item.title, item.description].filter(Boolean).join(' — ');
}

/**
 * Download an image and obtain alt text for it (generic text for logos/icons,
 * cached text when available, otherwise a fresh API call).
 * Returns { altText, imageData, contentType, aspectRatio } — altText is '' when
 * generation failed — or null when there is no usable image.
 */
async function prefetchAltText(imageUrl, context = '') {
  if (!imageUrl || !isValidHttpUrl(imageUrl)) return null;

  try {
    const image = await loadImage(imageUrl);
    if (!image) return null;

    if (shouldSkipAltText(imageUrl)) {
      console.log(`Skipping alt-text API for non-content image: ${imageUrl}`);
      return { ...image, altText: GENERIC_ALT_TEXT };
    }

    const cached = getCachedAltText(imageUrl);
    if (cached) {
      console.log(`Alt-text cache hit for ${imageUrl}`);
      return { ...image, altText: cached };
    }

    const { buffer, mimeType } = await resizeImageForAltText(image.imageData);
    const altText = await generateAltText(buffer, mimeType, undefined, undefined, context);
    if (altText) setCachedAltText(imageUrl, altText);

    return { ...image, altText };
  } catch (err) {
    console.warn(`prefetchAltText failed for ${imageUrl}: ${err.message}`);
    return null;
  }
}

function externalEmbed(url, title, description, thumb) {
  const external = { uri: url, title: title || 'Link', description: truncateDescription(description) };
  if (thumb) external.thumb = thumb;
  return { $type: 'app.bsky.embed.external', external };
}

/**
 * Upload a prefetched image and wrap it in an app.bsky.embed.images embed.
 */
async function uploadImagesEmbed(image, altText) {
  await rateLimit(true);
  const { data: { blob } } = await agent.uploadBlob(image.imageData, image.contentType);
  const imageEntry = { alt: altText, image: blob };
  if (image.aspectRatio) imageEntry.aspectRatio = image.aspectRatio;
  return { $type: 'app.bsky.embed.images', images: [imageEntry] };
}

/**
 * Build a link card (app.bsky.embed.external) with an optional thumbnail.
 * Used when alt text is disabled. Fills missing title/description/image from OG tags.
 */
async function buildLinkCard(item, url) {
  if (!isValidHttpUrl(url)) {
    console.error(`Skipping link card for invalid URL: ${url}`);
    return null;
  }

  let title = item.title || '';
  let description = item.description || '';
  let imageUrl = item.imageUrl || null;

  if (!title || !description || !imageUrl) {
    const ogData = await fetchOgMetadata(url);
    if (ogData) {
      title = title || ogData.title;
      description = description || ogData.description;
      imageUrl = imageUrl || ogData.imageUrl;
    }
  }

  let thumb;
  if (imageUrl) {
    try {
      const image = await loadImage(imageUrl);
      if (image) {
        await rateLimit(true);
        thumb = (await agent.uploadBlob(image.imageData, image.contentType)).data.blob;
      }
    } catch (imgError) {
      console.error(`Failed to fetch/upload thumbnail: ${imgError.message}`);
    }
  }

  return externalEmbed(url, title, description, thumb);
}

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

/**
 * Post an item to Bluesky. The link is recorded as posted before posting (so a
 * crash mid-post can't cause a duplicate) and rolled back if posting fails.
 * `buildEmbed` runs inside the rollback scope, since it may upload blobs.
 * Returns true on success.
 */
async function postItem({ feedKey, feedTitle, item, buildEmbed, label = 'Posted' }) {
  recordPostedLink(feedKey, item.link);
  await saveLastPostedLinks();

  try {
    const embed = await buildEmbed();
    await rateLimit(true);
    const postText = buildPostText(feedTitle, item.title, item.link);
    const rt = new RichText({ text: postText });
    await rt.detectFacets(agent);
    await agent.post({
      text: rt.text,
      facets: rt.facets,
      embed: embed || undefined,
      langs: [ALT_TEXT_LANGUAGE],
    });
    console.log(`${label}: ${postText}`);
    return true;
  } catch (err) {
    console.error(`Failed to post ${item.link}: ${err.message}`);
    unrecordPostedLink(feedKey, item.link);
    await saveLastPostedLinks();
    return false;
  }
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
    !isAlreadyPosted(item.link) &&
    !isDeferred(item.link)
  );

  if (postable.length === 0) return;

  if (!ALT_TEXT_ENABLED) {
    for (const item of postable) {
      await postItem({ feedKey, feedTitle: feed.title, item, buildEmbed: () => buildLinkCard(item, item.link) });
    }
    return;
  }

  // Prefetch images and alt text in parallel (bounded concurrency)
  const prefetchedByLink = new Map(); // link -> { imageUrl, ogData, prefetched }

  for (let i = 0; i < postable.length; i += ALT_TEXT_CONCURRENCY) {
    const batch = postable.slice(i, i + ALT_TEXT_CONCURRENCY);
    await Promise.all(batch.map(async item => {
      let imageUrl = item.imageUrl || null;
      let ogData = null;
      if (!imageUrl) {
        ogData = await fetchOgMetadata(item.link);
        imageUrl = ogData?.imageUrl || null;
      }
      const prefetched = await prefetchAltText(imageUrl, altTextContextFor(item));
      prefetchedByLink.set(item.link, { imageUrl, ogData, prefetched });
    }));
  }

  // Post sequentially, deferring items whose alt text failed
  for (const item of postable) {
    const { imageUrl, ogData, prefetched } = prefetchedByLink.get(item.link);

    if (prefetched && !prefetched.altText) {
      // Image fetched OK but alt text generation failed — DEFER
      console.warn(`Alt text failed for ${item.link}, deferring to retry queue.`);
      deferredItems.push({
        // Keep the resolved (possibly OG-derived) image URL so the retry can find it
        item: { ...item, imageUrl },
        feedKey,
        feedTitle: feed.title,
        retryCount: 0,
        deferredAt: new Date().toISOString(),
      });
      await saveDeferredItems();
      continue;
    }

    const buildEmbed = prefetched
      ? () => uploadImagesEmbed(prefetched, prefetched.altText)
      : async () => {
          // No usable image — post as external link card (no alt text needed)
          const og = ogData || await fetchOgMetadata(item.link);
          return externalEmbed(item.link, item.title || og?.title, item.description || og?.description || '');
        };

    await postItem({ feedKey, feedTitle: feed.title, item, buildEmbed });
  }
}

/**
 * Retry alt text for deferred items. Posts with alt text on success; after
 * ALT_TEXT_MAX_RETRIES failed cycles, posts without alt text.
 */
async function processDeferredItems() {
  if (deferredItems.length === 0) return;

  console.log(`Processing ${deferredItems.length} deferred item(s)...`);
  const stillDeferred = [];

  for (const entry of deferredItems) {
    const { item, feedKey, feedTitle, retryCount } = entry;

    if (isAlreadyPosted(item.link)) continue;

    const prefetched = await prefetchAltText(item.imageUrl || null, altTextContextFor(item));

    if (prefetched?.altText) {
      const posted = await postItem({
        feedKey, feedTitle, item,
        buildEmbed: () => uploadImagesEmbed(prefetched, prefetched.altText),
        label: 'Posted deferred item',
      });
      if (!posted) stillDeferred.push({ ...entry, retryCount: retryCount + 1 });
    } else if (retryCount + 1 >= ALT_TEXT_MAX_RETRIES) {
      console.warn(`Max retries (${ALT_TEXT_MAX_RETRIES}) exhausted for ${item.link}. Posting without alt text.`);
      await postItem({
        feedKey, feedTitle, item,
        buildEmbed: () => prefetched
          ? uploadImagesEmbed(prefetched, '')
          : externalEmbed(item.link, item.title, item.description || ''),
        label: 'Posted (no alt text, retries exhausted)',
      });
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
 * Scheduling loop.
 */
async function runLoop(feeds) {
  while (true) {
    await postLatestItems(feeds);
    await sleep(POLL_INTERVAL_MS);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Node as PID 1 in Docker ignores SIGTERM by default; exit promptly instead of
  // waiting to be killed. State files are written atomically, so this is safe.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      console.log(`Received ${signal}, shutting down.`);
      process.exit(0);
    });
  }

  const commit = process.env.GIT_SHA && process.env.GIT_SHA !== 'unknown' ? ` (${process.env.GIT_SHA.slice(0, 7)})` : '';
  console.log(`Blueskybot v${VERSION}${commit} starting up...`);
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
  try {
    await fs.access(DATA_DIR, fs.constants.W_OK);
  } catch {
    console.error(`Data directory ${path.resolve(DATA_DIR)} is not writable — posted-link state could not be saved. Check the volume's ownership/permissions.`);
    process.exit(1);
  }
  const feeds = await loadFeeds();
  console.log(`Loaded ${feeds.length} feed(s) from ${FEEDS_FILE}.`);
  lastPostedLinks = await readJson(LAST_POSTED_LINKS_FILE, {});
  deferredItems = await readJson(DEFERRED_ITEMS_FILE, []);
  if (deferredItems.length > 0) {
    console.log(`${deferredItems.length} deferred item(s) loaded from previous run.`);
  }
  runLoop(feeds);
}
