import { BotOrchestratorService } from './bot-orchestrator.service';
import { Intent } from '../intent/intent-detector.service';
import { MessageSource } from '../../database/entities/message.entity';
import { serializeAction } from '../../common/pending-action';

import { PseudonymService }        from '../../common/security/pseudonym/pseudonym.service';
import { PiiGuardInterceptor }     from '../../common/security/pseudonym/pii-guard.interceptor';
import { QueryReformulationService } from '../rag/query-reformulation.service';
import { FaqMatcherService }        from '../faq/faq-matcher.service';

const mockPseudonymService  = { pseudonymize: jest.fn().mockResolvedValue({ pseudonymizedText: 'texto', mappingKey: '', replacementsCount: 0 }), rehydrate: jest.fn().mockImplementation((t:string) => Promise.resolve(t)), invalidate: jest.fn().mockResolvedValue(undefined) };
const mockPiiGuard          = { inspect: jest.fn().mockReturnValue({ hasLeak: false, detections: [], detectedTypes: [] }) };
const mockQueryReformulation = { reformulate: jest.fn().mockImplementation(async (q:string) => ({ query: q, originalQuery: q, wasReformulated: false })) };

const mockConvSummary = {
  summarize: jest.fn().mockResolvedValue({
    summary: 'MOTIVO: Prueba\nINTENTADO: Bot\nESTADO: Activo\nCLIENTE: Sin datos',
    category: 'OTRO',
    categoryLabel: 'Otro',
    isAiGenerated: true,
  }),
};
const mockFaqMatcherService  = { match: jest.fn().mockResolvedValue({ found: false, answer: '', score: 0, faqId: '', faqQuestion: '' }) };


// ══════════════════════════════════════════════════════════════
// TESTS UNITARIOS — BotOrchestratorService
// Verifica el routing de intents, la gestión de pending actions,
// el pipeline RAG y el escalado. Todos los handlers y servicios
// están mockeados — este test solo valida la orquestación.
// ══════════════════════════════════════════════════════════════

const PHONE = '59170000001';

const makeSession = (overrides = {}) => ({
  phoneNumber: PHONE,
  clientId: 'C001',
  clientName: 'Test User',
  clientStatus: 'Activo',
  planName: 'Plan Plata',
  totalDebt: 0,
  tbnCode: 'TBN001',
  activeTicketId: null,
  activeInstallationId: null,
  pendingAction: null,
  pendingTechIssue: null,
  isEscalated: false,
  ragFailCount: 0,
  messages: [],
  ...overrides,
});

const makeIncoming = (overrides = {}) => ({
  from: PHONE,
  messageId: 'MSG001',
  type: 'text',
  text: 'hola',
  ...overrides,
});

