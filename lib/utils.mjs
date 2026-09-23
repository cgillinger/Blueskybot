// Shared helpers used by bot.mjs and the providers. Kept free of bot state so
// providers can import them without a circular dependency on bot.mjs.
import fetch from 'node-fetch';

export const FETCH_TIMEOUT_MS = 15_000;
export const MAX_DESCRIPTION_LENGTH = 300;

/**
 * Fetch with a timeout. AbortSignal.timeout also covers reading the body
 * (text()/arrayBuffer()), so a server that stalls mid-response can't hang the loop.
 */
export function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
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

/**
 * Truncate a description to Bluesky's link-card limit, adding an ellipsis.
 */
export function truncateDescription(text) {
  if (!text) return '';
  return text.length > MAX_DESCRIPTION_LENGTH
    ? text.slice(0, MAX_DESCRIPTION_LENGTH - 3) + '...'
    : text;
}
