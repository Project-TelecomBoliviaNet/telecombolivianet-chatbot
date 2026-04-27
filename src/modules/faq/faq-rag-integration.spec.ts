/**
 * @file faq-rag-integration.spec.ts
 * @description Tests de integración: FaqMatcher como primera capa del pipeline RAG.
 *
 * Criterios de aceptación validados:
 *   AC-01: Si hay FAQ match, retorna respuesta sin llamar a pgvector ni Gemini generate.
 *   AC-02: Si no hay FAQ match, continúa con el pipeline RAG completo.
 *   AC-03: isFaqMatch=true en el resultado cuando vino de una FAQ.
 *   AC-04: Si FaqMatcher lanza error, el pipeline RAG continúa normalmente.
 *   AC-05: Sin FaqMatcher registrado (setFaqMatcher no llamado), pipeline funciona normal.
 *   AC-06: E2E: pregunta frecuente → respuesta en <3 calls a Gemini (solo embed).
 */

import { Test, TestingModule }   from '@nestjs/testing';
import { ConfigService }         from '@nestjs/config';
import { getDataSourceToken }    from '@nestjs/typeorm';
import { RagService }            from '../rag/rag.service';
import { QueryReformulationService } from '../rag/query-reformulation.service';
import { PseudonymService }      from '../../common/security/pseudonym/pseudonym.service';
import { PiiGuardInterceptor }   from '../../common/security/pseudonym/pii-guard.interceptor';
import { FaqMatcherService }     from './faq-matcher.service';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const MOCK_EMBEDDING = Array(768).fill(0.1);

const mockFaqMatcher = {
  match: jest.fn(),
};

const mockPseudonymService = {
  pseudonymize: jest.fn().mockResolvedValue({
    pseudonymizedText: 'PREGUNTA: pregunta\nCONTEXTO: ',
    mappingKey:        '',
    replacementsCount: 0,
  }),
  rehydrate:  jest.fn().mockImplementation((text: string) => Promise.resolve(text)),
  invalidate: jest.fn().mockResolvedValue(undefined),
};

const mockPiiGuard = {
  inspect: jest.fn().mockReturnValue({ hasLeak: false, detections: [], detectedTypes: [] }),
};

const mockQueryReformulation = {
  reformulate: jest.fn().mockImplementation(async (q: string) => ({
    query: q, originalQuery: q, wasReformulated: false,
  })),
};

const mockDataSource = {
  query: jest.fn().mockResolvedValue([{
    id: 'chunk-001', content: 'Contenido del chunk.', documentTitle: 'Manual', similarity: 0.9,
  }]),
};

const mockConfig = {
  get: jest.fn((key: string) => {
    const cfg: Record<string, unknown> = {
      'gemini.apiKey':           'test-key',
      'gemini.embedModel':       'text-embedding-004',
      'gemini.ragModel':         'gemini-2.0-flash',
      'gemini.maxTokens':        512,
      'gemini.temperature':      0.3,
      'rag.similarityThreshold': 0.75,
      'rag.maxChunks':           3,
    };
    return cfg[key];
  }),
};

// ─── Setup ────────────────────────────────────────────────────────────────────

