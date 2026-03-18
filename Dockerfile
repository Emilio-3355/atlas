FROM node:20-slim

# Playwright Chromium dependencies
RUN apt-get update && apt-get install -y \
    libnss3 libatk-bridge2.0-0 libdrm2 libxcomposite1 libxdamage1 \
    libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 \
    libatspi2.0-0 libxshmfence1 libx11-xcb1 \
    libglib2.0-0 libdbus-1-3 libgtk-3-0 libxkbcommon0 \
    fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production=false

# Install Playwright Chromium
RUN npx playwright install chromium

COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

CMD ["sh", "-c", "node dist/config/migrate.js && node dist/index.js"]
