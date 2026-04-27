import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SessionService, SessionData } from '../session/session.service';
import { SistemaApiService } from '../client/sistema-api.service';
import { IntentDetectorService, Intent } from '../intent/intent-detector.service';
import { WhatsappApiService } from '../whatsapp/whatsapp-api.service';
import { MessageFormatterService } from './message-formatter.service';
import { RagService } from '../rag/rag.service';
import { AdminSignalrNotifierService } from '../notifications/admin-signalr-notifier.service';
import { BotRemoteConfigService } from './bot-remote-config.service';
import { PaymentHandler } from './handlers/payment.handler';
import { SupportHandler } from './handlers/support.handler';
import { InstallationHandler } from './handlers/installation.handler';
import { ConversationSummaryService } from './conversation-summary.service';
import { Conversation } from '../../database/entities/conversation.entity';
import { Message, MessageRole, MessageSource } from '../../database/entities/message.entity';
import { deserializeAction } from '../../common/pending-action';

// ══════════════════════════════════════════════════════════════
// BOT ORCHESTRATOR SERVICE — refactorizado (SRP)
//
// Responsabilidad única: orquestar el flujo de decisión.
// La lógica de negocio vive en handlers especializados:
//   PaymentHandler      → US-03, US-04, US-05, US-06
//   SupportHandler      → US-12, US-13, US-14
//   InstallationHandler → US-09, US-10, US-11
//
// Este servicio solo:
//   1. Identifica al cliente
//   2. Detecta el intent
//   3. Delega en el handler correcto
//   4. Gestiona RAG y escalado
// ══════════════════════════════════════════════════════════════

export interface IncomingMessage {
  from: string;
  messageId: string;
  type: string;
  text?: string;
  interactiveId?: string;
  imageId?: string;
  imageCaption?: string;
  contactName?: string;
}

@Injectable()
export class BotOrchestratorService {
  private readonly logger = new Logger(BotOrchestratorService.name);
  private readonly maxRagAttempts: number;

  constructor(
    private readonly config:          ConfigService,
    private readonly session:         SessionService,
    private readonly sistemaApi:      SistemaApiService,
    private readonly intentDetector:  IntentDetectorService,
    private readonly whatsapp:        WhatsappApiService,
    private readonly formatter:       MessageFormatterService,
    private readonly rag:             RagService,
    private readonly adminNotifier:   AdminSignalrNotifierService,
    private readonly payments:        PaymentHandler,
    private readonly support:         SupportHandler,
    private readonly installation:    InstallationHandler,
    private readonly convSummary:     ConversationSummaryService,
    private readonly remoteConfig:    BotRemoteConfigService,
    @InjectRepository(Conversation) private readonly convRepo: Repository<Conversation>,
    @InjectRepository(Message)      private readonly msgRepo:  Repository<Message>,
  ) {
    this.maxRagAttempts = config.get<number>('bot.maxRagAttempts') ?? 2;
  }

  // ─── ENTRADA PRINCIPAL ────────────────────────────────────
  async handleIncoming(incoming: IncomingMessage): Promise<void> {
    const { from, messageId, type, text, imageId, imageCaption, interactiveId } = incoming;

    await this.whatsapp.markAsRead(messageId).catch(() => {});

    const sessionData = await this.session.getSession(from);

    if (sessionData.isEscalated) {
      await this.persistMessage(sessionData, 'user', text || '[imagen]', MessageSource.ADMIN);
      this.logger.debug(`Conversación ${from} escalada. Bot silenciado.`);
      return;
    }

    // ── Verificar horario de atención ────────────────────────
    if (!this.remoteConfig.isWithinBusinessHours()) {
      const msg = this.remoteConfig.get().Horario.MensajeFueraHorario;
      await this.whatsapp.sendText(from, msg);
      await this.persistMessage(sessionData, 'bot', msg, MessageSource.SYSTEM);
      return;
    }

    await this.session.addMessage(from, 'user', text || '[imagen]');
    await this.persistMessage(sessionData, 'user', text || '[imagen]', null);

    const updatedSession = await this.identifyClient(from, sessionData);

    // Imagen → comprobante de pago (US-06)
    if (type === 'image' && imageId) {
      await this.payments.handleReceipt(imageId, imageCaption, updatedSession, this.makeSend(updatedSession));
      return;
    }

    const effectiveText = interactiveId ? this.resolveInteractiveId(interactiveId) : text;
    if (!effectiveText?.trim()) return;

    // ── Palabras clave configurables que fuerzan el menú principal ──
    const textNorm = effectiveText.trim().toLowerCase();
    const keywords = this.remoteConfig.get().PalabrasClave;
    if (!updatedSession.pendingAction && keywords.some((kw) => textNorm === kw.toLowerCase())) {
      const send = this.makeSend(updatedSession);
      await send(
        updatedSession.clientId
          ? this.formatter.welcome(updatedSession.clientName)
          : this.formatter.welcomeProspect(),
        MessageSource.INTENT,
      );
      return;
    }

    const intent = await this.intentDetector.detect(
      effectiveText,
      from,
      updatedSession.clientName,
    );
    this.logger.debug(`Intent: ${intent} — "${effectiveText.substring(0, 50)}"`);

    if (updatedSession.pendingAction) {
      await this.handlePendingAction(intent, effectiveText, updatedSession);
      return;
    }

    const handled = await this.routeIntent(intent, effectiveText, updatedSession);
    if (!handled) await this.handleRag(effectiveText, updatedSession);
  }

