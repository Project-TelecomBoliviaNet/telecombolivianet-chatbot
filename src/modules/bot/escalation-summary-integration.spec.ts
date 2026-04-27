/**
 * @file escalation-summary-integration.spec.ts
 * @description Tests de integración: triggerEscalation con resumen y categoría (US-EP06-01/02).
 *
 * Criterios de aceptación validados:
 *   AC-01: triggerEscalation llama a ConversationSummaryService.summarize().
 *   AC-02: El resumen y la categoría se incluyen en notifyEscalation().
 *   AC-03: El resumen y la categoría se persisten en la BD (convRepo.update).
 *   AC-04: Si summarize() falla, el escalado continúa sin resumen (no lanza).
 *   AC-05: El usuario recibe el mensaje de escalado independientemente del resumen.
 */

import { BotOrchestratorService } from './bot-orchestrator.service';
import { MessageSource }          from '../../database/entities/message.entity';
import { EscalationCategory }     from './conversation-summary.service';
import { SessionData }            from '../session/session.service';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    phoneNumber:          '59170000001',
    clientId:             'CLI-001',
    clientName:           'Juan Mamani',
    clientStatus:         'Activo',
    planName:             'Plan Fibra 100Mb',
    totalDebt:            0,
    tbnCode:              null,
    activeTicketId:       null,
    activeInstallationId: null,
    pendingAction:        null,
    pendingTechIssue:     null,
    isEscalated:          false,
    ragFailCount:         0,
    messages:             [],
    ...overrides,
  };
}

const MOCK_SUMMARY = {
  summary:       'MOTIVO: Sin internet\nINTENTADO: Guía router\nESTADO: Persiste\nCLIENTE: Juan Mamani, Plan 100Mb',
  category:      EscalationCategory.SOPORTE_TECNICO,
  categoryLabel: 'Soporte Técnico',
  isAiGenerated: true,
};

// ─── Mocks completos del orquestador ─────────────────────────────────────────

