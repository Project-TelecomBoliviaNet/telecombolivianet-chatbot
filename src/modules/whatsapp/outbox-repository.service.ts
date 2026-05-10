import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

// ══════════════════════════════════════════════════════════════
// OUTBOX REPOSITORY SERVICE
//
// Responsabilidad única: persistir y recuperar mensajes del
// outbox de WhatsApp en Redis.
//
// Extraído de SessionService (SRP): el outbox de mensajes no es
// parte del estado de sesión de usuario — es un mecanismo de
// entrega de mensajes.
//
// Usado por WhatsappOutboxService para la lógica de reintentos.
// ══════════════════════════════════════════════════════════════

export interface OutboxEntry {
  text:          string;
  attempts:      number;
  addedAt:       number;
  processingAt?: number;
}

const OUTBOX_TTL_SECONDS   = 1800; // 30 min
const PROCESSING_STALE_MS  = 60_000;
const KEY_PREFIX           = 'wa:outbox:';

@Injectable()
export class OutboxRepositoryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRepositoryService.name);
  private redis: Redis;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.redis = new Redis({
      host:     this.config.get<string>('redis.host'),
      port:     this.config.get<number>('redis.port'),
      password: this.config.get<string>('redis.password') || undefined,
      db:       this.config.get<number>('redis.db'),
      retryStrategy: (times) => Math.min(times * 100, 3000),
    });
    this.redis.on('error', (err) => this.logger.error('OutboxRedis error', err.message));
  }

  onModuleDestroy(): void { this.redis?.disconnect(); }

  private key(phone: string): string { return `${KEY_PREFIX}${phone}`; }

  async push(phone: string, text: string): Promise<void> {
    const entry: OutboxEntry = { text, attempts: 0, addedAt: Date.now() };
    await this.redis.setex(this.key(phone), OUTBOX_TTL_SECONDS, JSON.stringify(entry));
  }

  async get(phone: string): Promise<OutboxEntry | null> {
    const raw = await this.redis.get(this.key(phone));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as OutboxEntry;
    } catch {
      this.logger.warn(`Outbox corrupto para ${phone} — descartando`);
      await this.redis.del(this.key(phone));
      return null;
    }
  }

  async markAsProcessing(phone: string): Promise<boolean> {
    const entry = await this.get(phone);
    if (!entry) return false;
    if (entry.processingAt && Date.now() - entry.processingAt < PROCESSING_STALE_MS) {
      return false;
    }
    const ttl = Math.max(await this.redis.ttl(this.key(phone)), 60);
    await this.redis.setex(this.key(phone), ttl, JSON.stringify({ ...entry, processingAt: Date.now() }));
    return true;
  }

  async revertToPending(phone: string): Promise<void> {
    const entry = await this.get(phone);
    if (!entry) return;
    const ttl = Math.max(await this.redis.ttl(this.key(phone)), 60);
    await this.redis.setex(this.key(phone), ttl, JSON.stringify({ ...entry, processingAt: undefined }));
  }

  async remove(phone: string): Promise<void> {
    await this.redis.del(this.key(phone));
  }

  async incrementAttempts(phone: string): Promise<void> {
    const entry = await this.get(phone);
    if (!entry) return;
    const ttl = Math.max(await this.redis.ttl(this.key(phone)), 60);
    await this.redis.setex(this.key(phone), ttl, JSON.stringify({ ...entry, attempts: entry.attempts + 1 }));
  }

  async getAllPhones(): Promise<string[]> {
    const keys = await this.redis.keys(`${KEY_PREFIX}*`);
    return keys.map(k => k.replace(KEY_PREFIX, ''));
  }
}
