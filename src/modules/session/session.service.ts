import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

// ══════════════════════════════════════════════════════════════
// SESSION SERVICE (US-21)
// Gestiona el contexto de conversación en Redis
// - Últimos N mensajes por número de teléfono (TTL: 24h)
// - Estado transaccional: ticketId activo, instalacionId activa
// - Estado de escalado al admin
// ══════════════════════════════════════════════════════════════

export interface SessionMessage {
  role: 'user' | 'bot' | 'admin';
  content: string;
  timestamp: number;
}

export interface SessionData {
  phoneNumber: string;
  clientId: string | null;
  clientName: string | null;
  clientStatus: string | null;   // 'Activo' | 'Suspendido' | 'Cancelado'
  planName: string | null;
  totalDebt: number;
  tbnCode: string | null;

  // Estado transaccional activo
  activeTicketId: string | null;
  activeInstallationId: string | null;
  pendingAction: string | null;
  pendingTechIssue: string | null;  // acción pendiente de confirmación

  // Control del bot
  isEscalated: boolean;
  ragFailCount: number;

  // Historial de contexto para RAG (últimos N mensajes)
  messages: SessionMessage[];
}

const DEFAULT_SESSION: Omit<SessionData, 'phoneNumber'> = {
  clientId: null,
  clientName: null,
  clientStatus: null,
  planName: null,
  totalDebt: 0,
  tbnCode: null,
  activeTicketId: null,
  activeInstallationId: null,
  pendingAction: null,
  pendingTechIssue: null,
  isEscalated: false,
  ragFailCount: 0,
  messages: [],
};

@Injectable()
export class SessionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionService.name);
  private redis: Redis;
  private readonly TTL: number;
  private readonly MAX_MESSAGES: number;
  private readonly PREFIX = 'session:';

  constructor(private readonly config: ConfigService) {
    this.TTL = config.get<number>('redis.sessionTtl');
    this.MAX_MESSAGES = config.get<number>('rag.contextMessages');
  }

  onModuleInit() {
    this.redis = new Redis({
      host: this.config.get<string>('redis.host'),
      port: this.config.get<number>('redis.port'),
      password: this.config.get<string>('redis.password') || undefined,
      db: this.config.get<number>('redis.db'),
      retryStrategy: (times) => Math.min(times * 100, 3000),
    });

    this.redis.on('connect', () => this.logger.log('Redis conectado'));
    this.redis.on('error', (err) => this.logger.error('Redis error', err.message));
  }

  onModuleDestroy() {
    this.redis?.disconnect();
  }

  private key(phone: string): string {
    return `${this.PREFIX}${phone}`;
  }

  // ─── GET: obtener sesión completa ─────────────────────────
  async getSession(phone: string): Promise<SessionData> {
    const raw = await this.redis.get(this.key(phone));
    if (!raw) {
      return { phoneNumber: phone, ...DEFAULT_SESSION };
    }
    return JSON.parse(raw);
  }

  // ─── SAVE: guardar sesión y refrescar TTL ─────────────────
  async saveSession(session: SessionData): Promise<void> {
    await this.redis.setex(
      this.key(session.phoneNumber),
      this.TTL,
      JSON.stringify(session),
    );
  }

  // ─── UPDATE PARTIAL: actualizar campos específicos ─────────
  async updateSession(phone: string, partial: Partial<SessionData>): Promise<SessionData> {
    const session = await this.getSession(phone);
    const updated = { ...session, ...partial };
    await this.saveSession(updated);
    return updated;
  }

  // ─── ADD MESSAGE: agregar mensaje al contexto ──────────────
  async addMessage(
    phone: string,
    role: 'user' | 'bot' | 'admin',
    content: string,
  ): Promise<void> {
    const session = await this.getSession(phone);
    const msg: SessionMessage = { role, content, timestamp: Date.now() };

    session.messages.push(msg);

    // Mantener solo los últimos N mensajes
    if (session.messages.length > this.MAX_MESSAGES) {
      session.messages = session.messages.slice(-this.MAX_MESSAGES);
    }

    await this.saveSession(session);
  }

  // ─── SET CLIENT: identificar cliente ──────────────────────
  async setClientData(
    phone: string,
    data: {
      clientId: string;
      clientName: string;
      clientStatus: string;
      planName: string;
      totalDebt: number;
      tbnCode: string;
    },
  ): Promise<void> {
    await this.updateSession(phone, data);
  }

  // ─── ESCALATE: marcar conversación como escalada ──────────
  async escalate(phone: string): Promise<void> {
    await this.updateSession(phone, { isEscalated: true });
  }

  // ─── DEESCALATE: devolver control al bot ──────────────────
  async deescalate(phone: string): Promise<void> {
    await this.updateSession(phone, {
      isEscalated: false,
      ragFailCount: 0,
    });
  }

  // ─── INCREMENT RAG FAIL: contador de intentos fallidos ────
  async incrementRagFail(phone: string): Promise<number> {
    const session = await this.getSession(phone);
    const count = session.ragFailCount + 1;
    await this.updateSession(phone, { ragFailCount: count });
    return count;
  }

  // ─── RESET RAG FAIL: limpiar contador tras éxito ──────────
  async resetRagFail(phone: string): Promise<void> {
    await this.updateSession(phone, { ragFailCount: 0 });
  }

  // ─── SET PENDING ACTION: acción pendiente de confirmación ─
  async setPendingAction(phone: string, action: string | null): Promise<void> {
    await this.updateSession(phone, { pendingAction: action });
  }

  // ─── GET CONTEXT TEXT: texto de contexto para RAG ─────────
  async getContextText(phone: string): Promise<string> {
    const session = await this.getSession(phone);
    return session.messages
      .map((m) => `${m.role === 'user' ? 'Cliente' : 'Bot'}: ${m.content}`)
      .join('\n');
  }

  // ─── DELETE: limpiar sesión ────────────────────────────────
  async deleteSession(phone: string): Promise<void> {
    await this.redis.del(this.key(phone));
  }
}
