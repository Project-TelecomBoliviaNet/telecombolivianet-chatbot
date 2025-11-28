import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import axios, { AxiosInstance } from 'axios';
import { GeminiClientService } from '../ai/gemini-client.service';
import { SemanticCacheService } from './semantic-cache.service';

export interface RagResult {
  found: boolean;
  answer: string;
  chunkId?: string;
  similarity?: number;
  fromCache?: boolean;
}

export interface ChunkMatch {
  id: string;
  content: string;
  similarity: number;
  documentTitle: string;
}

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

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
    config: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly geminiClient: GeminiClientService,
    private readonly semanticCache: SemanticCacheService,
  ) {
    this.apiKey      = config.get<string>('gemini.apiKey');
    this.embedModel  = config.get<string>('gemini.embedModel');
    this.chatModel   = config.get<string>('gemini.chatModel');
    this.maxTokens   = config.get<number>('gemini.maxTokens');
    this.temperature = config.get<number>('gemini.temperature');
    this.threshold   = config.get<number>('rag.similarityThreshold');
    this.maxChunks   = config.get<number>('rag.maxChunks');

    this.http = axios.create({ timeout: 60000 });
  }

  // ─── Paso 1: Generar embedding con Gemini ────────────────────
  async embed(text: string, taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY' = 'RETRIEVAL_DOCUMENT'): Promise<number[]> {
    try {
      return await this.geminiClient.embedText(text, this.embedModel, taskType);
    } catch (err) {
      this.logger.error(`Error generando embedding: ${String(err)}`);
      throw err;
    }
  }

  // ─── Paso 2: Buscar chunks similares en pgvector ─────────────
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

  // ─── Paso 3: Generar respuesta con Gemini ────────────────────
  async generateAnswer(
    question: string,
    chunks: ChunkMatch[],
    conversationContext: string,
  ): Promise<string> {
    const context = chunks.map((c) => c.content).join('\n\n---\n\n');

    const systemInstruction =
      `Eres el asistente virtual de Telecom Bolivianet, una empresa de internet en Bolivia. ` +
      `Responde de forma amable, concisa y en español. ` +
      `Usa la información del contexto para responder. ` +
      `Si no sabes algo, di que no tienes esa información y ofrece conectar con un agente. ` +
      `Usa emojis con moderación para ser más amigable. ` +
      `No inventes precios, fechas ni datos que no estén en el contexto.`;

    const userPrompt =
      `Contexto de la conversación:\n${conversationContext}\n\n` +
      `Información relevante de nuestra base de conocimiento:\n${context}\n\n` +
      `Pregunta del cliente: ${question}`;

    try {
      const url = this.geminiClient.buildUrl(GEMINI_BASE, this.chatModel, 'generateContent', this.apiKey);
      const headers = await this.geminiClient.getAuthHeaders();
      const res = await this.http.post(url, {
        system_instruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: this.temperature,
          maxOutputTokens: this.maxTokens,
        },
      }, { headers });
      return res.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    } catch (err) {
      this.logger.error(`Error generando respuesta Gemini: ${String(err)}`);
      throw err;
    }
  }

  // ─── Pipeline completo ────────────────────────────────────────
  async query(question: string, conversationContext: string): Promise<RagResult> {
    try {
      const textToEmbed = conversationContext
        ? `${conversationContext}\nCliente: ${question}`
        : question;

      // Paso 1a: embedding solo de la pregunta → usado para caché semántica.
      // No incluye el contexto de conversación para que preguntas idénticas
      // de distintos usuarios siempre produzcan el mismo vector y generen hit.
      const questionEmbedding = await this.embed(question, 'RETRIEVAL_QUERY');

      // Paso 2: buscar en caché antes de gastar tokens en RAG
      const cached = await this.semanticCache.get(questionEmbedding);
      if (cached !== null) {
        this.logger.debug(`RAG: cache hit para "${question.substring(0, 60)}"`);
        return { found: true, answer: cached, fromCache: true };
      }

      // Paso 1b: embedding enriquecido con contexto → usado solo para RAG,
      // mejora la relevancia de los chunks recuperados.
      const ragEmbedding = await this.embed(textToEmbed, 'RETRIEVAL_QUERY');

      // Paso 3: búsqueda vectorial en knowledge_chunks
      const chunks = await this.searchChunks(ragEmbedding);

      if (chunks.length === 0) {
        this.logger.debug(`RAG: sin chunks relevantes (umbral ${this.threshold})`);
        return { found: false, answer: '' };
      }

      // Paso 4: generar respuesta con Gemini
      const answer = await this.generateAnswer(question, chunks, conversationContext);

      // Paso 5: guardar en caché usando el embedding de la pregunta sola
      await this.semanticCache.set(question, questionEmbedding, answer);

      return {
        found: true,
        answer,
        chunkId: chunks[0].id,
        similarity: chunks[0].similarity,
        fromCache: false,
      };
    } catch (err) {
      this.logger.error(`RAG pipeline error: ${String(err)}`);
      return { found: false, answer: '' };
    }
  }

  // ─── Vectorizar documento ─────────────────────────────────────
  async indexDocument(
    documentId: string,
    text: string,
    chunkSize = 500,
    overlap = 50,
  ): Promise<number> {
    const chunks = this.splitIntoChunks(text, chunkSize, overlap);
    let indexed = 0;

    for (let i = 0; i < chunks.length; i++) {
      try {
        const embedding = await this.embed(chunks[i]);
        const vectorStr = `[${embedding.join(',')}]`;

        await this.dataSource.query(
          `INSERT INTO knowledge_chunks (id, document_id, content, chunk_index, embedding)
           VALUES (uuid_generate_v4(), $1, $2, $3, $4::vector)
           ON CONFLICT (document_id, chunk_index)
           DO UPDATE SET content = EXCLUDED.content, embedding = EXCLUDED.embedding`,
          [documentId, chunks[i], i, vectorStr],
        );
        indexed++;
      } catch (err) {
        this.logger.error(`Error indexando chunk ${i}: ${String(err)}`);
      }
    }

    if (indexed === 0 && chunks.length > 0) {
      this.logger.error(
        `Documento ${documentId}: TODOS los chunks fallaron (0/${chunks.length}). ` +
        `Causas comunes: API key inválida, Vertex AI no habilitado en GCP, cuota excedida.`,
      );
    } else {
      this.logger.log(`Documento ${documentId}: ${indexed}/${chunks.length} chunks indexados`);
      // Base de conocimiento actualizada → invalidar caché semántico
      await this.semanticCache.clearAll();
    }
    return indexed;
  }

  async removeDocumentChunks(documentId: string): Promise<void> {
    await this.dataSource.query(
      `DELETE FROM knowledge_chunks WHERE document_id = $1`,
      [documentId],
    );
    // El caché semántico puede contener respuestas basadas en este documento.
    // Se invalida para que las próximas consultas usen la base de conocimiento actualizada.
    await this.semanticCache.clearAll();
  }

  private splitIntoChunks(text: string, size: number, overlap: number): string[] {
    const words = text.split(/\s+/);
    const chunks: string[] = [];
    let start = 0;

    while (start < words.length) {
      const end = Math.min(start + size, words.length);
      chunks.push(words.slice(start, end).join(' '));
      start += size - overlap;
    }

    return chunks.filter((c) => c.trim().length > 20);
  }
}
