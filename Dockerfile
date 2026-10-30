# Node 20 + Playwright's Chromium. The pinned Playwright image already
# includes the matching browser binaries and Linux system dependencies.
# Keep the package version in package.json aligned with this image tag.
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
