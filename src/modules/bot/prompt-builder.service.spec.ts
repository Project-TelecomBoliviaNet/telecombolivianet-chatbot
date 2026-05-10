import { PromptBuilderService } from './prompt-builder.service';
import { SessionData } from '../session/session.service';
import { PersonalitySection } from './prompt-sections/personality.section';
import { ClientInfoSection } from './prompt-sections/client-info.section';
import { SentimentHintSection } from './prompt-sections/sentiment-hint.section';
import { EscalationRulesSection } from './prompt-sections/escalation-rules.section';
import { GeneralInstructionsSection } from './prompt-sections/general-instructions.section';
import { ReceiptPendingSection } from './prompt-sections/receipt-pending.section';
import { TechSupportFlowSection } from './prompt-sections/tech-support-flow.section';
import { InstallationFlowSection } from './prompt-sections/installation-flow.section';

// ══════════════════════════════════════════════════════════════
// TESTS UNITARIOS — PromptBuilderService
// ══════════════════════════════════════════════════════════════

function makeSvc(): PromptBuilderService {
  return new PromptBuilderService([
    new PersonalitySection(),
    new ClientInfoSection(),
    new SentimentHintSection(),
    new EscalationRulesSection(),
    new GeneralInstructionsSection(),
    new ReceiptPendingSection(),
    new TechSupportFlowSection(),
    new InstallationFlowSection(),
  ]);
}

const SESSION_CLIENT: SessionData = {
  phoneNumber: '59171234567',
  clientId: 'client-001',
  clientName: 'Juan Pérez',
  clientStatus: 'Activo',
  planId: 'plan-100mb',
  planName: 'Plan 100 Mbps',
  totalDebt: 150.00,
  tbnCode: 'TBN-0001',
  activeTicketId: null,
  activeInstallationId: null,
  pendingAction: null,
  pendingTechIssue: null,
  isEscalated: false,
  ragFailCount: 0,
  ragLastFailAt: 0,
  lastSentiment: 'neutral',
  angryCount: 0,
  ratingSent: false,
  lastLocation: null,
  pendingImageId: null,
  pendingImageCaption: null,
  messages: [],
};

const SESSION_PROSPECT: SessionData = {
  ...SESSION_CLIENT,
  clientId: null,
  clientName: null,
  clientStatus: null,
  planId: null,
  planName: null,
  totalDebt: 0,
  tbnCode: null,
};

