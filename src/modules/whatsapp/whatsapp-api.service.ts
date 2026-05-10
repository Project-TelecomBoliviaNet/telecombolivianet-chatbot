import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { IWhatsappMessenger } from './whatsapp-messenger.interface';

// ══════════════════════════════════════════════════════════════
// WHATSAPP API SERVICE
// Envío de mensajes al cliente via Meta Cloud API v18+
// ══════════════════════════════════════════════════════════════

// Reintentar en errores transitorios: red, 429 (rate limit), 5xx
const RETRYABLE = (err: any): boolean => {
  const status = err.response?.status;
  return !status || status === 429 || status >= 500;
};

@Injectable()
export class WhatsappApiService implements IWhatsappMessenger {
  private readonly logger = new Logger(WhatsappApiService.name);
  private http: AxiosInstance;
  private readonly phoneNumberId: string;

  // Retry config (US-AI-12)
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_BASE_MS = 500;

  constructor(private readonly config: ConfigService) {
    this.phoneNumberId = config.get<string>('meta.phoneNumberId');
    const apiVersion = config.get<string>('meta.apiVersion');
    const apiUrl = config.get<string>('meta.apiUrl');
    const token = config.get<string>('meta.accessToken');

    this.http = axios.create({
      baseURL: `${apiUrl}/${apiVersion}`,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });
  }

  // ─── Retry con backoff exponencial (US-AI-12) ────────────
  private async withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    let lastErr: any;
    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (!RETRYABLE(err) || attempt === this.MAX_RETRIES) break;
        const delay = this.RETRY_BASE_MS * Math.pow(2, attempt - 1);
        this.logger.warn(JSON.stringify({
          event:   'whatsapp_retry',
          label,
          attempt,
          delayMs: delay,
          error:   err.message,
        }));
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr;
  }

  // ─── Enviar mensaje de texto ──────────────────────────────
  async sendText(to: string, text: string): Promise<string> {
    return this.withRetry(async () => {
      const res = await this.http.post(`/${this.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: false, body: text },
      });
      return res.data?.messages?.[0]?.id;
    }, `sendText:${to}`);
  }

  // ─── Enviar imagen (QR, comprobante, etc.) ────────────────
  async sendImage(to: string, imageUrl: string, caption?: string): Promise<string> {
    return this.withRetry(async () => {
      const res = await this.http.post(`/${this.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        to,
        type: 'image',
        image: { link: imageUrl, ...(caption && { caption }) },
      });
      return res.data?.messages?.[0]?.id;
    }, `sendImage:${to}`);
  }

  // ─── Enviar lista de opciones (interactive list) ──────────
  async sendList(
    to: string,
    body: string,
    buttonLabel: string,
    sections: Array<{
      title: string;
      rows: Array<{ id: string; title: string; description?: string }>;
    }>,
  ): Promise<string> {
    return this.withRetry(async () => {
      const res = await this.http.post(`/${this.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: body },
          action: { button: buttonLabel, sections },
        },
      });
      return res.data?.messages?.[0]?.id;
    }, `sendList:${to}`);
  }

  // ─── Enviar botones de respuesta rápida ──────────────────
  async sendButtons(
    to: string,
    body: string,
    buttons: Array<{ id: string; title: string }>,
  ): Promise<string> {
    return this.withRetry(async () => {
      const res = await this.http.post(`/${this.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: body },
          action: {
            buttons: buttons.map((b) => ({
              type: 'reply',
              reply: { id: b.id, title: b.title },
            })),
          },
        },
      });
      return res.data?.messages?.[0]?.id;
    }, `sendButtons:${to}`);
  }

  // ─── Marcar mensaje como leído ───────────────────────────
  async markAsRead(messageId: string): Promise<void> {
    try {
      await this.http.post(`/${this.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      });
    } catch {
      // No crítico si falla — no reintentar
    }
  }

  // ─── Descargar media (imagen de comprobante) ──────────────
  async downloadMedia(mediaId: string): Promise<Buffer> {
    // 1. Obtener URL temporal de la media
    const mediaRes = await this.http.get(`/${mediaId}`);
    const mediaUrl = mediaRes.data.url;

    // 2. Descargar el contenido
    const downloadRes = await axios.get(mediaUrl, {
      headers: { Authorization: `Bearer ${this.config.get('meta.accessToken')}` },
      responseType: 'arraybuffer',
    });
    return Buffer.from(downloadRes.data);
  }
}
