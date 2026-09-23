import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { resizeImageForAltText, generateAltText, parseFeedLine, shouldSkipAltText, getCachedAltText, setCachedAltText } from './bot.mjs';
import { getImageUrlFromItem } from './providers/rss.mjs';
import srApiFetcher from './providers/sr-api.mjs';

// ---------------------------------------------------------------------------
// getImageUrlFromItem
// ---------------------------------------------------------------------------

test('enclosure image/* returns enclosure URL', () => {
  const item = { enclosure: { url: 'https://example.com/image.jpg', type: 'image/jpeg' } };
  assert.equal(getImageUrlFromItem(item), 'https://example.com/image.jpg');
});

test('mediaThumbnail returns thumbnail URL', () => {
  const item = { mediaThumbnail: [{ $: { url: 'https://example.com/thumb.jpg' } }] };
  assert.equal(getImageUrlFromItem(item), 'https://example.com/thumb.jpg');
});

test('mediaContent medium=image returns content URL', () => {
  const item = { mediaContent: [{ $: { url: 'https://example.com/media.jpg', medium: 'image' } }] };
  assert.equal(getImageUrlFromItem(item), 'https://example.com/media.jpg');
});

test('content HTML <img src> fallback returns image URL', () => {
  const item = { content: '<p>Text</p><img src="https://example.com/content.jpg" alt="x"/>' };
  assert.equal(getImageUrlFromItem(item), 'https://example.com/content.jpg');
});

test('content HTML <img> with invalid URL returns null', () => {
  const item = { content: '<img src="javascript:alert(1)" />' };
  assert.equal(getImageUrlFromItem(item), null);
});

test('item with no image fields returns null', () => {
  assert.equal(getImageUrlFromItem({}), null);
});

test('enclosure takes priority over content HTML fallback', () => {
  const item = {
    enclosure: { url: 'https://example.com/enclosure.jpg', type: 'image/jpeg' },
    content: '<img src="https://example.com/content.jpg" />',
  };
  assert.equal(getImageUrlFromItem(item), 'https://example.com/enclosure.jpg');
});

// ---------------------------------------------------------------------------
// resizeImageForAltText
// ---------------------------------------------------------------------------

test('resizeImageForAltText returns buffer with mimeType image/jpeg', async () => {
  const src = await sharp({
    create: { width: 800, height: 600, channels: 3, background: { r: 100, g: 150, b: 200 } },
  }).jpeg().toBuffer();

  const result = await resizeImageForAltText(src, 512);

  assert.equal(result.mimeType, 'image/jpeg');
  assert.ok(Buffer.isBuffer(result.buffer), 'result.buffer must be a Buffer');
});

test('resizeImageForAltText output dimensions are ≤ maxDim', async () => {
  const src = await sharp({
    create: { width: 1024, height: 768, channels: 3, background: { r: 255, g: 0, b: 0 } },
  }).jpeg().toBuffer();

  const result = await resizeImageForAltText(src, 512);
  const meta = await sharp(result.buffer).metadata();

  assert.ok(meta.width <= 512, `width ${meta.width} should be ≤ 512`);
  assert.ok(meta.height <= 512, `height ${meta.height} should be ≤ 512`);
});

test('resizeImageForAltText does not enlarge images smaller than maxDim', async () => {
  const src = await sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 255, b: 0 } },
  }).jpeg().toBuffer();

  const result = await resizeImageForAltText(src, 512);
  const meta = await sharp(result.buffer).metadata();

  assert.ok(meta.width <= 100, `width ${meta.width} should not exceed original 100`);
  assert.ok(meta.height <= 100, `height ${meta.height} should not exceed original 100`);
});

// ---------------------------------------------------------------------------
// generateAltText
// ---------------------------------------------------------------------------

