import { Injectable, Logger, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ImageIntentDetectorService } from '../intent/image-intent-detector.service';
import { buildImageClassificationPrompt } from '../intent/image-context.helper';
import { MediaStorageService } from '../media/media-storage.service';
import { SessionService, SessionData } from '../session/session.service';
import { ITicketRepository, TICKET_REPOSITORY } from '../client/sistema-api.interfaces';
import { WhatsappApiService } from '../whatsapp/whatsapp-api.service';
import { ReceiptHandlerService } from '../payments/receipt-handler.service';
import { AdminSignalrNotifierService } from '../notifications/admin-signalr-notifier.service';
import { AgentService } from './agent.service';
import { AgentToolRegistry } from './tools/agent-tool-registry.service';
import { ESCALATE_TOOL } from './tools/agent-tool.interface';
import { AudioTranscriberService } from './audio-transcriber.service';
import { BotConfigCacheService } from './bot-config-cache.service';
import { Conversation } from '../../database/entities/conversation.entity';
import { MessageSource } from '../../database/entities/message.entity';
import { MessageContext } from './pipeline/message-context';
import { MessageHandler, MESSAGE_PIPELINE } from './pipeline/message-handler';
import { MessageSenderService } from './pipeline/message-sender.service';
import { MessagePersistenceService } from './pipeline/message-persistence.service';

// ══════════════════════════════════════════════════════════════
// BOT ORCHESTRATOR SERVICE — FIX-21 (Chain of Responsibility)
//
// El orquestador ahora es delgado: ejecuta el pipeline de handlers
// y luego delega la lógica core de agente IA al método processCoreLogic.
//
// Pipeline de pre-procesamiento (handlers registrados en MESSAGE_PIPELINE):
//   1. MarkAsReadHandler       — marca como leído + entrega mensajes pendientes
//   2. SessionLoadHandler      — carga sesión Redis
//   3. MediaDownloadHandler    — descarga audio/imagen, computa userContent
//   4. EscalationCheckHandler  — detiene si conversación está escalada
//   5. MessagePersistHandler   — persiste mensaje usuario + detecta primer contacto
//   6. ScheduleCheckHandler    — responde fuera de horario y detiene
//   7. ClientIdentificationHandler — identifica cliente + guarda ubicación
//
// Después del pipeline → processCoreLogic (enrutado de imágenes, resolución
// de texto, ejecución del agente IA, envío de respuesta, efectos post-agente).
// ══════════════════════════════════════════════════════════════

export interface IncomingMessage {
  from: string;
  messageId: string;
  type: string;
  text?: string;
  interactiveId?: string;
  imageId?: string;
  imageCaption?: string;
  audioId?: string;
  locationLat?: number;
  locationLng?: number;
  locationName?: string;
  locationAddress?: string;
  contactName?: string;
}

const INTERACTIVE_MAP: Record<string, string> = {
  reagendar_si:          'Sí, quiero reagendar mi instalación',
  reagendar_no:          'No, gracias. No quiero reagendar.',
  consulta_deuda:        'Quiero consultar mi deuda y facturas pendientes',
  solicitar_qr:          'Quiero obtener el código QR para pagar',
  sin_conexion:          'Tengo un problema técnico con mi internet',
  velocidad_lenta:       'Mi internet está muy lento',
  problema_router:       'Tengo problemas con mi router o módem',
  solicitar_instalacion: 'Quiero agendar o consultar mi instalación',
  solicitar_agente:      'Quiero hablar con un agente humano',
  consulta_periodo:      'Quiero saber información sobre el periodo de pago',
  menu:                  'Ver el menú de opciones disponibles',
};

@Injectable()
export class BotOrchestratorService {
  private readonly logger = new Logger(BotOrchestratorService.name);

