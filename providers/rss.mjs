import RSSParser from 'rss-parser';
import { fetchWithTimeout, isValidHttpUrl, truncateDescription } from '../lib/utils.mjs';

const parser = new RSSParser({
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: true }],
    ],
  },
});

/**
 * Extract the first image URL from an RSS item's media fields.
 * Checks enclosure, mediaThumbnail, and mediaContent in order.
 */
export function getImageUrlFromItem(item) {
  if (item.enclosure?.url && item.enclosure.type?.startsWith('image/') && isValidHttpUrl(item.enclosure.url)) {
    return item.enclosure.url;
  }
  const thumbUrl = item.mediaThumbnail?.[0]?.$.url;
  if (thumbUrl && isValidHttpUrl(thumbUrl)) {
    return thumbUrl;
  }
  const mc = item.mediaContent?.[0];
  if (mc) {
    const mcUrl = mc.$.url;
    if (mcUrl && (mc.$.medium === 'image' || mc.$.type?.startsWith('image/')) && isValidHttpUrl(mcUrl)) {
      return mcUrl;
    }
  }
  if (item.content) {
    const match = item.content.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (match && isValidHttpUrl(match[1])) return match[1];
  }
  return null;
}

/**
 * Fetch an RSS feed using conditional HTTP requests (ETag / If-Modified-Since).
 * Returns parsed feed data if the feed has new content, or null if unchanged (304).
 */
async function fetchFeedIfModified(feedUrl, httpCache) {
  const cached = httpCache.get(feedUrl);
  const headers = {};
  if (cached?.etag) headers['If-None-Match'] = cached.etag;
  if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;

  const response = await fetchWithTimeout(feedUrl, { headers });

  if (response.status === 304) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Feed returned HTTP ${response.status}`);
  }

  const xml = await response.text();
  const parsed = await parser.parseString(xml);

  // Only cache validators once the feed parsed successfully; otherwise a
  // broken response would be followed by 304s and its items never seen.
  httpCache.set(feedUrl, {
    etag: response.headers.get('etag') || null,
    lastModified: response.headers.get('last-modified') || null,
  });
  return parsed;
}


/**
 * RSS provider.
 * @param {object} feed - { type: 'rss', url, title }
 * @param {Map} httpCache - ETag/Last-Modified cache
 * @returns {Promise<Array|null>} Array of NormalizedItem, or null if unchanged.
 */
export default async function fetchItems(feed, httpCache) {
  const feedData = await fetchFeedIfModified(feed.url, httpCache);
  if (!feedData) return null;

  return feedData.items.map(item => ({
    title: item.title || '',
    link: item.link,
    description: truncateDescription(item.contentSnippet || item.summary || ''),
    imageUrl: getImageUrlFromItem(item),
    pubDate: item.pubDate,
  }));
}
