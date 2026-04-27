/**
 * @file rag-pseudonym.spec.ts
 * @description Tests de integración: RagService + seudonimización (US-EP01-04).
 *
 * Criterios de aceptación validados:
 *   AC-01: La query se seudonimiza antes de generar embeddings.
 *   AC-02: El contexto se seudonimiza junto con la query.
 *   AC-03: Gemini recibe texto seudonimizado en el prompt.
 *   AC-04: La respuesta de Gemini se re-hidrata con datos reales.
 *   AC-05: Si la re-hidratación falla por TTL, se retorna la respuesta con tokens.
 *   AC-06: Si PseudonymService falla, el pipeline continúa con texto original.
 *   AC-07: Test E2E completo con seudonimización + re-hidratación.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getDataSourceToken } from '@nestjs/typeorm';
import { RagService, RagResult } from './rag.service';
import { QueryReformulationService } from './query-reformulation.service';
import { PseudonymService } from '../../common/security/pseudonym/pseudonym.service';
import { PiiGuardInterceptor } from '../../common/security/pseudonym/pii-guard.interceptor';
import { PseudonymExpiredError } from '../../common/security/pseudonym/pseudonym-expired.error';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const MOCK_EMBEDDING   = Array(768).fill(0.1);
const MOCK_ANSWER_RAW  = 'Hola PERSONA_001, tu deuda es MONTO_001 y está pendiente.';
const MOCK_ANSWER_REAL = 'Hola Juan Mamani, tu deuda es Bs 350 y está pendiente.';
const MOCK_MAPPING_KEY = 'pseudo:59170000001:uuid-rag-test';

const mockPseudonymService = {
  pseudonymize: jest.fn(),
  rehydrate:    jest.fn(),
  invalidate:   jest.fn().mockResolvedValue(undefined),
};

const mockPiiGuard = {
  inspect: jest.fn().mockReturnValue({ hasLeak: false, detections: [], detectedTypes: [] }),
};

// Reformulación: por defecto pasa la query sin cambios (para no interferir con tests de EP-01)
const mockQueryReformulation = {
  reformulate: jest.fn().mockImplementation(async (query: string) => ({
    query,
    originalQuery:   query,
    wasReformulated: false,
  })),
};

const mockDataSource = {
  query: jest.fn(),
};

const mockConfigService = {
  get: jest.fn((key: string) => {
    const cfg: Record<string, unknown> = {
      'gemini.apiKey':              'test-api-key',
      'gemini.embedModel':          'text-embedding-004',
      'gemini.ragModel':            'gemini-2.0-flash',
      'gemini.maxTokens':           512,
      'gemini.temperature':         0.3,
      'rag.similarityThreshold':    0.75,
      'rag.maxChunks':              3,
    };
    return cfg[key];
  }),
};

// ─── Setup ────────────────────────────────────────────────────────────────────

describe('RagService — integración con seudonimización (US-EP01-04)', () => {
  let service: RagService;
  let geminiPostSpy: jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Reformulación: transparente por defecto — no interfiere con tests de EP-01
    mockQueryReformulation.reformulate.mockImplementation(async (query: string) => ({
      query,
      originalQuery:   query,
      wasReformulated: false,
    }));

    // Mock de Gemini: embed retorna vector, generate retorna respuesta con tokens
    geminiPostSpy = jest.fn()
      .mockResolvedValueOnce({ data: { embedding: { values: MOCK_EMBEDDING } } })   // embed call
      .mockResolvedValueOnce({                                                        // generate call
        data: { candidates: [{ content: { parts: [{ text: MOCK_ANSWER_RAW }] } }] },
      });

    // Mock de pgvector: retorna 1 chunk relevante
    mockDataSource.query.mockResolvedValue([{
      id:            'chunk-uuid-001',
      content:       'Información sobre deudas y pagos de clientes.',
      documentTitle: 'Manual de facturación 2024',
      similarity:    0.92,
    }]);

    // Mock de PseudonymService: seudonimiza y re-hidrata correctamente
    mockPseudonymService.pseudonymize.mockResolvedValue({
      pseudonymizedText: 'PREGUNTA: cuánto debo MONTO_001\nCONTEXTO: sesión PERSONA_001',
      mappingKey:        MOCK_MAPPING_KEY,
      replacementsCount: 2,
    });

    mockPseudonymService.rehydrate.mockResolvedValue(MOCK_ANSWER_REAL);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RagService,
        { provide: ConfigService,             useValue: mockConfigService },
        { provide: getDataSourceToken(),       useValue: mockDataSource },
        { provide: PseudonymService,           useValue: mockPseudonymService },
        { provide: PiiGuardInterceptor,        useValue: mockPiiGuard },
        { provide: QueryReformulationService,  useValue: mockQueryReformulation },
      ],
    }).compile();

    service = module.get<RagService>(RagService);
    (service as any).http = { post: geminiPostSpy };
  });

  // ─── AC-01: seudonimización antes del embedding ───────────────────────────

  it('AC-01: debe llamar a pseudonymize() antes de generar el embedding', async () => {
    await service.query('cuánto debo Bs 350', 'contexto', '59170000001', 'Juan Mamani');

    expect(mockPseudonymService.pseudonymize).toHaveBeenCalledWith(
      expect.stringContaining('PREGUNTA: cuánto debo Bs 350'),
      '59170000001',
      'Juan Mamani',
    );
  });

  // ─── AC-02: contexto incluido en la seudonimización ──────────────────────

  it('AC-02: debe incluir el contexto de conversación en la seudonimización', async () => {
    const contexto = 'Cliente: Juan Mamani llamó hace 3 días sobre su factura';

    await service.query('cuánto debo', contexto, '59170000001', 'Juan Mamani');

    const callArg = mockPseudonymService.pseudonymize.mock.calls[0][0] as string;
    expect(callArg).toContain('PREGUNTA:');
    expect(callArg).toContain('CONTEXTO:');
    expect(callArg).toContain(contexto);
  });

  // ─── AC-03: Gemini recibe texto seudonimizado ─────────────────────────────

  it('AC-03: el prompt enviado a Gemini NO debe contener datos reales', async () => {
    await service.query('cuánto debo Bs 350', 'contexto Juan Mamani', '59170000001', 'Juan Mamani');

    // Segunda llamada a Gemini es el generate (primera es el embed)
    const generateCall = geminiPostSpy.mock.calls[1];
    const payload      = generateCall[1] as { contents: Array<{ parts: Array<{ text: string }> }> };
    const prompt       = payload.contents[0].parts[0].text;

    expect(prompt).not.toContain('Juan Mamani');
    expect(prompt).not.toContain('Bs 350');
  });

  // ─── AC-04: re-hidratación de la respuesta ────────────────────────────────

  it('AC-04: la respuesta final debe estar re-hidratada con datos reales', async () => {
    const result = await service.query('cuánto debo', 'contexto', '59170000001', 'Juan Mamani');

    expect(result.found).toBe(true);
    expect(result.answer).toBe(MOCK_ANSWER_REAL);
    expect(mockPseudonymService.rehydrate).toHaveBeenCalledWith(
      MOCK_ANSWER_RAW,
      MOCK_MAPPING_KEY,
    );
  });

  // ─── AC-05: re-hidratación falla por TTL ─────────────────────────────────

  it('AC-05: si la re-hidratación falla por PseudonymExpiredError, retorna respuesta con tokens', async () => {
    mockPseudonymService.rehydrate.mockRejectedValueOnce(
      new PseudonymExpiredError(MOCK_MAPPING_KEY),
    );

    const result = await service.query('cuánto debo', 'contexto', '59170000001', null);

    // No lanza error — retorna la respuesta con tokens (mejor que error genérico)
    expect(result.found).toBe(true);
    expect(result.answer).toBe(MOCK_ANSWER_RAW);
  });

  // ─── AC-06: degradación controlada si PseudonymService falla ─────────────

  it('AC-06: si pseudonymize() falla, el pipeline continúa con texto original', async () => {
    mockPseudonymService.pseudonymize.mockRejectedValueOnce(
      new Error('Redis no disponible'),
    );

    // Reconfigurar mocks para el flujo sin seudonimización
    geminiPostSpy
      .mockResolvedValueOnce({ data: { embedding: { values: MOCK_EMBEDDING } } })
      .mockResolvedValueOnce({
        data: { candidates: [{ content: { parts: [{ text: 'Respuesta directa.' }] } }] },
      });

    mockPseudonymService.rehydrate.mockResolvedValueOnce('Respuesta directa.');

    const result = await service.query(
      'cuánto debo Bs 350',
      'contexto',
      '59170000001',
      'Juan Mamani',
    );

    // Pipeline no falló — retornó un resultado
    expect(result.found).toBe(true);
    // rehydrate no fue llamado (no hubo mappingKey)
    expect(mockPseudonymService.rehydrate).not.toHaveBeenCalled();
  });

  // ─── AC-07: test E2E completo ─────────────────────────────────────────────

  it('AC-07 E2E: query con PII → tokens en Gemini → respuesta re-hidratada', async () => {
    const preguntaReal   = '¿Cuánto debo Bs 350?';
    const contextoReal   = 'Conversación con Juan Mamani';
    const preguntaToken  = '¿Cuánto debo MONTO_001?';
    const contextoToken  = 'Conversación con PERSONA_001';
    const respuestaToken = 'Tu deuda es MONTO_001, PERSONA_001.';
    const respuestaReal  = 'Tu deuda es Bs 350, Juan Mamani.';

    // Reset completo de todos los mocks para aislar este test
    geminiPostSpy.mockReset();
    mockPseudonymService.pseudonymize.mockReset();
    mockPseudonymService.rehydrate.mockReset();
    mockPseudonymService.invalidate.mockReset().mockResolvedValue(undefined);

    geminiPostSpy
      .mockResolvedValueOnce({ data: { embedding: { values: MOCK_EMBEDDING } } })
      .mockResolvedValueOnce({
        data: { candidates: [{ content: { parts: [{ text: respuestaToken }] } }] },
      });

    mockPseudonymService.pseudonymize.mockResolvedValueOnce({
      pseudonymizedText: `PREGUNTA: ${preguntaToken}\nCONTEXTO: ${contextoToken}`,
      mappingKey:        'pseudo:591:e2e',
      replacementsCount: 2,
    });

    mockPseudonymService.rehydrate.mockResolvedValueOnce(respuestaReal);

    const result = await service.query(preguntaReal, contextoReal, '59170000001', 'Juan Mamani');

    // Resultado final tiene datos reales
    expect(result.answer).toBe(respuestaReal);
    expect(result.found).toBe(true);
    expect(result.documentTitle).toBe('Manual de facturación 2024');

    // Gemini recibió tokens, NO datos reales
    const generatePrompt = geminiPostSpy.mock.calls[1][1].contents[0].parts[0].text;
    expect(generatePrompt).toContain('PERSONA_001');
    expect(generatePrompt).toContain('MONTO_001');
    expect(generatePrompt).not.toContain('Juan Mamani');
    expect(generatePrompt).not.toContain('Bs 350');

    // Tabla Redis fue invalidada al terminar
    expect(mockPseudonymService.invalidate).toHaveBeenCalledWith('pseudo:591:e2e');
  });

  // ─── Sin teléfono: sin seudonimización ───────────────────────────────────

  it('query() sin phoneNumber no llama a pseudonymize()', async () => {
    await service.query('cuánto debo', 'contexto');

    expect(mockPseudonymService.pseudonymize).not.toHaveBeenCalled();
  });

  // ─── Documentación del resultado ─────────────────────────────────────────

  it('debe incluir documentTitle en el resultado (US-EP03-01)', async () => {
    const result = await service.query('consulta', 'ctx', '59170000001', null);

    expect(result.documentTitle).toBe('Manual de facturación 2024');
  });

  // ─── Sin chunks: retorna found=false sin seudonimizar ────────────────────

  it('si no hay chunks relevantes, retorna found=false sin llamar a Gemini generate', async () => {
    mockDataSource.query.mockResolvedValueOnce([]); // sin resultados

    const result = await service.query('consulta', 'ctx', '59170000001', null);

    expect(result.found).toBe(false);
    // Solo se llamó una vez a Gemini (embed), no el generate
    expect(geminiPostSpy).toHaveBeenCalledTimes(1);
  });
});
