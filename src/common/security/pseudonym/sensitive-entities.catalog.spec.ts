/**
 * @file sensitive-entities.catalog.spec.ts
 * @description Tests del catálogo de entidades sensibles.
 *
 * Criterios de aceptación validados (US-EP01-01):
 *   AC-01: Catálogo con las entidades definidas.
 *   AC-04: Tests que validan ≥5 positivos y ≥5 negativos por patrón.
 */

import {
  SENSITIVE_ENTITIES_CATALOG,
  SENSITIVE_ENTITIES_MAP,
  getPatternBasedEntities,
} from './sensitive-entities.catalog';
import { SensitiveEntityType } from './sensitive-entity.types';

// ─── Helper ───────────────────────────────────────────────────────────────────

function matchesAnyPattern(text: string, type: SensitiveEntityType): boolean {
  const def = SENSITIVE_ENTITIES_MAP.get(type);
  if (!def) return false;
  return def.patterns.some((p) => {
    const safe = new RegExp(p.source, p.flags);
    return safe.test(text);
  });
}

// ─── Estructura del catálogo ──────────────────────────────────────────────────

describe('SENSITIVE_ENTITIES_CATALOG — estructura', () => {
  it('debe contener todas las entidades definidas en SensitiveEntityType', () => {
    const catalogTypes = new Set(SENSITIVE_ENTITIES_CATALOG.map((d) => d.type));
    for (const type of Object.values(SensitiveEntityType)) {
      expect(catalogTypes).toContain(type);
    }
  });

  it('cada definición debe tener tokenPrefix no vacío', () => {
    for (const def of SENSITIVE_ENTITIES_CATALOG) {
      expect(def.tokenPrefix.trim().length).toBeGreaterThan(0);
    }
  });

  it('cada definición debe tener description no vacía', () => {
    for (const def of SENSITIVE_ENTITIES_CATALOG) {
      expect(def.description.trim().length).toBeGreaterThan(0);
    }
  });

  it('SENSITIVE_ENTITIES_MAP debe tener la misma cantidad de entradas que el catálogo', () => {
    expect(SENSITIVE_ENTITIES_MAP.size).toBe(SENSITIVE_ENTITIES_CATALOG.length);
  });

  it('getPatternBasedEntities() debe excluir FULL_NAME (sin patrones)', () => {
    const entities = getPatternBasedEntities();
    const types    = entities.map((e) => e.type);
    expect(types).not.toContain(SensitiveEntityType.FULL_NAME);
  });
});

// ─── TICKET_NUMBER ────────────────────────────────────────────────────────────

describe('TICKET_NUMBER — patrones', () => {
  const positivos = [
    'Mi ticket es TKT-7890',
    'el ticket TKT-2024-001 sigue abierto',
    'Ref: ticket #1234',
    'cierra el ticket#5678 por favor',
    'TKT-123 no fue atendido',
  ];

  const negativos = [
    'el total es 100',
    'mi nombre es TKT',       // prefijo sin guión y número
    'ticket de avión',
    'compré un ticket',
    'ref: ABC123',             // sin prefijo TKT
  ];

  test.each(positivos)('debe detectar: "%s"', (text) => {
    expect(matchesAnyPattern(text, SensitiveEntityType.TICKET_NUMBER)).toBe(true);
  });

  test.each(negativos)('NO debe detectar: "%s"', (text) => {
    expect(matchesAnyPattern(text, SensitiveEntityType.TICKET_NUMBER)).toBe(false);
  });
});

// ─── CLIENT_ID ────────────────────────────────────────────────────────────────

