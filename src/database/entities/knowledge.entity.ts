import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  UpdateDateColumn, OneToMany, ManyToOne, JoinColumn,
} from 'typeorm';

// ══════════════════════════════════════════════════════════════
// KNOWLEDGE DOCUMENT — documento de conocimiento RAG (US-16)
// Actualizado: campos para gestión de archivos y estado
//              de indexación vectorial.
// ══════════════════════════════════════════════════════════════

@Entity('knowledge_documents')
export class KnowledgeDocument {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 300 })
  title: string;

  @Column({ length: 100, default: 'General' })
  category: string;

  // ── Metadata del archivo original ─────────────────────────
  @Column({ name: 'original_filename', length: 300, nullable: true })
  originalFilename: string | null;

  @Column({ name: 'mime_type', length: 100, nullable: true })
  mimeType: string | null;

  @Column({ name: 'file_size', type: 'int', nullable: true })
  fileSize: number | null;

  @Column({ name: 'char_count', type: 'int', nullable: true })
  charCount: number | null;

  // ── Estado de indexación ───────────────────────────────────
  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  @Column({ name: 'chunk_count', type: 'int', default: 0 })
  chunkCount: number;

  @Column({ name: 'indexed_at', type: 'timestamptz', nullable: true })
  indexedAt: Date | null;

  @Column({ name: 'indexing_error', type: 'text', nullable: true })
  indexingError: string | null;

  // ── Quién lo subió (para auditoría) ───────────────────────
  @Column({ name: 'uploaded_by', length: 200, nullable: true })
  uploadedBy: string | null;

  @OneToMany(() => KnowledgeChunk, (c) => c.document, { cascade: true })
  chunks: KnowledgeChunk[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

// ══════════════════════════════════════════════════════════════
// KNOWLEDGE CHUNK — fragmento vectorizado de un documento
// ══════════════════════════════════════════════════════════════

@Entity('knowledge_chunks')
export class KnowledgeChunk {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'document_id', type: 'uuid' })
  documentId: string;

  @ManyToOne(() => KnowledgeDocument, (d) => d.chunks, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'document_id' })
  document: KnowledgeDocument;

  @Column({ type: 'text' })
  content: string;

  @Column({ name: 'chunk_index' })
  chunkIndex: number;

  // pgvector almacena el embedding como tipo `vector`.
  // TypeORM no tiene soporte nativo — se usa raw queries.
  // Esta columna NO se mapea con TypeORM; existe en la DB
  // como `embedding vector(768)` y se gestiona via DataSource.query()
  // @Column({ ... })   ← comentado intencionalmente

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
