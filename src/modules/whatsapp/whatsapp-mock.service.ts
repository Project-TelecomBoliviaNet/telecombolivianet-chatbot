import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// ══════════════════════════════════════════════════════════════
// WHATSAPP MOCK SERVICE  — Solo activo cuando NODE_ENV=test o
// WHATSAPP_MOCK=true. Reemplaza WhatsappApiService real en tests
// locales, imprimiendo mensajes en consola en lugar de llamar
// a Meta Cloud API.
//
// Permite probar todos los flujos del bot sin necesidad de:
//   - Cuenta de WhatsApp Business
//   - Token de Meta
//   - Número de teléfono real
// ══════════════════════════════════════════════════════════════

@Injectable()
export class WhatsappMockService {
  private readonly logger = new Logger('WhatsApp[MOCK]');

  // Historial de mensajes enviados (útil para asserts en tests)
  readonly sentMessages: Array<{
    to: string;
    type: 'text' | 'image' | 'buttons';
    content: string;
    buttons?: Array<{ id: string; title: string }>;
    timestamp: Date;
  }> = [];

  constructor(private readonly config: ConfigService) {
    this.logger.warn('══════════════════════════════════════════');
    this.logger.warn('  MODO MOCK ACTIVO — WhatsApp simulado   ');
    this.logger.warn('  Los mensajes se imprimen en consola    ');
    this.logger.warn('══════════════════════════════════════════');
  }

  async sendText(to: string, text: string): Promise<string> {
    const id = `mock_${Date.now()}`;
    this.sentMessages.push({ to, type: 'text', content: text, timestamp: new Date() });
    this.logger.log(`\n📤 → ${to}\n${text}\n${'─'.repeat(50)}`);
    return id;
  }

  async sendImage(to: string, imageUrl: string, caption?: string): Promise<string> {
    const id = `mock_img_${Date.now()}`;
    this.sentMessages.push({ to, type: 'image', content: imageUrl, timestamp: new Date() });
    this.logger.log(`\n🖼️  → ${to}\n[IMAGEN] ${imageUrl}${caption ? `\n${caption}` : ''}\n${'─'.repeat(50)}`);
    return id;
  }

  async sendButtons(
    to: string,
    body: string,
    buttons: Array<{ id: string; title: string }>,
  ): Promise<string> {
    const id = `mock_btn_${Date.now()}`;
    this.sentMessages.push({ to, type: 'buttons', content: body, buttons, timestamp: new Date() });
    const btnStr = buttons.map((b, i) => `  [${i + 1}] ${b.title} (id: ${b.id})`).join('\n');
    this.logger.log(`\n🔘 → ${to}\n${body}\n${btnStr}\n${'─'.repeat(50)}`);
    return id;
  }

  async markAsRead(_messageId: string): Promise<void> {
    // Mock: no-op
  }

  async downloadMedia(_mediaId: string): Promise<Buffer> {
    // Devuelve una imagen PNG mínima (1x1 px, 68 bytes) para que OCR no falle
    const PNG_1PX = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108020000009001' +
      '2e00000000c4944415478016360f8cfc00000000200016f65686600000000' +
      '49454e44ae426082',
      'hex',
    );
    this.logger.log(`📥 downloadMedia (mock) → imagen 1x1 px`);
    return PNG_1PX;
  }

  // Limpiar historial entre tests
  clearHistory(): void {
    this.sentMessages.length = 0;
  }

  // Obtener último mensaje enviado a un número
  lastMessageTo(phone: string): string | undefined {
    const msgs = this.sentMessages.filter((m) => m.to === phone);
    return msgs[msgs.length - 1]?.content;
  }
}