test('generateAltText sends correct base64 and prompt, returns trimmed text', async () => {
  const capturedRequests = [];

  const mockFetch = async (url, options) => {
    const body = JSON.parse(options.body);
    capturedRequests.push({ url, body });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '  A red square on white background  ' }] } }],
      }),
    };
  };

  const buf = Buffer.from('fake-image-data');
  const result = await generateAltText(buf, 'image/jpeg', mockFetch);

  assert.equal(result, 'A red square on white background');
  assert.equal(capturedRequests.length, 1);

  const parts = capturedRequests[0].body.contents[0].parts;
  assert.equal(parts[0].inlineData.mimeType, 'image/jpeg');
  assert.equal(parts[0].inlineData.data, buf.toString('base64'));
  assert.ok(parts[1].text.includes('alt text'), 'prompt should mention alt text');
});

test('generateAltText returns empty string on network error', async () => {
  const mockFetch = async () => { throw new Error('network error'); };
  const result = await generateAltText(Buffer.from('x'), 'image/jpeg', mockFetch);
  assert.equal(result, '');
});

test('generateAltText returns empty string after 429 retries exhausted', async () => {
  let callCount = 0;
  const mockFetch = async () => {
    callCount++;
    return { ok: false, status: 429 };
  };

  // retryDelayMs=1 keeps the test near-instant
  const result = await generateAltText(Buffer.from('x'), 'image/jpeg', mockFetch, 1);

  assert.equal(result, '');
  assert.equal(callCount, 3, 'should attempt exactly 3 times');
});

test('generateAltText returns empty string on non-2xx response', async () => {
  const mockFetch = async () => ({ ok: false, status: 500 });
  const result = await generateAltText(Buffer.from('x'), 'image/jpeg', mockFetch);
  assert.equal(result, '');
});

test('generateAltText returns empty string when response has no text', async () => {
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ candidates: [] }),
  });
  const result = await generateAltText(Buffer.from('x'), 'image/jpeg', mockFetch);
  assert.equal(result, '');
});

test('generateAltText includes context in Gemini prompt when provided', async () => {
  const capturedRequests = [];
  const mockFetch = async (url, options) => {
    const body = JSON.parse(options.body);
    capturedRequests.push({ url, body });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'A person on stage' }] } }],
      }),
    };
  };

  const buf = Buffer.from('fake-image-data');
  await generateAltText(buf, 'image/jpeg', mockFetch, 1000, 'Felicia om dödshoten');

  const prompt = capturedRequests[0].body.contents[0].parts[1].text;
  assert.ok(prompt.includes('Felicia om dödshoten'), 'prompt should include the context');
  assert.ok(prompt.includes('alt text'), 'prompt should still mention alt text');
});

test('generateAltText works without context (backward compatible)', async () => {
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: 'A red square' }] } }],
    }),
  });

  const result = await generateAltText(Buffer.from('x'), 'image/jpeg', mockFetch);
  assert.equal(result, 'A red square');
});

test('generateAltText truncates response to 300 characters', async () => {
  const longText = 'a'.repeat(400);
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: longText }] } }],
    }),
  });
  const result = await generateAltText(Buffer.from('x'), 'image/jpeg', mockFetch);
  assert.equal(result.length, 300);
});

// ---------------------------------------------------------------------------
// generateAltText (OpenAI provider)
// ---------------------------------------------------------------------------

function withOpenAIProvider(fn) {
  return async (t) => {
    const prev = process.env.ALT_TEXT_PROVIDER;
    process.env.ALT_TEXT_PROVIDER = 'openai';
    try {
      await fn(t);
    } finally {
      if (prev === undefined) delete process.env.ALT_TEXT_PROVIDER;
      else process.env.ALT_TEXT_PROVIDER = prev;
    }
  };
}

