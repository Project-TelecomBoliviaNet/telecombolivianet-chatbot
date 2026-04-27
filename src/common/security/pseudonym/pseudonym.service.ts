/**
 * @file pseudonym.service.ts
 * @description Servicio de seudonimización de datos personales.
 *
 * RESPONSABILIDAD (SRP):
 *   Este servicio hace exactamente una cosa: reemplazar entidades
 *   sensibles en texto por tokens neutros, y revertir ese proceso.
 *
 * ARQUITECTURA:
 *   ┌────────────────────────────────────────────────────────┐
 *   │  Texto con PII → pseudonymize() → Texto con tokens    │
 *   │                                 + Redis(mappingKey)    │
 *   │                                                        │
 *   │  Texto con tokens → rehydrate(mappingKey) → Texto PII │
 *   └────────────────────────────────────────────────────────┘
 *
 * ALMACENAMIENTO:
 *   La tabla de correspondencia {token → valorReal} se almacena
 *   en Redis con un TTL configurable (default: 5 minutos).
 *   La clave de Redis sigue el formato: pseudo:<phone>:<uuid>
 *
 * DISEÑO DE SEGURIDAD:
 *   - Los tokens son predecibles (CLIENTE_001) por diseño: el LLM
 *     necesita referencias estables para responder coherentemente.
 *   - El UUID en la clave Redis previene colisiones entre chats paralelos.
 *   - El TTL corto limita la ventana de exposición si Redis es comprometido.
 *   - rehydrate() falla explícitamente si el TTL expiró (PseudonymExpiredError).
 */

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';

import {
  SensitiveEntityType,
  PseudonymizeResult,
  PseudonymEntry,
  PiiDetection,
} from './sensitive-entity.types';
import {
  getPatternBasedEntities,
  SENSITIVE_ENTITIES_CATALOG,
} from './sensitive-entities.catalog';
import { PseudonymExpiredError } from './pseudonym-expired.error';

// ─── Constantes internas ──────────────────────────────────────────────────────

/** Prefijo de todas las claves Redis de este servicio */
const REDIS_KEY_PREFIX = 'pseudo:' as const;

/** Separador entre prefijo de token y número secuencial */
const TOKEN_SEPARATOR = '_' as const;

/** Número de dígitos del índice secuencial en tokens (001, 002, ...) */
const TOKEN_INDEX_PADDING = 3 as const;

// ─── Tipos internos ───────────────────────────────────────────────────────────

/** Tabla de correspondencia: token → entrada completa */
type MappingTable = Record<string, PseudonymEntry>;

/** Contador de tokens por prefijo en una sola ejecución de pseudonymize */
type TokenCounters = Map<string, number>;

// ─── Servicio ─────────────────────────────────────────────────────────────────

