import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

// ══════════════════════════════════════════════════════════════
// DatabaseMigrationService
//
// Aplica migraciones de schema al arrancar la aplicación,
// DESPUÉS de que TypeORM synchronize crea las tablas base.
//
// Necesario porque TypeORM synchronize no puede gestionar
// tipos de PostgreSQL sin soporte nativo (vector, uuid-ossp),
// por lo que la columna `embedding vector(768)` en
// knowledge_chunks se añade aquí de forma idempotente.
// ══════════════════════════════════════════════════════════════

@Injectable()
export class DatabaseMigrationService implements OnModuleInit {
  private readonly logger = new Logger(DatabaseMigrationService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    this.logger.log('Verificando schema de base de datos...');
    try {
      await this.ensureExtensions();
      await this.ensureEmbeddingColumn();
      await this.ensureConversationSummaryColumn();
      await this.ensureMessagesMediaColumns();
      await this.ensureSemanticCacheTable();
      await this.ensureConversationsPhoneIndex();
      this.logger.log('Schema verificado ✔');
    } catch (err) {
      this.logger.error(`Error crítico en migración de schema: ${(err as Error).message}`);
      throw err;
    }
  }

  private async ensureExtensions(): Promise<void> {
    await this.dataSource.query('CREATE EXTENSION IF NOT EXISTS vector');
    await this.dataSource.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  }

  private async ensureEmbeddingColumn(): Promise<void> {
    const [row] = await this.dataSource.query<{ exists: boolean }[]>(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'knowledge_chunks'
          AND column_name = 'embedding'
      ) AS exists
    `);

    if (row.exists) return;

    this.logger.warn('Columna embedding faltante en knowledge_chunks — aplicando migración');
    await this.dataSource.query(
      'ALTER TABLE knowledge_chunks ADD COLUMN embedding vector(768)',
    );
    await this.dataSource.query(`
      CREATE INDEX IF NOT EXISTS idx_chunks_embedding
        ON knowledge_chunks USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 10)
    `);
    this.logger.log('Migración: columna embedding añadida ✔');
  }

  private async ensureMessagesMediaColumns(): Promise<void> {
    const [row] = await this.dataSource.query<{ exists: boolean }[]>(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'messages'
          AND column_name = 'media_url'
      ) AS exists
    `);

    if (row.exists) return;

    this.logger.warn('Columnas media_url/media_type faltantes en messages — aplicando migración');
    await this.dataSource.query(
      'ALTER TABLE messages ADD COLUMN media_url VARCHAR(500), ADD COLUMN media_type VARCHAR(20)',
    );
    this.logger.log('Migración: columnas media_url y media_type añadidas a messages ✔');
  }

  private async ensureConversationSummaryColumn(): Promise<void> {
    const [row] = await this.dataSource.query<{ exists: boolean }[]>(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'conversations'
          AND column_name = 'summary'
      ) AS exists
    `);

    if (row.exists) return;

    this.logger.warn('Columna summary faltante en conversations — aplicando migración');
    await this.dataSource.query(
      'ALTER TABLE conversations ADD COLUMN summary TEXT',
    );
    this.logger.log('Migración: columna summary añadida a conversations ✔');
  }

  private async ensureSemanticCacheTable(): Promise<void> {
    const [row] = await this.dataSource.query<{ exists: boolean }[]>(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'semantic_cache'
      ) AS exists
    `);

    if (row.exists) return;

    this.logger.log('Tabla semantic_cache no encontrada — creando...');

    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS semantic_cache (
        id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        query_text      TEXT NOT NULL,
        query_embedding vector(768),
        answer          TEXT NOT NULL,
        hit_count       INT  NOT NULL DEFAULT 0,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at      TIMESTAMPTZ NOT NULL
      )
    `);
    await this.dataSource.query(`
      CREATE INDEX idx_semantic_cache_embedding
        ON semantic_cache USING ivfflat (query_embedding vector_cosine_ops)
        WITH (lists = 50)
    `);
    await this.dataSource.query(`
      CREATE INDEX idx_semantic_cache_expires ON semantic_cache(expires_at)
    `);

    this.logger.log('Migración: tabla semantic_cache creada ✔');
  }

  private async ensureConversationsPhoneIndex(): Promise<void> {
    const [row] = await this.dataSource.query<{ exists: boolean }[]>(`
      SELECT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE tablename = 'conversations'
          AND indexname = 'uq_conversations_phone_number'
      ) AS exists
    `);

    if (row.exists) return;

    this.logger.warn('Índice único faltante en conversations.phone_number — aplicando migración');
    await this.dataSource.query(
      'CREATE UNIQUE INDEX uq_conversations_phone_number ON conversations(phone_number)',
    );
    this.logger.log('Migración: índice único uq_conversations_phone_number creado ✔');
  }
}