  constructor(
    @Inject(MESSAGE_PIPELINE) private readonly pipeline: MessageHandler[],
    private readonly session:              SessionService,
    @Inject(TICKET_REPOSITORY) private readonly ticketRepo: ITicketRepository,
    private readonly whatsapp:             WhatsappApiService,
    private readonly receiptHandler:       ReceiptHandlerService,
    private readonly adminNotifier:        AdminSignalrNotifierService,
    private readonly agent:                AgentService,
    private readonly toolRegistry:         AgentToolRegistry,
    private readonly audioTranscriber:     AudioTranscriberService,
    private readonly botConfigCache:       BotConfigCacheService,
    private readonly imageIntentDetector:  ImageIntentDetectorService,
    private readonly mediaStorage:         MediaStorageService,
    private readonly sender:               MessageSenderService,
    private readonly persistence:          MessagePersistenceService,
    @InjectRepository(Conversation) private readonly convRepo: Repository<Conversation>,
  ) {}

  // ─── ENTRADA PRINCIPAL ────────────────────────────────────
  async handleIncoming(incoming: IncomingMessage): Promise<void> {
    await this.executeFullPipeline(incoming);
  }

  // ─── MOTOR DEL PIPELINE ───────────────────────────────────
  private async executeFullPipeline(incoming: IncomingMessage): Promise<void> {
    const ctx: MessageContext = {
      phone:           incoming.from,
      messageId:       incoming.messageId,
      type:            incoming.type,
      text:            incoming.text,
      interactiveId:   incoming.interactiveId,
      imageId:         incoming.imageId,
      imageCaption:    incoming.imageCaption,
      audioId:         incoming.audioId,
      locationLat:     incoming.locationLat,
      locationLng:     incoming.locationLng,
      locationName:    incoming.locationName,
      locationAddress: incoming.locationAddress,
    };

    let index = 0;
    const run = async (): Promise<void> => {
      if (index < this.pipeline.length) {
        await this.pipeline[index++].handle(ctx, run);
      } else {
        await this.processCoreLogic(ctx);
      }
    };
    await run();
  }

  // ─── LÓGICA CORE: enrutado, agente IA, efectos ───────────
  private async processCoreLogic(ctx: MessageContext): Promise<void> {
    const session = ctx.updatedSession!;

    // Imagen → enrutar según intención y terminar
    if (ctx.type === 'image' && ctx.imageId) {
      await this.handleImage(ctx.imageId, ctx.imageCaption, session, ctx.imageMediaUrl);
      return;
    }

    // Resolver texto efectivo
    let effectiveText: string | null | undefined;
    if (ctx.interactiveId) {
      effectiveText = INTERACTIVE_MAP[ctx.interactiveId] ?? ctx.interactiveId;
    } else if (ctx.type === 'audio') {
      effectiveText = await this.handleAudioBuffer(ctx.audioBuffer, session);
    } else if (ctx.type === 'location') {
      effectiveText = ctx.userContent;
    } else {
      effectiveText = ctx.text;
    }

    if (!effectiveText?.trim()) return;

    // Clasificación de imagen pendiente
    if (session.pendingAction === 'AWAITING_IMAGE_TYPE') {
      const handled = await this.handlePendingImageTypeResponse(effectiveText.trim(), session);
      if (handled) return;
    }

    // Historial para el agente (excluye el mensaje actual)
    const fullHistory = await this.session.getGeminiHistory(ctx.phone);
    const history     = fullHistory.slice(0, -1);

    // Detección de sentimiento (paralelo, no bloquea)
    const lastBotMsg = history.filter(m => m.role === 'model').at(-1)?.parts[0]?.text;
    this.agent.detectSentiment(effectiveText, lastBotMsg)
      .then((sentiment) => this.session.updateSentiment(ctx.phone, sentiment))
      .catch((err: unknown) => {
        this.logger.warn(`Sentimiento ${ctx.phone}: ${(err as Error)?.message ?? String(err)}`);
      });

    // Primer contacto → menú de bienvenida y salir (el agente no procesa el primer texto)
    if (ctx.isFirstContact) {
      await this.sendWelcomeListMenu(session);
      return;
    }

    const { executor, getMediaSent } = this.toolRegistry.buildExecutor(session);
    const toolDeclarations            = this.toolRegistry.getDeclarations();

    // Obtener config para inyectar NoEntendido en el prompt del agente (ISP)
    const cfg = await this.botConfigCache.getConfig();
    const noEntendidoCtx = `Si no entiendes la consulta del usuario, responde EXACTAMENTE: "${cfg.Mensajes.NoEntendido}"`;

    let response: string;
    let toolsCalled: string[];

    try {
      ({ response, toolsCalled } = await this.agent.run(
        effectiveText, session, history, executor, toolDeclarations, noEntendidoCtx,
      ));
    } catch (err) {
      this.logger.error(`AgentService.run error: ${(err as Error).message}`);
      response    = '😔 Tuve un problema procesando tu consulta. Por favor intenta de nuevo.';
      toolsCalled = [];
    }

    // Persistir imágenes enviadas por tools (ej. QR)
    for (const media of getMediaSent()) {
      await this.persistence.persistMessage(
        session, 'bot', '[imagen]', MessageSource.INTENT,
        undefined, media.localUrl, media.mediaType,
      );
    }

    await this.sender.send(session, response, MessageSource.AGENT);

    // Efectos post-agente
    if (toolsCalled.includes(ESCALATE_TOOL)) {
      await this.triggerEscalation(session);
    }
    if (toolsCalled.includes('close_support_ticket')) {
      await this.maybeSendSatisfactionSurvey(session);
    }
  }