@Injectable()
export class PseudonymService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PseudonymService.name);
  private redis: Redis;
  private readonly ttlSeconds: number;

  constructor(private readonly config: ConfigService) {
    this.ttlSeconds = config.get<number>('security.pseudonymTtlSeconds') ?? 300;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  onModuleInit(): void {
    this.redis = new Redis({
      host:     this.config.get<string>('redis.host'),
      port:     this.config.get<number>('redis.port'),
      password: this.config.get<string>('redis.password') || undefined,
      db:       this.config.get<number>('redis.db'),
      retryStrategy: (times) => Math.min(times * 100, 3_000),
      lazyConnect: true,
    });

    this.redis.on('error', (err) =>
      this.logger.error(`Redis error en PseudonymService: ${err.message}`),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }

  // ─── API pública ───────────────────────────────────────────────────────────

  /**
   * Reemplaza todas las entidades sensibles detectadas en `text` por tokens
   * neutros y persiste la tabla de correspondencia en Redis.
   *
   * @param text           Texto original que puede contener PII.
   * @param phoneNumber    Número de teléfono del cliente (para namespacing de Redis).
   * @param clientName     Nombre real del cliente (obtenido de sesión), opcional.
   *                       Si se provee, se reemplaza directamente por valor exacto.
   * @returns              Texto tokenizado + clave Redis de la tabla.
   *
   * @example
   * const result = await service.pseudonymize(
   *   'Hola Juan Mamani, tu deuda es Bs 350',
   *   '59170000001',
   *   'Juan Mamani'
   * );
   * // result.pseudonymizedText → 'Hola PERSONA_001, tu deuda es MONTO_001'
   * // result.mappingKey        → 'pseudo:59170000001:uuid-xyz'
   */
  async pseudonymize(
    text: string,
    phoneNumber: string,
    clientName?: string | null,
  ): Promise<PseudonymizeResult> {
    if (!text?.trim()) {
      return { pseudonymizedText: text, mappingKey: '', replacementsCount: 0 };
    }

    const table: MappingTable     = {};
    const counters: TokenCounters = new Map();
    let   workingText             = text;

    // ── Paso 1: Sustituir nombre de cliente por valor exacto ─────────────────
    if (clientName?.trim()) {
      workingText = this.replaceExactValue(
        workingText,
        clientName.trim(),
        SensitiveEntityType.FULL_NAME,
        'PERSONA',
        table,
        counters,
      );
    }

    // ── Paso 2: Aplicar patrones del catálogo ────────────────────────────────
    for (const entityDef of getPatternBasedEntities()) {
      for (const pattern of entityDef.patterns) {
        workingText = this.applyPattern(
          workingText,
          pattern,
          entityDef.type,
          entityDef.tokenPrefix,
          table,
          counters,
        );
      }
    }

    const replacementsCount = Object.keys(table).length;

    // ── Paso 3: Persistir tabla en Redis solo si hay reemplazos ──────────────
    let mappingKey = '';
    if (replacementsCount > 0) {
      mappingKey = this.buildRedisKey(phoneNumber);
      await this.persistTable(mappingKey, table);
    }

    this.logger.debug(
      `[pseudonymize] phone=${phoneNumber} ` +
      `replacements=${replacementsCount} key=${mappingKey || 'none'}`,
    );

    return {
      pseudonymizedText: workingText,
      mappingKey,
      replacementsCount,
    };
  }

  /**
   * Reemplaza los tokens en `pseudonymizedText` por los valores reales
   * almacenados en Redis bajo `mappingKey`.
   *
   * @throws {PseudonymExpiredError} Si la clave expiró o no existe en Redis.
   *
   * @example
   * const original = await service.rehydrate(
   *   'Hola PERSONA_001, tu deuda es MONTO_001',
   *   'pseudo:59170000001:uuid-xyz'
   * );
   * // original → 'Hola Juan Mamani, tu deuda es Bs 350'
   */
  async rehydrate(
    pseudonymizedText: string,
    mappingKey: string,
  ): Promise<string> {
    if (!mappingKey || !pseudonymizedText) return pseudonymizedText;

    const table = await this.loadTable(mappingKey);
    if (!table) {
      throw new PseudonymExpiredError(mappingKey);
    }

    let result = pseudonymizedText;

    // Reemplazar todos los tokens por sus valores reales.
    // Ordenar por longitud descendente para evitar sustituciones parciales
    // (ej: PERSONA_001 antes que PERSONA_00).
    const tokens = Object.keys(table).sort((a, b) => b.length - a.length);
    for (const token of tokens) {
      result = result.replaceAll(token, table[token].originalValue);
    }

    this.logger.debug(`[rehydrate] key=${mappingKey} tokens_replaced=${tokens.length}`);
    return result;
  }

  /**
   * Detecta qué tipos de PII existen en un texto SIN reemplazarlos.
   * Diseñado para el PiiGuardInterceptor: solo necesita saber SI hay PII,
   * nunca expone los valores detectados.
   *
   * @returns Lista de detecciones (solo metadatos, sin valores reales).
   */
  detect(text: string, clientName?: string | null): PiiDetection[] {
    const detections: PiiDetection[] = [];

    // Detectar nombre exacto
    if (clientName?.trim()) {
      const nameDetections = this.detectExact(text, clientName.trim(), SensitiveEntityType.FULL_NAME);
      detections.push(...nameDetections);
    }

    // Detectar por patrones
    for (const entityDef of getPatternBasedEntities()) {
      for (const pattern of entityDef.patterns) {
        const matches = this.detectPattern(text, pattern, entityDef.type);
        detections.push(...matches);
      }
    }

    return detections;
  }

  /**
   * Elimina explícitamente una tabla de Redis antes de que expire su TTL.
   * Llamar al cerrar un chat o al escalar, para limpiar datos lo antes posible.
   */
  async invalidate(mappingKey: string): Promise<void> {
    if (!mappingKey) return;
    await this.redis.del(mappingKey);
    this.logger.debug(`[invalidate] key=${mappingKey} eliminado`);
  }

  // ─── Métodos privados de reemplazo ─────────────────────────────────────────

  /**
   * Reemplaza todas las ocurrencias exactas (case-insensitive) de `value`
   * en `text` por un token, registrando en `table`.
   */
  private replaceExactValue(
    text: string,
    value: string,
    entityType: SensitiveEntityType,
    prefix: string,
    table: MappingTable,
    counters: TokenCounters,
  ): string {
    // Verificar si ya tokenizamos este valor exacto
    const existingToken = this.findExistingToken(value, table);
    if (existingToken) {
      // Ya tenemos el token — solo reemplazar ocurrencias adicionales
      return text.replaceAll(value, existingToken);
    }

    // Escapar caracteres especiales de regex para búsqueda literal
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern  = new RegExp(escaped, 'gi');

    if (!pattern.test(text)) return text; // No hay ocurrencias

    const token = this.nextToken(prefix, counters);
    table[token] = { token, originalValue: value, entityType };

    // Resetear lastIndex ya que usamos test() antes
    pattern.lastIndex = 0;
    return text.replace(pattern, token);
  }

  /**
   * Aplica un RegExp con flag 'g' al texto y reemplaza cada match
   * por un token, registrando en la tabla de correspondencia.
   *
   * Maneja el caso donde distintas matches tienen el mismo valor
   * (reutiliza el mismo token para el mismo valor).
   */
  private applyPattern(
    text: string,
    pattern: RegExp,
    entityType: SensitiveEntityType,
    prefix: string,
    table: MappingTable,
    counters: TokenCounters,
  ): string {
    // Clonar el patrón para reiniciar lastIndex sin mutar el catálogo
    const safePattern = new RegExp(pattern.source, pattern.flags);
    const matches = [...text.matchAll(safePattern)];
    if (matches.length === 0) return text;

    let result = text;

    // Procesar en orden inverso para no alterar índices de matches anteriores
    for (let i = matches.length - 1; i >= 0; i--) {
      const match = matches[i];
      const matchedValue = match[0];
      const matchStart   = match.index!;
      const matchEnd     = matchStart + matchedValue.length;

      // Reutilizar token si ya vimos este valor exacto
      const existing = this.findExistingToken(matchedValue, table);
      const token    = existing ?? this.nextToken(prefix, counters);

      if (!existing) {
        table[token] = { token, originalValue: matchedValue, entityType };
      }

      result = result.slice(0, matchStart) + token + result.slice(matchEnd);
    }

    return result;
  }

  // ─── Métodos privados de detección (solo para PiiGuard) ────────────────────

  private detectExact(
    text: string,
    value: string,
    entityType: SensitiveEntityType,
  ): PiiDetection[] {
    const detections: PiiDetection[] = [];
    const lower     = text.toLowerCase();
    const lowerVal  = value.toLowerCase();
    let   fromIndex = 0;

    while (true) {
      const idx = lower.indexOf(lowerVal, fromIndex);
      if (idx === -1) break;
      detections.push({
        entityType,
        startIndex:  idx,
        endIndex:    idx + value.length,
        valueLength: value.length,
      });
      fromIndex = idx + 1;
    }

    return detections;
  }

  private detectPattern(
    text: string,
    pattern: RegExp,
    entityType: SensitiveEntityType,
  ): PiiDetection[] {
    const safePattern = new RegExp(pattern.source, pattern.flags);
    const matches     = [...text.matchAll(safePattern)];

    return matches.map((m) => ({
      entityType,
      startIndex:  m.index!,
      endIndex:    m.index! + m[0].length,
      valueLength: m[0].length,
    }));
  }

  // ─── Helpers de tokenización ───────────────────────────────────────────────

  /**
   * Busca si un valor ya fue tokenizado en esta ejecución.
   * Comparación case-insensitive para evitar duplicados con distinta capitalización.
   */
  private findExistingToken(value: string, table: MappingTable): string | undefined {
    const lowerValue = value.toLowerCase();
    for (const [token, entry] of Object.entries(table)) {
      if (entry.originalValue.toLowerCase() === lowerValue) return token;
    }
    return undefined;
  }

  /**
   * Genera el siguiente token disponible para un prefijo dado.
   * Ejemplo: CLIENTE_001, CLIENTE_002, MONTO_001, ...
   */
  private nextToken(prefix: string, counters: TokenCounters): string {
    const current = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, current);
    const index = String(current).padStart(TOKEN_INDEX_PADDING, '0');
    return `${prefix}${TOKEN_SEPARATOR}${index}`;
  }

  // ─── Helpers de Redis ──────────────────────────────────────────────────────

  private buildRedisKey(phoneNumber: string): string {
    return `${REDIS_KEY_PREFIX}${phoneNumber}:${randomUUID()}`;
  }

  private async persistTable(key: string, table: MappingTable): Promise<void> {
    const serialized = JSON.stringify(table);
    await this.redis.set(key, serialized, 'EX', this.ttlSeconds);
  }

  private async loadTable(key: string): Promise<MappingTable | null> {
    const raw = await this.redis.get(key);
    if (!raw) return null;

    try {
      return JSON.parse(raw) as MappingTable;
    } catch {
      this.logger.error(`[loadTable] JSON inválido para key=${key}`);
      return null;
    }
  }
}
