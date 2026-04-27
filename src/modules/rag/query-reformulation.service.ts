/**
 * @file query-reformulation.service.ts
 * @description Servicio de reformulación de queries para el pipeline RAG.
 *
 * RESPONSABILIDAD (SRP):
 *   Una sola cosa: tomar una query del usuario (posiblemente ambigua,
 *   con jerga boliviana, errores ortográficos, o abreviaciones) y
 *   devolverla como una pregunta clara, bien formada y optimizada
 *   para búsqueda semántica.
 *
 * DISEÑO:
 *   ┌─────────────────────────────────────────────────────────┐
 *   │  "no tengo inet"   → "¿Por qué no tengo conexión a     │
 *   │                        internet? Pasos para solucionar" │
 *   │                                                         │
 *   │  "cuanto debo"     → "¿Cuál es mi deuda pendiente      │
 *   │                        de facturación?"                 │
 *   └─────────────────────────────────────────────────────────┘
 *
 * DEGRADACIÓN CONTROLADA:
 *   - Timeout de 3 segundos: si Gemini tarda más, se usa la query original.
 *   - Si Gemini no está disponible: retorna la query original.
 *   - Si la query ya es clara (sin jerga, sin errores): retorna sin modificar.
 *
 * MÉTRICAS:
 *   Se registra por Logger si la query fue reformulada o no, para
 *   monitorear la efectividad del reformulador.
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosInstance } from 'axios';
import { createGeminiClient, geminiUrl } from '../../common/http/gemini-client';

// ─── Tipos públicos ───────────────────────────────────────────────────────────

export interface ReformulationResult {
  /** Query final a usar en la búsqueda RAG */
  readonly query:        string;
  /** Query original tal como llegó del usuario */
  readonly originalQuery: string;
  /** Si se aplicó reformulación o se retornó la original */
  readonly wasReformulated: boolean;
}

// ─── Prompts internos ─────────────────────────────────────────────────────────

/**
 * Prompt de reformulación especializado en el dominio telecom boliviano.
 * Se mantiene como constante del módulo (no inyectable) porque es parte
 * de la lógica de negocio de este servicio, no configuración externa.
 */
const REFORMULATION_PROMPT = `
Eres un optimizador de búsqueda para el chatbot de Telecom Bolivianet,
empresa de internet por fibra óptica en Bolivia.

Tu tarea: reformular el mensaje del cliente para que sea una pregunta
clara y específica, optimizada para búsqueda en una base de conocimiento
técnica sobre internet, pagos y servicios de fibra óptica.

REGLAS:
1. Corrige errores ortográficos y expande abreviaciones bolivianas.
2. Agrega terminología técnica del dominio si el contexto lo sugiere.
3. Mantén la intención original — NO cambies el tema de la pregunta.
4. Si la pregunta ya es clara y técnica, devuélvela sin cambios.
5. Responde SOLO con la pregunta reformulada, sin explicación ni comillas.
6. La respuesta debe estar en español.

EJEMPLOS DE REFORMULACIÓN:
- "no tengo inet"           → "Sin conexión a internet, cómo solucionar"
- "kiero pagar"             → "Cómo realizar el pago de mi factura de internet"
- "cuanto debo"             → "Cuál es el monto de mi deuda pendiente"
- "lento el net"            → "Internet lento baja velocidad solución"
- "problema con routeador"  → "Falla en el router o módem pasos para solucionar"
- "cuando vence"            → "Fecha límite de pago del período actual"
- "mi plan"                 → "Información sobre mi plan de internet contratado"
- "sin luz"                 → "Sin internet luces del router apagadas solución"

CONTEXTO DE LA CONVERSACIÓN (últimos mensajes):
{conversationContext}

MENSAJE DEL CLIENTE:
{userQuery}

PREGUNTA REFORMULADA:
`.trim();

// ─── Servicio ─────────────────────────────────────────────────────────────────

@Injectable()
export class QueryReformulationService implements OnModuleInit {
  private readonly logger = new Logger(QueryReformulationService.name);
  private http: AxiosInstance | null = null;
  private readonly model: string;
  private readonly timeoutMs: number;
  private geminiAvailable = false;

