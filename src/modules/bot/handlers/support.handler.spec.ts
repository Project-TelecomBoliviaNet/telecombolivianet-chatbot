import { SupportHandler } from './support.handler';
import { Intent } from '../../intent/intent-detector.service';
import { MessageSource } from '../../../database/entities/message.entity';
import { serializeAction } from '../../../common/pending-action';
import { SessionService } from '../../session/session.service';
import { SistemaApiService } from '../../client/sistema-api.service';
import { IntentDetectorService } from '../../intent/intent-detector.service';
import { AdminSignalrNotifierService } from '../../notifications/admin-signalr-notifier.service';
import { MessageFormatterService } from '../message-formatter.service';
import { RagService } from '../../rag/rag.service';

import { QueryReformulationService } from '../../rag/query-reformulation.service';
import { PseudonymService }        from '../../../common/security/pseudonym/pseudonym.service';
import { PiiGuardInterceptor }     from '../../../common/security/pseudonym/pii-guard.interceptor';

const mockPseudonymServiceS   = { pseudonymize: jest.fn().mockResolvedValue({ pseudonymizedText: 'texto', mappingKey: '', replacementsCount: 0 }), rehydrate: jest.fn().mockImplementation((t:string) => Promise.resolve(t)), invalidate: jest.fn().mockResolvedValue(undefined) };
const mockPiiGuardS           = { inspect: jest.fn().mockReturnValue({ hasLeak: false, detections: [], detectedTypes: [] }) };
const mockQueryReformulationS  = { reformulate: jest.fn().mockImplementation(async (q:string) => ({ query: q, originalQuery: q, wasReformulated: false })) };


// ══════════════════════════════════════════════════════════════
// TESTS UNITARIOS — SupportHandler (US-12, US-13, US-14)
// ══════════════════════════════════════════════════════════════

