# Blueskybot

[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)
[![Bluesky](https://img.shields.io/badge/Bluesky-AT%20Protocol-0085ff?logo=bluesky&logoColor=white)](https://bsky.app/)

A lightweight Node.js bot that monitors RSS feeds and posts new articles to [Bluesky](https://bsky.app) with rich embed cards.

## Features

- Monitors multiple RSS feeds on a configurable polling interval
- Posts new articles with Open Graph metadata (title, description, thumbnail)
- Tracks posted links locally to prevent duplicates
- Persistent session management (logs in once, re-authenticates on expiry)
- Respects Bluesky API rate limits with separate read/write tracking
- Request timeouts and URL validation for reliability and security
- Runs as non-root user in Docker with health checks

## Prerequisites

- [Node.js](https://nodejs.org/) 18+ (or [Docker](https://www.docker.com/))
- A [Bluesky](https://bsky.app) account
- One or more RSS feed URLs to monitor

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/cgillinger/Blueskybot.git
cd Blueskybot
npm install
```

### 2. Configure credentials

```bash
cp .env.example .env
```

Edit `.env` with your Bluesky credentials:

```env
BLUESKY_USERNAME=your_handle@bsky.social
BLUESKY_PASSWORD=your_app_password
```

> **Tip:** Use an [App Password](https://bsky.app/settings/app-passwords) instead of your main password.

### 3. Configure RSS feeds

Edit the `RSS_FEEDS` array in `bot.mjs`:

```javascript
const RSS_FEEDS = [
  { url: 'https://example.com/feed.xml', title: 'Example' },
  { url: 'https://another.com/rss',      title: 'Another Feed' },
];
```

| Field   | Required | Description                              |
|---------|----------|------------------------------------------|
| `url`   | Yes      | Full URL to the RSS feed                 |
| `title` | No       | Prefix label shown in the Bluesky post   |

### 4. Run

```bash
npm start
```

The bot polls every minute and posts articles published within the last hour. Conditional HTTP requests (ETag/Last-Modified) keep unchanged polls near-zero cost.

## Docker

### Using Docker Compose (recommended)

```bash
cp .env.example .env          # configure credentials
docker compose up -d --build
```

```bash
docker compose logs -f        # follow logs
docker compose down           # stop
```

### Using Docker directly

```bash
docker build -t blueskybot .
docker run -d --name blueskybot --env-file .env --restart always blueskybot
```

The container uses `node:18-alpine`, runs as a non-root user, and includes a health check.

## Configuration

All configuration constants are defined at the top of `bot.mjs`:

| Constant                    | Default    | Description                                 |
|-----------------------------|------------|---------------------------------------------|
| `POLL_INTERVAL_MS`          | `60000`    | Polling interval (1 min)                    |
| `PUBLICATION_WINDOW_MS`     | `3600000`  | Only post articles newer than this (1 hour) |
| `MAX_TRACKED_LINKS_PER_FEED`| `20`       | Duplicate tracking buffer per feed          |
| `FETCH_TIMEOUT_MS`          | `15000`    | HTTP request timeout (15 sec)               |
| `MAX_IMAGE_SIZE`            | `1000000`  | Max thumbnail size in bytes (1 MB)          |

## Project Structure

```
Blueskybot/
├── bot.mjs              # Main application
├── Dockerfile           # Container image (Alpine, non-root)
├── docker-compose.yml   # Compose orchestration
├── package.json         # Dependencies and scripts
├── .env.example         # Credential template
├── .gitignore
├── LICENSE              # MIT
└── README.md
```

## How It Works

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  RSS Feeds  │────>│   bot.mjs    │────>│  Bluesky (AT     │
│  (polling)  │     │  parse/filter│     │  Protocol API)   │
└─────────────┘     └──────┬───────┘     └─────────────────┘
                           │
                    ┌──────┴───────┐
                    │ OG metadata  │
                    │ fetch + image│
                    │ upload       │
                    └──────┬───────┘
                           │
                    ┌──────┴───────┐
                    │ lastPosted   │
                    │ Links.json   │
                    └──────────────┘
```

1. **Poll** RSS feeds at a fixed interval
2. **Filter** articles to those published within the last hour
3. **Deduplicate** against locally stored posted links
4. **Fetch** Open Graph metadata (title, description, image) from article URL
5. **Upload** thumbnail image as blob to Bluesky
6. **Post** to Bluesky with `app.bsky.embed.external` embed card
7. **Persist** the posted link to avoid duplicates on restart

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `Invalid identifier or password` | Verify `.env` credentials. Use an [App Password](https://bsky.app/settings/app-passwords). |
| `API rate limit reached` | The bot automatically waits and retries. No action needed. |
| Thumbnails missing on some posts | The source site may lack `og:image` tags, or the image exceeds 1 MB. |
| `FETCH_TIMEOUT` errors | The target site is slow or unreachable. The post will still be created without a thumbnail. |
| Container unhealthy | Check logs with `docker compose logs` — likely a credential or network issue. |

## Contributing

Contributions are welcome! Please open an [issue](https://github.com/cgillinger/Blueskybot/issues) or submit a pull request.

## License

[MIT](LICENSE) &copy; Christian Gillinger
