/**
 * @file index.ts
 * @description Barrel de exportaciones del módulo de seudonimización.
 *
 * Permite importar con rutas limpias:
 *   import { PseudonymService } from '@common/security/pseudonym';
 */

export { PseudonymService }        from './pseudonym.service';
export { PseudonymExpiredError }   from './pseudonym-expired.error';
export { PiiGuardInterceptor, PiiLeakError } from './pii-guard.interceptor';
export type { PiiGuardMode, PiiGuardReport } from './pii-guard.interceptor';
export {
  SENSITIVE_ENTITIES_CATALOG,
  SENSITIVE_ENTITIES_MAP,
  getPatternBasedEntities,
}                                  from './sensitive-entities.catalog';
export {
  SensitiveEntityType,
}                                  from './sensitive-entity.types';
export type {
  SensitiveEntityDefinition,
  PseudonymEntry,
  PseudonymizeResult,
  PiiDetection,
}                                  from './sensitive-entity.types';
