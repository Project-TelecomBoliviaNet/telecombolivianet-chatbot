import {
  Controller, Get, Post, Param, Query, Headers, Body,
  UnauthorizedException, BadRequestException, NotFoundException,
  Logger, ParseIntPipe, DefaultValuePipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Conversation } from '../../database/entities/conversation.entity';
import { Message, MessageRole, MessageSource } from '../../database/entities/message.entity';
import { SessionService } from '../session/session.service';
import { WhatsappApiService } from '../whatsapp/whatsapp-api.service';

// ══════════════════════════════════════════════════════════════
// MONITOR CONTROLLER  — Panel simple de monitoreo (Fase 3)
//
// Endpoints protegidos por token estático (mismo mecanismo que
// el AdminNotifyController). Pensados para ser consumidos por:
//   a) El panel C# vía llamadas REST
//   b) Una pantalla de monitoreo interna
//
// GET /monitor/conversations           → listado paginado
// GET /monitor/conversations/escalated → solo escaladas
// GET /monitor/conversations/:phone    → detalle + mensajes
// GET /monitor/stats                   → totales del día
// ══════════════════════════════════════════════════════════════

@Controller('monitor')
export class MonitorController {
  private readonly logger = new Logger(MonitorController.name);
  private readonly internalToken: string;

  constructor(
    private readonly config: ConfigService,
    private readonly session: SessionService,
    private readonly whatsapp: WhatsappApiService,
    @InjectRepository(Conversation)
    private readonly convRepo: Repository<Conversation>,
    @InjectRepository(Message)
    private readonly msgRepo: Repository<Message>,
  ) {
    this.internalToken = this.config.get<string>('sistema.botStaticToken') ?? '';
  }

  // ─── Autenticación ────────────────────────────────────────
  private checkAuth(auth: string): void {
    if (!auth?.startsWith('Bearer ') || auth.slice(7) !== this.internalToken) {
      throw new UnauthorizedException('Token inválido');
    }
  }

  // ─── GET /monitor/conversations ───────────────────────────
  // tab: 'todas' | 'sin-responder' | 'en-atencion' | 'escaladas'
  @Get('conversations')
  async listConversations(
    @Headers('authorization') auth: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('tab', new DefaultValuePipe('todas')) tab: string,
  ) {
    this.checkAuth(auth);

    const qb = this.convRepo.createQueryBuilder('c').orderBy('c.updatedAt', 'DESC');

    if (tab === 'escaladas' || tab === 'en-atencion') {
      qb.where('c.isEscalated = :esc', { esc: true });
    } else if (tab === 'sin-responder') {
      // Conversaciones donde el último mensaje es del usuario (aún sin respuesta del bot/agente)
      qb.where(`EXISTS (
        SELECT 1 FROM messages m_last
        WHERE m_last.conversation_id = c.id
        AND m_last.role = 'user'
        AND m_last.created_at = (
          SELECT MAX(m_sub.created_at) FROM messages m_sub
          WHERE m_sub.conversation_id = c.id
        )
      )`);
    }

    const total = await qb.getCount();
    const items = await qb.skip((page - 1) * limit).take(limit).getMany();
    const conversations = await this.enrichConversations(items);

    return { total, page, limit, conversations };
  }

  // ─── GET /monitor/conversations/escalated ─────────────────
  @Get('conversations/escalated')
  async listEscalated(@Headers('authorization') auth: string) {
    this.checkAuth(auth);

    const items = await this.convRepo.find({
      where: { isEscalated: true },
      order: { escalatedAt: 'DESC' },
    });

    const conversations = await this.enrichConversations(items);
    return { total: items.length, conversations };
  }

  // ─── Enriquece lista con último mensaje y total (2 queries batch) ──
  private async enrichConversations(convs: Conversation[]) {
    if (convs.length === 0) return [];

    const ids = convs.map((c) => c.id);

    // Último mensaje por conversación
    const lastMsgs = await this.msgRepo
      .createQueryBuilder('m')
      .where('m.conversationId IN (:...ids)', { ids })
      .andWhere((qb) => {
        const sub = qb.subQuery()
          .select('MAX(inner.createdAt)')
          .from(Message, 'inner')
          .where('inner.conversationId = m.conversationId')
          .getQuery();
        return `m.createdAt = ${sub}`;
      })
      .getMany();

    // Conteo por conversación
    const countRows = await this.msgRepo
      .createQueryBuilder('m')
      .select('m.conversationId', 'cid')
      .addSelect('COUNT(m.id)', 'cnt')
      .where('m.conversationId IN (:...ids)', { ids })
      .groupBy('m.conversationId')
      .getRawMany<{ cid: string; cnt: string }>();

    const lastMsgMap = new Map(lastMsgs.map((m) => [m.conversationId, m.content]));
    const countMap   = new Map(countRows.map((r) => [r.cid, parseInt(r.cnt, 10)]));

    return convs.map((c) => ({
      ...this.formatConversation(c),
      ultimoMensaje: lastMsgMap.get(c.id) ?? null,
      totalMessages: countMap.get(c.id) ?? 0,
    }));
  }

