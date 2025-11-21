import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';

// ══════════════════════════════════════════════════════════════
// SESSION SERVICE — ACTUALIZADO (US-AI-09)
//
// Cambios respecto a la versión anterior:
//  - messages: SessionMessage[] conservado para compatibilidad
//  - getGeminiHistory() convierte al formato contents[] de Gemini
//  - MAX_MESSAGES sube de 5 a 20 (RAG_CONTEXT_MESSAGES)
//  - ragLastFailAt: ventana temporal de 10 min para ragFailCount
//  - lastSentiment: estado emocional detectado del cliente
//  - ratingSent: evita enviar encuesta más de una vez por sesión
// ══════════════════════════════════════════════════════════════

export interface SessionMessage {
  role: 'user' | 'bot' | 'admin';
  content: string;
  timestamp: number;
}

// Formato nativo de Gemini para el historial de conversación
export interface GeminiContent {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

export interface SessionData {
  phoneNumber: string;
  clientId: string | null;
  clientName: string | null;
  clientStatus: string | null;   // 'Activo' | 'Suspendido' | 'Cancelado'
  planId: string | null;
  planName: string | null;
  totalDebt: number;
  tbnCode: string | null;

  // Estado transaccional
  activeTicketId: string | null;
  activeInstallationId: string | null;
  pendingAction: string | null;
  pendingTechIssue: string | null;

  // Control del bot
  isEscalated: boolean;
  ragFailCount: number;
  ragLastFailAt: number;         // timestamp ms — ventana de 10 min para ragFailCount

  // Inteligencia emocional
  lastSentiment: 'neutral' | 'frustrated' | 'angry' | 'happy';
  angryCount: number;            // mensajes consecutivos con sentimiento 'angry'

  // Experiencia
  ratingSent: boolean;           // encuesta de satisfacción ya enviada en esta sesión

  // Última ubicación enviada por el cliente (F2)
  lastLocation: { lat: number; lng: number; name?: string; address?: string } | null;

  // Imagen pendiente de clasificar (imageId de Meta, se descarga cuando el usuario aclara el tipo)
  pendingImageId: string | null;
  pendingImageCaption: string | null;

