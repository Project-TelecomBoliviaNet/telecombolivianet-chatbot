/**
 * @file sensitive-entities.catalog.ts
 * @description Catálogo de entidades sensibles a seudonimizar.
 *
 * REGLAS DE DISEÑO DE PATRONES:
 * ─────────────────────────────
 * 1. Conservadores: mejor no detectar que detectar de más (falso positivo
 *    contamina el texto enviado a Gemini con tokens inesperados).
 * 2. Contextualizados: los patrones incluyen contexto boliviano
 *    (prefijos CLI-, TBN-, moneda Bs).
 * 3. Case-insensitive donde aplique (flag 'i').
 * 4. Global obligatorio (flag 'g') para que matchAll funcione.
 * 5. Orden en el catálogo importa: entidades más específicas primero
 *    para evitar que un patrón genérico consuma parte de uno específico.
 *
 * PROCESO DE ACTUALIZACIÓN:
 * ──────────────────────────
 * 1. Agregar la nueva entidad en SensitiveEntityType (types.ts).
 * 2. Agregar su definición aquí con al menos 5 ejemplos de prueba.
 * 3. Ejecutar los tests: npm test sensitive-entities.catalog.spec.
 * 4. Commit con mensaje: "feat(security): add [TIPO] to sensitive catalog".
 */

import {
  SensitiveEntityDefinition,
  SensitiveEntityType,
} from './sensitive-entity.types';

// ─── Catálogo completo ────────────────────────────────────────────────────────

/**
 * Lista ordenada de entidades sensibles.
 * El orden determina la prioridad de detección cuando dos patrones
 * podrían solaparse en el mismo fragmento de texto.
 *
 * Orden recomendado: más específico → más genérico.
 */