  // ─── GET /monitor/conversations/:phone ────────────────────
  @Get('conversations/:phone')
  async getConversation(
    @Param('phone') phone: string,
    @Headers('authorization') auth: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) msgLimit: number,
  ) {
    this.checkAuth(auth);

    const conv = await this.convRepo.findOne({ where: { phoneNumber: phone } });
    if (!conv) {
      return { found: false };
    }

    const messages = await this.msgRepo.find({
      where: { conversationId: conv.id },
      order: { createdAt: 'DESC' },
      take: msgLimit,
    });

    // Obtener sesión activa de Redis (estado en tiempo real)
    const liveSession = await this.session.getSession(phone).catch(() => null);

    return {
      found: true,
      conversation: this.formatConversation(conv),
      liveSession: liveSession
        ? {
            isEscalated: liveSession.isEscalated,
            pendingAction: liveSession.pendingAction,
            ragFailCount: liveSession.ragFailCount,
            activeTicketId: liveSession.activeTicketId,
            activeInstallationId: liveSession.activeInstallationId,
            lastLocation: liveSession.lastLocation ?? null,
          }
        : null,
      messages: messages.reverse().map((m) => ({
        id: m.id,
        role: m.role,
        source: m.source,
        content: m.content,
        createdAt: m.createdAt,
        mediaUrl: m.mediaUrl  ?? null,
        mediaType: m.mediaType ?? null,
      })),
    };
  }

  // ─── GET /monitor/stats ───────────────────────────────────
  @Get('stats')
  async getStats(@Headers('authorization') auth: string) {
    this.checkAuth(auth);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [
      totalConversations,
      escalatedCount,
      todayMessages,
      todayConversations,
    ] = await Promise.all([
      this.convRepo.count(),
      this.convRepo.count({ where: { isEscalated: true } }),
      this.msgRepo
        .createQueryBuilder('m')
        .where('m.createdAt >= :start', { start: todayStart })
        .getCount(),
      this.convRepo
        .createQueryBuilder('c')
        .where('c.updatedAt >= :start', { start: todayStart })
        .getCount(),
    ]);

    return {
      total: {
        conversations: totalConversations,
        escalated: escalatedCount,
      },
      today: {
        conversations: todayConversations,
        messages: todayMessages,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  // ─── POST /monitor/conversations/:phone/takeover ──────────
  @Post('conversations/:phone/takeover')
  async takeoverConversation(
    @Param('phone') phone: string,
    @Headers('authorization') auth: string,
    @Body() body: { agentName?: string },
  ) {
    this.checkAuth(auth);

    const conv = await this.convRepo.findOne({ where: { phoneNumber: phone } });
    if (!conv) throw new NotFoundException('Conversación no encontrada');

    conv.isEscalated = true;
    conv.escalatedAt = conv.escalatedAt ?? new Date();
    conv.agentName   = body.agentName ?? 'Agente';
    await this.convRepo.save(conv);
    await this.session.escalate(phone);

    this.logger.log(`Conversación ${phone} tomada por agente: ${conv.agentName}`);
    return { success: true, phoneNumber: phone, agentName: conv.agentName };
  }

  // ─── POST /monitor/conversations/:phone/release ───────────
  @Post('conversations/:phone/release')
  async releaseConversation(
    @Param('phone') phone: string,
    @Headers('authorization') auth: string,
  ) {
    this.checkAuth(auth);

    const conv = await this.convRepo.findOne({ where: { phoneNumber: phone } });
    if (!conv) throw new NotFoundException('Conversación no encontrada');

    conv.isEscalated = false;
    conv.escalatedAt = null;
    conv.agentName   = null;
    await this.convRepo.save(conv);
    await this.session.deescalate(phone);

    this.logger.log(`Conversación ${phone} devuelta al bot`);
    return { success: true, phoneNumber: phone };
  }

  // ─── POST /monitor/conversations/:phone/send ──────────────
  @Post('conversations/:phone/send')
  async sendAdminMessage(
    @Param('phone') phone: string,
    @Headers('authorization') auth: string,
    @Body() body: { text: string },
  ) {
    this.checkAuth(auth);

    if (!body.text?.trim()) throw new BadRequestException('Texto requerido');

    const conv = await this.convRepo.findOne({ where: { phoneNumber: phone } });
    if (!conv) throw new NotFoundException('Conversación no encontrada');

    const metaMessageId = await this.whatsapp.sendText(phone, body.text.trim());

    const msg = this.msgRepo.create({
      conversationId: conv.id,
      role:           MessageRole.ADMIN,
      source:         MessageSource.ADMIN,
      content:        body.text.trim(),
      metaMessageId:  metaMessageId ?? null,
    });
    await this.msgRepo.save(msg);
    await this.session.addMessage(phone, 'admin', body.text.trim());

    this.logger.log(`Mensaje admin enviado a ${phone}: "${body.text.trim().substring(0, 50)}"`);
    return { success: true, messageId: msg.id };
  }

  // ─── Formato de conversación ──────────────────────────────
  private formatConversation(c: Conversation) {
    return {
      id: c.id,
      phoneNumber: c.phoneNumber,
      clientId: c.clientId,
      clientName: c.clientName,
      isEscalated: c.isEscalated,
      agentName: c.agentName,
      escalatedAt: c.escalatedAt,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }
}
