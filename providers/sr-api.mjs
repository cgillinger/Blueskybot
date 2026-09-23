import { fetchWithTimeout, isValidHttpUrl, truncateDescription } from '../lib/utils.mjs';

const API_BASE = 'https://api.sr.se/api/v2/news';
const PAGE_SIZE = 20;

/**
 * Parse the .NET JSON date format "/Date(1714000000000)/" into an ISO string.
 */
function parseDotNetDate(raw) {
  if (!raw) return null;
  const match = raw.match(/\/Date\((\d+)\)\//);
  if (!match) return null;
  return new Date(parseInt(match[1], 10)).toISOString();
}


/**
 * Sveriges Radio news API provider.
 * feeds.txt: sr-api://<programid> | Title
 *
 * @param {object} feed - { type: 'sr-api', id, title }
 * @param {Map} _httpCache - unused (SR API has no conditional request support)
 * @param {Function} [fetchFn] - injectable for testing (defaults to fetchWithTimeout)
 */
export default async function fetchItems(feed, _httpCache, fetchFn = fetchWithTimeout) {
  const url = `${API_BASE}?programid=${encodeURIComponent(feed.id)}&format=json&size=${PAGE_SIZE}`;
  const response = await fetchFn(url);

  if (!response.ok) {
    throw new Error(`SR API returned HTTP ${response.status} for program ${feed.id}`);
  }

  const data = await response.json();
  const articles = Array.isArray(data?.articles) ? data.articles : [];

  return articles
    .filter(a => a.url && isValidHttpUrl(a.url))
    .map(a => ({
      title: a.title || '',
      link: a.url,
      description: truncateDescription(a.text || ''),
      imageUrl: a.imageurl && isValidHttpUrl(a.imageurl) ? a.imageurl : null,
      pubDate: parseDotNetDate(a.publishdateutc),
    }));
}
