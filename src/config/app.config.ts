import { registerAs } from '@nestjs/config';

// ─── APP ──────────────────────────────────────────────────────
export const appConfig = registerAs('app', () => ({
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 3001,
  name: process.env.APP_NAME || 'bolivianet-chatbot',
  httpTimeoutMs: parseInt(process.env.HTTP_TIMEOUT_MS, 10) || 10000,
}));

// ─── BASE DE DATOS ────────────────────────────────────────────
export const databaseConfig = registerAs('database', () => ({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT, 10) || 5432,
  username: process.env.DB_USERNAME || 'chatbot_user',
  password: process.env.DB_PASSWORD || 'chatbot_secret',
  database: process.env.DB_DATABASE || 'chatbot_db',
  synchronize: process.env.DB_SYNCHRONIZE === 'true',
  logging: process.env.DB_LOGGING === 'true',
}));

// ─── REDIS ────────────────────────────────────────────────────
export const redisConfig = registerAs('redis', () => ({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT, 10) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB, 10) || 0,
  sessionTtl: parseInt(process.env.REDIS_SESSION_TTL, 10) || 86400,
}));

// ─── SISTEMA CENTRAL C# ───────────────────────────────────────
export const sistemaConfig = registerAs('sistema', () => ({
  apiUrl: process.env.SISTEMA_API_URL || 'http://localhost:5000',
  botEmail: process.env.SISTEMA_BOT_EMAIL || 'bot@telecombolivianet.bo',
  botPassword: process.env.SISTEMA_BOT_PASSWORD || '',
  jwtRefreshMarginMinutes: parseInt(process.env.SISTEMA_JWT_REFRESH_MARGIN_MINUTES, 10) || 60,
  botStaticToken: process.env.SISTEMA_BOT_STATIC_TOKEN || '',
}));

// ─── META CLOUD API ───────────────────────────────────────────
export const metaConfig = registerAs('meta', () => ({
  verifyToken: process.env.META_VERIFY_TOKEN || '',
  accessToken: process.env.META_ACCESS_TOKEN || '',
  phoneNumberId: process.env.META_PHONE_NUMBER_ID || '',
  wabaId: process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID || '',
  apiVersion: process.env.META_API_VERSION || 'v18.0',
  apiUrl: process.env.META_API_URL || 'https://graph.facebook.com',
}));

// ─── GOOGLE GEMINI API ────────────────────────────────────────
// Reemplaza la configuración de Ollama.
//
// Modelos recomendados:
//   intentModel: gemini-2.0-flash   (rápido, barato, plan gratuito)
//   embedModel:  text-embedding-004  (768 dims, gratuito)
//   ragModel:    gemini-2.0-flash   (respuestas RAG, mismo modelo)
//
// Alternativas si superas el plan gratuito:
//   gemini-1.5-flash → mayor contexto, costo similar
//   gemini-1.5-pro   → mejor calidad, más costoso
//
// Obtén tu API key gratis en: https://aistudio.google.com/app/apikey
export const geminiConfig = registerAs('gemini', () => ({
  apiKey:       process.env.GEMINI_API_KEY || '',
  intentModel:  process.env.GEMINI_INTENT_MODEL  || 'gemini-2.0-flash',
  embedModel:   process.env.GEMINI_EMBED_MODEL   || 'text-embedding-004',
  ragModel:     process.env.GEMINI_RAG_MODEL     || 'gemini-2.0-flash',
  maxTokens:    parseInt(process.env.GEMINI_MAX_TOKENS, 10)     || 512,
  temperature:  parseFloat(process.env.GEMINI_TEMPERATURE)      || 0.3,
}));

// ─── RAG ──────────────────────────────────────────────────────
export const ragConfig = registerAs('rag', () => ({
  similarityThreshold: parseFloat(process.env.RAG_SIMILARITY_THRESHOLD) || 0.75,
  contextMessages:     parseInt(process.env.RAG_CONTEXT_MESSAGES, 10) || 5,
  maxChunks:           parseInt(process.env.RAG_MAX_CHUNKS, 10) || 3,
  // Timeout en ms para la reformulación de queries (US-EP02-01).
  // Si Gemini tarda más que esto, se usa la query original sin reformular.
  // Default: 3000ms. Mínimo recomendado: 1000ms.
  reformulationTimeoutMs: parseInt(process.env.RAG_REFORMULATION_TIMEOUT_MS, 10) || 3_000,
  // Umbral de similitud coseno para que una FAQ se considere matching.
  // 0.85 = solo coincidencias muy precisas. Bajar a 0.80 si hay pocas FAQs.
  faqSimilarityThreshold: parseFloat(process.env.FAQ_SIMILARITY_THRESHOLD) || 0.85,
}));

// ─── ALMACENAMIENTO ───────────────────────────────────────────
export const storageConfig = registerAs('storage', () => ({
  type: process.env.STORAGE_TYPE || 'local',
  localPath: process.env.STORAGE_LOCAL_PATH || './uploads',
  minio: {
    endpoint: process.env.MINIO_ENDPOINT || 'localhost',
    port: parseInt(process.env.MINIO_PORT, 10) || 9000,
    useSsl: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
    bucket: process.env.MINIO_BUCKET || 'chatbot-comprobantes',
  },
}));

// ─── BOT ──────────────────────────────────────────────────────
export const botConfig = registerAs('bot', () => ({
  maxRagAttempts: parseInt(process.env.BOT_MAX_RAG_ATTEMPTS, 10) || 2,
  installationDaysAhead: parseInt(process.env.BOT_INSTALLATION_DAYS_AHEAD, 10) || 7,
}));

// ─── RATE LIMITING ────────────────────────────────────────────
export const rateLimitConfig = registerAs('rateLimit', () => ({
  windowSeconds: parseInt(process.env.RATE_LIMIT_WINDOW_SECONDS, 10) || 60,
  maxRequests:   parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10)   || 20,
}));

// ─── SEGURIDAD / SEUDONIMIZACIÓN ──────────────────────────────
//
// pseudonymTtlSeconds:
//   TTL de la tabla de correspondencia token↔valor en Redis.
//   Valor corto = menor ventana de exposición si Redis es comprometido.
//   Debe ser mayor que el tiempo máximo de respuesta de Gemini (p95 ~10s).
//   Default: 300s (5 minutos).
//
// piiGuardMode:
//   'permissive' → alerta en logs pero no bloquea (recomendado al inicio).
//   'strict'     → bloquea la llamada a Gemini si detecta PII sin seudonimizar.
//   Cambiar a 'strict' cuando PseudonymService esté integrado en todos los flujos.
export const securityConfig = registerAs('security', () => ({
  pseudonymTtlSeconds: parseInt(process.env.PSEUDONYM_TTL_SECONDS, 10) || 300,
  piiGuardMode:        process.env.PII_GUARD_MODE || 'permissive',
}));
