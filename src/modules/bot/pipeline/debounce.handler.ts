import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { MessageContext } from './message-context';
import { MessageHandler } from './message-handler';

// Ventana en ms: si otro mensaje llega antes de que expire, el primero se descarta.
const DEBOUNCE_WINDOW_MS = 2_500;
// TTL del key Redis: debe ser mayor que DEBOUNCE_WINDOW_MS para sobrevivir al check
// (el setTimeout no es exacto — event loop + latencia Redis pueden añadir ~500ms)
const DEBOUNCE_TTL_MS = DEBOUNCE_WINDOW_MS * 2;

// Clave auxiliar para retener datos de imagen cuando llega imagen+caption como dos eventos
// WhatsApp envía imagen y caption como dos webhooks separados en < 1 s
const HELD_IMAGE_PREFIX = 'debounce:held_image:';

/**
 * Debounce por número de teléfono.
 *
 * Flujo:
 *   1. Guarda messageId como "mensaje en curso" en Redis (TTL = DEBOUNCE_WINDOW_MS).
 *   2. Espera DEBOUNCE_WINDOW_MS.
 *   3. Si el ID almacenado sigue siendo el mismo, este mensaje es el último
 *      de la ráfaga → continúa la cadena.
 *   4. Si el ID cambió (llegó un mensaje más reciente), descarta sin responder.
 *
 * Esto evita que el bot responda N veces cuando el usuario envía rápidamente
 * "hola" + "necesito ayuda" + "mi internet no funciona" en < 2.5 s.
 * Solo el último mensaje recibe respuesta.
 */
@Injectable()
export class DebounceHandler implements MessageHandler {
  private readonly logger = new Logger(DebounceHandler.name);
  private readonly redis: Redis;

  constructor(private readonly config: ConfigService) {
    this.redis = new Redis({
      host:          config.get<string>('redis.host'),
      port:          config.get<number>('redis.port'),
      password:      config.get<string>('redis.password') || undefined,
      db:            config.get<number>('redis.db'),
      retryStrategy: (times) => Math.min(times * 200, 5_000),
      lazyConnect:   true,
    });

    this.redis.on('error', (err: Error) =>
      this.logger.warn(`Redis debounce error: ${err.message}`),
    );
  }

  async handle(ctx: MessageContext, next: () => Promise<void>): Promise<void> {
    const key      = `debounce:${ctx.phone}`;
    const imageKey = `${HELD_IMAGE_PREFIX}${ctx.phone}`;

    try {
      // Si es imagen, guardar sus datos para posible fusión con el caption que llegará
      if (ctx.type === 'image' && ctx.imageId) {
        await this.redis.set(
          imageKey,
          JSON.stringify({ imageId: ctx.imageId, imageCaption: ctx.imageCaption ?? null }),
          'PX', DEBOUNCE_TTL_MS,
        );
      }

      await this.redis.set(key, ctx.messageId, 'PX', DEBOUNCE_TTL_MS);
      await new Promise<void>(resolve => setTimeout(resolve, DEBOUNCE_WINDOW_MS));

      const current = await this.redis.get(key);
      if (current !== ctx.messageId) {
        this.logger.debug(
          `Debounce: descartando msg ${ctx.messageId} de ${ctx.phone} (hay uno más reciente)`,
        );
        return;
      }

      // Si el mensaje ganador es texto, fusionar con imagen retenida (si existe)
      if (ctx.type === 'text') {
        const heldJson = await this.redis.getdel(imageKey);
        if (heldJson) {
          const held = JSON.parse(heldJson) as { imageId: string; imageCaption: string | null };
          this.logger.debug(
            `Debounce: fusionando imagen ${held.imageId} con caption "${ctx.text}" para ${ctx.phone}`,
          );
          ctx.type         = 'image';
          ctx.imageId      = held.imageId;
          ctx.imageCaption = ctx.text;
          ctx.text         = undefined;
        }
      }
    } catch (err: unknown) {
      this.logger.warn(`Debounce Redis error (fail open): ${(err as Error).message}`);
    }

    await next();
  }
}