test('generateAltText (openai) parses choices[0].message.content and trims', withOpenAIProvider(async () => {
  const capturedRequests = [];
  const mockFetch = async (url, options) => {
    const body = JSON.parse(options.body);
    capturedRequests.push({ url, body, headers: options.headers });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '  A blue circle on yellow background  ' } }],
      }),
    };
  };

  const buf = Buffer.from('fake-image-data');
  const result = await generateAltText(buf, 'image/jpeg', mockFetch);

  assert.equal(result, 'A blue circle on yellow background');
  assert.equal(capturedRequests.length, 1);
  assert.equal(capturedRequests[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(capturedRequests[0].body.model, 'gpt-4o-mini');

  const content = capturedRequests[0].body.messages[0].content;
  assert.equal(content[0].type, 'image_url');
  assert.equal(content[0].image_url.url, `data:image/jpeg;base64,${buf.toString('base64')}`);
  assert.equal(content[1].type, 'text');
  assert.ok(content[1].text.includes('alt text'), 'prompt should mention alt text');
}));

test('generateAltText (openai) returns empty string after 429 retries exhausted', withOpenAIProvider(async () => {
  let callCount = 0;
  const mockFetch = async () => {
    callCount++;
    return { ok: false, status: 429 };
  };

  const result = await generateAltText(Buffer.from('x'), 'image/jpeg', mockFetch, 1);

  assert.equal(result, '');
  assert.equal(callCount, 3, 'should attempt exactly 3 times');
}));

test('generateAltText (openai) returns empty string on non-2xx response', withOpenAIProvider(async () => {
  const mockFetch = async () => ({ ok: false, status: 500 });
  const result = await generateAltText(Buffer.from('x'), 'image/jpeg', mockFetch);
  assert.equal(result, '');
}));

test('generateAltText (openai) returns empty string on network error', withOpenAIProvider(async () => {
  const mockFetch = async () => { throw new Error('network error'); };
  const result = await generateAltText(Buffer.from('x'), 'image/jpeg', mockFetch);
  assert.equal(result, '');
}));

// ---------------------------------------------------------------------------
// parseFeedLine (feeds.txt format)
// ---------------------------------------------------------------------------

test('parseFeedLine: https URL with title produces rss feed', () => {
  const feed = parseFeedLine('https://example.com/feed.xml | Example News');
  assert.deepEqual(feed, { type: 'rss', url: 'https://example.com/feed.xml', title: 'Example News' });
});

test('parseFeedLine: https URL without title produces rss feed with null title', () => {
  const feed = parseFeedLine('https://example.com/feed.xml');
  assert.deepEqual(feed, { type: 'rss', url: 'https://example.com/feed.xml', title: null });
});

test('parseFeedLine: http URL is rss, not http provider type', () => {
  const feed = parseFeedLine('http://example.com/feed.xml | Old Feed');
  assert.equal(feed.type, 'rss');
  assert.equal(feed.url, 'http://example.com/feed.xml');
});

test('parseFeedLine: sr-api prefix with id and title', () => {
  const feed = parseFeedLine('sr-api://83 | Ekot');
  assert.deepEqual(feed, { type: 'sr-api', id: '83', title: 'Ekot' });
});

test('parseFeedLine: sr-api prefix without title produces null title', () => {
  const feed = parseFeedLine('sr-api://83');
  assert.deepEqual(feed, { type: 'sr-api', id: '83', title: null });
});

test('parseFeedLine: unknown prefix is accepted as custom provider type', () => {
  const feed = parseFeedLine('custom-src://some-id | Custom');
  assert.deepEqual(feed, { type: 'custom-src', id: 'some-id', title: 'Custom' });
});

// ---------------------------------------------------------------------------
// sr-api provider
// ---------------------------------------------------------------------------

const sampleSrResponse = {
  articles: [
    {
      title: 'Sample news title',
      url: 'https://sverigesradio.se/artikel/abc',
      text: 'Short body text',
      imageurl: 'https://static-cdn.sr.se/images/x.jpg?preset=api-default-rectangle',
      publishdateutc: '/Date(1714000000000)/',
    },
  ],
};

