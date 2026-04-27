import { Injectable, Logger } from '@nestjs/common';
import { SessionService, SessionData } from '../../session/session.service';
import { SistemaApiService } from '../../client/sistema-api.service';
import { IntentDetectorService, Intent } from '../../intent/intent-detector.service';
import { AdminSignalrNotifierService } from '../../notifications/admin-signalr-notifier.service';
import { MessageFormatterService } from '../message-formatter.service';
import { RagService } from '../../rag/rag.service';
import { MessageSource } from '../../../database/entities/message.entity';
import { SendFn } from './payment.handler';
import { serializeAction } from '../../../common/pending-action';

// ══════════════════════════════════════════════════════════════
// SUPPORT HANDLER — US-12, US-13, US-14
//
// Responsabilidad única: soporte técnico y gestión de tickets.
//   - Reporte sin internet / velocidad lenta / router (US-12, US-13)
//   - Intento RAG antes de crear ticket
//   - Creación de ticket con prioridad y SLA (US-12, US-13)
//   - Cierre de ticket por el cliente (US-14)
// ══════════════════════════════════════════════════════════════

@Injectable()
export class SupportHandler {
  private readonly logger = new Logger(SupportHandler.name);

  constructor(
    private readonly session: SessionService,
    private readonly sistemaApi: SistemaApiService,
    private readonly intentDetector: IntentDetectorService,
    private readonly adminNotifier: AdminSignalrNotifierService,
    private readonly formatter: MessageFormatterService,
    private readonly rag: RagService,
  ) {}

  // ─── Soporte técnico (US-12 / US-13) ─────────────────────
  async handleTechSupport(
    intent: Intent,
    text: string,
    session: SessionData,
    send: SendFn,
  ): Promise<void> {
    try {
      // Paso 1: intentar resolver con RAG antes de crear ticket
      try {
        const context = await this.session.getContextText(session.phoneNumber);
        const ragResult = await this.rag.query(
          text,
          context,
          session.phoneNumber,
          session.clientName,
        );

        if (ragResult.found && ragResult.answer) {
          await this.session.updateSession(session.phoneNumber, {
            pendingTechIssue: JSON.stringify({ intent, text }),
          });
          await this.session.setPendingAction(
            session.phoneNumber,
            serializeAction({ type: 'AWAITING_RAG_FEEDBACK' }),
          );
          await send(
            this.formatter.ragSupportGuide(ragResult.answer, ragResult.documentTitle),
            MessageSource.RAG,
            ragResult.chunkId,
          );
          return;
        }
      } catch {
        // RAG falló — crear ticket directamente
      }

      await this.createSupportTicket(intent, text, session, send);
    } catch (err) {
      this.logger.error(`handleTechSupport error: ${err.message}`);
      await send('😔 No pude procesar tu reporte. Por favor intenta de nuevo.');
    }
  }

  // ─── Crear ticket (US-12 / US-13) ────────────────────────
  async createSupportTicket(
    intent: Intent,
    text: string,
    session: SessionData,
    send: SendFn,
  ): Promise<void> {
    const priority = this.intentDetector.getTicketPriority(intent);
    const type     = this.intentDetector.getTicketType(intent);
    const slaHours = priority === 'Alta' ? 4 : priority === 'Media' ? 8 : 24;

    const ticket = await this.sistemaApi.createTicket({
      ClientId: session.clientId,
      Subject: this.sistemaApi.buildTicketSubject({
        type,
        tbnCode:    session.tbnCode    || 'NUEVO',
        clientName: session.clientName || 'Cliente',
        priority,
      }),
      Type: type,
      Priority: priority,
      Description: `Reporte via WhatsApp: ${text}`,
      SlaDurationHours: slaHours,
      Origin: 'Bot',
    });

    await this.session.updateSession(session.phoneNumber, {
      activeTicketId: ticket.Id,
      pendingTechIssue: null,
    });

    await send(
      this.formatter.ticketCreated(session.clientName, ticket.Id, priority),
      MessageSource.INTENT,
    );

    if (priority === 'Alta') {
      await this.adminNotifier.notifyHighPriorityTicket({
        phoneNumber: session.phoneNumber,
        clientName:  session.clientName ?? 'Desconocido',
        ticketId:    ticket.Id,
        description: text,
      });
      await this.session.setPendingAction(
        session.phoneNumber,
        serializeAction({ type: 'AWAITING_TICKET_DETAILS', ticketId: ticket.Id }),
      );
    } else {
      await this.adminNotifier.notifyTicketCreated({
        phoneNumber: session.phoneNumber,
        clientName:  session.clientName ?? 'Desconocido',
        ticketId:    ticket.Id,
        priority,
      });
    }
  }

