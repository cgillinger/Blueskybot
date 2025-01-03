FROM node:18

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --only=production

# Copy project files
COPY . .

# Start the bot
CMD ["node", "bot.mjs"]
