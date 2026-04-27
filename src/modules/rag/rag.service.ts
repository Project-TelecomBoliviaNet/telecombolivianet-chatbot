import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AxiosInstance } from 'axios';
import { createGeminiClient, geminiUrl } from '../../common/http/gemini-client';
import { PseudonymService, PiiGuardInterceptor, PseudonymExpiredError } from '../../common/security/pseudonym';
import { QueryReformulationService } from './query-reformulation.service';

// ══════════════════════════════════════════════════════════════
// RAG SERVICE — Versión Gemini API (US-15, US-16)
//
// Pipeline completo (post EP-01 + EP-02 + EP-03):
//
//   Pregunta usuario
//       │
//       ▼ (EP-01) Seudonimizar pregunta + contexto
//       │
//       ▼ (EP-02) Reformular query para búsqueda semántica
//       │
//       ▼         Generar embedding (Gemini text-embedding-004)
//       │
//       ▼         Buscar chunks similares (pgvector)
//       │
//       ▼ (EP-01) Seudonimizar chunks recuperados
//       │
//       ▼         Generar respuesta (Gemini Flash)
//       │
//       ▼ (EP-01) Re-hidratar respuesta con datos reales
//       │
//       ▼ (EP-03) Añadir referencia al documento fuente
//       │
//       ▼         Respuesta final al usuario
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
// RAG SERVICE — Versión Gemini API (US-15, US-16)
//
// Pipeline completo (EP-01 + EP-02 + EP-03 + EP-04):
//
//   Pregunta usuario
//       │
//       ▼ (EP-04) FaqMatcher: ¿hay FAQ con similitud ≥ threshold?
//       │         Sí → respuesta inmediata sin Gemini ni pgvector
//       │         No → continuar pipeline completo
//       │
//       ▼ (EP-01) Seudonimizar pregunta + contexto
//       ▼ (EP-02) Reformular query para búsqueda semántica
//       ▼         Generar embedding → pgvector → chunks
//       ▼         Gemini genera respuesta
//       ▼ (EP-01) Re-hidratar respuesta
//       ▼ (EP-03) Añadir referencia al documento fuente
// ══════════════════════════════════════════════════════════════

// ─── Importación diferida de FaqMatcherService ───────────────────────────────
// FaqMatcherService depende de RagService.embed() y RagService depende
// de FaqMatcherService — dependencia circular.
// Solución: @Optional() + setter público para late binding desde FaqModule.
import type { FaqMatcherService } from '../faq/faq-matcher.service';
import type { FaqMatchResult }    from '../faq/faq.dto';

export interface RagResult {
  found:          boolean;
  answer:         string;
  chunkId?:       string;
  similarity?:    number;
  /** Título del documento fuente (para mostrar al usuario — US-EP03-01) */
  documentTitle?: string;
  /** Si la respuesta vino de una FAQ pre-configurada (US-EP04-02) */
  isFaqMatch?:    boolean;
}

export interface ChunkMatch {
  id: string;
  content: string;
  similarity: number;
  documentTitle: string;
}

// ─── Contexto de seudonimización para el pipeline RAG ─────────────────────────

/**
 * Encapsula el estado de seudonimización de una query RAG.
 * Permite pasar la clave de re-hidratación a través del pipeline
 * sin acoplar cada paso al servicio de Redis.
 */
interface PseudonymContext {
  readonly mappingKey: string;
  readonly wasApplied: boolean;
}

// Tipos para la API de Gemini
interface GeminiEmbedResponse {
  embedding: { values: number[] };
}
interface GeminiCandidate {
  content: { parts: Array<{ text: string }> };
}
interface GeminiGenerateResponse {
  candidates: GeminiCandidate[];
}