export const SENSITIVE_ENTITIES_CATALOG: readonly SensitiveEntityDefinition[] = [

  // ── 1. Número de ticket (más específico — tiene prefijo TKT) ──────────────
  {
    type: SensitiveEntityType.TICKET_NUMBER,
    tokenPrefix: 'TICKET',
    description: 'Número de ticket de soporte técnico del sistema C#',
    patterns: [
      // TKT-7890, TKT-2024-001, ticket #1234
      /\bTKT-\d{3,8}\b/gi,
      /\bticket\s*#?\s*\d{3,8}\b/gi,
    ],
  },

  // ── 2. Número de cliente (prefijo CLI o formato numérico largo) ───────────
  {
    type: SensitiveEntityType.CLIENT_ID,
    tokenPrefix: 'CLIENTE',
    description: 'Identificador de cliente en el sistema central C#',
    patterns: [
      // CLI-4821, CLI-2024-00123
      /\bCLI-[\dA-Z-]{3,12}\b/gi,
      // "cliente: 48210", "cliente #4000", "cliente 48210"
      /\bcliente\s*[:#]?\s*\d{4,8}\b/gi,
      // "su cliente es 5000", "cliente es 4000" — con verbo entre medias
      /\bcliente\s+(?:es|número|num\.?)\s+\d{4,8}\b/gi,
    ],
  },

  // ── 3. Código TBN ─────────────────────────────────────────────────────────
  {
    type: SensitiveEntityType.TBN_CODE,
    tokenPrefix: 'TBN',
    description: 'Código TBN del sistema de facturación C#',
    patterns: [
      // TBN-2024-A, TBN-001
      /\bTBN-[\dA-Z-]{2,12}\b/gi,
    ],
  },

  // ── 4. Número de factura ──────────────────────────────────────────────────
  {
    type: SensitiveEntityType.INVOICE_NUMBER,
    tokenPrefix: 'FACTURA',
    description: 'Número de factura o comprobante de pago',
    patterns: [
      // FACT-2024-00123, FAC-001, FAC-2024
      /\bFACT?-[\d-]{2,12}\b/gi,
      // "factura 2024-001", "factura: 001"
      /\bfactura\s*[:#]?\s*([\dA-Z-]{3,12})\b/gi,
      // "comprobante 12345"
      /\bcomprobante\s*[:#]?\s*(\d{4,10})\b/gi,
    ],
  },

  // ── 5. Monto en bolivianos ────────────────────────────────────────────────
  {
    type: SensitiveEntityType.AMOUNT_BOB,
    tokenPrefix: 'MONTO',
    description: 'Monto monetario en bolivianos (Bs)',
    patterns: [
      // Bs 350, Bs. 350.00, bs 1,200.50
      /\bBs\.?\s*\d{1,6}(?:[.,]\d{1,2})?\b/gi,
      // 350 Bs, 1200.50 bs
      /\b\d{1,6}(?:[.,]\d{1,2})?\s*Bs\.?\b/gi,
      // 350 bolivianos
      /\b\d{1,6}(?:[.,]\d{1,2})?\s*bolivianos?\b/gi,
    ],
  },

  // ── 6. Número de teléfono boliviano ──────────────────────────────────────
  {
    type: SensitiveEntityType.PHONE_NUMBER,
    tokenPrefix: 'TELEFONO',
    description: 'Número de teléfono celular boliviano',
    patterns: [
      // +591 70000001, 591-70000001
      /\+?591[-\s]?[67]\d{7}\b/g,
      // 70000001 (8 dígitos iniciando en 6 o 7)
      /\b[67]\d{7}\b/g,
    ],
  },

  // ── 7. Nombre de plan de internet ────────────────────────────────────────
  {
    type: SensitiveEntityType.PLAN_NAME,
    tokenPrefix: 'PLAN',
    description: 'Nombre del plan de internet contratado',
    patterns: [
      // "Plan Fibra 100Mb", "Plan Básico", "plan hogar 50mb"
      /\bPlan\s+(?:Fibra\s+)?(?:Hogar\s+)?(?:Básico|Estándar|Premium|Pro|[\w]+\s*)?\d*\s*(?:Mb|MB|Gbps|Gb)?\b/gi,
      // "plan: Fibra 100Mb"
      /\bplan\s*[:#]\s*[\w\s]{3,30}(?:Mb|MB|Gbps|Gb)\b/gi,
    ],
  },

  // ── 8. Nombre completo (más genérico — va último) ─────────────────────────
  //
  // NOTA IMPORTANTE:
  // La detección de nombres propios con regex tiene alto riesgo de
  // falsos positivos (ej: "Hola", "Bolivia", nombres de planes).
  // Este patrón se aplica SOLO cuando el texto ya pasó por el
  // contexto de la sesión (clientName conocido), usando sustitución
  // directa por valor exacto, NO por regex genérico.
  //
  // La detección por regex genérico está desactivada intencionalmente.
  // Activar solo si se entrena un modelo NER como en la tesis (Mamani, 2026).
  {
    type: SensitiveEntityType.FULL_NAME,
    tokenPrefix: 'PERSONA',
    description: 'Nombre completo de persona (sustituido por valor exacto de sesión)',
    patterns: [
      // Patrón deliberadamente vacío — la sustitución de nombres se hace
      // por inyección del valor de sesión en PseudonymService, no por regex.
      // Ver: PseudonymService.buildSessionAwarePatterns()
    ],
  },

] as const;

// ─── Mapa de acceso rápido por tipo ──────────────────────────────────────────

/**
 * Mapa inmutable para acceso O(1) por tipo de entidad.
 * Construido una sola vez al cargar el módulo.
 */
export const SENSITIVE_ENTITIES_MAP: ReadonlyMap<
  SensitiveEntityType,
  SensitiveEntityDefinition
> = new Map(
  SENSITIVE_ENTITIES_CATALOG.map((def) => [def.type, def]),
);

// ─── Helper: entidades con patrones activos ───────────────────────────────────

/**
 * Retorna solo las definiciones que tienen al menos un patrón regex.
 * (Excluye FULL_NAME que usa sustitución directa).
 */
export function getPatternBasedEntities(): readonly SensitiveEntityDefinition[] {
  return SENSITIVE_ENTITIES_CATALOG.filter((def) => def.patterns.length > 0);
}
