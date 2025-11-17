import {
  Controller, Get, Post, Body, Query, Headers,
  HttpCode, Res, Logger, Req, Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { RawBodyRequest } from '@nestjs/common';
import { Request } from 'express';
import * as crypto from 'crypto';
import { BotOrchestratorService } from '../bot/bot-orchestrator.service';
import { INotificationRepository, NOTIFICATION_REPOSITORY } from '../client/sistema-api.interfaces';
import { WebhookDedupService } from './webhook-dedup.service';

// ══════════════════════════════════════════════════════════════
// WHATSAPP WEBHOOK CONTROLLER
// Punto de entrada del sistema:
// - GET  /webhook → verificación de Meta (US-01)
// - POST /webhook → mensajes entrantes de WhatsApp
// ══════════════════════════════════════════════════════════════

export interface MetaWebhookPayload {
  object: string;
  entry: Array<{
    id: string;
    changes: Array<{
      value: {
        messaging_product: string;
        metadata: { display_phone_number: string; phone_number_id: string };
        contacts?: Array<{ profile: { name: string }; wa_id: string }>;
        messages?: Array<{
          id: string;
          from: string;
          timestamp: string;
          type: 'text' | 'image' | 'audio' | 'document' | 'interactive' | 'location';
          text?: { body: string };
          image?: { id: string; mime_type: string; sha256: string; caption?: string };
          audio?: { id: string; mime_type: string };
          interactive?: {
            type: 'list_reply' | 'button_reply';
            list_reply?: { id: string; title: string };
            button_reply?: { id: string; title: string };
          };
          location?: { latitude: number; longitude: number; name?: string; address?: string };
        }>;
        statuses?: Array<{ id: string; status: string; timestamp: string }>;
      };
      field: string;
    }>;
  }>;
}

@Controller('webhook')
export class WhatsappWebhookController {
  private readonly logger = new Logger(WhatsappWebhookController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly orchestrator: BotOrchestratorService,
    @Inject(NOTIFICATION_REPOSITORY) private readonly notificationRepo: INotificationRepository,
    private readonly dedup: WebhookDedupService,
  ) {}

  // ─── Verificación de webhook por Meta ────────────────────
  @Get()
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    const verifyToken = this.config.get<string>('meta.verifyToken');

    if (mode === 'subscribe' && token === verifyToken) {
      this.logger.log('Webhook verificado correctamente por Meta');
      return res.status(200).send(challenge);
    }

    this.logger.warn('Verificación de webhook fallida - token incorrecto');
    return res.status(403).send('Forbidden');
  }

  // ─── Recepción de mensajes de WhatsApp ───────────────────
  @Post()
  @HttpCode(200)
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Body() payload: MetaWebhookPayload,
    @Headers('x-hub-signature-256') signature: string,
  ): Promise<{ status: string }> {
    // Verificar firma X-Hub-Signature-256 de Meta para prevenir mensajes falsos.
    // Si META_APP_SECRET está configurado, rechazar silenciosamente payloads sin firma válida.
    const appSecret = this.config.get<string>('meta.appSecret');
    if (appSecret) {
      if (!signature) {
        this.logger.warn('Webhook recibido sin X-Hub-Signature-256 — ignorado');
        return { status: 'ok' };
      }
      const rawBody = req.rawBody;
      const expectedHash = crypto
        .createHmac('sha256', appSecret)
        .update(rawBody ?? '')
        .digest('hex');
      const expectedSig = Buffer.from(`sha256=${expectedHash}`);
      const receivedSig = Buffer.from(signature);
      const sigValid =
        expectedSig.length === receivedSig.length &&
        crypto.timingSafeEqual(expectedSig, receivedSig);
      if (!sigValid) {
        this.logger.warn('Firma de webhook inválida — payload ignorado');
        return { status: 'ok' };
      }
    }

    // Meta espera 200 OK inmediatamente — procesamos de forma asíncrona
    this.processPayload(payload).catch((err) =>
      this.logger.error(`Error procesando payload: ${err.message}`, err.stack),
    );
    return { status: 'ok' };
  }

  private async processPayload(payload: MetaWebhookPayload): Promise<void> {
    if (payload.object !== 'whatsapp_business_account') return;

    for (const entry of payload.entry) {
      for (const change of entry.changes) {
        const { messages, contacts, statuses } = change.value;

        // US-18: procesar delivery receipts antes de mensajes
        if (statuses?.length) {
          for (const st of statuses) {
            if (st.status === 'delivered' || st.status === 'read') {
              await this.notificationRepo.postDeliveryStatus(st.id, st.status, st.timestamp);
            }
          }
        }

        if (!messages?.length) continue;

        for (const message of messages) {
          const from = message.from;
          const contactName = contacts?.[0]?.profile?.name;

          // FIX-10: deduplicar webhooks — Meta reintenta si no recibe 200 a tiempo
          if (await this.dedup.isDuplicate(message.id)) {
            this.logger.debug(`Webhook duplicado ignorado (messageId: ${message.id})`);
            continue;
          }

          // Structured log (US-AI-15)
          this.logger.log(JSON.stringify({
            event:     'incoming_message',
            from,
            messageId: message.id,
            type:      message.type,
          }));

          await this.orchestrator.handleIncoming({
            from,
            messageId:    message.id,
            type:         message.type,
            text:         message.text?.body
                            || message.interactive?.list_reply?.title
                            || message.interactive?.button_reply?.title,
            interactiveId: message.interactive?.list_reply?.id
                            || message.interactive?.button_reply?.id,
            imageId:         message.image?.id,
            imageCaption:    message.image?.caption,
            audioId:         message.audio?.id,
            locationLat:     message.location?.latitude,
            locationLng:     message.location?.longitude,
            locationName:    message.location?.name,
            locationAddress: message.location?.address,
            contactName,
          });
        }
      }
    }
  }
}
