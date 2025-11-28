import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Cron } from '@nestjs/schedule';

// ══════════════════════════════════════════════════════════════
// SemanticCacheService
//
// Caché semántica para el pipeline RAG. Almacena pares
// (query_embedding → answer) en PostgreSQL con pgvector y los
// reutiliza cuando una nueva consulta es semánticamente
// equivalente (similitud coseno ≥ cacheSimilarity).
//
// Beneficio: elimina la llamada a Gemini generateAnswer()
// para preguntas repetitivas (~60-80% del tráfico en un ISP).
//
// TTL diferenciado:
//   - Preguntas sobre precios/planes → 6h (datos volátiles)
//   - Preguntas técnicas/políticas   → 7d (datos estáticos)
//   - Resto                          → 24h
//
// Si cualquier operación falla, el error se loguea y se
// retorna null — el flujo RAG normal continúa sin interrupción.
// ══════════════════════════════════════════════════════════════

// Palabras clave para determinar el TTL de cada entrada
const PRICING_KEYWORDS = ['plan', 'precio', 'costo', 'cuánto', 'cuanto', 'tarifa', 'bs.', 'boliviano', 'mensual', 'pago'];
const STATIC_KEYWORDS  = ['router', 'reiniciar', 'reinicio', 'paso', 'contrato', 'política', 'politica', 'garantía', 'garantia', 'soporte'];

@Injectable()
export class SemanticCacheService {
  private readonly logger = new Logger(SemanticCacheService.name);
  private readonly enabled: boolean;
  private readonly similarity: number;
  private readonly ttlDefaultH: number;
  private readonly ttlPricingH: number;
  private readonly ttlStaticH: number;

  constructor(
    config: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {
    this.enabled    = config.get<boolean>('rag.cacheEnabled') ?? true;
    this.similarity = config.get<number>('rag.cacheSimilarity')  ?? 0.92;
    this.ttlDefaultH = config.get<number>('rag.cacheTtlDefaultH') ?? 24;
    this.ttlPricingH = config.get<number>('rag.cacheTtlPricingH') ?? 6;
    this.ttlStaticH  = config.get<number>('rag.cacheTtlStaticH')  ?? 168;
  }

  // ─── GET: busca una entrada semánticamente similar ────────────
  // Retorna la respuesta cacheada o null si no hay hit.
  async get(queryEmbedding: number[]): Promise<string | null> {
    if (!this.enabled) return null;

    try {
      const vectorStr = `[${queryEmbedding.join(',')}]`;

      const rows = await this.dataSource.query<{ id: string; answer: string; similarity: number }[]>(`
        SELECT id, answer,
               1 - (query_embedding <=> $1::vector) AS similarity
        FROM   semantic_cache
        WHERE  expires_at > NOW()
          AND  query_embedding IS NOT NULL
          AND  1 - (query_embedding <=> $1::vector) >= $2
        ORDER  BY query_embedding <=> $1::vector
        LIMIT  1
      `, [vectorStr, this.similarity]);

      if (rows.length === 0) return null;

      const { id, answer, similarity } = rows[0];
      this.logger.debug(`SemanticCache HIT — similarity: ${similarity.toFixed(4)}`);

      // Incrementar hit_count en background (no bloquea la respuesta)
      this.dataSource.query(
        'UPDATE semantic_cache SET hit_count = hit_count + 1 WHERE id = $1',
        [id],
      ).catch(err => this.logger.warn(`hit_count update falló: ${err.message}`));

      return answer;
    } catch (err) {
      this.logger.warn(`SemanticCache.get error (ignorando): ${(err as Error).message}`);
      return null;
    }
  }

  // ─── SET: almacena una nueva entrada con TTL calculado ────────
  async set(queryText: string, queryEmbedding: number[], answer: string): Promise<void> {
    if (!this.enabled) return;
    if (!answer.trim()) return; // no cachear respuestas vacías (fallos de API Gemini)

    try {
      const vectorStr = `[${queryEmbedding.join(',')}]`;
      const ttlHours  = this.computeTtlHours(queryText);
      const expiresAt = new Date(Date.now() + ttlHours * 3_600_000).toISOString();

      await this.dataSource.query(`
        INSERT INTO semantic_cache (query_text, query_embedding, answer, expires_at)
        VALUES ($1, $2::vector, $3, $4)
      `, [queryText, vectorStr, answer, expiresAt]);

      this.logger.debug(`SemanticCache SET — ttl: ${ttlHours}h, query: "${queryText.substring(0, 60)}"`);
    } catch (err) {
      this.logger.warn(`SemanticCache.set error (ignorando): ${(err as Error).message}`);
    }
  }

  // ─── CLEAR ALL: invalida el caché completo ───────────────────
  // Llamar cuando el conocimiento base cambia (documento actualizado
  // o eliminado) para evitar servir respuestas obsoletas.
  async clearAll(): Promise<void> {
    try {
      const deleted: { id: string }[] = await this.dataSource.query(
        'DELETE FROM semantic_cache RETURNING id',
      );
      if (deleted.length > 0) {
        this.logger.log(`SemanticCache: caché invalidado (${deleted.length} entradas eliminadas)`);
      }
    } catch (err) {
      this.logger.warn(`SemanticCache.clearAll error: ${(err as Error).message}`);
    }
  }

  // ─── CRON: limpieza diaria de entradas expiradas ──────────────
  // RETURNING id hace que pg retorne las filas eliminadas,
  // permitiendo contar cuántas se borraron via result.length.
  @Cron('0 3 * * *')
  async purgeExpired(): Promise<void> {
    try {
      const deleted: { id: string }[] = await this.dataSource.query(
        'DELETE FROM semantic_cache WHERE expires_at < NOW() RETURNING id',
      );
      if (deleted.length > 0) {
        this.logger.log(`SemanticCache: ${deleted.length} entradas expiradas eliminadas`);
      }
    } catch (err) {
      this.logger.warn(`SemanticCache.purgeExpired error: ${(err as Error).message}`);
    }
  }

  // ─── TTL según tipo de pregunta ───────────────────────────────
  private computeTtlHours(queryText: string): number {
    const lower = queryText.toLowerCase();
    if (PRICING_KEYWORDS.some(kw => lower.includes(kw))) return this.ttlPricingH;
    if (STATIC_KEYWORDS.some(kw => lower.includes(kw)))  return this.ttlStaticH;
    return this.ttlDefaultH;
  }
}
