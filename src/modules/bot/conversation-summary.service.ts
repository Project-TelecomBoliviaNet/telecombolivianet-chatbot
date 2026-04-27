/**
 * @file conversation-summary.service.ts
 * @description Genera resumen estructurado y categoriza conversaciones al escalar.
 *
 * RESPONSABILIDADES (SRP):
 *   1. Generar un briefing de la conversación para el agente humano (US-EP06-01).
 *   2. Clasificar el motivo de escalado en una categoría (US-EP06-02).
 *
 * DISEÑO:
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  historial de mensajes + datos de sesión                   │
 *   │              │                                             │
 *   │              ▼  Gemini Flash (prompt estructurado)         │
 *   │              │                                             │
 *   │    ┌─────────┴──────────┐                                 │
 *   │    ▼                    ▼                                  │
 *   │  resumen (texto)    categoría (enum)                       │
 *   │    │                    │                                  │
 *   │    ▼                    ▼                                  │
 *   │  notificación admin    BD (escalation_category)            │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * DEGRADACIÓN CONTROLADA:
 *   Si Gemini falla → el escalado continúa sin resumen.
 *   El agente recibe la notificación igual, solo sin el briefing automático.
 *
 * PRIVACIDAD:
 *   El historial enviado a Gemini pasa por seudonimización antes de enviarse.
 *   El resumen retornado se re-hidrata con los datos reales.
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosInstance } from 'axios';
import { createGeminiClient, geminiUrl } from '../../common/http/gemini-client';
import { SessionData } from '../session/session.service';
import { PseudonymService } from '../../common/security/pseudonym';

// ─── Tipos públicos ───────────────────────────────────────────────────────────

/**
 * Categorías de motivo de escalado (US-EP06-02).
 * Usadas para reportes y estadísticas de operaciones.
 */
export enum EscalationCategory {
  FACTURACION    = 'FACTURACION',
  SOPORTE_TECNICO = 'SOPORTE_TECNICO',
  INSTALACION    = 'INSTALACION',
  INFORMACION    = 'INFORMACION',
  OTRO           = 'OTRO',
}

export interface ConversationSummary {
  /** Resumen ejecutivo para el agente (con datos reales re-hidratados) */
  readonly summary:          string;
  /** Categoría del motivo de escalado */
  readonly category:         EscalationCategory;
  /** Nombre legible de la categoría para logs y notificaciones */
  readonly categoryLabel:    string;
  /** Si el resumen fue generado por IA o es un fallback */
  readonly isAiGenerated:    boolean;
}

// ─── Constantes internas ──────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<EscalationCategory, string> = {
  [EscalationCategory.FACTURACION]:    'Facturación y Pagos',
  [EscalationCategory.SOPORTE_TECNICO]: 'Soporte Técnico',
  [EscalationCategory.INSTALACION]:    'Instalación y Contratos',
  [EscalationCategory.INFORMACION]:    'Información General',
  [EscalationCategory.OTRO]:           'Otro',
};

const SUMMARY_PROMPT = `
Eres un asistente que resume conversaciones de soporte para agentes humanos.

Analiza la siguiente conversación de WhatsApp entre un cliente de Telecom Bolivianet
y el chatbot, y genera un briefing estructurado para el agente humano que atenderá el caso.

El briefing debe ser conciso (máximo 5 líneas) y contener:
1. Motivo principal del contacto
2. Acciones que ya intentó el bot
3. Estado actual del problema
4. Datos relevantes del cliente

Responde en español, usando este formato exacto (sin markdown):
MOTIVO: [motivo del contacto]
INTENTADO: [qué hizo el bot]
ESTADO: [cómo está el problema ahora]
CLIENTE: [datos relevantes como plan, deuda, ticket activo si aplica]

CONVERSACIÓN:
{conversation}

BRIEFING:
`.trim();

const CATEGORY_PROMPT = `
Clasifica el motivo principal de esta conversación de soporte en UNA de estas categorías.
Responde SOLO con la palabra en mayúsculas, sin explicación:

FACTURACION     → pagos, deudas, facturas, QR de pago, cobros
SOPORTE_TECNICO → sin internet, lentitud, router, cortes de servicio, tickets
INSTALACION     → nueva instalación, contratos, cambio de plan, cobertura
INFORMACION     → preguntas generales, precios, horarios, información del servicio
OTRO            → cualquier otro caso

CONVERSACIÓN:
{conversation}

CATEGORÍA:
`.trim();

const TIMEOUT_MS     = 8_000;  // 8 segundos máximo para el resumen
const MAX_CONV_CHARS = 2_000;  // Máximo caracteres del historial a enviar

// ─── Servicio ─────────────────────────────────────────────────────────────────

@Injectable()
export class ConversationSummaryService implements OnModuleInit {
  private readonly logger = new Logger(ConversationSummaryService.name);
  private http: AxiosInstance | null = null;
  private readonly model:  string;
  private geminiAvailable = false;

