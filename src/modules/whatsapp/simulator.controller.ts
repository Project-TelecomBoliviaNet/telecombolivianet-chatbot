import {
  Controller, Post, Get, Body, Logger, HttpCode, Optional,
} from '@nestjs/common';
import { BotOrchestratorService } from '../bot/bot-orchestrator.service';
import { WhatsappMockService } from './whatsapp-mock.service';

// ══════════════════════════════════════════════════════════════
// SIMULATOR CONTROLLER  — Solo activo con WHATSAPP_MOCK=true
//
// Permite probar el bot enviando mensajes HTTP directamente,
// sin necesitar WhatsApp ni Meta Cloud API.
//
// POST /simulate/message   → enviar mensaje de texto
// POST /simulate/image     → enviar imagen (comprobante)
// POST /simulate/button    → presionar botón interactivo
// GET  /simulate/history   → ver mensajes enviados por el bot
//
// Ejemplo curl:
//   curl -X POST http://localhost:3001/simulate/message \
//     -H "Content-Type: application/json" \
//     -d '{"from":"59170000001","text":"hola"}'
// ══════════════════════════════════════════════════════════════

@Controller('simulate')
export class SimulatorController {
  private readonly logger = new Logger('Simulator');

  // Historial de conversaciones simuladas
  private history: Array<{
    direction: 'in' | 'out';
    from: string;
    type: string;
    content: string;
    timestamp: string;
  }> = [];

  constructor(
    private readonly orchestrator: BotOrchestratorService,
    @Optional() private readonly mockWa: WhatsappMockService,
  ) {}

  // ─── POST /simulate/message — texto del "usuario" ─────────
  @Post('message')
  @HttpCode(200)
  async sendMessage(
    @Body() body: { from: string; text: string },
  ) {
    const { from, text } = body;
    if (!from || !text) {
      return { error: 'Se requieren "from" (número) y "text"' };
    }

    this.log('in', from, 'text', text);
    this.logger.log(`\n💬 Usuario [${from}]: ${text}`);

    const before = this.mockWa?.sentMessages.length ?? 0;

    await this.orchestrator.handleIncoming({
      from,
      messageId: `sim_${Date.now()}`,
      type: 'text',
      text,
    });

    const botReplies = this.mockWa
      ? this.mockWa.sentMessages.slice(before).map((m) => m.content)
      : [];

    return { ok: true, from, text, botReplies };
  }

  // ─── POST /simulate/image — imagen (comprobante de pago) ──
  @Post('image')
  @HttpCode(200)
  async sendImage(
    @Body() body: { from: string; caption?: string },
  ) {
    const { from, caption } = body;
    if (!from) return { error: 'Se requiere "from"' };

    this.log('in', from, 'image', caption || '[sin caption]');
    this.logger.log(`\n🖼️  Usuario [${from}]: [imagen]${caption ? ` "${caption}"` : ''}`);

    await this.orchestrator.handleIncoming({
      from,
      messageId: `sim_img_${Date.now()}`,
      type: 'image',
      imageId: 'mock_image_id',
      imageCaption: caption,
    });

    return { ok: true, from, type: 'image' };
  }

  // ─── POST /simulate/button — presionar botón interactivo ──
  @Post('button')
  @HttpCode(200)
  async pressButton(
    @Body() body: { from: string; buttonId: string; buttonTitle?: string },
  ) {
    const { from, buttonId, buttonTitle } = body;
    if (!from || !buttonId) {
      return { error: 'Se requieren "from" y "buttonId"' };
    }

    this.log('in', from, 'button', buttonId);
    this.logger.log(`\n🔘 Usuario [${from}]: [botón] ${buttonTitle || buttonId}`);

    await this.orchestrator.handleIncoming({
      from,
      messageId: `sim_btn_${Date.now()}`,
      type: 'interactive',
      text: buttonTitle || buttonId,
      interactiveId: buttonId,
    });

    return { ok: true, from, buttonId };
  }

  // ─── GET /simulate/history — historial de la simulación ───
  @Get('history')
  getHistory() {
    return {
      total: this.history.length,
      messages: this.history,
    };
  }

  // ─── POST /simulate/clear — limpiar historial ─────────────
  @Post('clear')
  @HttpCode(200)
  clearHistory() {
    this.history = [];
    return { ok: true, cleared: true };
  }

  private log(
    direction: 'in' | 'out',
    from: string,
    type: string,
    content: string,
  ) {
    this.history.push({
      direction,
      from,
      type,
      content,
      timestamp: new Date().toISOString(),
    });
  }
}