describe('PromptBuilderService.build()', () => {
  let svc: PromptBuilderService;

  beforeEach(() => { svc = makeSvc(); });

  it('PB-01 — incluye datos del cliente identificado', () => {
    const prompt = svc.build(SESSION_CLIENT);
    expect(prompt).toContain('Juan Pérez');
    expect(prompt).toContain('TBN-0001');
    expect(prompt).toContain('Activo');
    expect(prompt).toContain('150.00');
    expect(prompt).toContain('Plan 100 Mbps');
  });

  it('PB-02 — indica prospecto cuando clientId es null', () => {
    const prompt = svc.build(SESSION_PROSPECT);
    expect(prompt).toContain('NO está registrado');
    expect(prompt).toContain('prospecto');
  });

  it('PB-03 — advierte sobre cliente muy enojado (angryCount >= 2)', () => {
    const session = { ...SESSION_CLIENT, lastSentiment: 'angry' as const, angryCount: 2 };
    const prompt  = svc.build(session);
    expect(prompt).toContain('ATENCIÓN');
    expect(prompt).toContain('enojado');
    expect(prompt).toContain('agente humano');
  });

  it('PB-04 — no muestra advertencia de enojo con angryCount < 2', () => {
    const session = { ...SESSION_CLIENT, lastSentiment: 'angry' as const, angryCount: 1 };
    const prompt  = svc.build(session);
    expect(prompt).not.toContain('ATENCIÓN');
  });

  it('PB-05 — muestra nota de frustración cuando sentiment es frustrated', () => {
    const session = { ...SESSION_CLIENT, lastSentiment: 'frustrated' as const, angryCount: 0 };
    const prompt  = svc.build(session);
    expect(prompt).toContain('frustrado');
  });

  it('PB-06 — incluye ticket activo cuando existe', () => {
    const session = { ...SESSION_CLIENT, activeTicketId: 'TKT-9999' };
    const prompt  = svc.build(session);
    expect(prompt).toContain('TKT-9999');
  });

  it('PB-07 — incluye instalación activa cuando existe', () => {
    const session = { ...SESSION_CLIENT, activeInstallationId: 'INS-8888' };
    const prompt  = svc.build(session);
    expect(prompt).toContain('INS-8888');
  });

  it('PB-08 — incluye ubicación GPS cuando está disponible', () => {
    const session = {
      ...SESSION_CLIENT,
      lastLocation: { lat: -17.78, lng: -63.18, address: 'Av. Busch 123', name: 'Plan 3000' },
    };
    const prompt = svc.build(session);
    expect(prompt).toContain('-17.78');
    expect(prompt).toContain('Av. Busch 123');
  });

  it('PB-09 — aviso de comprobante pendiente cuando hay [comprobante de pago] en últimos 4 mensajes', () => {
    const session = {
      ...SESSION_CLIENT,
      messages: [
        { role: 'user' as const, content: '[comprobante de pago]', timestamp: Date.now() },
      ],
    };
    const prompt = svc.build(session);
    expect(prompt).toContain('COMPROBANTE EN REVISIÓN');
  });

  it('PB-10 — sin aviso de comprobante cuando los últimos 4 mensajes no lo contienen', () => {
    const prompt = svc.build(SESSION_CLIENT);
    expect(prompt).not.toContain('COMPROBANTE EN REVISIÓN');
  });

  it('PB-11 — incluye flujo de soporte técnico en el prompt', () => {
    const prompt = svc.build(SESSION_CLIENT);
    expect(prompt).toContain('search_knowledge_base');
    expect(prompt).toContain('close_support_ticket');
  });

  it('PB-12 — incluye flujo de instalación en el prompt', () => {
    const prompt = svc.build(SESSION_CLIENT);
    expect(prompt).toContain('check_coverage');
    expect(prompt).toContain('create_installation');
  });

  it('PB-13 — incluye personalidad del bot', () => {
    const prompt = svc.build(SESSION_CLIENT);
    expect(prompt).toContain('Telecom Bolivianet');
    expect(prompt).toContain('PERSONALIDAD');
  });

  it('PB-14 — incluye reglas de escalación', () => {
    const prompt = svc.build(SESSION_CLIENT);
    expect(prompt).toContain('escalate_to_agent');
    expect(prompt).toContain('CUÁNDO ESCALAR');
  });

  it('PB-15 — no duplica secciones (cada una aparece exactamente una vez)', () => {
    const prompt = svc.build(SESSION_CLIENT);
    const count  = (prompt.match(/PERSONALIDAD/g) ?? []).length;
    expect(count).toBe(1);
  });
});

describe('PromptBuilderService.buildSentimentHint()', () => {
  let svc: PromptBuilderService;

  beforeEach(() => { svc = makeSvc(); });

  it('PB-S1 — angry + angryCount>=2 → advertencia de escalación', () => {
    expect(svc.buildSentimentHint('angry', 3)).toContain('ATENCIÓN');
  });

  it('PB-S2 — angry + angryCount<2 → sin advertencia', () => {
    expect(svc.buildSentimentHint('angry', 1)).toBe('');
  });

  it('PB-S3 — frustrated → nota de malestar', () => {
    expect(svc.buildSentimentHint('frustrated', 0)).toContain('frustrado');
  });

  it('PB-S4 — neutral → string vacío', () => {
    expect(svc.buildSentimentHint('neutral', 0)).toBe('');
  });

  it('PB-S5 — happy → string vacío', () => {
    expect(svc.buildSentimentHint('happy', 5)).toBe('');
  });
});