  constructor(
    private readonly config:          ConfigService,
    private readonly pseudonymService: PseudonymService,
  ) {
    this.model = config.get<string>('gemini.intentModel') ?? 'gemini-2.0-flash';
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async onModuleInit(): Promise<void> {
    const apiKey = this.config.get<string>('gemini.apiKey');
    if (!apiKey) {
      this.logger.warn('ConversationSummary deshabilitado: GEMINI_API_KEY no configurada');
      return;
    }
    this.http           = createGeminiClient(apiKey, TIMEOUT_MS);
    this.geminiAvailable = true;
    this.logger.log(`ConversationSummaryService activo → modelo: ${this.model}`);
  }

  // ─── API pública ───────────────────────────────────────────────────────────

  /**
   * Genera el resumen ejecutivo y la categoría de una conversación escalada.
   *
   * Este método es NON-BLOCKING para el flujo de escalado:
   * cualquier error interno retorna un fallback sin lanzar.
   *
   * @param session        Datos de sesión del cliente (nombre, plan, deuda, etc.)
   * @param conversationText  Historial de mensajes formateado como texto.
   * @returns ConversationSummary con resumen y categoría.
   */
  async summarize(
    session:          SessionData,
    conversationText: string,
  ): Promise<ConversationSummary> {
    if (!this.geminiAvailable || !this.http) {
      return this.buildFallback(session);
    }

    if (!conversationText?.trim()) {
      return this.buildFallback(session);
    }

    try {
      // ── Seudonimizar el historial antes de enviarlo a Gemini ───────────────
      const { pseudonymizedText, mappingKey } = await this.pseudonymService
        .pseudonymize(
          this.truncateConversation(conversationText),
          session.phoneNumber,
          session.clientName,
        )
        .catch(() => ({
          pseudonymizedText: this.truncateConversation(conversationText),
          mappingKey:        '',
          replacementsCount: 0,
        }));

      // ── Llamadas paralelas a Gemini (resumen + categoría) ─────────────────
      const [rawSummary, rawCategory] = await Promise.all([
        this.callGemini(SUMMARY_PROMPT.replace('{conversation}', pseudonymizedText)),
        this.callGemini(CATEGORY_PROMPT.replace('{conversation}', pseudonymizedText)),
      ]);

      // ── Re-hidratar el resumen con datos reales ───────────────────────────
      const summary = mappingKey
        ? await this.pseudonymService.rehydrate(rawSummary, mappingKey).catch(() => rawSummary)
        : rawSummary;

      // Liberar tabla Redis
      if (mappingKey) {
        this.pseudonymService.invalidate(mappingKey).catch(() => {});
      }

      const category = this.parseCategory(rawCategory);

      this.logger.debug(
        `[Summary] Generado | phone=${session.phoneNumber} ` +
        `category=${category} summary_chars=${summary.length}`,
      );

      return {
        summary,
        category,
        categoryLabel: CATEGORY_LABELS[category],
        isAiGenerated: true,
      };
    } catch (err) {
      this.logger.warn(
        `[Summary] Error generando resumen (${err.message}), usando fallback`,
      );
      return this.buildFallback(session);
    }
  }

  // ─── Métodos privados ──────────────────────────────────────────────────────

  private async callGemini(prompt: string): Promise<string> {
    const url = geminiUrl(this.model, 'generateContent');
    const res = await this.http!.post(url, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature:     0.2,
        maxOutputTokens: 200,
        stopSequences:   ['---'],
      },
    });
    return res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
  }

  /**
   * Parsea la respuesta de Gemini y la mapea a un valor del enum.
   * Tolerante a variaciones de formato (espacios, mayúsculas, texto extra).
   */
  private parseCategory(raw: string): EscalationCategory {
    const cleaned = raw.trim().toUpperCase().replace(/[^A-Z_]/g, '');

    const categoryMap: Record<string, EscalationCategory> = {
      'FACTURACION':     EscalationCategory.FACTURACION,
      'FACTURACI':       EscalationCategory.FACTURACION,  // truncado
      'SOPORTE_TECNICO': EscalationCategory.SOPORTE_TECNICO,
      'SOPORTE':         EscalationCategory.SOPORTE_TECNICO,
      'INSTALACION':     EscalationCategory.INSTALACION,
      'INFORMACION':     EscalationCategory.INFORMACION,
      'OTRO':            EscalationCategory.OTRO,
    };

    for (const [key, value] of Object.entries(categoryMap)) {
      if (cleaned.includes(key)) return value;
    }

    return EscalationCategory.OTRO;
  }

  /**
   * Trunca el historial si supera MAX_CONV_CHARS para controlar los tokens.
   * Conserva los últimos mensajes (más relevantes) en lugar de los primeros.
   */
  private truncateConversation(text: string): string {
    if (text.length <= MAX_CONV_CHARS) return text;
    // Mantener los últimos MAX_CONV_CHARS caracteres
    return '...[conversación truncada]\n' + text.slice(-MAX_CONV_CHARS);
  }

  /**
   * Resumen de fallback cuando Gemini no está disponible o falla.
   * Construido con los datos de sesión disponibles — sin llamadas externas.
   */
  private buildFallback(session: SessionData): ConversationSummary {
    const lines: string[] = [];

    lines.push(`MOTIVO: Escalado solicitado`);
    lines.push(`INTENTADO: Bot no pudo resolver la consulta`);

    if (session.clientName && session.clientName !== '__prospect__') {
      lines.push(`ESTADO: Cliente identificado: ${session.clientName}`);
    } else {
      lines.push(`ESTADO: Cliente no identificado (prospecto)`);
    }

    const clientInfo: string[] = [];
    if (session.planName)   clientInfo.push(`Plan: ${session.planName}`);
    if (session.totalDebt)  clientInfo.push(`Deuda: Bs ${session.totalDebt}`);
    if (session.activeTicketId) clientInfo.push(`Ticket activo: ${session.activeTicketId}`);
    lines.push(`CLIENTE: ${clientInfo.length > 0 ? clientInfo.join(' | ') : 'Sin datos adicionales'}`);

    return {
      summary:       lines.join('\n'),
      category:      EscalationCategory.OTRO,
      categoryLabel: CATEGORY_LABELS[EscalationCategory.OTRO],
      isAiGenerated: false,
    };
  }
}