  // ─── ENRUTADOR DE IMÁGENES ────────────────────────────────
  private async handleImage(
    imageId: string,
    caption: string | undefined,
    session: SessionData,
    localImageUrl?: string,
  ): Promise<void> {
    const intent = this.imageIntentDetector.detect(caption);

    if (intent === 'payment') {
      await this.handleReceipt(imageId, caption, session);
      return;
    }
    if (intent === 'technical') {
      await this.handleTechnicalSupportImage(imageId, caption, session, localImageUrl);
      return;
    }

    await this.session.updateSession(session.phoneNumber, {
      pendingImageId:      imageId,
      pendingImageCaption: caption ?? null,
      pendingAction:       'AWAITING_IMAGE_TYPE',
    });
    await this.sender.send(
      session,
      buildImageClassificationPrompt(caption),
    );
  }

  // ─── IMAGEN DE SOPORTE TÉCNICO ────────────────────────────
  private async handleTechnicalSupportImage(
    imageId: string,
    caption: string | undefined,
    session: SessionData,
    localImageUrl?: string,
  ): Promise<void> {
    if (!session.clientId || session.clientName === '__prospect__') {
      await this.handleReceipt(imageId, caption, session);
      return;
    }

    try {
      const imageUrl = localImageUrl
        ?? await this.mediaStorage.saveMedia(await this.whatsapp.downloadMedia(imageId), 'image', imageId);

      const result = await this.ticketRepo.createTicket({
        ClientId:    session.clientId,
        Subject:     `[WhatsApp] Soporte técnico con imagen — ${session.tbnCode ?? session.clientName}`,
        Type:        'SoporteTecnico',
        Priority:    'Media',
        Description: caption ? `Imagen enviada por el cliente: "${caption}"` :
                     'El cliente envió una imagen de su equipo reportando un problema técnico.',
        Origin:      'Bot',
        AutoAssign:  true,
        ImageUrl:    imageUrl,
      });

      const ticketNum = result.TicketNumber ?? `#${result.Id.substring(0, 8)}`;
      await this.sender.send(
        session,
        `🔧 *${session.clientName}*, recibí la foto de tu equipo.\n\n` +
        `Se creó el ticket de soporte *${ticketNum}*. Un técnico revisará tu caso pronto. 🙏`,
        MessageSource.INTENT,
      );
    } catch (err) {
      this.logger.error(`Error creando ticket técnico: ${(err as Error).message}`);
      await this.sender.send(
        session,
        '😔 Hubo un problema al registrar tu solicitud. Por favor intenta de nuevo o describe el problema con texto.',
      );
    }
  }

