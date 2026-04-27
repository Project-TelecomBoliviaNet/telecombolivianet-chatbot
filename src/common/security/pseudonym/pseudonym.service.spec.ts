/**
 * @file pseudonym.service.spec.ts
 * @description Tests unitarios del PseudonymService.
 *
 * Criterios de aceptación validados (US-EP01-02):
 *   AC-01: pseudonymize() retorna texto tokenizado + mappingKey.
 *   AC-02: Tokens siguen el formato ENTIDAD_NNN.
 *   AC-03: Tabla de correspondencia se almacena en Redis con TTL.
 *   AC-04: rehydrate() restaura los valores reales.
 *   AC-05: PseudonymExpiredError si el TTL expiró.
 *   AC-06: La misma entidad en el texto usa el mismo token.
 *   AC-07: Cobertura ≥ 85%.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PseudonymService } from './pseudonym.service';
import { PseudonymExpiredError } from './pseudonym-expired.error';
import { SensitiveEntityType } from './sensitive-entity.types';

// ─── Mock de Redis ────────────────────────────────────────────────────────────

const redisStore = new Map<string, string>();

const mockRedisInstance = {
  set: jest.fn(async (key: string, value: string) => {
    redisStore.set(key, value);
    return 'OK';
  }),
  get: jest.fn(async (key: string) => redisStore.get(key) ?? null),
  del: jest.fn(async (key: string) => {
    redisStore.delete(key);
    return 1;
  }),
  on:   jest.fn(),
  quit: jest.fn(async () => 'OK'),
};

// ioredis exporta la clase como default export — hay que mockear el módulo
// completo para que `new Redis(...)` retorne nuestro mock.
jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => mockRedisInstance),
}));

// ─── Mock de ConfigService ───────────────────────────────────────────────────

const mockConfigService = {
  get: jest.fn((key: string) => {
    const cfg: Record<string, unknown> = {
      'redis.host':                    'localhost',
      'redis.port':                    6379,
      'redis.password':                undefined,
      'redis.db':                      0,
      'security.pseudonymTtlSeconds':  300,
    };
    return cfg[key];
  }),
};

// ─── Setup del módulo ─────────────────────────────────────────────────────────

describe('PseudonymService', () => {
  let service: PseudonymService;

  beforeEach(async () => {
    redisStore.clear();
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PseudonymService,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<PseudonymService>(PseudonymService);
    service.onModuleInit();
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  // ─── pseudonymize() ──────────────────────────────────────────────────────

  describe('pseudonymize()', () => {
    it('AC-01: debe retornar pseudonymizedText y mappingKey cuando hay PII', async () => {
      const result = await service.pseudonymize(
        'Tu deuda es Bs 350',
        '59170000001',
      );

      expect(result.pseudonymizedText).not.toContain('Bs 350');
      expect(result.pseudonymizedText).toMatch(/MONTO_\d{3}/);
      expect(result.mappingKey).toMatch(/^pseudo:59170000001:/);
      expect(result.replacementsCount).toBeGreaterThan(0);
    });

    it('AC-02: los tokens siguen el formato PREFIJO_NNN', async () => {
      const result = await service.pseudonymize(
        'Cliente CLI-4821 debe Bs 200 y Bs 100',
        '59170000001',
      );

      // El texto seudonimizado solo debe contener tokens válidos, no PII
      const tokenPattern = /\b[A-Z]+_\d{3}\b/g;
      const tokens = result.pseudonymizedText.match(tokenPattern) ?? [];
      expect(tokens.length).toBeGreaterThan(0);
      tokens.forEach((token) => {
        expect(token).toMatch(/^[A-Z]+_\d{3}$/);
      });
    });

    it('AC-03: debe persistir la tabla en Redis con TTL', async () => {
      await service.pseudonymize('Deuda Bs 500', '59170000001');

      expect(mockRedisInstance.set).toHaveBeenCalledWith(
        expect.stringMatching(/^pseudo:/),
        expect.any(String),
        'EX',
        300,
      );
    });

    it('AC-06: la misma entidad múltiples veces usa el mismo token', async () => {
      const result = await service.pseudonymize(
        'Debe Bs 350. El total es Bs 350.',
        '59170000001',
      );

      // Ambas ocurrencias de "Bs 350" deben tener el mismo token
      const tokens = result.pseudonymizedText.match(/MONTO_\d{3}/g) ?? [];
      expect(tokens.length).toBe(2);
      expect(tokens[0]).toBe(tokens[1]);
    });

    it('debe seudonimizar nombre del cliente cuando se provee clientName', async () => {
      const result = await service.pseudonymize(
        'Hola Juan Mamani, tu deuda es Bs 150',
        '59170000001',
        'Juan Mamani',
      );

      expect(result.pseudonymizedText).not.toContain('Juan Mamani');
      expect(result.pseudonymizedText).toContain('PERSONA_001');
      expect(result.pseudonymizedText).toContain('MONTO_001');
    });

    it('debe retornar texto original sin mappingKey si no hay PII', async () => {
      const textoSinPii = 'Hola, ¿cómo estás?';
      const result = await service.pseudonymize(textoSinPii, '59170000001');

      expect(result.pseudonymizedText).toBe(textoSinPii);
      expect(result.mappingKey).toBe('');
      expect(result.replacementsCount).toBe(0);
      expect(mockRedisInstance.set).not.toHaveBeenCalled();
    });

    it('debe manejar texto vacío sin lanzar error', async () => {
      const result = await service.pseudonymize('', '59170000001');
      expect(result.pseudonymizedText).toBe('');
      expect(result.replacementsCount).toBe(0);
    });

    it('debe seudonimizar ticket, cliente y monto en el mismo texto', async () => {
      const result = await service.pseudonymize(
        'Cliente CLI-4821 abrió TKT-7890 con deuda Bs 600',
        '59170000001',
      );

      expect(result.pseudonymizedText).not.toContain('CLI-4821');
      expect(result.pseudonymizedText).not.toContain('TKT-7890');
      expect(result.pseudonymizedText).not.toContain('Bs 600');
      expect(result.pseudonymizedText).toContain('CLIENTE_001');
      expect(result.pseudonymizedText).toContain('TICKET_001');
      expect(result.pseudonymizedText).toContain('MONTO_001');
    });

    it('debe asignar tokens distintos para valores distintos del mismo tipo', async () => {
      const result = await service.pseudonymize(
        'Deuda Bs 350 más interés Bs 50',
        '59170000001',
      );

      const tokens = result.pseudonymizedText.match(/MONTO_\d{3}/g) ?? [];
      const unique  = new Set(tokens);
      expect(unique.size).toBe(2); // MONTO_001 y MONTO_002
    });

    it('debe usar claves Redis únicas por invocación (UUID distinto)', async () => {
      const r1 = await service.pseudonymize('Bs 100', '59170000001');
      const r2 = await service.pseudonymize('Bs 200', '59170000001');

      expect(r1.mappingKey).not.toBe(r2.mappingKey);
    });
  });

  // ─── rehydrate() ─────────────────────────────────────────────────────────

  describe('rehydrate()', () => {
    it('AC-04: debe restaurar los valores reales', async () => {
      const original = 'Tu deuda es Bs 350 y tienes el ticket TKT-7890';
      const { pseudonymizedText, mappingKey } = await service.pseudonymize(
        original,
        '59170000001',
      );

      expect(pseudonymizedText).not.toBe(original);

      const restored = await service.rehydrate(pseudonymizedText, mappingKey);
      expect(restored).toBe(original);
    });

    it('AC-05: debe lanzar PseudonymExpiredError si la clave no existe', async () => {
      await expect(
        service.rehydrate('MONTO_001 pendiente', 'pseudo:fake:nonexistent-key'),
      ).rejects.toThrow(PseudonymExpiredError);
    });

    it('PseudonymExpiredError debe exponer la mappingKey', async () => {
      const key = 'pseudo:fake:test-key';
      try {
        await service.rehydrate('MONTO_001', key);
        fail('Debería haber lanzado PseudonymExpiredError');
      } catch (err) {
        expect(err).toBeInstanceOf(PseudonymExpiredError);
        expect((err as PseudonymExpiredError).mappingKey).toBe(key);
      }
    });

    it('debe retornar el texto original si mappingKey está vacío', async () => {
      const text   = 'MONTO_001 pendiente';
      const result = await service.rehydrate(text, '');
      expect(result).toBe(text);
    });

    it('debe reemplazar múltiples tokens distintos', async () => {
      const original = 'CLI-4821 debe Bs 350 por TKT-7890';
      const { pseudonymizedText, mappingKey } = await service.pseudonymize(
        original,
        '59170000001',
      );

      const restored = await service.rehydrate(pseudonymizedText, mappingKey);
      expect(restored).toBe(original);
    });

    it('debe funcionar correctamente con el nombre del cliente', async () => {
      const original = 'Hola María Rodríguez, debes Bs 200';
      const { pseudonymizedText, mappingKey } = await service.pseudonymize(
        original,
        '59170000001',
        'María Rodríguez',
      );

      expect(pseudonymizedText).not.toContain('María Rodríguez');
      const restored = await service.rehydrate(pseudonymizedText, mappingKey);
      expect(restored).toBe(original);
    });
  });

  // ─── detect() ────────────────────────────────────────────────────────────

  describe('detect()', () => {
    it('debe retornar detecciones para texto con PII', () => {
      const detections = service.detect('deuda Bs 350', null);
      expect(detections.length).toBeGreaterThan(0);
      expect(detections[0].entityType).toBe(SensitiveEntityType.AMOUNT_BOB);
    });

    it('debe retornar array vacío para texto sin PII', () => {
      const detections = service.detect('hola, ¿cómo estás?', null);
      expect(detections).toHaveLength(0);
    });

    it('debe detectar el nombre del cliente cuando se provee', () => {
      const detections = service.detect(
        'Hola Pedro Quispe, tu saldo es 0',
        'Pedro Quispe',
      );
      const tipos = detections.map((d) => d.entityType);
      expect(tipos).toContain(SensitiveEntityType.FULL_NAME);
    });

    it('las detecciones nunca deben exponer el valor real', () => {
      const detections = service.detect('deuda Bs 350', null);
      // PiiDetection solo tiene: entityType, startIndex, endIndex, valueLength
      for (const d of detections) {
        expect(d).not.toHaveProperty('value');
        expect(d).not.toHaveProperty('originalValue');
        expect(typeof d.entityType).toBe('string');
        expect(typeof d.startIndex).toBe('number');
        expect(typeof d.endIndex).toBe('number');
        expect(typeof d.valueLength).toBe('number');
      }
    });
  });

  // ─── invalidate() ────────────────────────────────────────────────────────

  describe('invalidate()', () => {
    it('debe eliminar la clave de Redis', async () => {
      const { mappingKey } = await service.pseudonymize('Bs 100', '59170000001');
      await service.invalidate(mappingKey);

      expect(mockRedisInstance.del).toHaveBeenCalledWith(mappingKey);
    });

    it('no debe llamar a Redis.del si mappingKey está vacío', async () => {
      await service.invalidate('');
      expect(mockRedisInstance.del).not.toHaveBeenCalled();
    });
  });
});
