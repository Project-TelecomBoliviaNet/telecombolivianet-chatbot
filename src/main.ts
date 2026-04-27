import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['log', 'warn', 'error', 'debug'],
  });

  const logger = new Logger('Bootstrap');
  const isProd = process.env.NODE_ENV === 'production';

  // ─── Seguridad HTTP — headers de seguridad estándar ──────
  // helmet añade: X-Content-Type-Options, X-Frame-Options,
  // Strict-Transport-Security, X-XSS-Protection, etc.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const helmet = require('helmet');
  app.use(helmet());

  // ─── CORS ─────────────────────────────────────────────────
  // En producción: solo el dominio del panel admin.
  // En desarrollo: cualquier origen (facilita pruebas locales).
  app.enableCors({
    origin: isProd
      ? (process.env.ADMIN_PANEL_URL || false)
      : '*',
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  });

  // ─── Validación global de DTOs ────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,              // elimina campos no declarados en el DTO
      forbidNonWhitelisted: false,  // no lanza error (el webhook de Meta envía campos extra)
      transform: true,              // transforma tipos automáticamente (ParseIntPipe, etc.)
    }),
  );

  // ─── Archivos estáticos (QR de pago) ─────────────────────
  // CORRECCIÓN DE SEGURIDAD: los comprobantes de pago ya NO se sirven
  // públicamente. Solo los QR temporales se sirven, y solo en desarrollo.
  //
  // En producción: los QR deben servirse desde MinIO con URLs firmadas
  // (tiempo de expiración corto), no desde el servidor de la aplicación.
  //
  // Si STORAGE_TYPE=local (desarrollo), habilitamos /uploads solo para QR.
  // En producción con STORAGE_TYPE=minio, este bloque no se ejecuta.
  if (!isProd && process.env.STORAGE_TYPE !== 'minio') {
    const { join } = require('path');
    app.useStaticAssets(join(process.cwd(), 'uploads'), {
      prefix: '/uploads',
    });
    logger.warn('⚠️  /uploads servido públicamente — solo válido en desarrollo local');
  }

  // ─── Puerto ───────────────────────────────────────────────
  const port = process.env.PORT || 3001;
  await app.listen(port);

  logger.log(`Bolivianet Chatbot corriendo en http://localhost:${port}`);
  logger.log(`Webhook WhatsApp: http://localhost:${port}/webhook`);
  logger.log(`Health check:     http://localhost:${port}/health`);
  logger.log(`Entorno:          ${process.env.NODE_ENV || 'development'}`);
}

bootstrap();
