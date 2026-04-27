import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

// ══════════════════════════════════════════════════════════════
// WHATSAPP API SERVICE
// Envío de mensajes al cliente via Meta Cloud API v18+
// ══════════════════════════════════════════════════════════════

@Injectable()
export class WhatsappApiService {
  private readonly logger = new Logger(WhatsappApiService.name);
  private http: AxiosInstance;
  private readonly phoneNumberId: string;

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

  // ─── Enviar mensaje de texto ──────────────────────────────
  async sendText(to: string, text: string): Promise<string> {
    try {
      const res = await this.http.post(`/${this.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: false, body: text },
      });
      return res.data?.messages?.[0]?.id;
    } catch (err) {
      this.logger.error(`sendText error a ${to}: ${err.message}`);
      throw err;
    }
  }

  // ─── Enviar imagen (QR, comprobante, etc.) ────────────────
  async sendImage(to: string, imageUrl: string, caption?: string): Promise<string> {
    const res = await this.http.post(`/${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'image',
      image: { link: imageUrl, ...(caption && { caption }) },
    });
    return res.data?.messages?.[0]?.id;
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
  }

  // ─── Enviar botones de respuesta rápida ──────────────────
  async sendButtons(
    to: string,
    body: string,
    buttons: Array<{ id: string; title: string }>,
  ): Promise<string> {
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
      // No crítico si falla
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