@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);
  private http: AxiosInstance;
  private readonly apiKey: string;
  private readonly embedModel: string;
  private readonly chatModel: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly threshold: number;
  private readonly maxChunks: number;

  constructor(
    private readonly config: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly pseudonymService: PseudonymService,
    private readonly piiGuard: PiiGuardInterceptor,
    private readonly queryReformulation: QueryReformulationService,
  ) {
    this.apiKey      = config.get<string>('gemini.apiKey');
    this.embedModel  = config.get<string>('gemini.embedModel');
    this.chatModel   = config.get<string>('gemini.ragModel');
    this.maxTokens   = config.get<number>('gemini.maxTokens');
    this.temperature = config.get<number>('gemini.temperature');
    this.threshold   = config.get<number>('rag.similarityThreshold');
    this.maxChunks   = config.get<number>('rag.maxChunks');

    this.http = createGeminiClient(this.apiKey);
  }

  // ─── Late binding para FaqMatcherService (evita dependencia circular) ─────
  private faqMatcher: FaqMatcherService | null = null;

  /** Llamado por FaqModule después de que ambos servicios están construidos */
  setFaqMatcher(matcher: FaqMatcherService): void {
    this.faqMatcher = matcher;
    this.logger.log('FaqMatcherService registrado en RagService');
  }

  // ─── Paso 1: Generar embedding del texto ──────────────────────────────────
  async embed(text: string): Promise<number[]> {
    try {
      const url = geminiUrl(this.embedModel, 'embedContent');

      const res = await this.http.post<GeminiEmbedResponse>(url, {
        model: `models/${this.embedModel}`,
        content: { parts: [{ text }] },
        taskType: 'RETRIEVAL_QUERY',
      });

      return res.data.embedding.values;
    } catch (err) {
      this.logger.error(`Error generando embedding con Gemini: ${err.message}`);
      throw err;
    }
  }

  // ─── Embedding para indexación de documentos ──────────────────────────────
  private async embedForIndexing(text: string, title?: string): Promise<number[]> {
    try {
      const url = geminiUrl(this.embedModel, 'embedContent');

      const res = await this.http.post<GeminiEmbedResponse>(url, {
        model: `models/${this.embedModel}`,
        content: { parts: [{ text }] },
        taskType: 'RETRIEVAL_DOCUMENT',
        ...(title ? { title } : {}),
      });

      return res.data.embedding.values;
    } catch (err) {
      this.logger.error(`Error generando embedding de documento: ${err.message}`);
      throw err;
    }
  }

  // ─── Paso 2: Buscar chunks similares en pgvector ──────────────────────────
  async searchChunks(embedding: number[]): Promise<ChunkMatch[]> {
    const vectorStr = `[${embedding.join(',')}]`;

    const rows = await this.dataSource.query(
      `
      SELECT
        kc.id,
        kc.content,
        kd.title as "documentTitle",
        1 - (kc.embedding <=> $1::vector) as similarity
      FROM knowledge_chunks kc
      JOIN knowledge_documents kd ON kd.id = kc.document_id
      WHERE kd.is_active = true
        AND kc.embedding IS NOT NULL
        AND 1 - (kc.embedding <=> $1::vector) >= $2
      ORDER BY kc.embedding <=> $1::vector
      LIMIT $3
      `,
      [vectorStr, this.threshold, this.maxChunks],
    );

    return rows as ChunkMatch[];
  }

  // ─── Paso 3: Generar respuesta con Gemini ─────────────────────────────────
  //
  // NOTA US-EP01-04: Este método recibe texto ya seudonimizado.
  // Gemini trabaja con tokens (CLIENTE_001) en lugar de datos reales.
  // La re-hidratación ocurre después, en query().
  async generateAnswer(
    question: string,
    chunks: ChunkMatch[],
    conversationContext: string,
  ): Promise<string> {
    const context = chunks.map((c) => c.content).join('\n\n---\n\n');

    const prompt =
      `Eres el asistente virtual de Telecom Bolivianet, una empresa de internet en Bolivia. ` +
      `Responde de forma amable, concisa y en español. ` +
      `Usa la información del contexto para responder. ` +
      `Si no sabes algo, di que no tienes esa información y ofrece conectar con un agente. ` +
      `Usa emojis con moderación para ser más amigable. ` +
      `No inventes precios, fechas ni datos que no estén en el contexto.\n\n` +
      `Contexto de la conversación:\n${conversationContext}\n\n` +
      `Información relevante de nuestra base de conocimiento:\n${context}\n\n` +
      `Pregunta del cliente: ${question}`;

    try {
      const url = geminiUrl(this.chatModel, 'generateContent');

      // Auditoría: verificar que no hay PII en el prompt antes de enviarlo
      this.piiGuard.inspect(prompt, 'rag-pipeline', null);

      const res = await this.http.post<GeminiGenerateResponse>(url, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: this.temperature,
          maxOutputTokens: this.maxTokens,
        },
      });

      return res.data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    } catch (err) {
      this.logger.error(`Error generando respuesta con Gemini: ${err.message}`);
      throw err;
    }
  }

  // ─── Pipeline completo (US-EP01-04) ───────────────────────────────────────
  //
  // @param question             Pregunta original del usuario (puede contener PII).
  // @param conversationContext  Historial de conversación (puede contener PII).
  // @param phoneNumber          Teléfono del cliente para namespacing Redis.
  //                             Opcional para retrocompatibilidad.
  // @param clientName           Nombre real del cliente (de sesión), para
  //                             seudonimizar el nombre en el prompt.
  async query(
    question: string,
    conversationContext: string,
    phoneNumber?: string,
    clientName?: string | null,
  ): Promise<RagResult> {
    if (!this.apiKey) {
      this.logger.warn('RAG deshabilitado: GEMINI_API_KEY no configurada');
      return { found: false, answer: '' };
    }

    // ── Paso 0: Consultar FAQs antes del pipeline completo (EP-04) ───────────
    // Si hay una FAQ con alta similitud, respondemos en ~50ms sin llamar
    // a pgvector ni a Gemini para generación. Solo necesitamos embed().
    if (this.faqMatcher) {
      try {
        const faqResult = await this.faqMatcher.match(question);
        if (faqResult.found) {
          this.logger.debug(
            `[RAG] Respondido por FAQ | score=${faqResult.score.toFixed(3)} ` +
            `faq="${faqResult.faqQuestion.substring(0, 40)}"`,
          );
          return {
            found:       true,
            answer:      faqResult.answer,
            isFaqMatch:  true,
          };
        }
      } catch (err) {
        // Error en FaqMatcher: continuar con el pipeline RAG completo
        this.logger.warn(`[RAG] FaqMatcher falló, continuando con RAG: ${err.message}`);
      }
    }
    const pseudoCtx = await this.applyPseudonymization(
      question,
      conversationContext,
      phoneNumber,
      clientName,
    );

    const pseudoQuestion = pseudoCtx.pseudoQuestion;
    const pseudoContext  = pseudoCtx.pseudoContext;
    const mappingKey     = pseudoCtx.mappingKey;

    try {
      // ── Paso B: Reformular la query (EP-02) ───────────────────────────────
      // Se reformula DESPUÉS de seudonimizar para que el reformulador tampoco
      // reciba datos personales reales. Los tokens (MONTO_001) no afectan la
      // reformulación porque el prompt se enfoca en la intención del mensaje.
      const reformulation = await this.queryReformulation.reformulate(
        pseudoQuestion,
        pseudoContext,
      );
      const queryToEmbed = reformulation.query;

      if (reformulation.wasReformulated) {
        this.logger.debug(
          `[RAG] Query reformulada | phone=${phoneNumber ?? 'N/A'} ` +
          `original="${pseudoQuestion.substring(0, 40)}" ` +
          `→ reformulada="${queryToEmbed.substring(0, 40)}"`,
        );
      }

      // ── Paso C: Embedding de la query reformulada ─────────────────────────
      // Usamos queryToEmbed (reformulada) para el vector de búsqueda,
      // pero pseudoQuestion (original seudonimizada) para la generación,
      // para que Gemini reciba el texto tal como lo escribió el usuario.
      const textToEmbed = pseudoContext
        ? `${pseudoContext}\nCliente: ${queryToEmbed}`
        : queryToEmbed;

      const embedding = await this.embed(textToEmbed);

      // ── Paso D: Búsqueda en pgvector ─────────────────────────────────────
      const chunks = await this.searchChunks(embedding);

      if (chunks.length === 0) {
        this.logger.debug(`RAG: sin chunks relevantes (umbral ${this.threshold})`);
        return { found: false, answer: '' };
      }

      // ── Paso E: Generar respuesta con Gemini (recibe texto seudonimizado) ─
      // Gemini recibe pseudoQuestion (voz del usuario) + chunks relevantes.
      // La query reformulada fue solo para mejorar la búsqueda vectorial.
      const rawAnswer = await this.generateAnswer(
        pseudoQuestion,
        chunks,
        pseudoContext,
      );

      // ── Paso F: Re-hidratar la respuesta con datos reales ─────────────────
      const finalAnswer = await this.rehydrateAnswer(rawAnswer, mappingKey, phoneNumber);

      // ── Paso G: Liberar la tabla de Redis (ya no se necesita) ─────────────
      if (mappingKey) {
        await this.pseudonymService.invalidate(mappingKey).catch(() => {
          // Non-blocking: si falla la invalidación explícita, el TTL lo limpiará
        });
      }

      return {
        found:         true,
        answer:        finalAnswer,
        chunkId:       chunks[0].id,
        similarity:    chunks[0].similarity,
        documentTitle: chunks[0].documentTitle,
      };
    } catch (err) {
      this.logger.error(`RAG pipeline error: ${err.message}`);
      return { found: false, answer: '' };
    }
  }

  // ─── Seudonimización de la query y el contexto ────────────────────────────

  private async applyPseudonymization(
    question: string,
    conversationContext: string,
    phoneNumber?: string,
    clientName?: string | null,
  ): Promise<{
    pseudoQuestion: string;
    pseudoContext:  string;
    mappingKey:     string;
  }> {
    if (!phoneNumber) {
      // Sin teléfono no podemos hacer namespacing en Redis — continuar sin seudonimizar
      return {
        pseudoQuestion: question,
        pseudoContext:  conversationContext,
        mappingKey:     '',
      };
    }

    try {
      // Seudonimizar pregunta y contexto juntos para que el mismo valor
      // obtenga el mismo token en ambos textos (CLIENTE_001 consistente)
      const combinedText = `PREGUNTA: ${question}\nCONTEXTO: ${conversationContext}`;

      const { pseudonymizedText, mappingKey, replacementsCount } =
        await this.pseudonymService.pseudonymize(combinedText, phoneNumber, clientName);

      if (replacementsCount > 0) {
        this.logger.debug(
          `[RAG] Seudonimización aplicada | phone=${phoneNumber} ` +
          `replacements=${replacementsCount}`,
        );
      }

      // Separar la pregunta seudonimizada del contexto seudonimizado
      const splitMarker   = '\nCONTEXTO: ';
      const splitIndex    = pseudonymizedText.indexOf(splitMarker);
      const pseudoQuestion = splitIndex > 0
        ? pseudonymizedText.slice('PREGUNTA: '.length, splitIndex)
        : question;
      const pseudoContext  = splitIndex > 0
        ? pseudonymizedText.slice(splitIndex + splitMarker.length)
        : conversationContext;

      return { pseudoQuestion, pseudoContext, mappingKey };
    } catch (err) {
      // Degradación controlada: si falla Redis, continuar con texto original
      this.logger.warn(
        `[RAG] PseudonymService falló, continuando sin seudonimizar: ${err.message}`,
      );
      return {
        pseudoQuestion: question,
        pseudoContext:  conversationContext,
        mappingKey:     '',
      };
    }
  }

  // ─── Re-hidratación de la respuesta de Gemini ─────────────────────────────

  private async rehydrateAnswer(
    rawAnswer: string,
    mappingKey: string,
    phoneNumber?: string,
  ): Promise<string> {
    if (!mappingKey) return rawAnswer;

    try {
      return await this.pseudonymService.rehydrate(rawAnswer, mappingKey);
    } catch (err) {
      if (err instanceof PseudonymExpiredError) {
        // El TTL expiró entre que se generó el embedding y llegó la respuesta.
        // Esto no debería pasar normalmente (pipeline < 15s, TTL = 5min),
        // pero si ocurre, enviamos la respuesta con tokens en lugar de bloquear.
        this.logger.warn(
          `[RAG] TTL expiró durante re-hidratación | phone=${phoneNumber} ` +
          `key=${mappingKey}. Enviando respuesta sin re-hidratar.`,
        );
        // Retornar la respuesta con tokens — es mejor que un error genérico
        // porque el usuario igual recibe información útil (solo sin su nombre/monto)
        return rawAnswer;
      }
      this.logger.error(`[RAG] Error en re-hidratación: ${err.message}`);
      return rawAnswer;
    }
  }

  // ─── Vectorizar documento (US-16) ─────────────────────────────────────────
  async indexDocument(
    documentId: string,
    text: string,
    documentTitle: string,
    chunkSize = 500,
    overlap = 50,
  ): Promise<number> {
    const chunks = this.splitIntoChunks(text, chunkSize, overlap);
    let indexed = 0;

    for (let i = 0; i < chunks.length; i++) {
      try {
        const embedding = await this.embedForIndexing(chunks[i], documentTitle);
        const vectorStr = `[${embedding.join(',')}]`;

        await this.dataSource.query(
          `INSERT INTO knowledge_chunks (id, document_id, content, chunk_index, embedding)
           VALUES (uuid_generate_v4(), $1, $2, $3, $4::vector)`,
          [documentId, chunks[i], i, vectorStr],
        );
        indexed++;

        // Respetar rate limit del plan gratuito (15 req/min para embeddings)
        if (i < chunks.length - 1) {
          await new Promise(r => setTimeout(r, 100));
        }
      } catch (err) {
        this.logger.error(`Error indexando chunk ${i}: ${err.message}`);
      }
    }

    this.logger.log(`Documento ${documentId}: ${indexed}/${chunks.length} chunks indexados`);
    return indexed;
  }

  // ─── Eliminar chunks de un documento ──────────────────────────────────────
  async removeDocumentChunks(documentId: string): Promise<void> {
    await this.dataSource.query(
      `DELETE FROM knowledge_chunks WHERE document_id = $1`,
      [documentId],
    );
  }

  // ─── Utilidad: dividir texto en chunks con overlap ────────────────────────
  private splitIntoChunks(text: string, size: number, overlap: number): string[] {
    const words  = text.split(/\s+/);
    const chunks: string[] = [];
    let   start  = 0;

    while (start < words.length) {
      const end = Math.min(start + size, words.length);
      chunks.push(words.slice(start, end).join(' '));
      start += size - overlap;
    }

    return chunks.filter((c) => c.trim().length > 20);
  }
}


// ══════════════════════════════════════════════════════════════
// RAG SERVICE — Versión Gemini API (US-15, US-16)
//
// Reemplaza Ollama local por Google Gemini:
//   - Embeddings: models/text-embedding-004 (gratuito, 768 dims)
//   - Generación: gemini-2.0-flash (plan gratuito: 1500 req/día)
//
// IMPORTANTE — migración de dimensión de embeddings:
//   Ollama nomic-embed-text → 768 dims
//   Google text-embedding-004 → 768 dims  ✓ (misma dimensión)
//   No es necesario reindexar los documentos existentes si se
//   usaba nomic-embed-text. Si se usaba otro modelo con distinta
//   dimensión, re-vectorizar con: DELETE FROM knowledge_chunks;
//   y subir los documentos de nuevo por la API /rag/documents.
//
// Pipeline:
//   Pregunta → embed (Gemini) → pgvector → LLM genera (Gemini)
// ══════════════════════════════════════════════════════════════

export interface RagResult {
  found: boolean;
  answer: string;
  chunkId?: string;
  similarity?: number;
}

export interface ChunkMatch {
  id: string;
  content: string;
  similarity: number;
  documentTitle: string;
}

