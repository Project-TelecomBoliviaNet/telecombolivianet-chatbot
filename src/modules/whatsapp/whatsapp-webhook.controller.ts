import {
  Controller, Get, Post, Body, Query, Headers,
  HttpCode, Res, Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { BotOrchestratorService } from '../bot/bot-orchestrator.service';

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
          type: 'text' | 'image' | 'audio' | 'document' | 'interactive';
          text?: { body: string };
          image?: { id: string; mime_type: string; sha256: string; caption?: string };
          interactive?: {
            type: 'list_reply' | 'button_reply';
            list_reply?: { id: string; title: string };
            button_reply?: { id: string; title: string };
          };
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
  async receive(@Body() payload: MetaWebhookPayload): Promise<{ status: string }> {
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
        const { messages, contacts } = change.value;
        if (!messages?.length) continue;

        for (const message of messages) {
          const from = message.from;
          const contactName = contacts?.[0]?.profile?.name;

          this.logger.debug(`Mensaje entrante de ${from} | tipo: ${message.type}`);

          await this.orchestrator.handleIncoming({
            from,
            messageId: message.id,
            type: message.type,
            text: message.text?.body || message.interactive?.list_reply?.title || message.interactive?.button_reply?.title,
            interactiveId: message.interactive?.list_reply?.id || message.interactive?.button_reply?.id,
            imageId: message.image?.id,
            imageCaption: message.image?.caption,
            contactName,
          });
        }
      }
    }
  }
}
