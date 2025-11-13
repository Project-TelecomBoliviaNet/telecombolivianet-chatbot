import { registerAs } from '@nestjs/config';

// ─── Validación obligatoria al arrancar ───────────────────────
// Lanza si faltan variables críticas para que el contenedor falle
// en startup con un mensaje claro, en lugar de fallar silenciosamente
// en el primer request.
export function validateConfig(config: Record<string, unknown>): Record<string, unknown> {
  const required = [
    'META_APP_SECRET',
    'META_PHONE_NUMBER_ID',
    'META_ACCESS_TOKEN',
  ];
  const missing = required.filter(k => !config[k]);
  if (missing.length > 0) {
    throw new Error(
      `Variables de entorno faltantes al iniciar el chatbot: ${missing.join(', ')}. ` +
      `La aplicación no puede iniciarse sin estas variables.`,
    );
  }
  return config;
}

function parseIntSafe(value: string | undefined, fallback: number): number {
  const n = parseInt(value ?? '', 10);
  return isNaN(n) ? fallback : n;
}

function parseFloatSafe(value: string | undefined, fallback: number): number {
  const n = parseFloat(value ?? '');
  return isNaN(n) ? fallback : n;
}

// ─── APP ──────────────────────────────────────────────────────
export const appConfig = registerAs('app', () => ({
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseIntSafe(process.env.PORT, 3001),
  name: process.env.APP_NAME || 'bolivianet-chatbot',
}));

// ─── BASE DE DATOS ────────────────────────────────────────────
export const databaseConfig = registerAs('database', () => ({
  host: process.env.DB_HOST || 'localhost',
  port: parseIntSafe(process.env.DB_PORT, 5432),
  username: process.env.DB_USERNAME || 'chatbot_user',
  password: process.env.DB_PASSWORD || 'chatbot_secret',
  database: process.env.DB_DATABASE || 'chatbot_db',
  synchronize: process.env.DB_SYNCHRONIZE === 'true',
  logging: process.env.DB_LOGGING === 'true',
}));

// ─── REDIS ────────────────────────────────────────────────────
export const redisConfig = registerAs('redis', () => ({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseIntSafe(process.env.REDIS_PORT, 6379),
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseIntSafe(process.env.REDIS_DB, 0),
  sessionTtl: parseIntSafe(process.env.REDIS_SESSION_TTL, 86400),
}));

// ─── SISTEMA CENTRAL C# ───────────────────────────────────────
export const sistemaConfig = registerAs('sistema', () => ({
  apiUrl: process.env.SISTEMA_API_URL || 'http://localhost:5000',
  botEmail: process.env.SISTEMA_BOT_EMAIL || 'bot@telecombolivianet.bo',
  botPassword: process.env.SISTEMA_BOT_PASSWORD || '',
  jwtRefreshMarginMinutes: parseIntSafe(process.env.SISTEMA_JWT_REFRESH_MARGIN_MINUTES, 60),
  // Token estático usado por MonitorController y AdminSignalrNotifier
  // para autenticar requests internos (panel admin → bot y bot → sistema)
  botStaticToken: process.env.SISTEMA_BOT_STATIC_TOKEN || '',
}));

// ─── META CLOUD API ───────────────────────────────────────────
export const metaConfig = registerAs('meta', () => ({
  verifyToken: process.env.META_VERIFY_TOKEN || '',
  appSecret: process.env.META_APP_SECRET || '',
  accessToken: process.env.META_ACCESS_TOKEN || '',
  phoneNumberId: process.env.META_PHONE_NUMBER_ID || '',
  wabaId: process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID || '',
  apiVersion: process.env.META_API_VERSION || 'v18.0',
  apiUrl: process.env.META_API_URL || 'https://graph.facebook.com',
}));

