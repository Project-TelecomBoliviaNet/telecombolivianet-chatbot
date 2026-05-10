# ══════════════════════════════════════════════════════════════
# TELECOM BOLIVIANET - CHATBOT WHATSAPP
# Dockerfile - Multi-stage build
# Corregido: npm ci correcto + dependencias nativas para alpine
# ══════════════════════════════════════════════════════════════

# ─── STAGE 1: Builder ─────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Dependencias nativas necesarias para sharp y pdf-parse en build
RUN apk add --no-cache python3 make g++ vips-dev

COPY package*.json ./
# Instalar TODAS las dependencias (incluyendo devDeps para compilar TS)
RUN npm install --legacy-peer-deps

COPY . .
RUN npm run build

# ─── STAGE 2: Production ──────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

# Dependencias del sistema para Tesseract.js, Sharp y OCR en español
RUN apk add --no-cache \
    tesseract-ocr \
    tesseract-ocr-data-spa \
    vips-dev \
    python3 \
    make \
    g++ \
    curl

COPY --from=builder /app/dist ./dist
COPY package*.json ./

# Instalar solo dependencias de producción
RUN npm ci --only=production --legacy-peer-deps

RUN mkdir -p uploads

EXPOSE 3001

CMD ["node", "dist/main"]

# ─── STAGE DEV: hot-reload ────────────────────────────────────
FROM node:20-alpine AS development

WORKDIR /app

RUN apk add --no-cache \
    tesseract-ocr \
    tesseract-ocr-data-spa \
    vips-dev \
    python3 \
    make \
    g++ \
    curl

COPY package*.json ./
RUN npm install --legacy-peer-deps

COPY . .

RUN mkdir -p uploads

EXPOSE 3001

CMD ["npm", "run", "start:dev"]
