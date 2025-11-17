import {
  Injectable,
  NestMiddleware,
  Logger,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response, NextFunction } from 'express';
import Redis from 'ioredis';
import { WhatsappApiService } from '../../modules/whatsapp/whatsapp-api.service';

// ══════════════════════════════════════════════════════════════
// RATE LIMITER MIDDLEWARE — por número de teléfono
//
// Implementa un sliding-window counter en Redis.
// Se aplica sobre el webhook de WhatsApp para evitar que un
// número abuse del bot (flood de mensajes, bots externos, etc.)
//
// Configuración (variables de entorno):
//   RATE_LIMIT_WINDOW_SECONDS  (default: 60)
//   RATE_LIMIT_MAX_REQUESTS    (default: 20)
//
// Si el número supera el límite → 429 con Retry-After header.
// Si Redis no está disponible → deja pasar (fail open).
// ══════════════════════════════════════════════════════════════

export interface RateLimitConfig {
  windowSeconds: number;
  maxRequests: number;
}

@Injectable()
export class PhoneRateLimiterMiddleware implements NestMiddleware {
  private readonly logger = new Logger(PhoneRateLimiterMiddleware.name);
  private redis: Redis;
  private readonly config: RateLimitConfig;

  constructor(
    private readonly configService: ConfigService,
    private readonly whatsapp: WhatsappApiService,
  ) {
    this.config = {
      windowSeconds: configService.get<number>('rateLimit.windowSeconds') ?? 60,
      maxRequests:   configService.get<number>('rateLimit.maxRequests')   ?? 20,
    };

    // Reutilizamos la misma instancia Redis del config de sesión
    this.redis = new Redis({
      host:         configService.get<string>('redis.host'),
      port:         configService.get<number>('redis.port'),
      password:     configService.get<string>('redis.password') || undefined,
      db:           configService.get<number>('redis.db'),
      retryStrategy: (times) => Math.min(times * 200, 5000),
      lazyConnect:  true,   // conecta al primer uso
    });

    this.redis.on('error', (err: Error) =>
      this.logger.warn(`Redis rate-limiter error: ${err.message}`),
    );
  }

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    // Extraer número de teléfono del cuerpo del webhook de WhatsApp
    const phone = this.extractPhone(req.body);

    if (!phone) {
      next();
      return;
    }

    try {
      const allowed = await this.checkLimit(phone);

      if (!allowed) {
        this.logger.warn(`Rate limit excedido para ${phone}`);
        // Notificar al usuario una sola vez por ventana de rate limit (DIP)
        await this.sendRateLimitNotification(phone);
        res
          .status(HttpStatus.TOO_MANY_REQUESTS)
          .set('Retry-After', String(this.config.windowSeconds))
          .json({
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: 'Demasiados mensajes. Por favor espera un momento.',
          });
        return;
      }
    } catch (err: unknown) {
      // Fail open: si Redis falla, no bloqueamos el bot
      this.logger.warn(`Rate limiter Redis error (fail open): ${(err as Error).message}`);
    }

    next();
  }

  // ─── Algoritmo: sliding window con INCR + EXPIRE ──────────
  async checkLimit(phone: string): Promise<boolean> {
    const key = `rl:${phone}`;

    // Pipeline atómico: incrementar y establecer TTL si es nuevo
    const pipeline = this.redis.pipeline();
    pipeline.incr(key);
    pipeline.ttl(key);

    const results = await pipeline.exec();

    const count = results?.[0]?.[1] as number;
    const ttl   = results?.[1]?.[1] as number;

    // Si la clave acaba de crearse (ttl = -1), establecer expiración
    if (ttl === -1) {
      await this.redis.expire(key, this.config.windowSeconds);
    }

    return count <= this.config.maxRequests;
  }

  // ─── Notificación al usuario (una sola vez por ventana) ───
  // Usa una clave Redis "rl:notified:{phone}" para no spamear.
  private async sendRateLimitNotification(phone: string): Promise<void> {
    const notifiedKey = `rl:notified:${phone}`;
    try {
      const alreadyNotified = await this.redis.set(
        notifiedKey, '1', 'EX', this.config.windowSeconds, 'NX',
      );
      if (alreadyNotified !== 'OK') return; // ya se notificó en esta ventana

      await this.whatsapp.sendText(
        phone,
        '⏳ Estás enviando muchos mensajes seguidos. ' +
        'Por favor espera un momento antes de continuar.',
      );
    } catch (err: unknown) {
      // Fire-and-forget: no bloquear el 429 si WhatsApp falla
      this.logger.warn(`No se pudo enviar notif. rate limit a ${phone}: ${(err as Error).message}`);
    }
  }

  // ─── Extraer teléfono del cuerpo del webhook Meta ─────────
  private extractPhone(body: unknown): string | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b = body as any;
      return (
        b?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from ?? null
      );
    } catch {
      return null;
    }
  }
}