test('sr-api: maps articles to normalized items', async () => {
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => sampleSrResponse,
  });

  const items = await srApiFetcher({ type: 'sr-api', id: '83', title: 'Ekot' }, new Map(), mockFetch);

  assert.equal(items.length, 1);
  const [item] = items;
  assert.equal(item.title, 'Sample news title');
  assert.equal(item.link, 'https://sverigesradio.se/artikel/abc');
  assert.equal(item.description, 'Short body text');
  assert.equal(item.imageUrl, 'https://static-cdn.sr.se/images/x.jpg?preset=api-default-rectangle');
});

test('sr-api: parses /Date(ms)/ format into a valid ISO date', async () => {
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => sampleSrResponse,
  });

  const [item] = await srApiFetcher({ type: 'sr-api', id: '83' }, new Map(), mockFetch);
  const parsed = new Date(item.pubDate);

  assert.equal(parsed.getTime(), 1714000000000);
  assert.equal(item.pubDate, new Date(1714000000000).toISOString());
});

test('sr-api: requests the correct URL with programid and size', async () => {
  let capturedUrl = null;
  const mockFetch = async (url) => {
    capturedUrl = url;
    return { ok: true, status: 200, json: async () => sampleSrResponse };
  };

  await srApiFetcher({ type: 'sr-api', id: '83' }, new Map(), mockFetch);

  assert.ok(capturedUrl.includes('programid=83'), 'URL must include programid');
  assert.ok(capturedUrl.includes('format=json'), 'URL must request JSON format');
  assert.ok(capturedUrl.includes('size=20'), 'URL must include size=20');
});

test('sr-api: truncates long description to 300 chars with ellipsis', async () => {
  const longText = 'a'.repeat(500);
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      articles: [{
        title: 't',
        url: 'https://sverigesradio.se/artikel/1',
        text: longText,
        imageurl: null,
        publishdateutc: '/Date(1714000000000)/',
      }],
    }),
  });

  const [item] = await srApiFetcher({ type: 'sr-api', id: '83' }, new Map(), mockFetch);

  assert.equal(item.description.length, 300);
  assert.ok(item.description.endsWith('...'), 'truncated text should end with ...');
});

test('sr-api: invalid imageurl is returned as null', async () => {
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      articles: [{
        title: 't',
        url: 'https://sverigesradio.se/artikel/1',
        text: 'x',
        imageurl: 'javascript:alert(1)',
        publishdateutc: '/Date(1714000000000)/',
      }],
    }),
  });

  const [item] = await srApiFetcher({ type: 'sr-api', id: '83' }, new Map(), mockFetch);
  assert.equal(item.imageUrl, null);
});

test('sr-api: throws on non-ok HTTP response', async () => {
  const mockFetch = async () => ({ ok: false, status: 500 });
  await assert.rejects(
    () => srApiFetcher({ type: 'sr-api', id: '83' }, new Map(), mockFetch),
    /HTTP 500/,
  );
});

// ---------------------------------------------------------------------------
// shouldSkipAltText
// ---------------------------------------------------------------------------

test('shouldSkipAltText returns true for favicon URLs', () => {
  assert.equal(shouldSkipAltText('https://example.com/favicon.ico'), true);
  assert.equal(shouldSkipAltText('https://example.com/assets/favicon-32x32.png'), true);
});

test('shouldSkipAltText returns true for logo URLs', () => {
  assert.equal(shouldSkipAltText('https://example.com/logo-white.svg'), true);
  assert.equal(shouldSkipAltText('https://example.com/logo.png'), true);
});

test('shouldSkipAltText returns true for icon URLs', () => {
  assert.equal(shouldSkipAltText('https://example.com/icon_small.png'), true);
  assert.equal(shouldSkipAltText('https://example.com/apple-touch-icon.png'), true);
  assert.equal(shouldSkipAltText('https://example.com/site-icon.jpg'), true);
});

