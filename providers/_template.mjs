/**
 * Provider: [NAME]
 *
 * feeds.txt usage:
 *   my-provider://some-id | Display Title
 *
 * Add to the provider registry in bot.mjs:
 *   import myProvider from './providers/my-provider.mjs';
 *   providers['my-provider'] = myProvider;
 */

// Most providers want these helpers. Remove the import if you don't need them.
// import { fetchWithTimeout, isValidHttpUrl, truncateDescription } from '../lib/utils.mjs';

/**
 * Normalized item shape (this is what you must return per item):
 *
 *   {
 *     title:       string,          // post title
 *     link:        string,           // article URL (must be http/https)
 *     description: string,           // plain text, truncate to ~300 chars
 *     imageUrl:    string | null,    // must pass isValidHttpUrl() or be null
 *     pubDate:     string,           // ISO 8601 or RFC 2822 parseable by new Date()
 *   }
 *
 * Return values:
 *   Array<NormalizedItem>  — items to consider for posting
 *   null                   — source unchanged (e.g. HTTP 304); skip this cycle
 *
 * @param {object} feed     - parsed feed config, e.g. { type, id, title }
 * @param {Map}    httpCache - shared ETag/Last-Modified cache (optional to use)
 * @returns {Promise<Array|null>}
 */
export default async function fetchItems(feed, httpCache) {
  // 1. Fetch data from your source using feed.id (or feed.url).
  // 2. Map each record to the NormalizedItem shape above.
  // 3. Return the array, or null if nothing changed since the last poll.
  throw new Error('Not implemented — replace with your provider logic');
}
