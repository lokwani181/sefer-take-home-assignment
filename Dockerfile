# Shipment documents → NetCHB entry XML: API + web UI in one container on port 3001.
#
#   docker build -t netchb-entry .
#   docker run --rm -p 3001:3001 netchb-entry
#   open http://localhost:3001
#
# Debian bookworm ships Tesseract 5.3.x; the app was developed against 5.5.1 (Homebrew), so OCR
# confidences can differ slightly. No API keys or LLMs are used. The USITC HTS API is only called
# for headings that are not in the committed reference data (set HTS_OFFLINE=1 to forbid it).

ARG NODE_IMAGE=node:22-bookworm-slim

# ── 1. Dependencies (all of them: the server runs TypeScript through tsx) ────────────────────
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund

# ── 2. Build the web app (tsc typecheck + vite build → web/dist) ─────────────────────────────
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY web web
RUN npm run build

# ── 3. Runtime: Node + Tesseract + poppler + xmllint, non-root ───────────────────────────────
FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng poppler-utils libxml2-utils ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3001 \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared packages/shared
COPY server/package.json server/tsconfig.json server/
COPY server/src server/src
COPY web/package.json web/package.json
COPY --from=build /app/web/dist web/dist
# The sample shipment, so the CLI can be tried inside the container.
COPY samples/*.pdf samples/
# OCR layout/page-image cache and HTS cache (server/.cache) must be writable by the app user.
RUN mkdir -p server/.cache output && chown -R node:node server/.cache output

USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>r.json()).then(b=>process.exit(b.ok?0:1)).catch(()=>process.exit(1))"

# Same as `npm start` (tsx src/index.ts) but without the npm/tsx wrapper processes, so SIGTERM
# from `docker stop` reaches the server's shutdown handler directly.
WORKDIR /app/server
CMD ["node", "--import", "tsx", "src/index.ts"]
