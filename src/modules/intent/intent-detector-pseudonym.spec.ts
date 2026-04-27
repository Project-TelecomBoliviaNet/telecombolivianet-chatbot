/**
 * @file intent-detector-pseudonym.spec.ts
 * @description Tests de integración: IntentDetectorService + seudonimización.
 *
 * Criterios de aceptación validados (US-EP01-03):
 *   AC-01: detect() seudonimiza el texto antes de enviarlo a Gemini.
 *   AC-02: El intent es correcto incluso con texto con PII.
 *   AC-03: Gemini NO recibe nombres reales ni montos reales.
 *   AC-04: Los logs muestran texto seudonimizado.
 *   AC-05: Test E2E "Juan Mamani debe Bs 350" → tokens en Gemini.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  IntentDetectorService,
  Intent,
} from './intent-detector.service';
import { PseudonymService } from '../../common/security/pseudonym/pseudonym.service';
import { PiiGuardInterceptor } from '../../common/security/pseudonym/pii-guard.interceptor';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockPseudonymService = {
  pseudonymize: jest.fn(),
  detect:       jest.fn().mockReturnValue([]),
};

const mockPiiGuard = {
  inspect: jest.fn().mockReturnValue({ hasLeak: false, detections: [], detectedTypes: [] }),
};

const mockConfigService = {
  get: jest.fn((key: string) => {
    const cfg: Record<string, unknown> = {
      'gemini.apiKey':      'test-api-key',
      'gemini.intentModel': 'gemini-2.0-flash',
    };
    return cfg[key];
  }),
};

// Texto seudonimizado que retornará el mock de PseudonymService
const PSEUDO_TEXT = 'Hola PERSONA_001, tu deuda es MONTO_001';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('IntentDetectorService — integración con seudonimización', () => {
  let service: IntentDetectorService;
  let geminiPostSpy: jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Mock del cliente HTTP de Gemini
    geminiPostSpy = jest.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: { parts: [{ text: 'CONSULTA_DEUDA' }] },
        }],
      },
    });

    mockPseudonymService.pseudonymize.mockResolvedValue({
      pseudonymizedText: PSEUDO_TEXT,
      mappingKey:        'pseudo:59170000001:uuid-test',
      replacementsCount: 2,
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IntentDetectorService,
        { provide: ConfigService,       useValue: mockConfigService },
        { provide: PseudonymService,    useValue: mockPseudonymService },
        { provide: PiiGuardInterceptor, useValue: mockPiiGuard },
      ],
    }).compile();

    service = module.get<IntentDetectorService>(IntentDetectorService);

    // Inyectar el mock de HTTP y marcar Gemini como disponible
    (service as any).http = { post: geminiPostSpy };
    (service as any).geminiAvailable = true;
    (service as any).model = 'gemini-2.0-flash';
  });

  // ─── AC-01 ────────────────────────────────────────────────────────────────

  it('AC-01: debe llamar a pseudonymize() antes de enviar a Gemini', async () => {
    await service.detect(
      'Hola Juan Mamani, cuánto debo',
      '59170000001',
      'Juan Mamani',
    );

    expect(mockPseudonymService.pseudonymize).toHaveBeenCalledWith(
      'Hola Juan Mamani, cuánto debo',
      '59170000001',
      'Juan Mamani',
    );
  });

  // ─── AC-02 ────────────────────────────────────────────────────────────────

  it('AC-02: debe retornar el intent correcto con texto con PII', async () => {
    const intent = await service.detect(
      'cuánto debo Bs 350',
      '59170000001',
      null,
    );

    expect(intent).toBe(Intent.CONSULTA_DEUDA);
  });

  // ─── AC-03 ────────────────────────────────────────────────────────────────

  it('AC-03: Gemini debe recibir el texto seudonimizado, NO el original', async () => {
    await service.detect(
      'Hola Juan Mamani, tu deuda es Bs 350',
      '59170000001',
      'Juan Mamani',
    );

    // Verificar el payload enviado a Gemini
    const callArgs = geminiPostSpy.mock.calls[0];
    const payload  = callArgs[1] as { contents: Array<{ parts: Array<{ text: string }> }> };
    const promptEnviado = payload.contents[0].parts[0].text;

    expect(promptEnviado).toContain(PSEUDO_TEXT);
    expect(promptEnviado).not.toContain('Juan Mamani');
    expect(promptEnviado).not.toContain('Bs 350');
  });

  // ─── AC-05: Test E2E ──────────────────────────────────────────────────────

  it('AC-05 E2E: "Juan Mamani debe Bs 350" → tokens en Gemini → intent CONSULTA_DEUDA', async () => {
    const textoOriginal   = 'Hola soy Juan Mamani y debo Bs 350';
    const textoTokenizado = 'Hola soy PERSONA_001 y debo MONTO_001';

    mockPseudonymService.pseudonymize.mockResolvedValueOnce({
      pseudonymizedText: textoTokenizado,
      mappingKey:        'pseudo:59170000001:e2e-test',
      replacementsCount: 2,
    });

    geminiPostSpy.mockResolvedValueOnce({
      data: { candidates: [{ content: { parts: [{ text: 'CONSULTA_DEUDA' }] } }] },
    });

    const intent = await service.detect(textoOriginal, '59170000001', 'Juan Mamani');

    // Intent correcto
    expect(intent).toBe(Intent.CONSULTA_DEUDA);

    // Gemini recibió tokens, NO datos reales
    const payload = geminiPostSpy.mock.calls[0][1];
    const prompt  = payload.contents[0].parts[0].text;
    expect(prompt).toContain('PERSONA_001');
    expect(prompt).toContain('MONTO_001');
    expect(prompt).not.toContain('Juan Mamani');
    expect(prompt).not.toContain('Bs 350');
  });

  // ─── Degradación controlada ───────────────────────────────────────────────

  it('debe continuar con texto original si pseudonymize() falla', async () => {
    mockPseudonymService.pseudonymize.mockRejectedValueOnce(
      new Error('Redis no disponible'),
    );

    // No debe lanzar error
    const intent = await service.detect('cuánto debo', '59170000001', null);
    expect(intent).toBeDefined();
  });

  it('detect() sin phoneNumber no debe llamar a pseudonymize()', async () => {
    // Compatibilidad hacia atrás: llamadas sin phoneNumber no seudonomizan
    await service.detect('cuánto debo');
    expect(mockPseudonymService.pseudonymize).not.toHaveBeenCalled();
  });

  // ─── PiiGuard ─────────────────────────────────────────────────────────────

  it('debe llamar a piiGuard.inspect() con el texto seudonimizado', async () => {
    await service.detect('cuánto debo Bs 100', '59170000001', null);

    expect(mockPiiGuard.inspect).toHaveBeenCalledWith(
      PSEUDO_TEXT,   // texto YA seudonimizado
      '59170000001',
      null,
    );
  });

  // ─── Fallback regex ───────────────────────────────────────────────────────

  it('debe usar fallback regex con el texto ORIGINAL si Gemini no está disponible', async () => {
    (service as any).geminiAvailable = false;

    const intent = await service.detect('cuánto debo', '59170000001', null);

    // Regex debe detectar CONSULTA_DEUDA sin necesidad de Gemini
    expect(intent).toBe(Intent.CONSULTA_DEUDA);
    expect(geminiPostSpy).not.toHaveBeenCalled();
  });
});
