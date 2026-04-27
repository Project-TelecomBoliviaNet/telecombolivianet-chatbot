import {
  Controller, Get, Param, Query, Headers,
  UnauthorizedException, Logger, ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Conversation } from '../../database/entities/conversation.entity';
import { Message } from '../../database/entities/message.entity';
import { SessionService } from '../session/session.service';
import { isValidToken, extractBearerToken } from '../../common/security/token.util';

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
    @InjectRepository(Conversation)
    private readonly convRepo: Repository<Conversation>,
    @InjectRepository(Message)
    private readonly msgRepo: Repository<Message>,
  ) {
    // Usamos el mismo mecanismo de auth que AdminNotifyController
    this.internalToken = this.config.get<string>('sistema.botStaticToken') ?? '';
  }

  // ─── Autenticación ────────────────────────────────────────
  private checkAuth(auth: string): void {
    const received = extractBearerToken(auth);
    if (!received || !isValidToken(received, this.internalToken)) {
      throw new UnauthorizedException('Token inválido');
    }
  }

  // ─── GET /monitor/conversations ───────────────────────────
  @Get('conversations')
  async listConversations(
    @Headers('authorization') auth: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    this.checkAuth(auth);

    const [items, total] = await this.convRepo.findAndCount({
      order: { updatedAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return {
      total,
      page,
      limit,
      conversations: items.map((c) => this.formatConversation(c)),
    };
  }

  // ─── GET /monitor/conversations/escalated ─────────────────
  @Get('conversations/escalated')
  async listEscalated(@Headers('authorization') auth: string) {
    this.checkAuth(auth);

    const items = await this.convRepo.find({
      where: { isEscalated: true },
      order: { escalatedAt: 'DESC' },
    });

    return {
      total: items.length,
      conversations: items.map((c) => this.formatConversation(c)),
    };
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
          }
        : null,
      messages: messages.reverse().map((m) => ({
        id: m.id,
        role: m.role,
        source: m.source,
        content: m.content,
        createdAt: m.createdAt,
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
      escalationsByCategory,
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
      // US-EP06-02: breakdown de escalados por categoría del día
      this.convRepo
        .createQueryBuilder('c')
        .select('c.escalation_category', 'category')
        .addSelect('COUNT(*)', 'count')
        .where('c.is_escalated = true')
        .andWhere('c.escalated_at >= :start', { start: todayStart })
        .andWhere('c.escalation_category IS NOT NULL')
        .groupBy('c.escalation_category')
        .getRawMany<{ category: string; count: string }>(),
    ]);

    // Convertir el array a objeto para facilitar consumo por el panel admin
    const categoryBreakdown = escalationsByCategory.reduce(
      (acc, row) => {
        acc[row.category] = parseInt(row.count, 10);
        return acc;
      },
      {} as Record<string, number>,
    );

    return {
      total: {
        conversations: totalConversations,
        escalated:     escalatedCount,
      },
      today: {
        conversations:     todayConversations,
        messages:          todayMessages,
        // US-EP06-02: escalados de hoy con breakdown por categoría
        escalated:         escalationsByCategory.reduce((s, r) => s + parseInt(r.count, 10), 0),
        escalatedByCategory: categoryBreakdown,
      },
      generatedAt: new Date().toISOString(),
    };
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