  // ─── RESPUESTA A CLASIFICACIÓN DE IMAGEN ─────────────────
  private async handlePendingImageTypeResponse(text: string, session: SessionData): Promise<boolean> {
    const { pendingImageId, pendingImageCaption } = session;

    if (!pendingImageId) {
      await this.session.updateSession(session.phoneNumber, {
        pendingAction: null, pendingImageId: null, pendingImageCaption: null,
      });
      return false;
    }

    const choice = text.charAt(0);

    if (choice === '1') {
      await this.session.updateSession(session.phoneNumber, {
        pendingAction: null, pendingImageId: null, pendingImageCaption: null,
      });
      await this.handleReceipt(pendingImageId, pendingImageCaption ?? undefined, session);
      return true;
    }

    if (choice === '2') {
      await this.session.updateSession(session.phoneNumber, {
        pendingAction: null, pendingImageId: null, pendingImageCaption: null,
      });
      await this.handleTechnicalSupportImage(pendingImageId, pendingImageCaption ?? undefined, session);
      return true;
    }

    // Si el texto es claramente una nueva consulta (no "1" o "2"), cancelar la espera
    // y dejar que el agente responda normalmente en lugar de bloquear la conversación.
    if (text.length > 3 || /[a-zA-ZáéíóúÁÉÍÓÚüÜñÑ]/.test(choice)) {
      await this.session.updateSession(session.phoneNumber, {
        pendingAction: null, pendingImageId: null, pendingImageCaption: null,
      });
      return false;
    }

    await this.sender.send(session, '❓ Por favor responde *1* para comprobante de pago o *2* para soporte técnico.');
    return true;
  }

  // ─── COMPROBANTE DE PAGO ──────────────────────────────────
  private async handleReceipt(imageId: string, caption: string | undefined, session: SessionData): Promise<void> {
    const ocrResult = await this.receiptHandler.handle(imageId, caption, session);

    if (!ocrResult) {
      await this.sender.send(session, '😔 Hubo un problema al procesar tu comprobante. Por favor envíalo de nuevo.');
      return;
    }

    if (!ocrResult.isReceipt) {
      await this.sender.send(
        session,
        '📋 La imagen que enviaste no parece ser un comprobante de pago.\n\n' +
        'Por favor envía una foto o captura de tu comprobante bancario, transferencia, pago QR, o recibo en efectivo. 🙏',
        MessageSource.SYSTEM,
      );
      return;
    }

    const isKnownClient = session.clientName && session.clientName !== '__prospect__';
    const isCash        = ocrResult.receiptType === 'cash';

    let msg: string;
    if (isCash) {
      const nameStr = isKnownClient ? `*${session.clientName}*, ` : '';
      msg = `🧾 ${nameStr}recibimos la foto de tu recibo de pago en efectivo.\n\n` +
            `Nuestro equipo lo verificará. Si el pago ya fue registrado por el cobrador, no es necesario hacer nada más. 🙏`;
    } else if (isKnownClient) {
      const parts = [`✅ *${session.clientName}*, recibimos tu comprobante de pago.`];
      if (ocrResult.amount) parts.push(`💰 Monto detectado: *Bs. ${ocrResult.amount.toFixed(2)}*`);
      if (ocrResult.bank)   parts.push(`🏦 Banco: *${ocrResult.bank}*`);
      if (ocrResult.date)   parts.push(`📅 Fecha: *${ocrResult.date}*`);
      parts.push('\nNuestro equipo verificará el pago en las próximas horas. ¡Gracias! 🙏');
      msg = parts.join('\n');
    } else {
      msg = '✅ Recibimos tu comprobante. Si eres cliente, nuestro equipo verificará el pago. ¡Gracias!';
    }

    await this.sender.send(session, msg, MessageSource.INTENT);
  }