describe('CLIENT_ID — patrones', () => {
  const positivos = [
    'tu código es CLI-4821',
    'cliente CLI-2024-00123',
    'cliente: 48210',
    'su cliente es 5000',
    'cliente #4000 registrado',
  ];

  const negativos = [
    'hola cliente',
    'eres un buen cliente',
    '50',                      // muy corto
    'CLI sin número',
    'código abc',
  ];

  test.each(positivos)('debe detectar: "%s"', (text) => {
    expect(matchesAnyPattern(text, SensitiveEntityType.CLIENT_ID)).toBe(true);
  });

  test.each(negativos)('NO debe detectar: "%s"', (text) => {
    expect(matchesAnyPattern(text, SensitiveEntityType.CLIENT_ID)).toBe(false);
  });
});

// ─── AMOUNT_BOB ───────────────────────────────────────────────────────────────

describe('AMOUNT_BOB — patrones', () => {
  const positivos = [
    'debes Bs 350',
    'pago de Bs. 1200.50',
    'son bs 80',
    '350 Bs de deuda',
    '1.200 bolivianos pendientes',
  ];

  const negativos = [
    'buenas noches',
    'mi plan',
    '350 mensajes',
    'número 500',
    'Bs sin número',
  ];

  test.each(positivos)('debe detectar: "%s"', (text) => {
    expect(matchesAnyPattern(text, SensitiveEntityType.AMOUNT_BOB)).toBe(true);
  });

  test.each(negativos)('NO debe detectar: "%s"', (text) => {
    expect(matchesAnyPattern(text, SensitiveEntityType.AMOUNT_BOB)).toBe(false);
  });
});

// ─── PHONE_NUMBER ─────────────────────────────────────────────────────────────

describe('PHONE_NUMBER — patrones', () => {
  const positivos = [
    'llámame al +59170000001',
    'mi número 591-70123456',
    'cel: 76543210',
    'teléfono 67890123',
    '+591 71234567',
  ];

  const negativos = [
    '12345678',                // empieza en 1, no en 6 o 7
    '591',                     // demasiado corto
    '700000',                  // solo 6 dígitos
    '800000001',               // empieza en 8
    'código 9876',
  ];

  test.each(positivos)('debe detectar: "%s"', (text) => {
    expect(matchesAnyPattern(text, SensitiveEntityType.PHONE_NUMBER)).toBe(true);
  });

  test.each(negativos)('NO debe detectar: "%s"', (text) => {
    expect(matchesAnyPattern(text, SensitiveEntityType.PHONE_NUMBER)).toBe(false);
  });
});

// ─── INVOICE_NUMBER ───────────────────────────────────────────────────────────

describe('INVOICE_NUMBER — patrones', () => {
  const positivos = [
    'factura FACT-2024-00123',
    'la FAC-001 está pendiente',
    'factura: 2024-001',
    'comprobante 12345',
    'FACT-7890',
  ];

  const negativos = [
    'hola',
    'factura',                 // sin número
    'comprobante de amor',
    '123',                     // muy corto
    'REF-001',                 // prefijo diferente
  ];

  test.each(positivos)('debe detectar: "%s"', (text) => {
    expect(matchesAnyPattern(text, SensitiveEntityType.INVOICE_NUMBER)).toBe(true);
  });

  test.each(negativos)('NO debe detectar: "%s"', (text) => {
    expect(matchesAnyPattern(text, SensitiveEntityType.INVOICE_NUMBER)).toBe(false);
  });
});

// ─── TBN_CODE ────────────────────────────────────────────────────────────────

describe('TBN_CODE — patrones', () => {
  const positivos = [
    'código TBN-2024-A',
    'ref TBN-001',
    'su TBN-XY es válido',
    'TBN-2023-Z1',
    'código: TBN-99',
  ];

  const negativos = [
    'TBN sin guión',
    'TBNN-001',               // prefijo incorrecto
    'código 001',
    'hola TBN',
    'T-001',
  ];

  test.each(positivos)('debe detectar: "%s"', (text) => {
    expect(matchesAnyPattern(text, SensitiveEntityType.TBN_CODE)).toBe(true);
  });

  test.each(negativos)('NO debe detectar: "%s"', (text) => {
    expect(matchesAnyPattern(text, SensitiveEntityType.TBN_CODE)).toBe(false);
  });
});
