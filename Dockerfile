FROM node:22-alpine

# Run as non-root user for security
RUN addgroup -S botuser && adduser -S botuser -G botuser

WORKDIR /app

# Install exact dependency versions from the lockfile
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# feeds.txt and bot state (lastPostedLinks.json, deferredItems.json) live in
# /data, which should be mounted as a volume so they survive image updates.
ENV DATA_DIR=/data
RUN mkdir -p /data && chown -R botuser:botuser /app /data
VOLUME /data

# Commit the image was built from; shown in the startup log.
ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA}

USER botuser

# Healthcheck: verify the node process is running
HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
  CMD pgrep -x node > /dev/null || exit 1

CMD ["node", "bot.mjs"]
