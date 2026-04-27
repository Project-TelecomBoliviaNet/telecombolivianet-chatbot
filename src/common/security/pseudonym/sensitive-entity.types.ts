/**
 * @file sensitive-entity.types.ts
 * @description Tipos y contratos del sistema de seudonimización.
 *
 * Principio de responsabilidad única (SRP):
 *   Este archivo solo define tipos — sin lógica, sin dependencias.
 *   Cualquier servicio puede importarlos sin acoplamientos circulares.
 */

// ─── Categorías de entidades sensibles ───────────────────────────────────────

/**
 * Identifica el tipo de dato personal que una entidad representa.
 * Usada en logs de auditoría (nunca se logguea el valor, solo el tipo).
 */
export enum SensitiveEntityType {
  /** Nombre completo de persona (ej: "Juan Mamani Condori") */
  FULL_NAME = 'FULL_NAME',

  /** Número de cliente en el sistema C# (ej: "CLI-4821") */
  CLIENT_ID = 'CLIENT_ID',

  /** Monto de dinero en bolivianos (ej: "Bs 350", "350.00 Bs") */
  AMOUNT_BOB = 'AMOUNT_BOB',

  /** Número de factura o comprobante (ej: "FACT-2024-00123") */
  INVOICE_NUMBER = 'INVOICE_NUMBER',

  /** Número de teléfono celular boliviano (ej: "591 70000001") */
  PHONE_NUMBER = 'PHONE_NUMBER',

  /** Número de ticket de soporte (ej: "TKT-7890") */
  TICKET_NUMBER = 'TICKET_NUMBER',

  /** Nombre de plan de internet (ej: "Plan Fibra 100Mb") */
  PLAN_NAME = 'PLAN_NAME',

  /** Código TBN del sistema C# (ej: "TBN-2024-A") */
  TBN_CODE = 'TBN_CODE',
}

// ─── Definición de una entidad sensible ──────────────────────────────────────

/**
 * Define cómo detectar y tokenizar un tipo de dato personal.
 *
 * Cada EntidadSensible es inmutable: el catálogo se carga una vez
 * al inicio y no cambia en runtime.
 */
export interface SensitiveEntityDefinition {
  /** Tipo semántico del dato personal */
  readonly type: SensitiveEntityType;

  /**
   * Prefijo del token de reemplazo.
   * Ejemplo: prefijo "CLIENTE" → tokens "CLIENTE_001", "CLIENTE_002"
   */
  readonly tokenPrefix: string;

  /**
   * Expresiones regulares para detectar el dato en texto.
   * Se evalúan en orden; la primera que coincida gana.
   *
   * IMPORTANTE: Deben ser conservadoras (evitar falsos positivos)
   * y compiladas con flag 'g' para `matchAll`.
   */
  readonly patterns: readonly RegExp[];

  /**
   * Descripción legible para humanos. Usada en logs y documentación.
   */
  readonly description: string;
}

// ─── Resultado de seudonimización ────────────────────────────────────────────

/**
 * Par token → valor real, almacenado en la tabla de correspondencia.
 */
export interface PseudonymEntry {
  /** Token de reemplazo (ej: "CLIENTE_001") */
  readonly token: string;
  /** Valor real original (ej: "Juan Mamani") */
  readonly originalValue: string;
  /** Tipo semántico, para auditoría */
  readonly entityType: SensitiveEntityType;
}

/**
 * Resultado completo de pseudonymize().
 */
export interface PseudonymizeResult {
  /** Texto con todos los datos sensibles reemplazados por tokens */
  readonly pseudonymizedText: string;
  /**
   * Clave de Redis donde se almacenó la tabla de correspondencia.
   * Se pasa a rehydrate() para recuperar los valores reales.
   */
  readonly mappingKey: string;
  /** Cuántos reemplazos se realizaron (útil para métricas) */
  readonly replacementsCount: number;
}

// ─── Resultado de detección (para auditoría/tests) ───────────────────────────

/**
 * Describe una detección individual encontrada en un texto.
 * No contiene el valor real — solo metadatos para auditoría.
 */
export interface PiiDetection {
  /** Tipo de entidad detectada */
  readonly entityType: SensitiveEntityType;
  /** Posición de inicio en el texto original */
  readonly startIndex: number;
  /** Posición de fin en el texto original */
  readonly endIndex: number;
  /** Longitud del valor detectado (sin exponer el valor) */
  readonly valueLength: number;
}