  // Historial de conversación (últimos N mensajes)
  messages: SessionMessage[];
}

const DEFAULT_SESSION: Omit<SessionData, 'phoneNumber'> = {
  clientId: null,
  clientName: null,
  clientStatus: null,
  planId: null,
  planName: null,
  totalDebt: 0,
  tbnCode: null,
  activeTicketId: null,
  activeInstallationId: null,
  pendingAction: null,
  pendingTechIssue: null,
  isEscalated: false,
  ragFailCount: 0,
  ragLastFailAt: 0,
  lastSentiment: 'neutral',
  angryCount: 0,
  ratingSent: false,
  lastLocation: null,
  pendingImageId: null,
  pendingImageCaption: null,
  messages: [],
};

@Injectable()
export class SessionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionService.name);
  private redis: Redis;
  private readonly TTL: number;
  private readonly MAX_MESSAGES: number;
  private readonly RAG_FAIL_WINDOW_MS: number;
  private readonly PREFIX = 'session:';
  private readonly LOCK_PREFIX = 'session:lock:';
  private readonly LOCK_TTL_MS = 5000;

  // Lua: acquires lock atomically (SET NX PX)
  private static readonly LUA_ACQUIRE = `
    return redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2])
  `;

  // Lua: releases lock only if the token matches (prevents releasing another owner's lock)
  private static readonly LUA_RELEASE = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('DEL', KEYS[1])
    else
      return 0
    end
  `;

  // Lua: atomically merges a partial patch into the session without a distributed lock.
  // Reads current session, merges patch fields, writes back — all in one atomic operation.
  // Falls back to ARGV[2] (JSON-serialized DEFAULT_SESSION) if the key doesn't exist yet.
  // Preserves TTL: uses remaining TTL if key exists, otherwise falls back to ARGV[3].
  private static readonly LUA_PATCH = `
    local raw = redis.call('GET', KEYS[1])
    local ttl = redis.call('TTL', KEYS[1])
    if ttl < 1 then ttl = tonumber(ARGV[3]) end
    local sess
    if raw then
      sess = cjson.decode(raw)
    else
      sess = cjson.decode(ARGV[2])
    end
    local patch = cjson.decode(ARGV[1])
    for k, v in pairs(patch) do
      sess[k] = v
    end
    return redis.call('SET', KEYS[1], cjson.encode(sess), 'EX', ttl)
  `;

  constructor(private readonly config: ConfigService) {
    this.TTL          = config.get<number>('redis.sessionTtl') ?? 86400;
    this.MAX_MESSAGES = config.get<number>('rag.contextMessages') ?? 20;
    const windowMin   = config.get<number>('rag.failWindowMinutes') ?? 10;
    this.RAG_FAIL_WINDOW_MS = windowMin * 60 * 1000;
  }

  onModuleInit() {
    this.redis = new Redis({
      host:     this.config.get<string>('redis.host'),
      port:     this.config.get<number>('redis.port'),
      password: this.config.get<string>('redis.password') || undefined,
      db:       this.config.get<number>('redis.db'),
      retryStrategy: (times) => Math.min(times * 100, 3000),
    });

    this.redis.on('connect', () => this.logger.log('Redis conectado'));
    this.redis.on('error',   (err) => this.logger.error('Redis error', err.message));
  }

  onModuleDestroy() { this.redis?.disconnect(); }

  private key(phone: string): string { return `${this.PREFIX}${phone}`; }
  private lockKey(phone: string): string { return `${this.LOCK_PREFIX}${phone}`; }

  // Ejecuta fn dentro de un lock distribuido por número de teléfono.
  // Reintenta hasta 10 veces con backoff de 50ms antes de rendir.
  async withLock<T>(phone: string, fn: () => Promise<T>): Promise<T> {
    const token = randomUUID();
    const lockK = this.lockKey(phone);
    const maxRetries = 10;
    const retryMs = 50;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const acquired = await this.redis.eval(
        SessionService.LUA_ACQUIRE,
        1,
        lockK,
        token,
        String(this.LOCK_TTL_MS),
      );

      if (acquired === 'OK') {
        try {
          return await fn();
        } finally {
          await this.redis.eval(SessionService.LUA_RELEASE, 1, lockK, token);
        }
      }

      await new Promise(r => setTimeout(r, retryMs));
    }

    this.logger.warn(`No se pudo adquirir lock para ${phone} en ${maxRetries} intentos — ejecutando sin lock`);
    return fn();
  }

  // ─── GET ──────────────────────────────────────────────────
  async getSession(phone: string): Promise<SessionData> {
    const raw = await this.redis.get(this.key(phone));
    if (!raw) return { phoneNumber: phone, ...DEFAULT_SESSION, messages: [] };
    try {
      const parsed = JSON.parse(raw) as SessionData;
      // Migración en caliente: rellenar campos nuevos en sesiones antiguas
      return { ...DEFAULT_SESSION, phoneNumber: phone, ...parsed };
    } catch {
      this.logger.warn(`Sesión corrupta para ${phone} — reiniciando`);
      return { phoneNumber: phone, ...DEFAULT_SESSION, messages: [] };
    }
  }

  // ─── SAVE ─────────────────────────────────────────────────
  async saveSession(session: SessionData): Promise<void> {
    await this.redis.setex(this.key(session.phoneNumber), this.TTL, JSON.stringify(session));
  }

  // ─── UPDATE PARTIAL ───────────────────────────────────────
  async updateSession(phone: string, partial: Partial<SessionData>): Promise<SessionData> {
    return this.withLock(phone, async () => {
      const session = await this.getSession(phone);
      const updated = { ...session, ...partial };
      await this.saveSession(updated);
      return updated;
    });
  }

  // ─── PATCH ATOMIC (Lua) ───────────────────────────────────
  // Merges only the given fields atomically using a Lua script — no distributed lock needed.
  // Suitable for fire-and-forget field updates (e.g. clientId, ragFailCount) where the
  // caller doesn't need to read the full session first.
  // For updates that depend on reading existing state, use updateSession (which uses withLock).
  async patchSession(phone: string, patch: Partial<SessionData>): Promise<void> {
    const defaultJson = JSON.stringify({ phoneNumber: phone, ...DEFAULT_SESSION });
    await this.redis.eval(
      SessionService.LUA_PATCH,
      1,
      this.key(phone),
      JSON.stringify(patch),
      defaultJson,
      String(this.TTL),
    );
  }

  // ─── ADD MESSAGE ──────────────────────────────────────────
  async addMessage(phone: string, role: 'user' | 'bot' | 'admin', content: string): Promise<void> {
    await this.withLock(phone, async () => {
      const session = await this.getSession(phone);
      session.messages.push({ role, content, timestamp: Date.now() });
      if (session.messages.length > this.MAX_MESSAGES) {
        session.messages = session.messages.slice(-this.MAX_MESSAGES);
      }
      await this.saveSession(session);
    });
  }

  // ─── GET GEMINI HISTORY ──────────────────────────────────
  // Convierte messages[] al formato contents[] que espera Gemini:
  //   user  → role: 'user'
  //   bot / admin → role: 'model'
  async getGeminiHistory(phone: string): Promise<GeminiContent[]> {
    const session = await this.getSession(phone);
    return session.messages.map((m): GeminiContent => ({
      role:  m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.content }],
    }));
  }

  // ─── GET CONTEXT TEXT (para RAG legacy) ──────────────────
  async getContextText(phone: string): Promise<string> {
    const session = await this.getSession(phone);
    return session.messages
      .map(m => `${m.role === 'user' ? 'Cliente' : 'Bot'}: ${m.content}`)
      .join('\n');
  }

  // ─── SET CLIENT DATA ──────────────────────────────────────
  async setClientData(phone: string, data: {
    clientId: string; clientName: string; clientStatus: string;
    planId: string; planName: string; totalDebt: number; tbnCode: string;
  }): Promise<void> {
    await this.updateSession(phone, data);
  }

  // ─── ESCALATE / DEESCALATE ────────────────────────────────
  async escalate(phone: string): Promise<void> {
    await this.updateSession(phone, { isEscalated: true });
  }

  async deescalate(phone: string): Promise<void> {
    await this.updateSession(phone, {
      isEscalated: false,
      ragFailCount: 0,
      ragLastFailAt: 0,
      angryCount: 0,
    });
  }

  // ─── RAG FAIL CON VENTANA TEMPORAL ───────────────────────
  // Si el último fallo fue hace más de RAG_FAIL_WINDOW_MS, se reinicia
  // el contador — así 2 preguntas fuera de contexto separadas por horas
  // no causan escalación automática.
  async incrementRagFail(phone: string): Promise<number> {
    return this.withLock(phone, async () => {
      const session = await this.getSession(phone);
      const now     = Date.now();
      const elapsed = now - (session.ragLastFailAt ?? 0);
      const count   = elapsed > this.RAG_FAIL_WINDOW_MS ? 1 : session.ragFailCount + 1;
      const updated = { ...session, ragFailCount: count, ragLastFailAt: now };
      await this.saveSession(updated);
      return count;
    });
  }

  async resetRagFail(phone: string): Promise<void> {
    await this.updateSession(phone, { ragFailCount: 0, ragLastFailAt: 0 });
  }

  // ─── SENTIMIENTO ──────────────────────────────────────────
  async updateSentiment(
    phone: string,
    sentiment: 'neutral' | 'frustrated' | 'angry' | 'happy',
  ): Promise<void> {
    await this.withLock(phone, async () => {
      const session    = await this.getSession(phone);
      const angryCount = sentiment === 'angry' ? (session.angryCount ?? 0) + 1 : 0;
      await this.saveSession({ ...session, lastSentiment: sentiment, angryCount });
    });
  }

  // ─── PENDING ACTION ───────────────────────────────────────
  async setPendingAction(phone: string, action: string | null): Promise<void> {
    await this.updateSession(phone, { pendingAction: action });
  }

  // ─── DELETE ───────────────────────────────────────────────
  async deleteSession(phone: string): Promise<void> {
    await this.redis.del(this.key(phone));
  }

}