  // ─── ROUTING DE INTENTS ───────────────────────────────────
  private async routeIntent(intent: Intent, text: string, session: SessionData): Promise<boolean> {
    const send = this.makeSend(session);
    const isProspect = !session.clientId;
    const prospectMsg = (msg: string) => send(`⚠️ ${msg}`);

    switch (intent) {
      case Intent.SALUDO:
      case Intent.MENU:
        await send(
          isProspect ? this.formatter.welcomeProspect() : this.formatter.welcome(session.clientName),
          MessageSource.INTENT,
        );
        return true;

      case Intent.CONSULTA_DEUDA:
        if (isProspect) await prospectMsg('No encontré tu número en nuestro sistema. ¿Ya eres cliente?');
        else await this.payments.handleDebt(session, send);
        return true;

      case Intent.CONSULTA_PERIODO:
        await this.payments.handlePaymentPeriodInfo(session, send);
        return true;

      case Intent.SOLICITAR_QR:
        if (isProspect) await prospectMsg('Para solicitar el QR de pago necesitas ser cliente registrado.');
        else await this.payments.handleQr(session, send);
        return true;

      case Intent.SIN_CONEXION:
      case Intent.VELOCIDAD_LENTA:
      case Intent.PROBLEMA_ROUTER:
        if (isProspect) await prospectMsg('El soporte técnico es solo para clientes registrados.');
        else await this.support.handleTechSupport(intent, text, session, send);
        return true;

      case Intent.CERRAR_TICKET:
        if (isProspect) await prospectMsg('El soporte técnico es solo para clientes registrados.');
        else await this.support.handleCloseTicket(session, send);
        return true;

      case Intent.SOLICITAR_INSTALACION:
        await this.installation.handleInstallationRequest(session, send);
        return true;

      case Intent.CANCELAR_INSTALACION:
        if (isProspect) await prospectMsg('No tienes instalaciones agendadas en nuestro sistema.');
        else await this.installation.handleCancelInstallation(session, send);
        return true;

      case Intent.SOLICITAR_AGENTE:
        await this.triggerEscalation(session);
        return true;

      default:
        return false;
    }
  }

  // ─── PENDING ACTION — despacha al handler correcto ────────
  private async handlePendingAction(intent: Intent, text: string, session: SessionData): Promise<void> {
    const action = deserializeAction(session.pendingAction);
    const send   = this.makeSend(session);

    if (!action) {
      await this.session.setPendingAction(session.phoneNumber, null);
      await this.routeIntent(intent, text, session);
      return;
    }

    switch (action.type) {
      case 'CONFIRM_CLOSE_TICKET':
        await this.support.confirmCloseTicket(action.ticketId, intent === Intent.CONFIRMAR, session, send);
        break;

      case 'CONFIRM_CANCEL_INSTALLATION':
        await this.installation.confirmCancelInstallation(action.installationId, intent === Intent.CONFIRMAR, session, send);
        break;

      case 'AWAITING_SLOT_SELECTION':
        await this.installation.handleSlotSelection(text, session, send);
        break;

      case 'AWAITING_ADDRESS':
        await this.installation.handleAddressAndConfirm(text, action.slotDate, action.slotTime, session, send);
        break;

      case 'AWAITING_TICKET_DETAILS':
        await this.support.handleTicketDetails(action.ticketId ?? session.activeTicketId, text, session, send);
        break;

      case 'AWAITING_RAG_FEEDBACK':
        await this.support.handleRagFeedback(intent === Intent.CONFIRMAR, text, session, send);
        break;

      case 'AWAITING_TICKET_ID_TO_CLOSE':
        await this.support.handleManualTicketId(text, session, send);
        break;

      default:
        await this.session.setPendingAction(session.phoneNumber, null);
        await this.routeIntent(intent, text, session);
    }
  }

  // ─── RAG (US-15) ─────────────────────────────────────────
  private async handleRag(text: string, session: SessionData): Promise<void> {
    const context = await this.session.getContextText(session.phoneNumber);
    const result  = await this.rag.query(
      text,
      context,
      session.phoneNumber,
      session.clientName,
    );
    const send = this.makeSend(session);

    if (result.found) {
      await this.session.resetRagFail(session.phoneNumber);
      await send(
        this.formatter.ragAnswer(result.answer, result.documentTitle),
        MessageSource.RAG,
        result.chunkId,
      );
    } else {
      const failCount = await this.session.incrementRagFail(session.phoneNumber);
      if (failCount >= this.maxRagAttempts) {
        await this.triggerEscalation(session);
      } else {
        await send(this.formatter.fallbackMenu(), MessageSource.SYSTEM);
      }
    }
  }

