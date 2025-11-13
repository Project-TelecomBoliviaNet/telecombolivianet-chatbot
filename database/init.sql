-- ══════════════════════════════════════════════════════════════
-- TELECOM BOLIVIANET - CHATBOT WHATSAPP
-- Inicialización de base de datos del bot
-- ══════════════════════════════════════════════════════════════

-- Extensión pgvector para búsqueda semántica RAG
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── CONVERSACIONES ───────────────────────────────────────────
-- Historial completo de todos los mensajes por número de WhatsApp
CREATE TABLE IF NOT EXISTS conversations (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone_number  VARCHAR(20) NOT NULL,
    client_id     UUID,                          -- NULL si es prospecto
    client_name   VARCHAR(200),
    -- Control de sesión
    is_escalated  BOOLEAN NOT NULL DEFAULT FALSE, -- true = admin tomó control
    escalated_at  TIMESTAMP,
    agent_name    VARCHAR(200),                  -- nombre del admin que tomó control
    -- Resumen de conversación generado por IA al escalar (US-AI-10)
    summary       TEXT,
    -- Contadores para lógica del bot
    rag_fail_count INT NOT NULL DEFAULT 0,       -- intentos RAG fallidos consecutivos
    -- Timestamps
    created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversations_phone ON conversations(phone_number);

-- ─── MENSAJES ─────────────────────────────────────────────────
CREATE TYPE message_role AS ENUM ('user', 'bot', 'admin');
CREATE TYPE message_source AS ENUM ('intent', 'rag', 'agent', 'admin', 'system', 'escalation');

CREATE TABLE IF NOT EXISTS messages (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            message_role NOT NULL,
    content         TEXT NOT NULL,
    source          message_source,              -- origen de la respuesta del bot
    chunk_id        UUID,                        -- si source=rag, el chunk usado
    meta_message_id VARCHAR(100),               -- ID del mensaje en Meta API
    media_url       VARCHAR(500),               -- URL de audio/imagen guardado en disco
    media_type      VARCHAR(20),                -- 'audio' | 'image'
    -- Timestamps
    created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

-- ─── DOCUMENTOS DE CONOCIMIENTO (RAG) ─────────────────────────
-- Actualizado (US-16): campos de metadata de archivo e indexación
CREATE TABLE IF NOT EXISTS knowledge_documents (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title             VARCHAR(300) NOT NULL,
    category          VARCHAR(100) NOT NULL DEFAULT 'General',
    -- Metadata del archivo original
    original_filename VARCHAR(300),
    mime_type         VARCHAR(100),
    file_size         INT,
    char_count        INT,
    -- Estado de indexación vectorial
    is_active         BOOLEAN NOT NULL DEFAULT TRUE,
    chunk_count       INT NOT NULL DEFAULT 0,
    indexed_at        TIMESTAMPTZ,
    indexing_error    TEXT,
    -- Auditoría
    uploaded_by       VARCHAR(200),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── CHUNKS VECTORIZADOS (RAG) ────────────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    content     TEXT NOT NULL,
    chunk_index INT NOT NULL,                   -- posición dentro del documento
    embedding   vector(768),                    -- nomic-embed-text = 768 dims
    created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chunks_document ON knowledge_chunks(document_id);
-- Índice coseno para búsqueda semántica (pgvector)
CREATE INDEX IF NOT EXISTS idx_chunks_embedding
    ON knowledge_chunks USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_knowledge_docs_category ON knowledge_documents(category);
CREATE INDEX IF NOT EXISTS idx_knowledge_docs_active ON knowledge_documents(is_active);

-- ─── SESIONES DE ADMIN (control manual) ───────────────────────
CREATE TABLE IF NOT EXISTS admin_sessions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id UUID NOT NULL REFERENCES conversations(id),
    admin_name      VARCHAR(200) NOT NULL,
    started_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    ended_at        TIMESTAMP,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE
);

-- ─── FUNCIÓN: actualizar updated_at automáticamente ───────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_conversations_updated_at
    BEFORE UPDATE ON conversations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_knowledge_documents_updated_at
    BEFORE UPDATE ON knowledge_documents
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ══════════════════════════════════════════════════════════════
-- MIGRACIÓN: Aplicar en bases de datos existentes de Fase 1/2
-- Seguro ejecutar múltiples veces (IF NOT EXISTS / DO $$)
-- ══════════════════════════════════════════════════════════════
DO $$
BEGIN
  -- Nuevos campos de knowledge_documents (Fase 3 / US-16)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_name='knowledge_documents' AND column_name='category') THEN
    ALTER TABLE knowledge_documents
      ADD COLUMN category          VARCHAR(100) NOT NULL DEFAULT 'General',
      ADD COLUMN original_filename VARCHAR(300),
      ADD COLUMN mime_type         VARCHAR(100),
      ADD COLUMN file_size         INT,
      ADD COLUMN char_count        INT,
      ADD COLUMN chunk_count       INT NOT NULL DEFAULT 0,
      ADD COLUMN indexed_at        TIMESTAMPTZ,
      ADD COLUMN indexing_error    TEXT;

    -- Renombrar file_name → original_filename si viene de Fase 1
    IF EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_name='knowledge_documents' AND column_name='file_name') THEN
      UPDATE knowledge_documents SET original_filename = file_name WHERE file_name IS NOT NULL;
      ALTER TABLE knowledge_documents DROP COLUMN IF EXISTS file_name;
    END IF;

    -- Renombrar content_type → mime_type si viene de Fase 1
    IF EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_name='knowledge_documents' AND column_name='content_type') THEN
      UPDATE knowledge_documents SET mime_type = content_type WHERE content_type IS NOT NULL;
      ALTER TABLE knowledge_documents DROP COLUMN IF EXISTS content_type;
    END IF;

    RAISE NOTICE 'Migración knowledge_documents aplicada correctamente';
  ELSE
    RAISE NOTICE 'knowledge_documents ya tiene columnas de Fase 3 — sin cambios';
  END IF;

  -- Columna embedding en knowledge_chunks (pgvector vector(768))
  -- TypeORM synchronize no la crea porque el campo está sin decorador en la entidad.
  -- Esta migración la agrega si falta (seguro ejecutar múltiples veces).
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_name='knowledge_chunks' AND column_name='embedding') THEN
    CREATE EXTENSION IF NOT EXISTS vector;
    ALTER TABLE knowledge_chunks ADD COLUMN embedding vector(768);
    CREATE INDEX IF NOT EXISTS idx_chunks_embedding
      ON knowledge_chunks USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 10);
    RAISE NOTICE 'Migración: columna embedding añadida a knowledge_chunks ✔';
  ELSE
    RAISE NOTICE 'knowledge_chunks ya tiene columna embedding — sin cambios';
  END IF;

  -- UNIQUE constraint en knowledge_chunks(document_id, chunk_index) para ON CONFLICT en re-indexación
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'knowledge_chunks_document_chunk_key'
      AND conrelid = 'knowledge_chunks'::regclass
  ) THEN
    ALTER TABLE knowledge_chunks
      ADD CONSTRAINT knowledge_chunks_document_chunk_key UNIQUE (document_id, chunk_index);
    RAISE NOTICE 'Migración: constraint UNIQUE (document_id, chunk_index) añadido a knowledge_chunks ✔';
  END IF;

  -- Valor 'agent' en enum message_source (MessageSource.AGENT en TypeScript)
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'agent'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'message_source')
  ) THEN
    ALTER TYPE message_source ADD VALUE 'agent';
    RAISE NOTICE 'Migración: valor "agent" añadido a enum message_source ✔';
  END IF;

  -- Columnas media_url / media_type en messages (F3/F4: audio e imágenes)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_name='messages' AND column_name='media_url') THEN
    ALTER TABLE messages
      ADD COLUMN media_url  VARCHAR(500),
      ADD COLUMN media_type VARCHAR(20);
    RAISE NOTICE 'Migración: columnas media_url y media_type añadidas a messages ✔';
  ELSE
    RAISE NOTICE 'messages ya tiene columna media_url — sin cambios';
  END IF;

  -- UNIQUE constraint en conversations.phone_number requerido por TypeORM upsert.
  -- ON CONFLICT necesita un constraint, no solo un índice.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversations_phone_number_key'
      AND conrelid = 'conversations'::regclass
  ) THEN
    ALTER TABLE conversations ADD CONSTRAINT conversations_phone_number_key UNIQUE (phone_number);
    RAISE NOTICE 'Migración: constraint UNIQUE phone_number añadido a conversations ✔';
  ELSE
    RAISE NOTICE 'conversations ya tiene constraint UNIQUE phone_number — sin cambios';
  END IF;

END $$;

-- ─── CACHÉ SEMÁNTICA (RAG) ────────────────────────────────────
-- Almacena pares (embedding_consulta → respuesta_generada) para evitar
-- llamadas repetidas a Gemini cuando la pregunta es semánticamente equivalente.
-- TTL diferenciado: precios/planes → 6h, soporte estático → 7d, resto → 24h.
CREATE TABLE IF NOT EXISTS semantic_cache (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    query_text      TEXT NOT NULL,
    query_embedding vector(768),
    answer          TEXT NOT NULL,
    hit_count       INT  NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL
);

-- Índice coseno para búsqueda por similitud semántica
-- lists=50: tabla pequeña (~200-500 filas típicas en un ISP)
CREATE INDEX IF NOT EXISTS idx_semantic_cache_embedding
    ON semantic_cache USING ivfflat (query_embedding vector_cosine_ops)
    WITH (lists = 50);

-- Índice para el cron de limpieza y el filtro expires_at > NOW()
CREATE INDEX IF NOT EXISTS idx_semantic_cache_expires
    ON semantic_cache(expires_at);
