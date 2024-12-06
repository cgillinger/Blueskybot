
# Blueskybot

A bot for posting RSS feed updates to Bluesky using Node.js (and Docker).

---

## Features
- Fetches RSS feeds and posts new updates to a Bluesky account.
- Avoids duplicate posts by tracking links locally.
- Fetches metadata (title, description, thumbnail) for embedded links.
- Adheres to Bluesky's API rate limits.
- Configurable post frequency, duplicate-checking, and freshness criteria.

---

## Quick Start

Choose your preferred setup method:

1. **[Standard Node.js Installation](#nodejs-installation)**: If you are comfortable with Node.js.
2. **[Docker Installation](#docker-installation)**: Recommended if you prefer to use containers.

---

## Node.js Installation

Follow these steps to set up and run the bot using Node.js:

### Step 1: Clone the Repository
```bash
git clone https://github.com/cgillinger/bluebot.git
cd bluebot
```

### Step 2: Install Dependencies
Install all required dependencies:
```bash
npm install
```

### Step 3: Configure the `.env` File
- Open the included `.env` file and replace placeholder values with your Bluesky credentials:
```env
BLUESKY_USERNAME=your_username@provider.com
BLUESKY_PASSWORD=your_secure_password
```
- **Important**: The `.env` file must remain in the project directory for the bot to work.

### Step 4: Update RSS Feeds
- Open `bot.mjs` in a text editor.
- Update the `RSS_FEEDS` array with the RSS feed URLs you want the bot to monitor:
```javascript
const RSS_FEEDS = [
  { url: 'https://example.com/rss-feed-1.xml', title: 'Example Feed 1' },
  { url: 'https://example.com/rss-feed-2.xml', title: 'Example Feed 2' },
];
```

### Step 5: Start the Bot
Run the bot:
```bash
npm start
```

---

## Docker Installation

Docker simplifies setup and eliminates dependency conflicts. Here’s how to use Docker:

### What is Docker?
Docker allows you to package an application and its dependencies into a container, ensuring it runs consistently across environments.

### Step 1: Build the Docker Image
Navigate to the project directory using the terminal. This is the folder where your `Dockerfile` is located, typically the root directory of the repository you cloned. Then, run the following command:
```bash
docker build -t bluebot .
```
- `docker build`: Tells Docker to build an image.
- `-t bluebot`: Names the image "bluebot."
- `.`: Refers to the current directory.

### Step 2: Configure Environment Variables
Ensure your `.env` file is ready with valid Bluesky credentials.

### Step 3: Run the Docker Container
Start the container:
```bash
docker run --env-file .env -d --name bluebot-container bluebot
```
- `--env-file .env`: Passes environment variables to the container.
- `-d`: Runs the container in detached mode.
- `--name bluebot-container`: Names the container.

### Step 4: View Logs
Check the logs to ensure the bot is running:
```bash
docker logs bluebot-container
```

### Step 5: Stop or Remove the Container
To stop the container:
```bash
docker stop bluebot-container
```
To remove the container:
```bash
docker rm bluebot-container
```

---

## Understanding the Dockerfile

The provided Dockerfile sets up the container for running the bot. Here’s a breakdown:

1. **Base Image**:
   ```dockerfile
   FROM node:18
   ```
   - Uses the official Node.js 18 image as the base environment.

2. **Set Working Directory**:
   ```dockerfile
   WORKDIR /app
   ```
   - Defines `/app` as the working directory where all subsequent commands will run.

3. **Install Dependencies**:
   ```dockerfile
   COPY package*.json ./
   RUN npm install --only=production
   ```
   - Copies `package.json` and `package-lock.json` into the container and installs required dependencies.

4. **Add Project Files**:
   ```dockerfile
   COPY . .
   ```
   - Copies all files from your local project directory into the container.

5. **Expose Ports (Optional)**:
   ```dockerfile
   EXPOSE 3000
   ```
   - Prepares the container to use port 3000. Useful for HTTP monitoring if added later.

6. **Start the Bot**:
   ```dockerfile
   CMD ["node", "bot.mjs"]
   ```
   - Starts the bot script when the container runs.

---

## Common Issues and Troubleshooting

### Invalid Bluesky Credentials
If you see `Invalid identifier or password`:
1. Double-check your `.env` file for correct credentials.
2. Verify your Bluesky account is active.

### Rate Limit Errors
If rate limits are encountered (status code `429`), the bot automatically retries after the required wait time.

### Missing Dependencies
If you encounter missing modules, reinstall them:
```bash
npm install
```

---

## Contributing
Contributions are welcome! Open an issue or submit a pull request to improve this project.

---

## License
This project is licensed under the ISC License.
