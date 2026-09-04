# Dockerfile
# Node 20 + Playwright's Chromium. Runs as a long-lived process (dashboard +
# scheduler + persistent browser context). Designed for Fly.io / Render / any
# Docker host with a persistent volume mounted at /data.

FROM mcr.microsoft.com/playwright:v1.47.0-jammy AS base

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /data && chmod -R 777 /data

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

RUN chmod +x scripts/start.sh

CMD ["bash", "scripts/start.sh"]