describe('BotOrchestratorService', () => {
  let orchestrator: BotOrchestratorService;
  let sessionSvc: any;
  let sistemaApi: any;
  let intentDetector: any;
  let whatsapp: any;
  let formatter: any;
  let rag: any;
  let adminNotifier: any;
  let payments: any;
  let support: any;
  let installation: any;
  let convRepo: any;
  let msgRepo: any;
  let config: any;

  beforeEach(() => {
    const currentSession = makeSession();

    sessionSvc = {
      getSession: jest.fn().mockResolvedValue(currentSession),
      addMessage: jest.fn().mockResolvedValue(undefined),
      updateSession: jest.fn().mockResolvedValue({}),
      setPendingAction: jest.fn().mockResolvedValue(undefined),
      escalate: jest.fn().mockResolvedValue(undefined),
      resetRagFail: jest.fn().mockResolvedValue(undefined),
      incrementRagFail: jest.fn().mockResolvedValue(1),
      getContextText: jest.fn().mockResolvedValue('contexto'),
    };

    sistemaApi = {
      getClientByPhone: jest.fn().mockResolvedValue(null),
    };

    intentDetector = {
      detect: jest.fn().mockResolvedValue(Intent.SALUDO),
    };

    whatsapp = {
      markAsRead: jest.fn().mockResolvedValue(undefined),
      sendText: jest.fn().mockResolvedValue('msg-id'),
    };

    formatter = {
      welcome:          jest.fn().mockReturnValue('bienvenido cliente'),
      welcomeProspect:  jest.fn().mockReturnValue('bienvenido prospecto'),
      escalationNotice: jest.fn().mockReturnValue('escalando'),
      fallbackMenu:     jest.fn().mockReturnValue('menú fallback'),
      ragAnswer:        jest.fn().mockReturnValue('respuesta rag con fuente'),
    };

    rag = {
      query: jest.fn().mockResolvedValue({ found: false, answer: '' }),
    };

    adminNotifier = {
      notifyEscalation: jest.fn().mockResolvedValue(undefined),
    };

    payments = {
      handleDebt: jest.fn().mockResolvedValue(undefined),
      handlePaymentPeriodInfo: jest.fn().mockResolvedValue(undefined),
      handleQr: jest.fn().mockResolvedValue(undefined),
      handleReceipt: jest.fn().mockResolvedValue(undefined),
    };

    support = {
      handleTechSupport: jest.fn().mockResolvedValue(undefined),
      handleCloseTicket: jest.fn().mockResolvedValue(undefined),
      confirmCloseTicket: jest.fn().mockResolvedValue(undefined),
      handleTicketDetails: jest.fn().mockResolvedValue(undefined),
      handleRagFeedback: jest.fn().mockResolvedValue(undefined),
      handleManualTicketId: jest.fn().mockResolvedValue(undefined),
    };

    installation = {
      handleInstallationRequest: jest.fn().mockResolvedValue(undefined),
      handleCancelInstallation: jest.fn().mockResolvedValue(undefined),
      confirmCancelInstallation: jest.fn().mockResolvedValue(undefined),
      handleSlotSelection: jest.fn().mockResolvedValue(undefined),
      handleAddressAndConfirm: jest.fn().mockResolvedValue(undefined),
    };

    convRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockReturnValue({ id: 'CONV1', phoneNumber: PHONE }),
      save: jest.fn().mockResolvedValue({ id: 'CONV1' }),
      update: jest.fn().mockResolvedValue(undefined),
      upsert: jest.fn().mockResolvedValue(undefined),
    };

    msgRepo = {
      create: jest.fn().mockReturnValue({}),
      save: jest.fn().mockResolvedValue({}),
    };

    config = {
      get: jest.fn((key: string) => {
        if (key === 'bot.maxRagAttempts') return 2;
        return undefined;
      }),
    };

    orchestrator = new BotOrchestratorService(
      config, sessionSvc, sistemaApi, intentDetector,
      whatsapp, formatter, rag, adminNotifier,
      payments, support, installation, mockConvSummary as any, convRepo, msgRepo,
    );
  });

  // ─── handleIncoming() — flujo principal ──────────────────
  describe('handleIncoming()', () => {
    it('marca el mensaje como leído al inicio', async () => {
      await orchestrator.handleIncoming(makeIncoming());
      expect(whatsapp.markAsRead).toHaveBeenCalledWith('MSG001');
    });

    it('silencia el bot y persiste si la conversación está escalada', async () => {
      sessionSvc.getSession.mockResolvedValueOnce(makeSession({ isEscalated: true }));
      await orchestrator.handleIncoming(makeIncoming({ text: 'necesito ayuda' }));

      expect(intentDetector.detect).not.toHaveBeenCalled();
      expect(whatsapp.sendText).not.toHaveBeenCalled();
    });

    it('ignora mensajes de texto vacíos', async () => {
      await orchestrator.handleIncoming(makeIncoming({ text: '   ' }));
      expect(intentDetector.detect).not.toHaveBeenCalled();
    });

    it('delega imágenes a payments.handleReceipt', async () => {
      await orchestrator.handleIncoming(makeIncoming({
        type: 'image',
        imageId: 'IMG001',
        imageCaption: 'comprobante',
      }));
      expect(payments.handleReceipt).toHaveBeenCalledWith('IMG001', 'comprobante', expect.any(Object), expect.any(Function));
    });

    it('resuelve botones interactivos (reagendar_si → instalar)', async () => {
      intentDetector.detect.mockResolvedValueOnce(Intent.SOLICITAR_INSTALACION);
      await orchestrator.handleIncoming(makeIncoming({
        text: undefined,
        interactiveId: 'reagendar_si',
      }));
      expect(intentDetector.detect).toHaveBeenCalledWith('instalar', '59170000001', 'Test User');
    });
  });

  // ─── routeIntent() — routing de intents ──────────────────
  describe('routeIntent()', () => {
    const runIntent = async (intent: Intent, sessionOverrides = {}) => {
      intentDetector.detect.mockResolvedValueOnce(intent);
      sessionSvc.getSession.mockResolvedValue(makeSession(sessionOverrides));
      await orchestrator.handleIncoming(makeIncoming({ text: 'test' }));
    };

    it('SALUDO → envía bienvenida de prospecto si no hay clientId', async () => {
      await runIntent(Intent.SALUDO, { clientId: null });
      expect(formatter.welcomeProspect).toHaveBeenCalled();
    });

    it('SALUDO → envía bienvenida de cliente si hay clientId', async () => {
      await runIntent(Intent.SALUDO, { clientId: 'C001' });
      expect(formatter.welcome).toHaveBeenCalled();
    });

    it('CONSULTA_DEUDA → delega a payments.handleDebt para cliente', async () => {
      await runIntent(Intent.CONSULTA_DEUDA, { clientId: 'C001' });
      expect(payments.handleDebt).toHaveBeenCalled();
    });

    it('CONSULTA_DEUDA → mensaje de prospecto si sin clientId', async () => {
      await runIntent(Intent.CONSULTA_DEUDA, { clientId: null });
      expect(whatsapp.sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('⚠️'));
      expect(payments.handleDebt).not.toHaveBeenCalled();
    });

    it('SOLICITAR_QR → delega a payments.handleQr para cliente', async () => {
      await runIntent(Intent.SOLICITAR_QR, { clientId: 'C001' });
      expect(payments.handleQr).toHaveBeenCalled();
    });

    it('SIN_CONEXION → delega a support.handleTechSupport para cliente', async () => {
      await runIntent(Intent.SIN_CONEXION, { clientId: 'C001' });
      expect(support.handleTechSupport).toHaveBeenCalledWith(
        Intent.SIN_CONEXION, 'test', expect.any(Object), expect.any(Function),
      );
    });

    it('VELOCIDAD_LENTA → delega a support.handleTechSupport', async () => {
      await runIntent(Intent.VELOCIDAD_LENTA, { clientId: 'C001' });
      expect(support.handleTechSupport).toHaveBeenCalled();
    });

    it('CERRAR_TICKET → delega a support.handleCloseTicket', async () => {
      await runIntent(Intent.CERRAR_TICKET, { clientId: 'C001' });
      expect(support.handleCloseTicket).toHaveBeenCalled();
    });

    it('SOLICITAR_INSTALACION → delega a installation.handleInstallationRequest', async () => {
      await runIntent(Intent.SOLICITAR_INSTALACION);
      expect(installation.handleInstallationRequest).toHaveBeenCalled();
    });

    it('CANCELAR_INSTALACION → delega a installation.handleCancelInstallation', async () => {
      await runIntent(Intent.CANCELAR_INSTALACION, { clientId: 'C001' });
      expect(installation.handleCancelInstallation).toHaveBeenCalled();
    });

    it('SOLICITAR_AGENTE → dispara escalado', async () => {
      await runIntent(Intent.SOLICITAR_AGENTE);
      expect(sessionSvc.escalate).toHaveBeenCalled();
      expect(adminNotifier.notifyEscalation).toHaveBeenCalled();
    });

    it('NINGUNO → activa pipeline RAG', async () => {
      await runIntent(Intent.NINGUNO);
      expect(rag.query).toHaveBeenCalled();
    });
  });

  // ─── handlePendingAction() — despacho a handlers ─────────
  describe('handlePendingAction()', () => {
    const runWithPending = async (pendingAction: string, intent: Intent, text = 'sí') => {
      intentDetector.detect.mockResolvedValueOnce(intent);
      sessionSvc.getSession.mockResolvedValue(makeSession({ pendingAction }));
      await orchestrator.handleIncoming(makeIncoming({ text }));
    };

    it('CONFIRM_CLOSE_TICKET + CONFIRMAR → llama confirmCloseTicket(true)', async () => {
      const action = serializeAction({ type: 'CONFIRM_CLOSE_TICKET', ticketId: 'TK001' });
      await runWithPending(action, Intent.CONFIRMAR);
      expect(support.confirmCloseTicket).toHaveBeenCalledWith('TK001', true, expect.any(Object), expect.any(Function));
    });

    it('CONFIRM_CLOSE_TICKET + CANCELAR → llama confirmCloseTicket(false)', async () => {
      const action = serializeAction({ type: 'CONFIRM_CLOSE_TICKET', ticketId: 'TK001' });
      await runWithPending(action, Intent.CANCELAR, 'no');
      expect(support.confirmCloseTicket).toHaveBeenCalledWith('TK001', false, expect.any(Object), expect.any(Function));
    });

    it('CONFIRM_CANCEL_INSTALLATION + CONFIRMAR → llama confirmCancelInstallation(true)', async () => {
      const action = serializeAction({ type: 'CONFIRM_CANCEL_INSTALLATION', installationId: 'INST001' });
      await runWithPending(action, Intent.CONFIRMAR);
      expect(installation.confirmCancelInstallation).toHaveBeenCalledWith('INST001', true, expect.any(Object), expect.any(Function));
    });

    it('AWAITING_SLOT_SELECTION → delega a handleSlotSelection', async () => {
      const action = serializeAction({ type: 'AWAITING_SLOT_SELECTION' });
      await runWithPending(action, Intent.NINGUNO, 'Lunes 09:00');
      expect(installation.handleSlotSelection).toHaveBeenCalledWith('Lunes 09:00', expect.any(Object), expect.any(Function));
    });

    it('AWAITING_ADDRESS → delega a handleAddressAndConfirm con fecha y hora', async () => {
      const action = serializeAction({ type: 'AWAITING_ADDRESS', slotDate: '2025-06-09', slotTime: '09:00' });
      await runWithPending(action, Intent.NINGUNO, 'Av. Principal 123');
      expect(installation.handleAddressAndConfirm).toHaveBeenCalledWith(
        'Av. Principal 123', '2025-06-09', '09:00', expect.any(Object), expect.any(Function),
      );
    });

    it('AWAITING_RAG_FEEDBACK + CONFIRMAR → llama handleRagFeedback(true)', async () => {
      const action = serializeAction({ type: 'AWAITING_RAG_FEEDBACK' });
      await runWithPending(action, Intent.CONFIRMAR);
      expect(support.handleRagFeedback).toHaveBeenCalledWith(true, 'sí', expect.any(Object), expect.any(Function));
    });

    it('AWAITING_TICKET_ID_TO_CLOSE → delega a handleManualTicketId', async () => {
      const action = serializeAction({ type: 'AWAITING_TICKET_ID_TO_CLOSE' });
      await runWithPending(action, Intent.NINGUNO, 'ABCD1234');
      expect(support.handleManualTicketId).toHaveBeenCalledWith('ABCD1234', expect.any(Object), expect.any(Function));
    });

    it('pendingAction inválido/desconocido → limpia y procesa como intent normal', async () => {
      await runWithPending('GARBAGE_STATE', Intent.SALUDO);
      expect(sessionSvc.setPendingAction).toHaveBeenCalledWith(PHONE, null);
    });
  });

  // ─── handleRag() — pipeline RAG ──────────────────────────
  describe('handleRag() — US-15', () => {
    const runRag = async (ragResult: any, ragFailCount = 0) => {
      intentDetector.detect.mockResolvedValueOnce(Intent.NINGUNO);
      rag.query.mockResolvedValueOnce(ragResult);
      sessionSvc.getSession.mockResolvedValue(makeSession({ ragFailCount }));
      sessionSvc.incrementRagFail.mockResolvedValueOnce(ragFailCount + 1);
      await orchestrator.handleIncoming(makeIncoming({ text: 'pregunta libre' }));
    };

    it('envía respuesta RAG cuando se encuentra resultado', async () => {
      await runRag({ found: true, answer: 'Respuesta del RAG', chunkId: 'CK1' });
      expect(sessionSvc.resetRagFail).toHaveBeenCalled();
      expect(whatsapp.sendText).toHaveBeenCalledWith(PHONE, 'respuesta rag con fuente');
      expect(formatter.ragAnswer).toHaveBeenCalledWith('Respuesta del RAG', undefined);
    });

    it('muestra menú fallback en el primer fallo RAG', async () => {
      await runRag({ found: false, answer: '' }, 0);
      expect(formatter.fallbackMenu).toHaveBeenCalled();
      expect(sessionSvc.escalate).not.toHaveBeenCalled();
    });

    it('escala al admin tras maxRagAttempts (2) fallos consecutivos', async () => {
      intentDetector.detect.mockResolvedValueOnce(Intent.NINGUNO);
      rag.query.mockResolvedValueOnce({ found: false, answer: '' });
      sessionSvc.getSession.mockResolvedValue(makeSession({ ragFailCount: 1 }));
      sessionSvc.incrementRagFail.mockResolvedValueOnce(2);
      await orchestrator.handleIncoming(makeIncoming({ text: 'pregunta' }));

      expect(sessionSvc.escalate).toHaveBeenCalled();
      expect(adminNotifier.notifyEscalation).toHaveBeenCalled();
    });
  });
});
