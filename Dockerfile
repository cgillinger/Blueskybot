# Använd Node.js som basbild
FROM node:18

# Skapa appkatalogen
WORKDIR /app

# Kopiera package.json och package-lock.json till arbetskatalogen
COPY package*.json ./

# Installera nödvändiga paket
RUN npm install

# Kopiera hela projektet till arbetskatalogen
COPY . .

# Exponera port (om du vill använda en HTTP-server för status)
EXPOSE 3000

# Starta skriptet
CMD ["node", "bluesky_rss_bot.js"]