  // ─── F3: TRANSCRIPCIÓN DE AUDIO ───────────────────────────
  private async handleAudioBuffer(audioBuffer: Buffer | null | undefined, session: SessionData): Promise<string | null> {
    const transcript = audioBuffer
      ? await this.audioTranscriber.transcribeBuffer(audioBuffer, 'audio/ogg; codecs=opus')
      : null;

    if (!transcript) {
      await this.sender.send(
        session,
        '🎤 No pude transcribir tu nota de voz. Te voy a conectar con un agente para que pueda ayudarte. 👤',
        MessageSource.SYSTEM,
      );
      await this.triggerEscalation(session);
      return null;
    }

    return transcript;
  }

  // ─── MENÚ DE BIENVENIDA NATIVO ────────────────────────────
  private async sendWelcomeListMenu(session: SessionData): Promise<void> {
    const isProspect = !session.clientId;
    const cfg        = await this.botConfigCache.getConfig();
    const nombre     = isProspect ? '' : (session.clientName ?? '');
    const template   = isProspect
      ? (cfg.Mensajes.BienvenidaProspecto || cfg.Mensajes.Bienvenida)
      : cfg.Mensajes.Bienvenida;
    const greeting   = template.replace(/\{+nombre\}+/gi, nombre).trim();

    const activeOptions = cfg.Menu.Opciones.filter(o =>
      o.Activa && (isProspect ? !o.SoloCliente : true),
    );
    const rows = activeOptions.map(o => ({
      id:          o.Intent.toLowerCase(),
      title:       o.Etiqueta,
      description: o.Descripcion ?? '',
    }));

    if (rows.length === 0) return;

    try {
      await this.whatsapp.sendList(
        session.phoneNumber, greeting, cfg.Menu.TituloBoton,
        [{ title: cfg.Menu.TituloSeccion, rows }],
      );
    } catch (err: unknown) {
      this.logger.warn(`sendList falló para ${session.phoneNumber}: ${(err as Error).message} — enviando texto plano`);
      const fallback = rows.map((r, i) => `${i + 1}. ${r.title}`).join('\n');
      await this.sender.send(session, `${greeting}\n\n${fallback}`);
    }
  }

  // ─── ESCALADO AL ADMIN ────────────────────────────────────
  async triggerEscalation(session: SessionData): Promise<void> {
    const cfg = await this.botConfigCache.getConfig();
    await this.whatsapp.sendText(session.phoneNumber, cfg.Mensajes.EscaladoAgente);
    await this.session.escalate(session.phoneNumber);

    let summary = '';
    try {
      const history = await this.session.getGeminiHistory(session.phoneNumber);
      summary = await this.agent.summarizeConversation(history);
    } catch (err) {
      this.logger.warn(`No se pudo generar resumen de escalación: ${(err as Error).message}`);
    }

    await this.convRepo.update(
      { phoneNumber: session.phoneNumber },
      { isEscalated: true, escalatedAt: new Date(), ...(summary ? { summary } : {}) },
    );

    this.logger.log(JSON.stringify({
      event: 'escalation_triggered', phone: session.phoneNumber,
      clientName: session.clientName, hasSummary: !!summary,
    }));

    await this.adminNotifier.notifyEscalation({
      phoneNumber: session.phoneNumber,
      clientName:  session.clientName ?? undefined,
      reason:      'Escalado via agente IA',
    });
  }

  // ─── ENCUESTA DE SATISFACCIÓN ─────────────────────────────
  private async maybeSendSatisfactionSurvey(session: SessionData): Promise<void> {
    const current = await this.session.getSession(session.phoneNumber);
    if (current.ratingSent) return;

    const survey =
      '⭐ ¿Cómo calificarías la atención recibida hoy?\n\n' +
      '1️⃣ Muy mala\n2️⃣ Mala\n3️⃣ Regular\n4️⃣ Buena\n5️⃣ Excelente\n\n' +
      'Escribe el número de tu calificación 😊';

    await this.whatsapp.sendText(session.phoneNumber, survey);
    await this.session.updateSession(session.phoneNumber, { ratingSent: true });

    this.logger.log(JSON.stringify({ event: 'satisfaction_survey_sent', phone: session.phoneNumber }));
  }
}
