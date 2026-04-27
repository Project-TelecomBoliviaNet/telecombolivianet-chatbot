# ══════════════════════════════════════════════════════════════
# Chatbot Bolivianet — NestJS
# Multi-stage: build → producción (imagen mínima)
# ══════════════════════════════════════════════════════════════

# ── Stage 1: build ───────────────────────────────────────────
FROM node:20-alpine AS build

WORKDIR /app

COPY package.json ./
RUN npm install --frozen-lockfile 2>/dev/null || npm install

COPY tsconfig.json nest-cli.json ./
COPY src/ ./src/

RUN npm run build

# ── Stage 2: producción ──────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev --frozen-lockfile 2>/dev/null || npm install --omit=dev

COPY --from=build /app/dist ./dist

RUN mkdir -p uploads

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["node", "dist/main"]
