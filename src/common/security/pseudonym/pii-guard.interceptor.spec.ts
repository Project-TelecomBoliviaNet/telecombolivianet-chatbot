/**
 * @file pii-guard.interceptor.spec.ts
 * @description Tests unitarios del PiiGuardInterceptor.
 *
 * Criterios de aceptación validados (US-EP01-05):
 *   AC-01: Detecta PII y emite WARN en logs (modo permissive).
 *   AC-02: El log incluye tipo de entidad y cantidad (nunca el valor).
 *   AC-03: En modo strict lanza PiiLeakError.
 *   AC-04: En modo permissive NO lanza error.
 *   AC-05: Tests unitarios con los patrones del catálogo.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { PiiGuardInterceptor, PiiLeakError } from './pii-guard.interceptor';
import { PseudonymService } from './pseudonym.service';
import { SensitiveEntityType, PiiDetection } from './sensitive-entity.types';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockPseudonymService = {
  detect: jest.fn<PiiDetection[], [string, string | null | undefined]>(),
};

function makeConfig(mode: 'permissive' | 'strict') {
  return {
    get: jest.fn((key: string) =>
      key === 'security.piiGuardMode' ? mode : undefined,
    ),
  };
}

async function buildGuard(mode: 'permissive' | 'strict'): Promise<PiiGuardInterceptor> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      PiiGuardInterceptor,
      { provide: PseudonymService, useValue: mockPseudonymService },
      { provide: ConfigService, useValue: makeConfig(mode) },
    ],
  }).compile();

  return module.get<PiiGuardInterceptor>(PiiGuardInterceptor);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PiiGuardInterceptor', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    // Spy sobre Logger.prototype.warn para verificar alertas
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  // ─── Modo permissive ──────────────────────────────────────────────────────

  describe('modo permissive', () => {
    it('AC-04: debe retornar reporte sin lanzar error cuando hay PII', async () => {
      const guard = await buildGuard('permissive');

      mockPseudonymService.detect.mockReturnValue([
        {
          entityType:  SensitiveEntityType.AMOUNT_BOB,
          startIndex:  10,
          endIndex:    16,
          valueLength: 6,
        },
      ]);

      expect(() => guard.inspect('deuda Bs 350', '59170000001')).not.toThrow();
    });

    it('AC-01: debe loggear WARN cuando detecta PII', async () => {
      const guard = await buildGuard('permissive');

      mockPseudonymService.detect.mockReturnValue([
        {
          entityType:  SensitiveEntityType.CLIENT_ID,
          startIndex:  0,
          endIndex:    8,
          valueLength: 8,
        },
      ]);

      guard.inspect('CLI-4821 texto', '59170000001');

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('PII no seudonimizada detectada'),
      );
    });

    it('AC-02: el log NO debe contener el valor real (solo el tipo)', async () => {
      const guard = await buildGuard('permissive');

      mockPseudonymService.detect.mockReturnValue([
        {
          entityType:  SensitiveEntityType.AMOUNT_BOB,
          startIndex:  0,
          endIndex:    6,
          valueLength: 6,
        },
      ]);

      guard.inspect('Bs 350', '59170000001');

      const logArgs = warnSpy.mock.calls[0][0] as string;
      expect(logArgs).toContain('AMOUNT_BOB');
      expect(logArgs).not.toContain('Bs 350'); // Nunca el valor real
      expect(logArgs).not.toContain('350');    // Nunca el monto
    });

    it('debe retornar hasLeak=false si no hay PII', async () => {
      const guard = await buildGuard('permissive');
      mockPseudonymService.detect.mockReturnValue([]);

      const report = guard.inspect('hola, ¿cómo estás?', '59170000001');

      expect(report.hasLeak).toBe(false);
      expect(report.detections).toHaveLength(0);
      expect(report.detectedTypes).toHaveLength(0);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('debe consolidar tipos únicos en detectedTypes', async () => {
      const guard = await buildGuard('permissive');

      mockPseudonymService.detect.mockReturnValue([
        { entityType: SensitiveEntityType.AMOUNT_BOB, startIndex: 0, endIndex: 6, valueLength: 6 },
        { entityType: SensitiveEntityType.AMOUNT_BOB, startIndex: 20, endIndex: 26, valueLength: 6 },
        { entityType: SensitiveEntityType.CLIENT_ID,  startIndex: 10, endIndex: 18, valueLength: 8 },
      ]);

      const report = guard.inspect('texto con PII', '59170000001');

      expect(report.detectedTypes).toHaveLength(2); // Solo tipos únicos
      expect(report.detectedTypes).toContain(SensitiveEntityType.AMOUNT_BOB);
      expect(report.detectedTypes).toContain(SensitiveEntityType.CLIENT_ID);
    });
  });

  // ─── Modo strict ──────────────────────────────────────────────────────────

  describe('modo strict', () => {
    it('AC-03: debe lanzar PiiLeakError cuando detecta PII', async () => {
      const guard = await buildGuard('strict');

      mockPseudonymService.detect.mockReturnValue([
        {
          entityType:  SensitiveEntityType.TICKET_NUMBER,
          startIndex:  0,
          endIndex:    8,
          valueLength: 8,
        },
      ]);

      expect(() => guard.inspect('TKT-7890', '59170000001')).toThrow(PiiLeakError);
    });

    it('PiiLeakError debe exponer el reporte y el teléfono', async () => {
      const guard = await buildGuard('strict');

      mockPseudonymService.detect.mockReturnValue([
        {
          entityType:  SensitiveEntityType.PHONE_NUMBER,
          startIndex:  0,
          endIndex:    8,
          valueLength: 8,
        },
      ]);

      try {
        guard.inspect('76543210', '59170000002');
        fail('Debería haber lanzado PiiLeakError');
      } catch (err) {
        expect(err).toBeInstanceOf(PiiLeakError);
        const leak = err as PiiLeakError;
        expect(leak.phoneNumber).toBe('59170000002');
        expect(leak.report.hasLeak).toBe(true);
        expect(leak.report.detectedTypes).toContain(SensitiveEntityType.PHONE_NUMBER);
      }
    });

    it('NO debe lanzar si no hay PII (modo strict)', async () => {
      const guard = await buildGuard('strict');
      mockPseudonymService.detect.mockReturnValue([]);

      expect(() => guard.inspect('texto limpio', '59170000001')).not.toThrow();
    });
  });

  // ─── Integración con PseudonymService.detect() ───────────────────────────

  describe('delega correctamente en PseudonymService', () => {
    it('debe pasar texto y clientName a detect()', async () => {
      const guard = await buildGuard('permissive');
      mockPseudonymService.detect.mockReturnValue([]);

      guard.inspect('texto', '59170000001', 'Juan Mamani');

      expect(mockPseudonymService.detect).toHaveBeenCalledWith('texto', 'Juan Mamani');
    });

    it('debe pasar undefined como clientName si no se provee', async () => {
      const guard = await buildGuard('permissive');
      mockPseudonymService.detect.mockReturnValue([]);

      guard.inspect('texto', '59170000001');

      expect(mockPseudonymService.detect).toHaveBeenCalledWith('texto', undefined);
    });
  });
});