  constructor(private readonly config: ConfigService) {
    this.model     = config.get<string>('gemini.intentModel') ?? 'gemini-2.0-flash';
    this.timeoutMs = config.get<number>('rag.reformulationTimeoutMs') ?? 3_000;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async onModuleInit(): Promise<void> {
    const apiKey = this.config.get<string>('gemini.apiKey');

    if (!apiKey) {
      this.logger.warn(
        'QueryReformulation deshabilitado: GEMINI_API_KEY no configurada',
      );
      return;
    }

    this.http           = createGeminiClient(apiKey, this.timeoutMs);
    this.geminiAvailable = true;
    this.logger.log(`QueryReformulationService activo → modelo: ${this.model}`);
  }

  // ─── API pública ───────────────────────────────────────────────────────────

  /**
   * Reformula una query del usuario para optimizarla para búsqueda RAG.
   *
   * @param userQuery            Texto original del usuario (puede tener jerga/errores).
   * @param conversationContext  Últimos turnos de conversación para desambiguación.
   *                             Ejemplo: "Usuario: tengo problema con el router\n
   *                                       Bot: ¿Qué luces tiene encendidas?"
   * @returns ReformulationResult con la query final y metadatos.
   *
   * @example
   * const result = await service.reformulate('no m llega el net', ctx);
   * // result.query          → 'Sin conexión a internet cómo solucionar el problema'
   * // result.wasReformulated → true
   */
  async reformulate(
    userQuery:            string,
    conversationContext:  string = '',
  ): Promise<ReformulationResult> {
    const trimmedQuery = userQuery?.trim() ?? '';

    if (!trimmedQuery) {
      return this.passthrough(trimmedQuery, 'query vacía');
    }

    if (!this.geminiAvailable || !this.http) {
      return this.passthrough(trimmedQuery, 'Gemini no disponible');
    }

    // Queries muy cortas (1-2 palabras sin contexto) siempre se reformulan
    // Queries largas y bien formadas puede que no necesiten reformulación
    try {
      const reformulated = await this.callGemini(trimmedQuery, conversationContext);

      if (!reformulated || reformulated.trim() === trimmedQuery) {
        return this.passthrough(trimmedQuery, 'sin cambios necesarios');
      }

      this.logger.debug(
        `[reformulate] Aplicada | original="${trimmedQuery.substring(0, 50)}" ` +
        `→ reformulada="${reformulated.substring(0, 50)}"`,
      );

      return {
        query:            reformulated.trim(),
        originalQuery:    trimmedQuery,
        wasReformulated:  true,
      };
    } catch (err) {
      // Timeout o error de red: degradación controlada, no bloquear el RAG
      this.logger.warn(
        `[reformulate] Falló (${err.message}), usando query original`,
      );
      return this.passthrough(trimmedQuery, `error: ${err.message}`);
    }
  }

  // ─── Métodos privados ──────────────────────────────────────────────────────

  private async callGemini(
    userQuery:           string,
    conversationContext: string,
  ): Promise<string> {
    const prompt = REFORMULATION_PROMPT
      .replace('{conversationContext}', conversationContext || '(sin contexto previo)')
      .replace('{userQuery}', userQuery);

    const url = geminiUrl(this.model, 'generateContent');

    const res = await this.http!.post(url, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature:     0.1,   // Determinista: la reformulación debe ser consistente
        maxOutputTokens: 60,    // Una sola pregunta reformulada, no necesita más
        stopSequences:   ['\n\n', '?¿'],
      },
    });

    const raw = res.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    return this.sanitizeReformulation(raw, userQuery);
  }

  /**
   * Limpia la respuesta de Gemini para asegurarse de que es una query válida.
   * - Elimina comillas envolventes que Gemini a veces agrega.
   * - Recorta espacios y saltos de línea.
   * - Si la respuesta parece inválida (muy larga o muy corta), usa la original.
   */
  private sanitizeReformulation(raw: string, fallback: string): string {
    const cleaned = raw
      .trim()
      .replace(/^["'`]|["'`]$/g, '')   // Quitar comillas envolventes
      .replace(/\n.*/s, '')             // Tomar solo la primera línea
      .trim();

    // Sanity check: si la reformulación es extremadamente larga o vacía, usar original
    if (!cleaned || cleaned.length > 200 || cleaned.length < 3) {
      return fallback;
    }

    return cleaned;
  }

  private passthrough(query: string, reason: string): ReformulationResult {
    this.logger.debug(`[reformulate] Sin cambios (${reason}) | query="${query.substring(0, 50)}"`);
    return {
      query:            query,
      originalQuery:    query,
      wasReformulated:  false,
    };
  }
}
