/**
 * @file conversation-summary.service.spec.ts
 * @description Tests unitarios de ConversationSummaryService (US-EP06-01 y US-EP06-02).
 *
 * Criterios de aceptación validados:
 *   US-EP06-01 AC-01: Genera resumen estructurado al escalar.
 *   US-EP06-01 AC-02: El resumen incluye motivo, intentado, estado, cliente.
 *   US-EP06-01 AC-03: Si Gemini falla, el escalado continúa con fallback.
 *   US-EP06-01 AC-04: El historial pasa por seudonimización antes de Gemini.
 *   US-EP06-01 AC-05: La respuesta de Gemini se re-hidrata con datos reales.
 *   US-EP06-02 AC-01: Clasifica el escalado en una de 5 categorías.
 *   US-EP06-02 AC-02: Resumen y categoría se generan en paralelo.
 *   US-EP06-02 AC-03: parseCategory es tolerante a variaciones de formato.
 *   US-EP06-02 AC-04: Fallback usa categoría OTRO cuando Gemini no disponible.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  ConversationSummaryService,
  EscalationCategory,
} from './conversation-summary.service';
import { PseudonymService } from '../../common/security/pseudonym/pseudonym.service';
import { SessionData } from '../session/session.service';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    phoneNumber:         '59170000001',
    clientId:            'CLI-001',
    clientName:          'Juan Mamani',
    clientStatus:        'Activo',
    planName:            'Plan Fibra 100Mb',
    totalDebt:           350,
    tbnCode:             'TBN-2024-A',
    activeTicketId:      null,
    activeInstallationId: null,
    pendingAction:       null,
    pendingTechIssue:    null,
    isEscalated:         false,
    ragFailCount:        2,
    messages:            [],
    ...overrides,
  };
}

const CONVERSATION = [
  'Cliente: no tengo internet',
  'Bot: Revisemos tu router. ¿Qué luces tiene encendidas?',
  'Cliente: solo la luz de encendido',
  'Bot: Intenta reiniciar el router desconectando el cable 30 segundos.',
  'Cliente: ya lo hice y sigue sin funcionar',
].join('\n');

// ─── Mocks ────────────────────────────────────────────────────────────────────

const PSEUDO_CONV  = CONVERSATION.replace('Juan Mamani', 'PERSONA_001');
const MAPPING_KEY  = 'pseudo:59170000001:ep06-test';

const mockPseudonymService = {
  pseudonymize: jest.fn().mockResolvedValue({
    pseudonymizedText: PSEUDO_CONV,
    mappingKey:        MAPPING_KEY,
    replacementsCount: 1,
  }),
  rehydrate:  jest.fn().mockImplementation((text: string) => Promise.resolve(
    text.replace('PERSONA_001', 'Juan Mamani'),
  )),
  invalidate: jest.fn().mockResolvedValue(undefined),
};

const mockConfig = {
  get: jest.fn((key: string) => {
    const cfg: Record<string, unknown> = {
      'gemini.apiKey':      'test-api-key',
      'gemini.intentModel': 'gemini-2.0-flash',
    };
    return cfg[key];
  }),
};

// ─── Setup ────────────────────────────────────────────────────────────────────

async function buildService(geminiResponses?: string[]): Promise<{
  service: ConversationSummaryService;
  postSpy: jest.Mock;
}> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ConversationSummaryService,
      { provide: ConfigService,    useValue: mockConfig },
      { provide: PseudonymService, useValue: mockPseudonymService },
    ],
  }).compile();

  const service = module.get<ConversationSummaryService>(ConversationSummaryService);

  const responses = geminiResponses ?? [
    'MOTIVO: Sin conexión a internet\nINTENTADO: Guía de reinicio\nESTADO: Problema persiste\nCLIENTE: Plan Fibra 100Mb',
    'SOPORTE_TECNICO',
  ];

  let callCount = 0;
  const postSpy = jest.fn().mockImplementation(() => {
    const text = responses[callCount % responses.length];
    callCount++;
    return Promise.resolve({
      data: { candidates: [{ content: { parts: [{ text }] } }] },
    });
  });

  (service as any).http            = { post: postSpy };
  (service as any).geminiAvailable = true;

  return { service, postSpy };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ConversationSummaryService (US-EP06-01 + US-EP06-02)', () => {

  beforeEach(() => jest.clearAllMocks());

  // ─── US-EP06-01: Resumen estructurado ────────────────────────────────────

  describe('US-EP06-01 — Resumen al escalar', () => {
    it('AC-01: retorna un resumen con isAiGenerated=true cuando Gemini funciona', async () => {
      const { service } = await buildService();
      const result = await service.summarize(makeSession(), CONVERSATION);

      expect(result.isAiGenerated).toBe(true);
      expect(result.summary).toBeTruthy();
      expect(result.summary.length).toBeGreaterThan(10);
    });

    it('AC-02: el resumen contiene las 4 secciones esperadas', async () => {
      const { service } = await buildService([
        'MOTIVO: Sin internet\nINTENTADO: Reinicio router\nESTADO: Sigue fallando\nCLIENTE: Plan 100Mb',
        'SOPORTE_TECNICO',
      ]);
      const result = await service.summarize(makeSession(), CONVERSATION);

      expect(result.summary).toContain('MOTIVO:');
      expect(result.summary).toContain('INTENTADO:');
      expect(result.summary).toContain('ESTADO:');
      expect(result.summary).toContain('CLIENTE:');
    });

    it('AC-04: seudonimiza el historial antes de enviarlo a Gemini', async () => {
      const { service, postSpy } = await buildService();
      await service.summarize(makeSession(), CONVERSATION);

      expect(mockPseudonymService.pseudonymize).toHaveBeenCalledWith(
        expect.stringContaining('no tengo internet'), // texto original truncado
        '59170000001',
        'Juan Mamani',
      );

      // Gemini recibe el texto seudonimizado (sin nombre real)
      const promptEnviado = postSpy.mock.calls[0][1].contents[0].parts[0].text;
      expect(promptEnviado).not.toContain('Juan Mamani');
    });

    it('AC-05: re-hidrata la respuesta de Gemini con datos reales', async () => {
      const { service } = await buildService([
        'MOTIVO: Sin internet\nINTENTADO: Bot\nESTADO: OK\nCLIENTE: PERSONA_001',
        'SOPORTE_TECNICO',
      ]);
      const result = await service.summarize(makeSession(), CONVERSATION);

      // La re-hidratación debe reemplazar PERSONA_001 con Juan Mamani
      expect(mockPseudonymService.rehydrate).toHaveBeenCalled();
      expect(result.summary).toContain('Juan Mamani');
      expect(result.summary).not.toContain('PERSONA_001');
    });

    it('AC-03: si Gemini falla, retorna fallback con isAiGenerated=false', async () => {
      const { service, postSpy } = await buildService();
      postSpy.mockRejectedValue(new Error('503 Service Unavailable'));

      const result = await service.summarize(makeSession(), CONVERSATION);

      expect(result.isAiGenerated).toBe(false);
      expect(result.summary).toBeTruthy();
      expect(result.category).toBe(EscalationCategory.OTRO);
    });

    it('AC-03: si pseudonymize falla, continúa con texto original (degradación)', async () => {
      const { service } = await buildService();
      mockPseudonymService.pseudonymize.mockRejectedValueOnce(new Error('Redis no disponible'));

      // No debe lanzar — el servicio usa texto original como fallback
      const result = await service.summarize(makeSession(), CONVERSATION);
      expect(result).toBeDefined();
    });

    it('fallback incluye datos de sesión disponibles', async () => {
      const session = makeSession({
        planName:  'Plan Fibra 50Mb',
        totalDebt: 150,
      });

      // Sin Gemini disponible
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ConversationSummaryService,
          { provide: ConfigService,    useValue: { get: jest.fn().mockReturnValue('') } },
          { provide: PseudonymService, useValue: mockPseudonymService },
        ],
      }).compile();

      const service = module.get<ConversationSummaryService>(ConversationSummaryService);

      const result = await service.summarize(session, '');

      expect(result.isAiGenerated).toBe(false);
      expect(result.summary).toContain('Juan Mamani');
      expect(result.summary).toContain('Plan Fibra 50Mb');
      expect(result.summary).toContain('150');
    });

    it('historial vacío retorna fallback sin llamar a Gemini', async () => {
      const { service, postSpy } = await buildService();

      const result = await service.summarize(makeSession(), '');

      expect(result.isAiGenerated).toBe(false);
      expect(postSpy).not.toHaveBeenCalled();
    });

    it('invalida la tabla Redis después de re-hidratar', async () => {
      const { service } = await buildService();
      await service.summarize(makeSession(), CONVERSATION);

      await new Promise(r => setImmediate(r)); // esperar al fire-and-forget
      expect(mockPseudonymService.invalidate).toHaveBeenCalledWith(MAPPING_KEY);
    });
  });

  // ─── US-EP06-02: Categorización ──────────────────────────────────────────

  describe('US-EP06-02 — Categorización de escalado', () => {
    it('AC-01: categoriza como FACTURACION cuando Gemini retorna esa categoría', async () => {
      const { service } = await buildService([
        'MOTIVO: Consulta de pago\nINTENTADO: Bot\nESTADO: OK\nCLIENTE: Sin datos',
        'FACTURACION',
      ]);
      const result = await service.summarize(makeSession(), CONVERSATION);

      expect(result.category).toBe(EscalationCategory.FACTURACION);
      expect(result.categoryLabel).toBe('Facturación y Pagos');
    });

    it('AC-01: categoriza como SOPORTE_TECNICO', async () => {
      const { service } = await buildService([
        'MOTIVO: Sin internet\nINTENTADO: Bot\nESTADO: OK\nCLIENTE: Sin datos',
        'SOPORTE_TECNICO',
      ]);
      const result = await service.summarize(makeSession(), CONVERSATION);
      expect(result.category).toBe(EscalationCategory.SOPORTE_TECNICO);
    });

    it('AC-01: categoriza como INSTALACION', async () => {
      const { service } = await buildService([
        'MOTIVO: Nueva instalación\nINTENTADO: Bot\nESTADO: OK\nCLIENTE: Sin datos',
        'INSTALACION',
      ]);
      const result = await service.summarize(makeSession(), CONVERSATION);
      expect(result.category).toBe(EscalationCategory.INSTALACION);
    });

    it('AC-01: categoriza como INFORMACION', async () => {
      const { service } = await buildService([
        'MOTIVO: Info de planes\nINTENTADO: Bot\nESTADO: OK\nCLIENTE: Sin datos',
        'INFORMACION',
      ]);
      const result = await service.summarize(makeSession(), CONVERSATION);
      expect(result.category).toBe(EscalationCategory.INFORMACION);
    });

    it('AC-03: parseCategory es tolerante a texto extra de Gemini', async () => {
      const { service } = await buildService([
        'MOTIVO: OK\nINTENTADO: OK\nESTADO: OK\nCLIENTE: OK',
        '  La categoría es SOPORTE_TECNICO principalmente.  ',
      ]);
      const result = await service.summarize(makeSession(), CONVERSATION);
      expect(result.category).toBe(EscalationCategory.SOPORTE_TECNICO);
    });

    it('AC-03: usa OTRO si Gemini retorna texto irreconocible', async () => {
      const { service } = await buildService([
        'MOTIVO: OK\nINTENTADO: OK\nESTADO: OK\nCLIENTE: OK',
        'NO_SE_QUE_CATEGORIA_ES',
      ]);
      const result = await service.summarize(makeSession(), CONVERSATION);
      expect(result.category).toBe(EscalationCategory.OTRO);
    });

    it('AC-04: fallback siempre usa OTRO como categoría', async () => {
      const { service, postSpy } = await buildService();
      postSpy.mockRejectedValue(new Error('timeout'));

      const result = await service.summarize(makeSession(), CONVERSATION);
      expect(result.category).toBe(EscalationCategory.OTRO);
    });

    it('AC-02: summary y category se generan en la misma llamada a summarize()', async () => {
      const { service, postSpy } = await buildService([
        'MOTIVO: Sin internet\nINTENTADO: Bot\nESTADO: OK\nCLIENTE: Sin datos',
        'SOPORTE_TECNICO',
      ]);
      const result = await service.summarize(makeSession(), CONVERSATION);

      // Ambas llamadas a Gemini ocurrieron
      expect(postSpy).toHaveBeenCalledTimes(2);
      // El resultado tiene ambos campos poblados
      expect(result.summary).toBeTruthy();
      expect(result.category).toBeTruthy();
    });

    it('retorna categoryLabel legible en español', async () => {
      const { service } = await buildService([
        'MOTIVO: OK\nINTENTADO: OK\nESTADO: OK\nCLIENTE: OK',
        'INSTALACION',
      ]);
      const result = await service.summarize(makeSession(), CONVERSATION);
      expect(result.categoryLabel).toBe('Instalación y Contratos');
    });
  });

  // ─── Integración con triggerEscalation ───────────────────────────────────

  describe('campos del resultado', () => {
    it('retorna todos los campos requeridos por notifyEscalation', async () => {
      const { service } = await buildService();
      const result = await service.summarize(makeSession(), CONVERSATION);

      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('category');
      expect(result).toHaveProperty('categoryLabel');
      expect(result).toHaveProperty('isAiGenerated');
    });

    it('summary nunca es null ni undefined', async () => {
      const { service, postSpy } = await buildService();
      postSpy.mockRejectedValue(new Error('error'));

      const result = await service.summarize(makeSession(), CONVERSATION);
      expect(result.summary).not.toBeNull();
      expect(result.summary).not.toBeUndefined();
      expect(result.summary.length).toBeGreaterThan(0);
    });
  });
});
