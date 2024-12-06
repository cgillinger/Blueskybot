
# Blueskybot

A bot for posting RSS feed updates to Bluesky using Node.js (and Docker).

## Features
- Fetches RSS feeds and posts new updates to a Bluesky account.
- Avoids duplicate posts by tracking links locally.
- Fetches metadata (title, description, thumbnail) for embedded links.
- Adheres to Bluesky's API rate limits.
- Configurable post frequency, duplicate-checking, and freshness criteria.

## Requirements
- [Node.js](https://nodejs.org/) version 16 or higher.
- A Bluesky account.

## Getting Started

Follow these steps to set up and run the bot:

### 1. Clone the repository
```bash
git clone https://github.com/cgillinger/bluebot.git
cd bluebot
```

### 2. Install dependencies
Run the following command to install all required dependencies:
```bash
npm install
```

### 3. Configure the `.env` file
- A `.env` file is included in the repository with placeholder values. Open it and replace placeholders with your actual Bluesky credentials:
```env
BLUESKY_USERNAME=your_username@provider.com
BLUESKY_PASSWORD=your_secure_password
```
- **Important**: The `.env` file must remain in the project directory for the bot to work.

### 4. Update RSS Feeds
- Open the `bot.mjs` file in a text editor.
- Locate the `RSS_FEEDS` array:
```javascript
const RSS_FEEDS = [
  { url: 'https://example.com/rss-feed-1.xml', title: 'Example Feed 1' },
  { url: 'https://example.com/rss-feed-2.xml', title: 'Example Feed 2' },
];
```
- Replace the placeholder URLs with the RSS feed URLs you want the bot to monitor. Optionally, add a `title` for each feed.

### 5. Configure Posting Behavior
The bot includes several configurable parameters that you can modify in `bot.mjs`:

#### **Post Frequency**
- By default, the bot fetches and posts updates every 5 minutes.
- To change the interval, update this line in `bot.mjs`:
```javascript
setInterval(postLatestRSSItems, 5 * 60 * 1000); // Repeat every 5 minutes
```
- Replace `5 * 60 * 1000` with your desired interval in milliseconds.

#### **Avoiding Duplicate Posts**
- The bot keeps track of links it has already posted using a local file (`lastPostedLinks.json`).
- You can adjust how many links are stored for each feed by editing this section:
```javascript
if (lastPostedLinks[feedUrl].length > 20) {
  lastPostedLinks[feedUrl].shift();
}
```
- Replace `20` with the number of past links to retain.

#### **Freshness Criteria**
- The bot only considers posts published within the last hour as "new."
- To adjust this timeframe, update this function in `bot.mjs`:
```javascript
const oneHourAgo = Date.now() - 60 * 60 * 1000; // Last hour
```
- Replace `60 * 60 * 1000` with your desired timeframe in milliseconds.

### 6. Start the bot
Run the bot using:
```bash
npm start
```

The bot will:
- Fetch new entries from the configured RSS feeds.
- Post them to your Bluesky account if they haven't been posted already.
- Repeat based on your configured interval.

## Common Issues and Troubleshooting

### Invalid Bluesky Credentials
If you see an error like `Invalid identifier or password`, ensure that:
1. Your `.env` file is correctly configured with valid Bluesky credentials.
2. Your Bluesky account is active and accessible.

### Rate Limit Errors
If the bot encounters rate limits (status code `429`), it will automatically pause and retry after the required wait time.

### Missing Dependencies
If the bot fails to start due to missing modules, run:
```bash
npm install
```

## Additional Notes
- The bot uses placeholders for RSS feeds and requires manual updates in `bot.mjs` to set the actual feeds.
- `.env` is intentionally included in the repository because it contains only placeholder data.

## License
This project is licensed under the ISC License.

## Contributing
Contributions are welcome! Open an issue or submit a pull request if you'd like to help improve the project.


### Docker Support

You can use Docker to run the project without installing Node.js or its dependencies locally. Here’s how:

#### 1. Build the Docker Image
In the project directory (where your `Dockerfile` is located), run the following command to build the Docker image:
```bash
docker build -t bluebot .
```

#### 2. Run the Docker Container
Start the container using:
```bash
docker run -d --name bluebot-container bluebot
```
This command:
- Runs the container in detached mode (`-d`).
- Names the container `bluebot-container`.

#### 3. View Logs
Check the logs to ensure the bot is running correctly:
```bash
docker logs bluebot-container
```

#### 4. Stop or Remove the Container
To stop the running container:
```bash
docker stop bluebot-container
```
To remove the container:
```bash
docker rm bluebot-container
```

#### Optional: Expose HTTP Port
If you modify the bot to expose an HTTP server for status monitoring, ensure port 3000 is exposed in the Dockerfile and map it when running the container:
```bash
docker run -d -p 3000:3000 --name bluebot-container bluebot
```