// ─── GEMINI ───────────────────────────────────────────────────
export const geminiConfig = registerAs('gemini', () => ({
  apiKey:             process.env.GEMINI_API_KEY || '',
  chatModel:          process.env.GEMINI_CHAT_MODEL  || 'gemini-2.0-flash',
  embedModel:         process.env.GEMINI_EMBED_MODEL || 'text-embedding-004',
  maxTokens:          parseIntSafe(process.env.GEMINI_MAX_TOKENS, 512),
  temperature:        parseFloatSafe(process.env.GEMINI_TEMPERATURE, 0.3),
  // JSON de cuenta de servicio para Vertex AI (Google Cloud billing)
  // Si está vacío, se usa API key con AI Studio billing
  serviceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
  // Región de Vertex AI (default: us-central1)
  location:           process.env.GEMINI_LOCATION || 'us-central1',
}));

// ─── RAG ──────────────────────────────────────────────────────
export const ragConfig = registerAs('rag', () => ({
  similarityThreshold: parseFloatSafe(process.env.RAG_SIMILARITY_THRESHOLD, 0.75),
  contextMessages:     parseIntSafe(process.env.RAG_CONTEXT_MESSAGES, 20),
  maxChunks:           parseIntSafe(process.env.RAG_MAX_CHUNKS, 3),
  failWindowMinutes:   parseIntSafe(process.env.RAG_FAIL_WINDOW_MINUTES, 10),

  // Caché semántica — reduce llamadas a Gemini para preguntas repetitivas
  cacheEnabled:     process.env.RAG_CACHE_ENABLED !== 'false',
  cacheSimilarity:  parseFloatSafe(process.env.RAG_CACHE_SIMILARITY, 0.92),
  cacheTtlDefaultH: parseIntSafe(process.env.RAG_CACHE_TTL_DEFAULT_H, 24),
  cacheTtlPricingH: parseIntSafe(process.env.RAG_CACHE_TTL_PRICING_H, 6),
  cacheTtlStaticH:  parseIntSafe(process.env.RAG_CACHE_TTL_STATIC_H, 168),
}));

// ─── ALMACENAMIENTO ───────────────────────────────────────────
export const storageConfig = registerAs('storage', () => ({
  // 'local' | 'supabase'  — default: local (backward-compatible)
  type: process.env.STORAGE_TYPE || 'local',
  localPath: process.env.STORAGE_LOCAL_PATH || './uploads',
  // URL base pública para construir la URL de los archivos en modo local.
  publicUrl: process.env.STORAGE_PUBLIC_URL || '',
  supabase: {
    url:    (process.env.SUPABASE_URL    || '').replace(/\/$/, ''),
    key:     process.env.SUPABASE_ANON_KEY || '',
    bucket:  process.env.SUPABASE_STORAGE_BUCKET || 'chatbot-uploads',
  },
  minio: {
    endpoint: process.env.MINIO_ENDPOINT || 'localhost',
    port: parseIntSafe(process.env.MINIO_PORT, 9000),
    useSsl: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY || '',
    secretKey: process.env.MINIO_SECRET_KEY || '',
    bucket: process.env.MINIO_BUCKET || 'chatbot-comprobantes',
  },
}));

// ─── BOT ──────────────────────────────────────────────────────
export const botConfig = registerAs('bot', () => ({
  maxRagAttempts: parseIntSafe(process.env.BOT_MAX_RAG_ATTEMPTS, 2),
  installationDaysAhead: parseIntSafe(process.env.BOT_INSTALLATION_DAYS_AHEAD, 7),
}));

// ─── RATE LIMITING ────────────────────────────────────────────
export const rateLimitConfig = registerAs('rateLimit', () => ({
  // Número máximo de mensajes por número de teléfono dentro de la ventana
  windowSeconds: parseIntSafe(process.env.RATE_LIMIT_WINDOW_SECONDS, 60),
  maxRequests:   parseIntSafe(process.env.RATE_LIMIT_MAX_REQUESTS, 20),
}));

// ─── SISTEMA (extendido con token estático para monitor) ──────
// Nota: sistemaConfig ya existe arriba; esta extensión agrega
// botStaticToken que usa el MonitorController y AdminSignalrNotifier.
// Se resuelve inyectando en sistemaConfig directamente.
// (Ver línea botStaticToken en sistemaConfig arriba → se añade abajo)