function buildOrchestrator() {
  const session = {
    escalate:       jest.fn().mockResolvedValue(undefined),
    getContextText: jest.fn().mockResolvedValue('historial de prueba'),
    addMessage:     jest.fn().mockResolvedValue(undefined),
  };
  const convRepo = {
    update:   jest.fn().mockResolvedValue(undefined),
    findOne:  jest.fn().mockResolvedValue({ id: 'conv-001', phoneNumber: '59170000001' }),
    create:   jest.fn().mockReturnValue({ id: 'conv-001' }),
    save:     jest.fn().mockResolvedValue({ id: 'conv-001' }),
  };
  const msgRepo = {
    save:   jest.fn().mockResolvedValue(undefined),
    create: jest.fn().mockReturnValue({}),
  };
  const whatsapp      = { sendText: jest.fn().mockResolvedValue('msg-id'), markAsRead: jest.fn() };
  const formatter     = { escalationNotice: jest.fn().mockReturnValue('Escalando al agente...') };
  const adminNotifier = { notifyEscalation: jest.fn().mockResolvedValue(undefined) };
  const convSummary   = { summarize: jest.fn().mockResolvedValue(MOCK_SUMMARY) };

  const config         = { get: jest.fn().mockReturnValue(2) };
  const sistemaApi     = {};
  const intentDetector = {};
  const rag            = {};
  const payments       = {};
  const support        = {};
  const installation   = {};

  const orchestrator = new BotOrchestratorService(
    config as any,
    session as any,
    sistemaApi as any,
    intentDetector as any,
    whatsapp as any,
    formatter as any,
    rag as any,
    adminNotifier as any,
    payments as any,
    support as any,
    installation as any,
    convSummary as any,
    convRepo as any,
    msgRepo as any,
  );

  return { orchestrator, session, convRepo, whatsapp, formatter, adminNotifier, convSummary };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('triggerEscalation — EP-06 integración', () => {

  beforeEach(() => jest.clearAllMocks());

  // ─── AC-01 ────────────────────────────────────────────────────────────────

  it('AC-01: llama a ConversationSummaryService.summarize() con la sesión y el historial', async () => {
    const { orchestrator, convSummary } = buildOrchestrator();
    const sess = makeSession();

    await orchestrator.triggerEscalation(sess);

    expect(convSummary.summarize).toHaveBeenCalledWith(
      sess,
      'historial de prueba',
    );
  });

  // ─── AC-02 ────────────────────────────────────────────────────────────────

  it('AC-02: incluye el resumen y la categoría en notifyEscalation()', async () => {
    const { orchestrator, adminNotifier } = buildOrchestrator();

    await orchestrator.triggerEscalation(makeSession());

    expect(adminNotifier.notifyEscalation).toHaveBeenCalledWith(
      expect.objectContaining({
        escalationSummary:       MOCK_SUMMARY.summary,
        escalationCategory:      EscalationCategory.SOPORTE_TECNICO,
        escalationCategoryLabel: 'Soporte Técnico',
      }),
    );
  });

  // ─── AC-03 ────────────────────────────────────────────────────────────────

  it('AC-03: persiste el resumen y la categoría en la BD', async () => {
    const { orchestrator, convRepo } = buildOrchestrator();

    await orchestrator.triggerEscalation(makeSession());

    // convRepo.update es llamado dos veces:
    //   1. Para marcar isEscalated=true
    //   2. Para guardar escalationSummary y escalationCategory
    const calls = (convRepo.update as jest.Mock).mock.calls;
    const summaryCall = calls.find(c =>
      c[1]?.escalationSummary !== undefined,
    );

    expect(summaryCall).toBeDefined();
    expect(summaryCall[1]).toMatchObject({
      escalationSummary:  MOCK_SUMMARY.summary,
      escalationCategory: EscalationCategory.SOPORTE_TECNICO,
    });
  });

  // ─── AC-04 ────────────────────────────────────────────────────────────────

  it('AC-04: si summarize() falla, el escalado continúa sin resumen (non-blocking)', async () => {
    const { orchestrator, adminNotifier, convSummary } = buildOrchestrator();
    (convSummary.summarize as jest.Mock).mockRejectedValueOnce(new Error('timeout Gemini'));

    // No debe lanzar
    await expect(orchestrator.triggerEscalation(makeSession())).resolves.not.toThrow();

    // adminNotifier fue llamado igual — sin datos de resumen
    expect(adminNotifier.notifyEscalation).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumber: '59170000001',
        escalationSummary:       undefined,
        escalationCategory:      undefined,
        escalationCategoryLabel: undefined,
      }),
    );
  });

  // ─── AC-05 ────────────────────────────────────────────────────────────────

  it('AC-05: el usuario siempre recibe el mensaje de escalado', async () => {
    const { orchestrator, whatsapp } = buildOrchestrator();

    await orchestrator.triggerEscalation(makeSession());

    expect(whatsapp.sendText).toHaveBeenCalledWith(
      '59170000001',
      'Escalando al agente...',
    );
  });

  it('AC-05: el usuario recibe el mensaje incluso si summarize() falla', async () => {
    const { orchestrator, whatsapp, convSummary } = buildOrchestrator();
    (convSummary.summarize as jest.Mock).mockRejectedValueOnce(new Error('Gemini no disponible'));

    await orchestrator.triggerEscalation(makeSession());

    expect(whatsapp.sendText).toHaveBeenCalledWith(
      '59170000001',
      'Escalando al agente...',
    );
  });

  // ─── Orden de operaciones ──────────────────────────────────────────────────

  it('marca la sesión como escalada ANTES de intentar el resumen', async () => {
    const { orchestrator, session } = buildOrchestrator();
    const callOrder: string[] = [];

    (session.escalate as jest.Mock).mockImplementation(async () => {
      callOrder.push('escalate');
    });
    (session.getContextText as jest.Mock).mockImplementation(async () => {
      callOrder.push('getContextText');
      return 'historial';
    });

    await orchestrator.triggerEscalation(makeSession());

    expect(callOrder.indexOf('escalate')).toBeLessThan(
      callOrder.indexOf('getContextText'),
    );
  });

  // ─── Campos de la notificación ────────────────────────────────────────────

  it('la notificación incluye el phoneNumber y clientName del cliente', async () => {
    const { orchestrator, adminNotifier } = buildOrchestrator();
    const sess = makeSession({ clientName: 'María López' });

    await orchestrator.triggerEscalation(sess);

    expect(adminNotifier.notifyEscalation).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumber: '59170000001',
        clientName:  'María López',
      }),
    );
  });
});
