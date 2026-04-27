/**
 * @file faq-matcher.service.ts
 * @description Matching semántico de FAQs usando embeddings en memoria.
 *
 * RESPONSABILIDAD (SRP):
 *   Una sola cosa: dada una query del usuario, encontrar si existe una FAQ
 *   con similitud semántica suficiente para responderla sin consultar el RAG.
 *
 * ARQUITECTURA:
 *   ┌──────────────────────────────────────────────────────────┐
 *   │  query usuario                                           │
 *   │       │                                                  │
 *   │       ▼  embed(query) → vector                          │
 *   │       │                                                  │
 *   │       ▼  cosineSimilarity(vector, faqVector) × N FAQs   │
 *   │       │                                                  │
 *   │       ▼  score ≥ threshold?                             │
 *   │      / \                                                 │
 *   │    Sí    No                                              │
 *   │     │      │                                             │
 *   │  FAQ resp  continuar con RAG completo                   │
 *   └──────────────────────────────────────────────────────────┘
 *
 * ÍNDICE EN MEMORIA:
 *   Los embeddings de todas las FAQs activas se mantienen en un Map
 *   en memoria (faqId → vector). Se reconstruye cuando FaqService
 *   reporta que el cache fue invalidado (nueva FAQ, edición, etc.).
 *
 * OCP:
 *   El servicio depende de RagService para generar embeddings — no
 *   reimplementa la lógica de embedding. Si el modelo cambia en RagService,
 *   FaqMatcherService se adapta automáticamente.
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Faq } from '../../database/entities/faq.entity';
import { FaqService } from './faq.service';
import { RagService } from '../rag/rag.service';
import { FaqMatchResult } from './faq.dto';

// ─── Tipos internos ───────────────────────────────────────────────────────────

interface FaqIndexEntry {
  faq:       Faq;
  embedding: number[];
}

// ─── Servicio ─────────────────────────────────────────────────────────────────

@Injectable()
export class FaqMatcherService implements OnModuleInit {
  private readonly logger    = new Logger(FaqMatcherService.name);
  private readonly threshold: number;

  /** Índice en memoria: faqId → {faq, embedding} */
  private index: Map<string, FaqIndexEntry> = new Map();
  /** Timestamp del último rebuild del índice */
  private indexBuiltAt = 0;
  /** TTL del índice: se reconstruye cada 5 minutos aunque no haya cambios */
  private readonly INDEX_TTL_MS = 5 * 60 * 1000;

  constructor(
    private readonly faqService:  FaqService,
    private readonly ragService:  RagService,
    private readonly config:      ConfigService,
  ) {
    this.threshold = config.get<number>('rag.faqSimilarityThreshold') ?? 0.85;
  }

  async onModuleInit(): Promise<void> {
    // Construcción no-bloqueante del índice al arrancar
    this.buildIndex().catch((err) =>
      this.logger.warn(`No se pudo construir índice de FAQs al arrancar: ${err.message}`),
    );
  }

  // ─── API pública ───────────────────────────────────────────────────────────

  /**
   * Busca si existe una FAQ con suficiente similitud semántica para la query.
   *
   * @param query  Texto del usuario (ya seudonimizado si aplica).
   * @returns FaqMatchResult con found=true si hay coincidencia, found=false si no.
   *
   * Latencia esperada:
   *   - Si el índice está en memoria: ~50ms (solo embed + similitud)
   *   - Si hay que reconstruir el índice: ~200ms + N×100ms por FAQ
   */
  async match(query: string): Promise<FaqMatchResult> {
    if (!query?.trim()) {
      return this.noMatch();
    }

    // Asegurar que el índice está actualizado
    await this.ensureIndexFresh();

    if (this.index.size === 0) {
      return this.noMatch();
    }

    try {
      // Generar embedding de la query del usuario
      const queryEmbedding = await this.ragService.embed(query);

      // Calcular similitud coseno con cada FAQ del índice
      let bestScore   = 0;
      let bestEntry: FaqIndexEntry | null = null;

      for (const entry of this.index.values()) {
        const score = this.cosineSimilarity(queryEmbedding, entry.embedding);

        // Desempate por prioridad cuando los scores son muy cercanos (±0.01)
        const isBetter = score > bestScore ||
          (Math.abs(score - bestScore) < 0.01 &&
           bestEntry !== null &&
           entry.faq.priority > bestEntry.faq.priority);

        if (isBetter) {
          bestScore = score;
          bestEntry = entry;
        }
      }

      if (bestScore >= this.threshold && bestEntry) {
        this.logger.debug(
          `[FaqMatcher] Match encontrado | score=${bestScore.toFixed(3)} ` +
          `faq="${bestEntry.faq.question.substring(0, 50)}"`,
        );

        // Incrementar contador de uso (non-blocking)
        this.faqService.incrementMatchCount(bestEntry.faq.id).catch(() => {});

        return {
          found:       true,
          answer:      bestEntry.faq.answer,
          score:       bestScore,
          faqId:       bestEntry.faq.id,
          faqQuestion: bestEntry.faq.question,
        };
      }

      this.logger.debug(
        `[FaqMatcher] Sin match (mejor score=${bestScore.toFixed(3)}, threshold=${this.threshold})`,
      );
      return this.noMatch();

    } catch (err) {
      // Error al generar embedding: no bloquear, dejar que el RAG continúe
      this.logger.warn(`[FaqMatcher] Error en matching: ${err.message}`);
      return this.noMatch();
    }
  }

  /**
   * Fuerza la reconstrucción del índice de embeddings.
   * Llamar después de modificar FAQs si se necesita invalidación inmediata
   * (normalmente no es necesario — el TTL de 5 min es suficiente).
   */
  async invalidateIndex(): Promise<void> {
    this.indexBuiltAt = 0;
    await this.buildIndex();
  }

  // ─── Construcción y mantenimiento del índice ──────────────────────────────

  private async ensureIndexFresh(): Promise<void> {
    const age = Date.now() - this.indexBuiltAt;
    if (age > this.INDEX_TTL_MS) {
      await this.buildIndex();
    }
  }

  private async buildIndex(): Promise<void> {
    try {
      const faqs = await this.faqService.getActiveFaqs();

      if (faqs.length === 0) {
        this.index = new Map();
        this.indexBuiltAt = Date.now();
        this.logger.debug('[FaqMatcher] Índice vacío (no hay FAQs activas)');
        return;
      }

      const newIndex = new Map<string, FaqIndexEntry>();

      for (const faq of faqs) {
        try {
          // Vectorizar la pregunta canónica de cada FAQ
          const embedding = await this.ragService.embed(faq.question);
          newIndex.set(faq.id, { faq, embedding });
        } catch (err) {
          this.logger.warn(
            `[FaqMatcher] No se pudo vectorizar FAQ ${faq.id}: ${err.message}`,
          );
        }
      }

      this.index        = newIndex;
      this.indexBuiltAt = Date.now();

      this.logger.log(
        `[FaqMatcher] Índice construido: ${newIndex.size}/${faqs.length} FAQs vectorizadas`,
      );
    } catch (err) {
      this.logger.error(`[FaqMatcher] Error construyendo índice: ${err.message}`);
    }
  }

  // ─── Similitud coseno ─────────────────────────────────────────────────────

  /**
   * Calcula la similitud coseno entre dos vectores.
   * Retorna un valor entre -1 y 1; para embeddings normalizados, entre 0 y 1.
   *
   * O(n) donde n = dimensiones del vector (768 para text-embedding-004).
   * Para ~100 FAQs: 100 × 768 = 76.800 operaciones — <1ms en CPU moderno.
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;

    let dot   = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dot   += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  private noMatch(): FaqMatchResult {
    return { found: false, answer: '', score: 0, faqId: '', faqQuestion: '' };
  }
}