  // ─── Cerrar ticket (US-14) ────────────────────────────────
  async handleCloseTicket(session: SessionData, send: SendFn): Promise<void> {
    if (!session.activeTicketId) {
      await this.session.setPendingAction(
        session.phoneNumber,
        serializeAction({ type: 'AWAITING_TICKET_ID_TO_CLOSE' }),
      );
      await send(
        '🔍 No encontré un ticket activo en tu sesión.\n\nEscribe el *número de ticket* (ej: A1B2C3D4) y lo cerramos.',
        MessageSource.INTENT,
      );
      return;
    }

    await this.session.setPendingAction(
      session.phoneNumber,
      serializeAction({ type: 'CONFIRM_CLOSE_TICKET', ticketId: session.activeTicketId }),
    );
    await send(this.formatter.confirmCloseTicket(session.activeTicketId), MessageSource.INTENT);
  }

  // ─── Confirmar cierre de ticket ───────────────────────────
  async confirmCloseTicket(
    ticketId: string,
    confirmed: boolean,
    session: SessionData,
    send: SendFn,
  ): Promise<void> {
    if (confirmed) {
      await this.sistemaApi.closeTicket(ticketId, 'Resuelto por el cliente via WhatsApp');
      await this.session.updateSession(session.phoneNumber, {
        activeTicketId: null,
        pendingAction: null,
      });
      await send(this.formatter.ticketClosed(ticketId), MessageSource.INTENT);
      await this.adminNotifier.notifyTicketCreated({
        phoneNumber: session.phoneNumber,
        clientName:  session.clientName ?? 'Desconocido',
        ticketId,
        priority: 'Cerrado',
      });
    } else {
      await this.session.setPendingAction(session.phoneNumber, null);
      await send('👍 Tu ticket sigue abierto. Avísame si necesitas algo más.');
    }
  }

  // ─── Actualizar detalles del ticket ───────────────────────
  async handleTicketDetails(
    ticketId: string,
    text: string,
    session: SessionData,
    send: SendFn,
  ): Promise<void> {
    if (text.length > 5) {
      await this.sistemaApi.updateTicket(ticketId, `Detalles adicionales: ${text}`);
      await this.session.setPendingAction(session.phoneNumber, null);
      await send(this.formatter.ticketUpdated(), MessageSource.INTENT);
    }
  }

  // ─── Feedback RAG: problema resuelto o no ─────────────────
  async handleRagFeedback(
    resolved: boolean,
    text: string,
    session: SessionData,
    send: SendFn,
  ): Promise<void> {
    if (resolved) {
      await this.session.setPendingAction(session.phoneNumber, null);
      await this.session.updateSession(session.phoneNumber, { pendingTechIssue: null });
      await send('✅ ¡Excelente! Nos alegra que se haya resuelto. Si el problema vuelve, escríbenos.', MessageSource.SYSTEM);
    } else {
      await this.session.setPendingAction(session.phoneNumber, null);
      const issueStr = session.pendingTechIssue as string | null;
      let techIntent = Intent.SIN_CONEXION;
      let techText   = text;
      if (issueStr) {
        try {
          const parsed = JSON.parse(issueStr);
          techIntent = parsed.intent as Intent;
          techText   = parsed.text as string;
        } catch { /* usar defaults */ }
      }
      await send(this.formatter.ragNoSolution(), MessageSource.SYSTEM);
      await this.createSupportTicket(techIntent, techText, session, send);
    }
  }

  // ─── Cierre manual por número de ticket ───────────────────
  async handleManualTicketId(
    ticketIdRaw: string,
    session: SessionData,
    send: SendFn,
  ): Promise<void> {
    const ticketId = ticketIdRaw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (ticketId.length < 4) {
      await send(
        '⚠️ No reconocí ese número de ticket. Escríbelo tal como te lo enviamos (ej: A1B2C3D4).',
        MessageSource.SYSTEM,
      );
      return;
    }
    await this.session.setPendingAction(
      session.phoneNumber,
      serializeAction({ type: 'CONFIRM_CLOSE_TICKET', ticketId }),
    );
    await send(this.formatter.confirmCloseTicket(ticketId), MessageSource.INTENT);
  }
}
