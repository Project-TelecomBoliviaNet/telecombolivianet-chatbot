/**
 * @file query-reformulation.service.spec.ts
 * @description Tests unitarios del QueryReformulationService (US-EP02-01).
 *
 * Criterios de aceptación validados:
 *   AC-01: Recibe texto del usuario + historial y retorna query reformulada.
 *   AC-02: Si la query ya es clara, la retorna sin modificar.
 *   AC-03: Timeout de 3s → fallback a query original sin bloquear.
 *   AC-04: Si Gemini no está disponible → retorna original.
 *   AC-05: El flag wasReformulated indica si hubo cambio.
 *   AC-06: Tests con 10 casos de queries bolivianas típicas.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { QueryReformulationService } from './query-reformulation.service';

// ─── Mock de ConfigService ────────────────────────────────────────────────────

const mockConfig = {
  get: jest.fn((key: string) => {
    const cfg: Record<string, unknown> = {
      'gemini.apiKey':              'test-api-key',
      'gemini.intentModel':         'gemini-2.0-flash',
      'rag.reformulationTimeoutMs': 3_000,
    };
    return cfg[key];
  }),
};

// ─── Helper ───────────────────────────────────────────────────────────────────

async function buildService(geminiResponse?: string): Promise<{
  service: QueryReformulationService;
  postSpy: jest.Mock;
}> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      QueryReformulationService,
      { provide: ConfigService, useValue: mockConfig },
    ],
  }).compile();

  const service = module.get<QueryReformulationService>(QueryReformulationService);

  // Marcar Gemini como disponible e inyectar mock HTTP
  const postSpy = jest.fn().mockResolvedValue({
    data: {
      candidates: [{
        content: { parts: [{ text: geminiResponse ?? 'Sin conexión a internet solución' }] },
      }],
    },
  });

  (service as any).http            = { post: postSpy };
  (service as any).geminiAvailable = true;

  return { service, postSpy };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('QueryReformulationService (US-EP02-01)', () => {

  // ─── AC-01: reformula correctamente ──────────────────────────────────────

  describe('AC-01: reformulación de queries bolivianas', () => {
    const casos: Array<{ entrada: string; esperado: string }> = [
      { entrada: 'no tengo inet',               esperado: 'Sin conexión a internet solución' },
      { entrada: 'kiero pagar',                  esperado: 'Cómo pagar mi factura' },
      { entrada: 'cuanto debo',                  esperado: 'Cuál es mi deuda pendiente' },
      { entrada: 'lento el net',                 esperado: 'Internet lento baja velocidad' },
      { entrada: 'problema con routeador',       esperado: 'Falla en el router solución' },
      { entrada: 'cuando vence',                 esperado: 'Fecha límite de pago actual' },
      { entrada: 'no m llega el net',            esperado: 'Sin conexión a internet cómo solucionar' },
      { entrada: 'luz roja en el modem',         esperado: 'Luz roja en el router qué significa' },
      { entrada: 'kiero cambiar mi plan',        esperado: 'Cómo cambiar mi plan de internet' },
      { entrada: 'no carga nada en mi cel',      esperado: 'Internet no carga en dispositivo móvil' },
    ];

    test.each(casos)(
      'reformula: "$entrada" → usa la respuesta de Gemini',
      async ({ entrada, esperado }) => {
        const { service } = await buildService(esperado);
        const result = await service.reformulate(entrada, '');

        expect(result.wasReformulated).toBe(true);
        expect(result.query).toBe(esperado);
        expect(result.originalQuery).toBe(entrada);
      },
    );
  });

  // ─── AC-02: sin cambios si Gemini devuelve lo mismo ──────────────────────

  it('AC-02: wasReformulated=false cuando Gemini devuelve la query igual', async () => {
    const query = 'cómo reinicio el router';
    const { service } = await buildService(query); // Gemini devuelve lo mismo

    const result = await service.reformulate(query, '');

    expect(result.wasReformulated).toBe(false);
    expect(result.query).toBe(query);
  });

  // ─── AC-03: timeout → fallback a query original ───────────────────────────

  it('AC-03: timeout de Gemini devuelve la query original sin bloquear', async () => {
    const { service, postSpy } = await buildService();

    postSpy.mockRejectedValueOnce(
      Object.assign(new Error('timeout of 3000ms exceeded'), { code: 'ECONNABORTED' }),
    );

    const query  = 'no tengo internet';
    const result = await service.reformulate(query, '');

    expect(result.wasReformulated).toBe(false);
    expect(result.query).toBe(query);
    expect(result.originalQuery).toBe(query);
  });

  // ─── AC-04: Gemini no disponible → retorna original ──────────────────────

  it('AC-04: si Gemini no está disponible, retorna la query original', async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QueryReformulationService,
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    const service = module.get<QueryReformulationService>(QueryReformulationService);
    // geminiAvailable es false por defecto (no se llamó a onModuleInit)

    const result = await service.reformulate('no tengo internet', '');

    expect(result.wasReformulated).toBe(false);
    expect(result.query).toBe('no tengo internet');
  });

  // ─── AC-05: wasReformulated correcto ──────────────────────────────────────

  describe('AC-05: flag wasReformulated', () => {
    it('es true cuando la query cambió', async () => {
      const { service } = await buildService('Sin conexión a internet');
      const result = await service.reformulate('no hay net', '');
      expect(result.wasReformulated).toBe(true);
    });

    it('es false cuando el texto era vacío', async () => {
      const { service } = await buildService();
      const result = await service.reformulate('', '');
      expect(result.wasReformulated).toBe(false);
    });

    it('es false cuando Gemini falla', async () => {
      const { service, postSpy } = await buildService();
      postSpy.mockRejectedValueOnce(new Error('503 Service Unavailable'));
      const result = await service.reformulate('cuanto debo', '');
      expect(result.wasReformulated).toBe(false);
    });
  });

  // ─── Sanitización de respuesta de Gemini ──────────────────────────────────

  describe('sanitización de respuesta', () => {
    it('elimina comillas envolventes que Gemini puede agregar', async () => {
      const { service } = await buildService('"Sin conexión a internet"');
      const result = await service.reformulate('no tengo net', '');
      expect(result.query).toBe('Sin conexión a internet');
      expect(result.query).not.toContain('"');
    });

    it('toma solo la primera línea si Gemini retorna múltiples', async () => {
      const { service } = await buildService('Primera línea\nSegunda línea');
      const result = await service.reformulate('no tengo net', '');
      expect(result.query).toBe('Primera línea');
    });

    it('usa fallback si la respuesta es demasiado larga (>200 chars)', async () => {
      const textoLargo = 'A'.repeat(201);
      const { service } = await buildService(textoLargo);
      const original = 'no tengo net';
      const result   = await service.reformulate(original, '');
      expect(result.query).toBe(original);
      expect(result.wasReformulated).toBe(false);
    });

    it('usa fallback si la respuesta es demasiado corta (<3 chars)', async () => {
      const { service } = await buildService('OK');
      const original = 'no tengo net';
      const result   = await service.reformulate(original, '');
      expect(result.query).toBe(original);
      expect(result.wasReformulated).toBe(false);
    });
  });

  // ─── Uso del contexto de conversación ─────────────────────────────────────

  it('incluye el contexto de conversación en el prompt enviado a Gemini', async () => {
    const { service, postSpy } = await buildService('Router sin señal solución');
    const contexto = 'Usuario: tengo problemas\nBot: ¿con qué exactamente?';

    await service.reformulate('con el router', contexto);

    const promptEnviado = postSpy.mock.calls[0][1].contents[0].parts[0].text;
    expect(promptEnviado).toContain(contexto);
  });

  it('maneja ausencia de contexto sin lanzar error', async () => {
    const { service } = await buildService('Sin conexión a internet');
    const result = await service.reformulate('no tengo internet');
    expect(result).toBeDefined();
    expect(result.query).toBeTruthy();
  });

  // ─── Estructura del objeto retornado ──────────────────────────────────────

  it('siempre retorna originalQuery igual a la entrada', async () => {
    const { service } = await buildService('Reformulada');
    const input  = 'kiero pagar mi cuota';
    const result = await service.reformulate(input, '');
    expect(result.originalQuery).toBe(input);
  });

  it('query nunca es undefined ni null', async () => {
    const { service, postSpy } = await buildService();
    postSpy.mockRejectedValueOnce(new Error('network error'));
    const result = await service.reformulate('algo', '');
    expect(result.query).toBeTruthy();
    expect(result.query).not.toBeNull();
    expect(result.query).not.toBeUndefined();
  });
});
