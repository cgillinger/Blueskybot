# Use Node.js as the base image
FROM node:18

# Set the working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json to the working directory
COPY package*.json ./

# Install necessary packages
RUN npm install

# Copy the entire project to the working directory
COPY . .

# Expose port (optional; useful for an HTTP server for status monitoring)
EXPOSE 3000

# Start the script
CMD ["node", "bluesky_rss_bot.js"]
