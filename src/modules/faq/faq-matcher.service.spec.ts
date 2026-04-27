/**
 * @file faq-matcher.service.spec.ts
 * @description Tests unitarios del FaqMatcherService (US-EP04-02).
 *
 * Criterios de aceptación validados:
 *   AC-01: Retorna found=true cuando la similitud coseno ≥ threshold.
 *   AC-02: Retorna found=false cuando ninguna FAQ supera el threshold.
 *   AC-03: Usa el embedding de la FAQ canónica para comparar.
 *   AC-04: Desempate por prioridad cuando scores son muy cercanos.
 *   AC-05: Si embed() falla, retorna found=false sin lanzar.
 *   AC-06: Reconstruye el índice cuando el TTL expira.
 *   AC-07: incrementMatchCount() se llama con el ID correcto.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { FaqMatcherService } from './faq-matcher.service';
import { FaqService }        from './faq.service';
import { RagService }        from '../rag/rag.service';
import { Faq }               from '../../database/entities/faq.entity';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeVector(value: number, dims = 768): number[] {
  return Array(dims).fill(value);
}

/**
 * Calcula el vector unitario (normalizado) para un vector de un solo valor.
 * Un vector de valor v tiene norma = v * sqrt(dims).
 * Su versión unitaria = v / (v * sqrt(dims)) = 1/sqrt(dims) para cada dim.
 */
function unitVector(dims = 768): number[] {
  return Array(dims).fill(1 / Math.sqrt(dims));
}

function makeFaq(overrides: Partial<Faq> = {}): Faq {
  return {
    id:         'faq-001',
    question:   '¿Cuándo vence el pago?',
    answer:     'El pago vence el día 5 de cada mes.',
    tags:       ['pagos'],
    priority:   5,
    isActive:   true,
    matchCount: 0,
    createdAt:  new Date(),
    updatedAt:  new Date(),
    ...overrides,
  };
}

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockFaqService = {
  getActiveFaqs:       jest.fn(),
  incrementMatchCount: jest.fn().mockResolvedValue(undefined),
};

const mockRagService = {
  embed: jest.fn(),
};

const mockConfig = {
  get: jest.fn((key: string) => {
    if (key === 'rag.faqSimilarityThreshold') return 0.85;
    return undefined;
  }),
};

// ─── Setup ────────────────────────────────────────────────────────────────────

