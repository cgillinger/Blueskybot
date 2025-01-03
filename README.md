# Blueskybot

A bot for posting RSS feed updates to Bluesky using Node.js or Docker.

---

## Features

- Fetches RSS feeds and posts new updates to a Bluesky account.
- Avoids duplicates by locally tracking previously published links.
- Retrieves metadata (title, description, thumbnail) for embedded links.
- Adheres to Bluesky's API rate limits.
- Configurable settings for frequency, duplicate-checking, and relevance.

---

## Quick Start

Choose your preferred setup method:

1. **[Standard Node.js Installation](#nodejs-installation)**: If you're comfortable with Node.js.
2. **[Docker Installation](#docker-installation)**: Recommended to avoid dependency issues.

---

## Node.js Installation

### Step 1: Clone the Repository

```bash
git clone https://github.com/cgillinger/Blueskybot.git
cd Blueskybot
```

### Step 2: Install Dependencies

Install all required packages:

```bash
npm install
```

### Step 3: Configure the `.env` File

- Locate the `.env.example` file in the repository and rename it to `.env`:

```bash
mv .env.example .env
```

- Open the `.env` file and replace the placeholder values with your Bluesky credentials:

```env
BLUESKY_USERNAME=your_email@provider.com
BLUESKY_PASSWORD=your_secure_password
```

> **Note**: The `.env` file must remain in the project directory for the bot to function.

### Step 4: Update RSS Feeds

- Open `bot.mjs` in a text editor.
- Update the `RSS_FEEDS` array with the RSS feeds you want to monitor:

```javascript
const RSS_FEEDS = [
  { url: 'https://example.com/rss-feed-1.xml', title: 'Example Feed 1' },
  { url: 'https://example.com/rss-feed-2.xml', title: 'Example Feed 2' },
];
```

#### Important Notes:
- Ensure every URL is valid and points to an active RSS feed.
- Titles are optional but help you identify each feed.
- Do not add extra fields beyond `url` and `title`.

### Step 5: Start the Bot

Run the bot:

```bash
npm start
```

---

## Docker Installation

Docker simplifies setup and avoids dependency issues. Here’s how to get started:

### Install Docker

1. **Windows**:
   - Download and install [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop/).
   - Ensure WSL2 is enabled if you are using Windows 10 or later.

2. **MacOS**:
   - Download and install [Docker Desktop for Mac](https://www.docker.com/products/docker-desktop/).
   - Supports macOS Catalina and later.

3. **Linux**:
   - Follow the installation instructions for your distribution:
     - [Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
     - [Debian](https://docs.docker.com/engine/install/debian/)
     - [Fedora](https://docs.docker.com/engine/install/fedora/)
     - [CentOS](https://docs.docker.com/engine/install/centos/)

> **Note**: Verify that Docker and Docker Compose are working correctly by running `docker --version` and `docker compose version`.

### Step 1: Build the Docker Image

Navigate to the project directory in the terminal (the folder where the `Dockerfile` is located). Run:

```bash
docker build -t blueskybot .
```

### Step 2: Configure Environment Variables

Ensure your `.env` file is updated with valid Bluesky credentials.

### Step 3: Start the Docker Container

Start the container:

```bash
docker run --env-file .env -d --name blueskybot-container blueskybot
```

### Step 4: View Logs

Check the logs to verify the bot is running:

```bash
docker logs blueskybot-container
```

### Step 5: Stop or Remove the Container

To stop the container:

```bash
docker stop blueskybot-container
```

To remove the container:

```bash
docker rm blueskybot-container
```

---

## File Overview

### Key Files

- **`bot.mjs`**: The main script performing all bot functions.
- **`package.json`**: Lists the project’s dependencies.
- **`Dockerfile`**: Instructions for building the Docker image.
- **`.env`**: Contains environment variables used by the bot.

### Project Structure

```plaintext
/
├── bot.mjs          # Main script
├── Dockerfile       # Docker configuration
├── docker-compose.yml # Alternative Docker configuration (optional)
├── LICENSE          # Project license (MIT)
├── package.json     # Dependencies
├── README.md        # Documentation
```

---

## Common Issues and Troubleshooting

### Invalid Bluesky Credentials

If you see `Invalid identifier or password`:
1. Verify that your `.env` file contains correct credentials.
2. Ensure your Bluesky account is active.

### API Rate Limits

If API rate limits are encountered (status code `429`), the bot automatically waits until the limit resets.

### Missing Dependencies

If modules are missing, reinstall them:

```bash
npm install
```

---

## Contributing

Contributions are welcome! Open an issue or submit a pull request to improve this project.

---

## License

This project is licensed under the [MIT License](LICENSE).


