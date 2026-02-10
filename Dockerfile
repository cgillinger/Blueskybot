FROM node:18-alpine

# Run as non-root user for security
RUN addgroup -S botuser && adduser -S botuser -G botuser

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --only=production

# Copy project files
COPY . .

# Own app files as non-root user
RUN chown -R botuser:botuser /app
USER botuser

# Healthcheck: verify the node process is running
HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
  CMD pgrep -x node > /dev/null || exit 1

# Start the bot
CMD ["node", "bot.mjs"]