test('shouldSkipAltText returns true for brand URLs', () => {
  assert.equal(shouldSkipAltText('https://example.com/brand-image.png'), true);
  assert.equal(shouldSkipAltText('https://example.com/brand.logo.svg'), true);
});

test('shouldSkipAltText returns false for regular content image URLs', () => {
  assert.equal(shouldSkipAltText('https://example.com/photo.jpg'), false);
  assert.equal(shouldSkipAltText('https://example.com/article-hero.png'), false);
  assert.equal(shouldSkipAltText('https://example.com/images/story-2024.jpg'), false);
});

test('shouldSkipAltText returns false for null and undefined', () => {
  assert.equal(shouldSkipAltText(null), false);
  assert.equal(shouldSkipAltText(undefined), false);
  assert.equal(shouldSkipAltText(''), false);
});

// ---------------------------------------------------------------------------
// Alt-text cache behavior
// ---------------------------------------------------------------------------

test('getCachedAltText returns null for an uncached URL', () => {
  const url = `https://example.com/never-cached-${Date.now()}.jpg`;
  assert.equal(getCachedAltText(url), null);
});

test('setCachedAltText and getCachedAltText round-trip', () => {
  const url = `https://example.com/cache-test-${Date.now()}.jpg`;
  setCachedAltText(url, 'A scenic mountain landscape');
  assert.equal(getCachedAltText(url), 'A scenic mountain landscape');
});

test('setCachedAltText overwrites an existing entry for the same URL', () => {
  const url = `https://example.com/overwrite-${Date.now()}.jpg`;
  setCachedAltText(url, 'First description');
  setCachedAltText(url, 'Updated description');
  assert.equal(getCachedAltText(url), 'Updated description');
});

// ---------------------------------------------------------------------------
// Deferred items (integration stubs — require full agent mocking)
// ---------------------------------------------------------------------------

test.todo('prefetchAltText returns cached result on second call for same URL');

test.todo('item is deferred when alt text returns empty string');

test.todo('deferred item posts on retry when alt text succeeds');

test.todo('deferred item posts without alt text after ALT_TEXT_MAX_RETRIES');

test.todo('parallel prefetch processes in batches of ALT_TEXT_CONCURRENCY');

// --- buildPostText ---

import { buildPostText } from './bot.mjs';

test('buildPostText keeps short posts unchanged', () => {
  assert.equal(buildPostText('Ekot', 'Rubrik', 'https://x.se/a'), 'Ekot: Rubrik\n\nhttps://x.se/a');
  assert.equal(buildPostText(null, 'Rubrik', 'https://x.se/a'), 'Rubrik\n\nhttps://x.se/a');
});

test('buildPostText truncates long titles to fit 300 graphemes and keeps the link', () => {
  const link = 'https://example.com/' + 'a'.repeat(80);
  const text = buildPostText('Feed', 'ö'.repeat(400), link);
  assert.equal([...new Intl.Segmenter().segment(text)].length, 300);
  assert.ok(text.endsWith(`…\n\n${link}`));
  assert.ok(text.startsWith('Feed: '));
});

test('generateAltText (gemini) calls the default model with the key in a header', async () => {
  let captured;
  const mockFetch = async (url, options) => {
    captured = { url, headers: options.headers };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'x' }] } }] }) };
  };
  await generateAltText(Buffer.from('x'), 'image/jpeg', mockFetch);
  assert.ok(captured.url.includes('/models/gemini-3.5-flash:generateContent'));
  assert.ok(!captured.url.includes('key='), 'API key must not be in the URL');
  assert.ok('x-goog-api-key' in captured.headers);
});

test('generateAltText (gemini) ignores thought parts and joins answer text', async () => {
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [
        { text: 'thinking about it', thought: true },
        { text: 'En röd ' },
        { text: 'rektangel' },
      ] } }],
    }),
  });
  const result = await generateAltText(Buffer.from('x'), 'image/jpeg', mockFetch);
  assert.equal(result, 'En röd rektangel');
});