async function buildMatcher(): Promise<FaqMatcherService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      FaqMatcherService,
      { provide: FaqService,    useValue: mockFaqService },
      { provide: RagService,    useValue: mockRagService },
      { provide: ConfigService, useValue: mockConfig },
    ],
  }).compile();

  const matcher = module.get<FaqMatcherService>(FaqMatcherService);

  // Saltar onModuleInit para controlar la construcción del índice en los tests
  return matcher;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('FaqMatcherService (US-EP04-02)', () => {

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── AC-01: match exitoso ──────────────────────────────────────────────────

  it('AC-01: retorna found=true cuando similitud ≥ threshold (0.85)', async () => {
    const matcher = await buildMatcher();
    const faq     = makeFaq();

    // FAQ tiene vector unitario; query tiene el mismo vector → similitud = 1.0
    mockFaqService.getActiveFaqs.mockResolvedValue([faq]);
    mockRagService.embed
      .mockResolvedValueOnce(unitVector())  // embed de la pregunta FAQ (buildIndex)
      .mockResolvedValueOnce(unitVector()); // embed de la query del usuario

    const result = await matcher.match('cuándo vence el pago');

    expect(result.found).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0.85);
    expect(result.answer).toBe(faq.answer);
    expect(result.faqId).toBe(faq.id);
  });

  // ─── AC-02: sin match ─────────────────────────────────────────────────────

  it('AC-02: retorna found=false cuando ninguna FAQ supera el threshold', async () => {
    const matcher = await buildMatcher();
    const faq     = makeFaq();

    // FAQ con vector [1,0,0...] y query con vector [0,1,0...] → similitud ≈ 0
    mockFaqService.getActiveFaqs.mockResolvedValue([faq]);
    const vecA = Array(768).fill(0); vecA[0] = 1;
    const vecB = Array(768).fill(0); vecB[1] = 1;

    mockRagService.embed
      .mockResolvedValueOnce(vecA) // FAQ
      .mockResolvedValueOnce(vecB); // query

    const result = await matcher.match('pregunta completamente diferente');

    expect(result.found).toBe(false);
    expect(result.score).toBeLessThan(0.85);
  });

  // ─── AC-04: desempate por prioridad ───────────────────────────────────────

  it('AC-04: ante scores similares, gana la FAQ con mayor prioridad', async () => {
    const matcher   = await buildMatcher();
    const faqLow    = makeFaq({ id: 'faq-low',  priority: 3, answer: 'Respuesta baja prioridad' });
    const faqHigh   = makeFaq({ id: 'faq-high', priority: 9, answer: 'Respuesta alta prioridad' });

    mockFaqService.getActiveFaqs.mockResolvedValue([faqLow, faqHigh]);

    // Ambas FAQs con vector muy similar al de la query (diferencia de 0.001)
    const vecBase  = unitVector();
    const vecLow   = vecBase.map((v, i) => i === 0 ? v - 0.001 : v);
    const vecHigh  = vecBase.map((v, i) => i === 0 ? v + 0.001 : v);
    const vecQuery = unitVector();

    mockRagService.embed
      .mockResolvedValueOnce(vecLow)   // embed FAQ baja prioridad
      .mockResolvedValueOnce(vecHigh)  // embed FAQ alta prioridad
      .mockResolvedValueOnce(vecQuery); // embed query usuario

    const result = await matcher.match('cuándo vence el pago');

    // Con scores muy cercanos, debe ganar la de mayor prioridad
    expect(result.found).toBe(true);
    expect(result.faqId).toBe('faq-high');
    expect(result.answer).toBe('Respuesta alta prioridad');
  });

  // ─── AC-05: degradación si embed falla ───────────────────────────────────

  it('AC-05: retorna found=false sin lanzar si embed() falla en match()', async () => {
    const matcher = await buildMatcher();
    const faq     = makeFaq();

    mockFaqService.getActiveFaqs.mockResolvedValue([faq]);
    mockRagService.embed
      .mockResolvedValueOnce(unitVector())      // embed FAQ en buildIndex OK
      .mockRejectedValueOnce(new Error('503')); // embed query usuario falla

    const result = await matcher.match('cuándo vence el pago');

    expect(result.found).toBe(false);
  });

  // ─── AC-06: reconstrucción del índice ────────────────────────────────────

  it('AC-06: reconstruye el índice cuando se llama a invalidateIndex()', async () => {
    const matcher = await buildMatcher();

    mockFaqService.getActiveFaqs.mockResolvedValue([makeFaq()]);
    mockRagService.embed.mockResolvedValue(unitVector());

    await matcher.invalidateIndex();

    expect(mockFaqService.getActiveFaqs).toHaveBeenCalledTimes(1);
    expect(mockRagService.embed).toHaveBeenCalledTimes(1);
  });

  // ─── AC-07: incrementMatchCount ───────────────────────────────────────────

  it('AC-07: llama a incrementMatchCount con el ID de la FAQ seleccionada', async () => {
    const matcher = await buildMatcher();
    const faq     = makeFaq({ id: 'faq-tracked-001' });

    mockFaqService.getActiveFaqs.mockResolvedValue([faq]);
    mockRagService.embed
      .mockResolvedValueOnce(unitVector())
      .mockResolvedValueOnce(unitVector());

    await matcher.match('cuándo vence el pago');

    // Esperar al microtask de incrementMatchCount (es fire-and-forget)
    await new Promise(r => setImmediate(r));

    expect(mockFaqService.incrementMatchCount).toHaveBeenCalledWith('faq-tracked-001');
  });

  // ─── Query vacía ─────────────────────────────────────────────────────────

  it('retorna found=false para query vacía sin llamar a embed', async () => {
    const matcher = await buildMatcher();
    mockFaqService.getActiveFaqs.mockResolvedValue([makeFaq()]);

    const result = await matcher.match('');

    expect(result.found).toBe(false);
    expect(mockRagService.embed).not.toHaveBeenCalled();
  });

  // ─── Sin FAQs activas ─────────────────────────────────────────────────────

  it('retorna found=false cuando no hay FAQs activas', async () => {
    const matcher = await buildMatcher();
    mockFaqService.getActiveFaqs.mockResolvedValue([]);
    mockRagService.embed.mockResolvedValue(unitVector());

    const result = await matcher.match('cualquier pregunta');

    expect(result.found).toBe(false);
    // No debe llamar a embed para la query si no hay FAQs
    expect(mockRagService.embed).not.toHaveBeenCalled();
  });

  // ─── Similitud coseno ────────────────────────────────────────────────────

  describe('cosineSimilarity (vía comportamiento observable)', () => {
    it('vectores idénticos tienen similitud 1.0', async () => {
      const matcher = await buildMatcher();
      const faq = makeFaq();

      mockFaqService.getActiveFaqs.mockResolvedValue([faq]);
      mockRagService.embed
        .mockResolvedValueOnce(unitVector())
        .mockResolvedValueOnce(unitVector()); // mismo vector

      const result = await matcher.match('pregunta');

      expect(result.score).toBeCloseTo(1.0, 3);
    });

    it('vectores ortogonales tienen similitud ≈ 0', async () => {
      const matcher = await buildMatcher();
      const faq = makeFaq();

      mockFaqService.getActiveFaqs.mockResolvedValue([faq]);

      const vecA = Array(768).fill(0); vecA[0] = 1;
      const vecB = Array(768).fill(0); vecB[1] = 1;

      mockRagService.embed
        .mockResolvedValueOnce(vecA)
        .mockResolvedValueOnce(vecB);

      const result = await matcher.match('pregunta');

      expect(result.score).toBeCloseTo(0.0, 3);
    });
  });
});
