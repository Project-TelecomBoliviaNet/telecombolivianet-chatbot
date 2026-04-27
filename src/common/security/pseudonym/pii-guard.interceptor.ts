/**
 * @file pii-guard.interceptor.ts
 * @description Interceptor de auditoría que detecta PII no seudonimizada
 *              antes de que salga hacia la API de Gemini.
 *
 * RESPONSABILIDAD (SRP):
 *   Única responsabilidad: escanear strings antes de enviarse a Gemini
 *   y emitir alertas si contienen PII. No modifica los datos.
 *
 * MODOS DE OPERACIÓN (PII_GUARD_MODE):
 *   - 'permissive' (default): Alerta en logs pero deja pasar la solicitud.
 *     Adecuado para arranque inicial — no bloquea el servicio.
 *   - 'strict': Lanza PiiLeakError y bloquea la solicitud.
 *     Activar cuando PseudonymService esté 100% integrado.
 *
 * USO:
 *   Llamar a guard.inspect(text, phone) antes de cualquier llamada a Gemini.
 *   El interceptor decide si alertar o bloquear según el modo configurado.
 *
 * QUÉ SE LOGGUEA (nunca el valor real):
 *   - Tipo de entidad detectada (ej: AMOUNT_BOB)
 *   - Cantidad de ocurrencias
 *   - Número de teléfono (namespaced, para correlacionar con la sesión)
 *   - Timestamp
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PseudonymService } from './pseudonym.service';
import { PiiDetection, SensitiveEntityType } from './sensitive-entity.types';

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type PiiGuardMode = 'permissive' | 'strict';

export interface PiiGuardReport {
  /** ¿Se detectó PII? */
  readonly hasLeak: boolean;
  /** Detecciones encontradas (sin valores reales) */
  readonly detections: PiiDetection[];
  /** Tipos únicos de entidades detectadas */
  readonly detectedTypes: SensitiveEntityType[];
}

// ─── Error de fuga en modo strict ─────────────────────────────────────────────

export class PiiLeakError extends Error {
  readonly report: PiiGuardReport;
  readonly phoneNumber: string;

  constructor(report: PiiGuardReport, phoneNumber: string) {
    const types = report.detectedTypes.join(', ');
    super(
      `[PiiGuard-STRICT] PII detectada antes de enviar a Gemini. ` +
      `Tipos: ${types}. Teléfono: ${phoneNumber}. ` +
      `Aplicar pseudonymize() antes de llamar al LLM.`,
    );
    this.name        = 'PiiLeakError';
    this.report      = report;
    this.phoneNumber = phoneNumber;

    Object.setPrototypeOf(this, PiiLeakError.prototype);
  }
}

// ─── Servicio ─────────────────────────────────────────────────────────────────

@Injectable()
export class PiiGuardInterceptor {
  private readonly logger = new Logger(PiiGuardInterceptor.name);
  private readonly mode: PiiGuardMode;

  constructor(
    private readonly pseudonymService: PseudonymService,
    private readonly config: ConfigService,
  ) {
    this.mode = (config.get<string>('security.piiGuardMode') ?? 'permissive') as PiiGuardMode;

    this.logger.log(`PiiGuard activo en modo: ${this.mode.toUpperCase()}`);
  }

  /**
   * Inspecciona `text` buscando PII no seudonimizada.
   *
   * En modo 'permissive': solo loggea si detecta PII, no lanza error.
   * En modo 'strict':     lanza PiiLeakError si detecta PII.
   *
   * @param text          Texto a inspeccionar (el que se enviará a Gemini).
   * @param phoneNumber   Teléfono del cliente para contexto de log.
   * @param clientName    Nombre del cliente para incluirlo en la detección.
   * @returns             Reporte de detección (útil para tests).
   */
  inspect(
    text: string,
    phoneNumber: string,
    clientName?: string | null,
  ): PiiGuardReport {
    const detections = this.pseudonymService.detect(text, clientName);
    const hasLeak    = detections.length > 0;

    const detectedTypes = [
      ...new Set(detections.map((d) => d.entityType)),
    ];

    const report: PiiGuardReport = { hasLeak, detections, detectedTypes };

    if (hasLeak) {
      this.emitAlert(report, phoneNumber);

      if (this.mode === 'strict') {
        throw new PiiLeakError(report, phoneNumber);
      }
    }

    return report;
  }

  // ─── Privado ───────────────────────────────────────────────────────────────

  private emitAlert(report: PiiGuardReport, phoneNumber: string): void {
    const types      = report.detectedTypes.join(', ');
    const count      = report.detections.length;
    const timestamp  = new Date().toISOString();

    // CRÍTICO: nunca se logguea el texto original ni los valores detectados
    this.logger.warn(
      `[PiiGuard] ⚠️  PII no seudonimizada detectada.\n` +
      `  timestamp     : ${timestamp}\n` +
      `  phone         : ${phoneNumber}\n` +
      `  tipos         : ${types}\n` +
      `  ocurrencias   : ${count}\n` +
      `  modo          : ${this.mode}\n` +
      `  acción        : ${this.mode === 'strict' ? 'BLOQUEADO' : 'PERMITIDO (alerta)'}`,
    );
  }
}
