# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project follows [Semantic Versioning](https://semver.org/).

Versions before 2.0.0 were never tagged; they are reconstructed from the git
history and each one points at the last commit it covers.

## [2.0.0] - Unreleased

### Breaking
- Requires Node.js 20.9 or newer (the Docker image now uses Node 22; Node 18 is end-of-life).
- Docker: `feeds.txt` and the state files now live in `/data` (`DATA_DIR`), mounted as a volume.
  See *Upgrading from 1.x* in the README.

### Added
- Prebuilt multi-arch Docker image on GHCR (`ghcr.io/cgillinger/blueskybot`), built and tested by GitHub Actions.
- `DATA_DIR` setting for where `feeds.txt`, `lastPostedLinks.json` and `deferredItems.json` are kept.
- Version (and commit, in Docker) printed at startup; `package-lock.json` committed for reproducible builds.
- Clean shutdown on SIGTERM/SIGINT; startup check that the data directory is writable.

### Fixed
- Stalled response bodies could hang the poll loop (timeouts now cover the whole request).
- State files are written atomically, so a crash mid-write can no longer cause reposts.
- Items waiting for alt-text retry were re-queued every minute, multiplying alt-text API calls.
- Deferred items lost their OG-derived image and were posted without it.
- Error pages or non-image responses could be uploaded as images.
- RSS: HTTP errors are reported, and ETags are only cached after a successful parse.
- Posts longer than Bluesky's 300-grapheme limit were rejected; long titles are now shortened.

### Changed
- Default Gemini model is now `gemini-3.5-flash`; `gemini-2.5-flash` is retired by Google on 16 October 2026.
  The model can be changed with `GEMINI_MODEL` (and `OPENAI_MODEL` for OpenAI).
- Gemini API key is sent as a header instead of in the URL.
- `sharp` upgraded to 0.35 (fixes libvips/libheif security advisories).
- Internal refactor removing duplicated image/alt-text/posting code; shared helpers in `lib/utils.mjs`.

## [1.3.1] - 2026-05-01 (`ae39ecf`)

### Documentation
- Clarified that `feeds.txt` is baked into the Docker image at build time, and the comment syntax.
- Troubleshooting entry for commented-out feeds that still post.

## [1.3.0] - 2026-04-27 (`fd5b46a`)

### Added
- Optional AI alt text for images via Gemini 2.5 Flash, with OpenAI (`gpt-4o-mini`) as an alternative provider.
- Pluggable provider architecture, including a Sveriges Radio API provider (`sr-api://`).
- Clickable links in posts via RichText facet detection.
- Parallel alt-text prefetch, retry queue for failed alt text, in-memory alt-text cache and smaller images to reduce token cost.
- Article title/description passed as context to the alt-text prompt.

### Changed
- Alt-text prompt is cautious about identifying people.
- 30 s timeout for alt-text API calls.

## [1.2.0] - 2026-04-20 (`33f8223`)

### Added
- Link cards built from RSS data first, with Open Graph scraping as fallback.
- Image extraction from `<img>` in item content for feeds without media fields.
- Test suite (`npm test`).

## [1.1.0] - 2026-02-14 (`115c185`)

### Added
- Feeds configured in an external `feeds.txt`.
- 1-minute polling with conditional HTTP requests (ETag / Last-Modified).

### Fixed
- Security hardening, persistent session management and reliability improvements.
- Race condition and several duplicate-post safeguards, including global cross-feed duplicate detection.

## [1.0.0] - 2025-01-03 (`2ab2b67`)

### Added
- Initial bot: posts new RSS items to Bluesky with link cards.
- Docker and Docker Compose support.
- Project renamed to Blueskybot.