const makeSession = (overrides = {}) => ({
  phoneNumber: '59170000001',
  clientId: 'C001',
  clientName: 'Carlos López',
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

describe('SupportHandler', () => {
  let handler: SupportHandler;
  let send: jest.Mock;
  let session: any;
  let sistemaApi: any;
  let intentDetector: any;
  let adminNotifier: any;
  let formatter: any;
  let rag: any;

  beforeEach(() => {
    send = jest.fn().mockResolvedValue(undefined);

    session = {
      getContextText: jest.fn().mockResolvedValue('contexto'),
      updateSession: jest.fn().mockResolvedValue({}),
      setPendingAction: jest.fn().mockResolvedValue(undefined),
    } as any;

    sistemaApi = {
      createTicket: jest.fn().mockResolvedValue({ Id: 'TK-ABCD1234' }),
      closeTicket: jest.fn().mockResolvedValue(undefined),
      updateTicket: jest.fn().mockResolvedValue(undefined),
      buildTicketSubject: jest.fn().mockReturnValue('[Soporte Técnico] TBN001 – Carlos López – Alta'),
    };

    intentDetector = {
      getTicketPriority: jest.fn().mockReturnValue('Alta'),
      getTicketType: jest.fn().mockReturnValue('SoporteTecnico'),
    };

    adminNotifier = {
      notifyHighPriorityTicket: jest.fn().mockResolvedValue(undefined),
      notifyTicketCreated: jest.fn().mockResolvedValue(undefined),
    };

    formatter = {
      ragSupportGuide: jest.fn().mockReturnValue('guia rag'),
      ragNoSolution: jest.fn().mockReturnValue('sin solucion rag'),
      ticketCreated: jest.fn().mockReturnValue('ticket creado'),
      ticketClosed: jest.fn().mockReturnValue('ticket cerrado'),
      ticketUpdated: jest.fn().mockReturnValue('ticket actualizado'),
      confirmCloseTicket: jest.fn().mockReturnValue('confirmar cierre'),
    };

    rag = {
      query: jest.fn().mockResolvedValue({ found: false, answer: '' }),
    };

    handler = new SupportHandler(
      session as unknown as SessionService,
      sistemaApi as unknown as SistemaApiService,
      intentDetector as unknown as IntentDetectorService,
      adminNotifier as unknown as AdminSignalrNotifierService,
      formatter as unknown as MessageFormatterService,
      rag as unknown as RagService,
    );
  });

  // ─── handleTechSupport() ─────────────────────────────────
  describe('handleTechSupport() — US-12/13', () => {
    it('primero intenta RAG; si encuentra guía la envía y espera feedback', async () => {
      rag.query.mockResolvedValueOnce({ found: true, answer: 'Reinicia el router', chunkId: 'CK1' });
      await handler.handleTechSupport(Intent.PROBLEMA_ROUTER, 'router roto', makeSession(), send);

      expect(rag.query).toHaveBeenCalledWith('router roto', 'contexto', '59170000001', 'Carlos López');
      expect(formatter.ragSupportGuide).toHaveBeenCalledWith('Reinicia el router', undefined);
      expect(send).toHaveBeenCalledWith('guia rag', MessageSource.RAG, 'CK1');
      expect(sistemaApi.createTicket).not.toHaveBeenCalled();
    });

    it('crea ticket directamente si RAG no encuentra nada', async () => {
      await handler.handleTechSupport(Intent.SIN_CONEXION, 'sin internet', makeSession(), send);

      expect(sistemaApi.createTicket).toHaveBeenCalled();
      expect(formatter.ticketCreated).toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith('ticket creado', MessageSource.INTENT);
    });

    it('crea ticket directamente si RAG lanza error', async () => {
      rag.query.mockRejectedValueOnce(new Error('Gemini timeout'));
      await handler.handleTechSupport(Intent.VELOCIDAD_LENTA, 'lento', makeSession(), send);

      expect(sistemaApi.createTicket).toHaveBeenCalled();
    });

    it('notifica admin con alta prioridad para SIN_CONEXION', async () => {
      await handler.handleTechSupport(Intent.SIN_CONEXION, 'sin internet', makeSession(), send);

      expect(adminNotifier.notifyHighPriorityTicket).toHaveBeenCalledWith(
        expect.objectContaining({
          ticketId: 'TK-ABCD1234',
          clientName: 'Carlos López',
          phoneNumber: '59170000001',
        }),
      );
    });

    it('notifica con notifyTicketCreated para prioridad Media', async () => {
      intentDetector.getTicketPriority.mockReturnValue('Media');
      await handler.handleTechSupport(Intent.VELOCIDAD_LENTA, 'lento', makeSession(), send);

      expect(adminNotifier.notifyTicketCreated).toHaveBeenCalledWith(
        expect.objectContaining({ ticketId: 'TK-ABCD1234', priority: 'Media' }),
      );
    });

    it('envía error al usuario si la creación del ticket falla', async () => {
      sistemaApi.createTicket.mockRejectedValueOnce(new Error('DB error'));
      await handler.handleTechSupport(Intent.SIN_CONEXION, 'sin internet', makeSession(), send);

      expect(send).toHaveBeenCalledWith(expect.stringContaining('No pude procesar'));
    });
  });

  // ─── handleCloseTicket() ─────────────────────────────────
  describe('handleCloseTicket() — US-14', () => {
    it('pide ID de ticket manual si no hay ticket activo en sesión', async () => {
      await handler.handleCloseTicket(makeSession(), send);

      expect(session.setPendingAction).toHaveBeenCalledWith(
        '59170000001',
        serializeAction({ type: 'AWAITING_TICKET_ID_TO_CLOSE' }),
      );
      expect(send).toHaveBeenCalledWith(expect.stringContaining('número de ticket'), MessageSource.INTENT);
    });

    it('pide confirmación si hay ticket activo en sesión', async () => {
      await handler.handleCloseTicket(makeSession({ activeTicketId: 'TK999' }), send);

      expect(session.setPendingAction).toHaveBeenCalledWith(
        '59170000001',
        serializeAction({ type: 'CONFIRM_CLOSE_TICKET', ticketId: 'TK999' }),
      );
      expect(formatter.confirmCloseTicket).toHaveBeenCalledWith('TK999');
    });
  });

  // ─── confirmCloseTicket() ────────────────────────────────
  describe('confirmCloseTicket()', () => {
    it('cierra el ticket y notifica al admin cuando se confirma', async () => {
      await handler.confirmCloseTicket('TK001', true, makeSession(), send);

      expect(sistemaApi.closeTicket).toHaveBeenCalledWith('TK001', expect.any(String));
      expect(adminNotifier.notifyTicketCreated).toHaveBeenCalledWith(
        expect.objectContaining({ ticketId: 'TK001', priority: 'Cerrado' }),
      );
      expect(formatter.ticketClosed).toHaveBeenCalledWith('TK001');
    });

    it('mantiene el ticket abierto cuando se rechaza', async () => {
      await handler.confirmCloseTicket('TK001', false, makeSession(), send);

      expect(sistemaApi.closeTicket).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith(expect.stringContaining('sigue abierto'));
    });
  });

  // ─── handleRagFeedback() ──────────────────────────────────
  describe('handleRagFeedback()', () => {
    it('limpia el estado cuando el problema se resolvió', async () => {
      await handler.handleRagFeedback(true, 'sí', makeSession(), send);

      expect(session.setPendingAction).toHaveBeenCalledWith('59170000001', null);
      expect(send).toHaveBeenCalledWith(expect.stringContaining('Excelente'), MessageSource.SYSTEM);
      expect(sistemaApi.createTicket).not.toHaveBeenCalled();
    });

    it('crea ticket cuando el problema NO se resolvió', async () => {
      const sess = makeSession({
        pendingTechIssue: JSON.stringify({ intent: Intent.SIN_CONEXION, text: 'sin internet' }),
      });
      await handler.handleRagFeedback(false, 'no', sess, send);

      expect(formatter.ragNoSolution).toHaveBeenCalled();
      expect(sistemaApi.createTicket).toHaveBeenCalled();
    });

    it('usa defaults si pendingTechIssue es null', async () => {
      await handler.handleRagFeedback(false, 'no', makeSession(), send);

      expect(sistemaApi.createTicket).toHaveBeenCalled();
      // No lanza error aunque pendingTechIssue sea null
    });
  });

  // ─── handleManualTicketId() ───────────────────────────────
  describe('handleManualTicketId()', () => {
    it('rechaza IDs muy cortos (menos de 4 caracteres)', async () => {
      await handler.handleManualTicketId('AB', makeSession(), send);

      expect(send).toHaveBeenCalledWith(expect.stringContaining('No reconocí'), MessageSource.SYSTEM);
      expect(session.setPendingAction).not.toHaveBeenCalled();
    });

    it('normaliza y acepta ID válido', async () => {
      await handler.handleManualTicketId(' abcd1234 ', makeSession(), send);

      expect(session.setPendingAction).toHaveBeenCalledWith(
        '59170000001',
        serializeAction({ type: 'CONFIRM_CLOSE_TICKET', ticketId: 'ABCD1234' }),
      );
    });

    it('elimina caracteres no alfanuméricos del ID', async () => {
      await handler.handleManualTicketId('TK-001-X', makeSession(), send);

      expect(session.setPendingAction).toHaveBeenCalledWith(
        '59170000001',
        serializeAction({ type: 'CONFIRM_CLOSE_TICKET', ticketId: 'TK001X' }),
      );
    });
  });

  // ─── handleTicketDetails() ────────────────────────────────
  describe('handleTicketDetails()', () => {
    it('actualiza el ticket con detalles adicionales', async () => {
      await handler.handleTicketDetails('TK001', 'El router parpadea rojo y verde', makeSession(), send);

      expect(sistemaApi.updateTicket).toHaveBeenCalledWith('TK001', expect.stringContaining('El router parpadea'));
      expect(formatter.ticketUpdated).toHaveBeenCalled();
    });

    it('no actualiza si el texto es muy corto (≤5 chars)', async () => {
      await handler.handleTicketDetails('TK001', 'ok', makeSession(), send);

      expect(sistemaApi.updateTicket).not.toHaveBeenCalled();
    });
  });
});