  // ─── ESCALADO ENRIQUECIDO (US-17 + US-EP06-01 + US-EP06-02) ─
  async triggerEscalation(session: SessionData): Promise<void> {
    // 1. Marcar sesión y BD como escalada
    await this.session.escalate(session.phoneNumber);
    await this.convRepo.update(
      { phoneNumber: session.phoneNumber },
      { isEscalated: true, escalatedAt: new Date() },
    );

    // 2. Notificar al usuario
    await this.makeSend(session)(this.formatter.escalationNotice(), MessageSource.ESCALATION);
    this.logger.log(`Conversación ${session.phoneNumber} escalada al admin`);

    // 3. Generar resumen y categoría (EP-06) — non-blocking
    //    Si falla, el escalado continúa sin resumen
    let escalationSummary:      string | undefined;
    let escalationCategory:     string | undefined;
    let escalationCategoryLabel: string | undefined;

    try {
      const conversationText = await this.session.getContextText(session.phoneNumber);
      const summaryResult    = await this.convSummary.summarize(session, conversationText);

      escalationSummary       = summaryResult.summary;
      escalationCategory      = summaryResult.category;
      escalationCategoryLabel = summaryResult.categoryLabel;

      // Persistir resumen y categoría en BD para auditoría
      await this.convRepo.update(
        { phoneNumber: session.phoneNumber },
        {
          escalationSummary:  summaryResult.summary,
          escalationCategory: summaryResult.category,
        },
      );

      this.logger.debug(
        `[Escalado] Resumen generado | phone=${session.phoneNumber} ` +
        `category=${summaryResult.category} ai=${summaryResult.isAiGenerated}`,
      );
    } catch (err) {
      this.logger.warn(
        `[Escalado] No se pudo generar resumen (${err.message}), ` +
        `notificando sin briefing`,
      );
    }

    // 4. Notificar al admin con el briefing (o sin él si falló)
    await this.adminNotifier.notifyEscalation({
      phoneNumber:             session.phoneNumber,
      clientName:              session.clientName ?? undefined,
      reason:                  'Escalado automático por fallo en RAG o solicitud del cliente',
      escalationSummary,
      escalationCategory,
      escalationCategoryLabel,
    });
  }

  // ─── IDENTIFICACIÓN DE CLIENTE (US-01 / US-02) ───────────
  private async identifyClient(phone: string, session: SessionData): Promise<SessionData> {
    if (session.clientId || session.clientName === '__prospect__') return session;

    try {
      const client = await this.sistemaApi.getClientByPhone(phone);
      if (client) {
        await this.session.setClientData(phone, {
          clientId:     client.Id,
          clientName:   client.FullName,
          clientStatus: client.Status,
          planName:     client.PlanName,
          totalDebt:    client.TotalDebt,
          tbnCode:      client.TbnCode,
        });
        await this.convRepo.upsert(
          { phoneNumber: phone, clientId: client.Id, clientName: client.FullName },
          ['phoneNumber'],
        );
        return await this.session.getSession(phone);
      }
      await this.session.updateSession(phone, { clientName: '__prospect__' });
    } catch (err) {
      this.logger.error(`Error identificando cliente ${phone}: ${err.message}`);
    }

    return await this.session.getSession(phone);
  }

  // ─── HELPERS ─────────────────────────────────────────────
  private resolveInteractiveId(id: string): string {
    const MAP: Record<string, string> = {
      reagendar_si: 'instalar',
      reagendar_no: 'no',
    };
    return MAP[id] ?? id;
  }

  /** Crea una función send vinculada a la sesión actual */
  private makeSend(session: SessionData) {
    return async (text: string, source: MessageSource = MessageSource.SYSTEM, chunkId?: string) => {
      await this.whatsapp.sendText(session.phoneNumber, text);
      await this.session.addMessage(session.phoneNumber, 'bot', text);
      await this.persistMessage(session, 'bot', text, source, chunkId);
    };
  }

  private async persistMessage(
    session: SessionData,
    role: 'user' | 'bot' | 'admin',
    content: string,
    source: MessageSource | null,
    chunkId?: string,
  ): Promise<void> {
    try {
      let conv = await this.convRepo.findOne({ where: { phoneNumber: session.phoneNumber } });
      if (!conv) {
        conv = this.convRepo.create({ phoneNumber: session.phoneNumber });
        conv = await this.convRepo.save(conv);
      }
      await this.msgRepo.save(
        this.msgRepo.create({
          conversationId: conv.id,
          role:    role as MessageRole,
          content,
          source,
          chunkId: chunkId || null,
        }),
      );
    } catch (err) {
      this.logger.error(`Error persistiendo mensaje: ${err.message}`);
    }
  }
}