async function buildRagService(): Promise<{ service: RagService; geminiPost: jest.Mock }> {
  const geminiPost = jest.fn()
    .mockResolvedValueOnce({ data: { embedding: { values: MOCK_EMBEDDING } } })
    .mockResolvedValueOnce({
      data: { candidates: [{ content: { parts: [{ text: 'Respuesta del RAG.' }] } }] },
    });

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      RagService,
      { provide: ConfigService,             useValue: mockConfig },
      { provide: getDataSourceToken(),       useValue: mockDataSource },
      { provide: PseudonymService,           useValue: mockPseudonymService },
      { provide: PiiGuardInterceptor,        useValue: mockPiiGuard },
      { provide: QueryReformulationService,  useValue: mockQueryReformulation },
    ],
  }).compile();

  const service = module.get<RagService>(RagService);
  (service as any).http = { post: geminiPost };

  return { service, geminiPost };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RagService + FaqMatcher — integración (US-EP04-02)', () => {

  beforeEach(() => {
    jest.clearAllMocks();

    mockPseudonymService.pseudonymize.mockResolvedValue({
      pseudonymizedText: 'PREGUNTA: pregunta\nCONTEXTO: ',
      mappingKey:        '',
      replacementsCount: 0,
    });
    mockPseudonymService.rehydrate.mockImplementation((t: string) => Promise.resolve(t));
    mockQueryReformulation.reformulate.mockImplementation(async (q: string) => ({
      query: q, originalQuery: q, wasReformulated: false,
    }));
  });

  // ─── AC-01: FAQ match → respuesta inmediata ───────────────────────────────

  it('AC-01: si hay FAQ match, retorna respuesta sin llamar a pgvector ni Gemini generate', async () => {
    const { service, geminiPost } = await buildRagService();

    mockFaqMatcher.match.mockResolvedValue({
      found:       true,
      answer:      'El pago vence el día 5 de cada mes.',
      score:       0.96,
      faqId:       'faq-001',
      faqQuestion: '¿Cuándo vence el pago?',
    });

    service.setFaqMatcher(mockFaqMatcher as unknown as FaqMatcherService);

    const result = await service.query('cuándo vence el pago', '', '59170000001', null);

    expect(result.found).toBe(true);
    expect(result.answer).toBe('El pago vence el día 5 de cada mes.');
    expect(result.isFaqMatch).toBe(true);

    // Gemini NO fue llamado (ni embed ni generate)
    expect(geminiPost).not.toHaveBeenCalled();
    // pgvector NO fue consultado
    expect(mockDataSource.query).not.toHaveBeenCalled();
  });

  // ─── AC-03: isFaqMatch en el resultado ───────────────────────────────────

  it('AC-03: isFaqMatch=true cuando la respuesta viene de una FAQ', async () => {
    const { service } = await buildRagService();

    mockFaqMatcher.match.mockResolvedValue({
      found: true, answer: 'Respuesta FAQ.', score: 0.9,
      faqId: 'f1', faqQuestion: 'P?',
    });
    service.setFaqMatcher(mockFaqMatcher as unknown as FaqMatcherService);

    const result = await service.query('consulta', '', '59170000001', null);
    expect(result.isFaqMatch).toBe(true);
  });

  // ─── AC-02: sin FAQ match → pipeline RAG completo ────────────────────────

  it('AC-02: si no hay FAQ match, continúa con el pipeline RAG completo', async () => {
    const { service, geminiPost } = await buildRagService();

    mockFaqMatcher.match.mockResolvedValue({
      found: false, answer: '', score: 0.3, faqId: '', faqQuestion: '',
    });
    service.setFaqMatcher(mockFaqMatcher as unknown as FaqMatcherService);

    const result = await service.query('pregunta técnica', '', '59170000001', null);

    expect(result.found).toBe(true);
    // Gemini SÍ fue llamado (embed + generate)
    expect(geminiPost).toHaveBeenCalledTimes(2);
  });

  // ─── AC-04: FaqMatcher falla → pipeline RAG continúa ─────────────────────

  it('AC-04: si FaqMatcher lanza error, el pipeline RAG continúa normalmente', async () => {
    const { service, geminiPost } = await buildRagService();

    mockFaqMatcher.match.mockRejectedValue(new Error('Redis no disponible'));
    service.setFaqMatcher(mockFaqMatcher as unknown as FaqMatcherService);

    // No debe lanzar error — continúa con RAG completo
    const result = await service.query('pregunta', '', '59170000001', null);

    expect(result).toBeDefined();
    // El pipeline RAG completo fue ejecutado
    expect(geminiPost).toHaveBeenCalledTimes(2);
  });

  // ─── AC-05: sin FaqMatcher registrado ────────────────────────────────────

  it('AC-05: sin FaqMatcher registrado, el pipeline RAG funciona normalmente', async () => {
    const { service, geminiPost } = await buildRagService();
    // NO llamamos service.setFaqMatcher() — faqMatcher = null

    const result = await service.query('pregunta', '', '59170000001', null);

    expect(result.found).toBe(true);
    expect(geminiPost).toHaveBeenCalledTimes(2);
    expect(mockFaqMatcher.match).not.toHaveBeenCalled();
  });

  // ─── AC-06: E2E — pregunta frecuente con mínimo overhead ─────────────────

  it('AC-06 E2E: FAQ match usa solo embed de la query (latencia mínima)', async () => {
    const { service, geminiPost } = await buildRagService();

    // FAQ match exitoso
    mockFaqMatcher.match.mockResolvedValue({
      found:       true,
      answer:      'Para pagar, solicita tu QR por este chat.',
      score:       0.94,
      faqId:       'faq-pagos-001',
      faqQuestion: '¿Cómo puedo pagar mi factura?',
    });
    service.setFaqMatcher(mockFaqMatcher as unknown as FaqMatcherService);

    const result = await service.query(
      'kiero pagar mi cuota',
      '',
      '59170000001',
      null,
    );

    // Respuesta correcta de la FAQ
    expect(result.found).toBe(true);
    expect(result.answer).toBe('Para pagar, solicita tu QR por este chat.');
    expect(result.isFaqMatch).toBe(true);

    // Gemini NO fue llamado en absoluto (ni embed para búsqueda ni generate)
    // El embed lo hace FaqMatcherService internamente, no RagService
    expect(geminiPost).not.toHaveBeenCalled();

    // pgvector NO fue consultado
    expect(mockDataSource.query).not.toHaveBeenCalled();
  });
});
