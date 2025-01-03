# Blueskybot

A bot that automatically shares RSS feed updates to your Bluesky account. Great for sharing news, blog posts, or any RSS content with your followers.

## Features

- Automatically posts RSS feed updates to Bluesky
- Prevents duplicate posts
- Adds link previews to make posts look better
- Respects Bluesky's rate limits
- Runs quietly in the background

## Prerequisites

Before starting, you'll need to install either Docker (recommended) or Node.js.

### Installing Docker

#### Windows
1. Requirements:
   - Windows 10/11 Pro, Enterprise, or Education
   - OR Windows 10/11 Home version 2004 or higher
2. Get Docker:
   - Download [Docker Desktop for Windows](https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe)
   - Run the installer
   - Restart your computer when done

#### Mac
1. Requirements:
   - macOS 11 or newer (Intel Macs)
   - macOS 12 or newer (M1/M2 Macs)
2. Get Docker:
   - [Download for Intel Mac](https://desktop.docker.com/mac/main/amd64/Docker.dmg)
   - [Download for M1/M2 Mac](https://desktop.docker.com/mac/main/arm64/Docker.dmg)
   - Open the .dmg file
   - Drag Docker to Applications
   - Start Docker from Applications

#### Linux
```bash
# Ubuntu/Debian
sudo apt update
sudo apt install docker.io docker-compose

# Start Docker
sudo systemctl start docker
sudo systemctl enable docker

# Optional: Run Docker without sudo
sudo usermod -aG docker $USER
# Log out and back in after this
```

### Installing Node.js (Alternative)
If you prefer not to use Docker:
- [Windows Installer](https://nodejs.org/dist/v18.19.0/node-v18.19.0-x64.msi)
- [Mac Installer](https://nodejs.org/dist/v18.19.0/node-v18.19.0.pkg)
- Or visit [nodejs.org](https://nodejs.org/) for the latest version

## Setting Up the Bot

### Using Docker (Recommended)

1. Get the bot files:
```bash
git clone https://github.com/cgillinger/blueskybot.git
cd blueskybot
```

2. Set up your account:
```bash
cp .env.example .env
```
Then edit `.env` with your Bluesky login details:
```env
BLUESKY_USERNAME=your.username@bsky.social
BLUESKY_PASSWORD=your_password
```

3. Start the bot:
```bash
docker-compose up -d
```

That's it! The bot is now running. Check the logs to see it working:
```bash
docker-compose logs -f
```

### Useful Docker Commands

```bash
# Stop the bot
docker-compose down

# Restart the bot
docker-compose restart

# Check if it's running
docker-compose ps
```

### Using Node.js

If you're using Node.js instead of Docker:

```bash
# Get the files
git clone https://github.com/cgillinger/blueskybot.git
cd blueskybot

# Install dependencies
npm install

# Set up account details
cp .env.example .env
# Edit .env with your details

# Start the bot
npm start
```

## Adding Your RSS Feeds

Edit `bot.mjs` to add your feeds:

```javascript
const RSS_FEEDS = [
  { 
    url: 'https://news-site.com/feed.xml',
    title: 'News Site'
  },
  { 
    url: 'https://blog.com/rss',
    title: 'Blog'
  }
];
```

After changing feeds, restart the bot:
```bash
docker-compose restart
```

## Troubleshooting

### Login Problems
If you see "Invalid identifier or password":
- Double-check your Bluesky username and password in `.env`
- Make sure there are no extra spaces
- Try logging into Bluesky's website to verify your account

### Bot Not Posting
- Check the logs: `docker-compose logs -f`
- Verify your RSS feed URLs
- Make sure the bot is running: `docker-compose ps`

### Docker Issues
Try resetting the container:
```bash
docker-compose down
docker-compose up -d --build
```

## Tips for Success

### Security
- Keep your `.env` file private
- Never share screenshots showing your login details
- Regularly check your Bluesky account activity

### Maintenance
- Check the logs occasionally
- Make sure your RSS feeds are still valid
- Update the bot when new versions are available

## Contributing

Want to help improve the bot? Here's how:
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## Support

- Found a bug? [Open an issue](https://github.com/cgillinger/blueskybot/issues)
- Questions? Check existing issues or create a new one
- License: MIT
- Author: Christian Gillinger

---

Happy posting! Remember to check the logs when first starting to make sure everything is working as expected.