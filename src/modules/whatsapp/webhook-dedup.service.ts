import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

// ══════════════════════════════════════════════════════════════
// WEBHOOK DEDUP SERVICE — FIX-10
//
// Meta reintenta webhooks si no recibe 200 en < 20 segundos.
// Este servicio marca cada messageId como procesado con SET NX
// para que el reintento sea ignorado (responde 200 sin reejecutar).
// TTL de 5 minutos: Meta no reintenta más allá de ese tiempo.
// ══════════════════════════════════════════════════════════════

@Injectable()
export class WebhookDedupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookDedupService.name);
  private redis: Redis;

  private static readonly PREFIX  = 'webhook_dedup:';
  private static readonly TTL_SEC = 300; // 5 minutos — ventana de reintentos de Meta

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.redis = new Redis({
      host:          this.config.get<string>('redis.host'),
      port:          this.config.get<number>('redis.port'),
      password:      this.config.get<string>('redis.password') || undefined,
      db:            this.config.get<number>('redis.db'),
      retryStrategy: (times) => Math.min(times * 100, 3000),
    });
    this.redis.on('error', (err) =>
      this.logger.error('Redis error (dedup)', err.message));
  }

  onModuleDestroy(): void {
    this.redis?.disconnect();
  }

  /**
   * Intenta marcar el messageId como procesado de forma atómica.
   * @returns `true` si el mensaje YA fue procesado antes (duplicado), `false` si es nuevo.
   */
  async isDuplicate(messageId: string): Promise<boolean> {
    const key = `${WebhookDedupService.PREFIX}${messageId}`;
    // SET key '1' NX EX ttl — retorna 'OK' si se creó, null si ya existía
    const result = await this.redis.set(key, '1', 'EX', WebhookDedupService.TTL_SEC, 'NX');
    return result === null; // null = ya existía = duplicado
  }
}
