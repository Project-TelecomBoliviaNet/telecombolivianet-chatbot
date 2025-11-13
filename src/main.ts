import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  if (!process.env.META_APP_SECRET) {
    logger.warn('META_APP_SECRET no configurado — validación de firma de webhook desactivada. Configúralo en producción.');
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['log', 'warn', 'error', 'debug'],
    rawBody: true,
  });

  // ─── Pipes globales ──────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // ─── Security headers (FIX-31) ──────────────────────────
  app.use((_req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-XSS-Protection', '0');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
    );
    next();
  });

  // ─── CORS ────────────────────────────────────────────────
  app.enableCors({
    origin: process.env.NODE_ENV === 'production' ? false : '*',
  });

  // ─── Archivos estáticos: solo en modo local (no Supabase) ───
  if (process.env.STORAGE_TYPE !== 'supabase') {
    app.useStaticAssets(join(process.cwd(), 'uploads'), {
      prefix: '/uploads',
    });
  }

  // ─── Puerto ──────────────────────────────────────────────
  const port = process.env.PORT || 3001;
  await app.listen(port);

  logger.log(`🚀 Bolivianet Chatbot corriendo en: http://localhost:${port}`);
  logger.log(`📱 Webhook WhatsApp: http://localhost:${port}/webhook`);
  logger.log(`❤️  Health check: http://localhost:${port}/health`);
  logger.log(`🌍 Entorno: ${process.env.NODE_ENV || 'development'}`);
}

bootstrap();
