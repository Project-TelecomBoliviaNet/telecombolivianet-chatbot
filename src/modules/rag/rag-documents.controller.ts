import {
  Controller, Get, Post, Delete, Patch, Param,
  UploadedFile, UseInterceptors, Body, Headers,
  UnauthorizedException, BadRequestException, NotFoundException,
  Logger, ParseUUIDPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { memoryStorage } from 'multer';
import * as pdfParse from 'pdf-parse';
import { KnowledgeDocument, KnowledgeChunk } from '../../database/entities/knowledge.entity';
import { RagService } from './rag.service';
import { isValidToken, extractBearerToken } from '../../common/security/token.util';

// ══════════════════════════════════════════════════════════════
// RAG DOCUMENTS CONTROLLER  (US-16)
//
// CRUD de documentos de conocimiento del chatbot.
// Consumido por el panel admin C#.
//
// POST   /rag/documents          → subir PDF/DOCX, vectorizar
// GET    /rag/documents          → listar documentos
// GET    /rag/documents/:id      → detalle + chunks count
// PATCH  /rag/documents/:id      → actualizar título / re-vectorizar
// DELETE /rag/documents/:id      → eliminar doc + chunks pgvector
//
// Auth: Bearer token estático (SISTEMA_BOT_STATIC_TOKEN)
// Formatos: PDF (extraído con pdf-parse), TXT plano
// ══════════════════════════════════════════════════════════════

@Controller('rag/documents')
export class RagDocumentsController {
  private readonly logger = new Logger(RagDocumentsController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly ragService: RagService,
    @InjectRepository(KnowledgeDocument)
    private readonly docRepo: Repository<KnowledgeDocument>,
    @InjectRepository(KnowledgeChunk)
    private readonly chunkRepo: Repository<KnowledgeChunk>,
  ) {}

  // ─── Autenticación ────────────────────────────────────────
  private checkAuth(auth: string): void {
    const token    = this.config.get<string>('sistema.botStaticToken') ?? '';
    const received = extractBearerToken(auth);
    if (!received || !isValidToken(received, token)) {
      throw new UnauthorizedException('Token inválido');
    }
  }

  // ─── POST /rag/documents — subir y vectorizar ─────────────
  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB máx
      fileFilter: (_req, file, cb) => {
        const allowed = ['application/pdf', 'text/plain'];
        if (allowed.includes(file.mimetype)) {
          cb(null, true);
        } else {
          cb(new BadRequestException('Solo se aceptan archivos PDF o TXT'), false);
        }
      },
    }),
  )
  async uploadDocument(
    @UploadedFile() file: Express.Multer.File,
    @Body('title') title: string,
    @Body('category') category: string,
    @Headers('authorization') auth: string,
  ) {
    this.checkAuth(auth);

    if (!file) throw new BadRequestException('Se requiere un archivo');
    if (!title?.trim()) throw new BadRequestException('Se requiere un título');

    this.logger.log(`Subiendo documento: "${title}" (${file.mimetype}, ${file.size} bytes)`);

    // Extraer texto según tipo de archivo
    const text = await this.extractText(file);
    if (!text || text.trim().length < 50) {
      throw new BadRequestException('El documento no contiene texto suficiente para indexar');
    }

    // Crear registro en DB
    const doc = this.docRepo.create({
      title: title.trim(),
      category: category?.trim() || 'General',
      originalFilename: file.originalname,
      mimeType: file.mimetype,
      fileSize: file.size,
      isActive: true,
      charCount: text.length,
    });
    const savedDoc = await this.docRepo.save(doc);

    // Vectorizar en background (no bloqueamos la respuesta HTTP)
    this.vectorizeInBackground(savedDoc.id, text, savedDoc.title);

    return {
      id: savedDoc.id,
      title: savedDoc.title,
      category: savedDoc.category,
      status: 'indexing',
      message: 'Documento recibido. La vectorización se realiza en segundo plano.',
    };
  }

  // ─── GET /rag/documents — listar ──────────────────────────
  @Get()
  async listDocuments(@Headers('authorization') auth: string) {
    this.checkAuth(auth);

    const docs = await this.docRepo.find({ order: { createdAt: 'DESC' } });

    // Agregar conteo de chunks por documento
    const withChunks = await Promise.all(
      docs.map(async (doc) => {
        const chunkCount = await this.chunkRepo.count({
          where: { documentId: doc.id },
        });
        return { ...this.formatDoc(doc), chunkCount };
      }),
    );

    return { total: docs.length, documents: withChunks };
  }

  // ─── GET /rag/documents/:id — detalle ─────────────────────
  @Get(':id')
  async getDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('authorization') auth: string,
  ) {
    this.checkAuth(auth);

    const doc = await this.docRepo.findOne({ where: { id } });
    if (!doc) throw new NotFoundException('Documento no encontrado');

    const chunkCount = await this.chunkRepo.count({ where: { documentId: id } });

    return { ...this.formatDoc(doc), chunkCount };
  }

  // ─── PATCH /rag/documents/:id — actualizar / re-vectorizar
  @Patch(':id')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 20 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        const allowed = ['application/pdf', 'text/plain'];
        cb(allowed.includes(file.mimetype) ? null : new BadRequestException('Solo PDF o TXT'), allowed.includes(file.mimetype));
      },
    }),
  )
  async updateDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('title') title: string | undefined,
    @Body('category') category: string | undefined,
    @Body('isActive') isActive: string | undefined,
    @Headers('authorization') auth: string,
  ) {
    this.checkAuth(auth);

    const doc = await this.docRepo.findOne({ where: { id } });
    if (!doc) throw new NotFoundException('Documento no encontrado');

    // Actualizar campos simples
    if (title?.trim()) doc.title = title.trim();
    if (category?.trim()) doc.category = category.trim();
    if (isActive !== undefined) doc.isActive = isActive === 'true';

    // Si viene nuevo archivo → re-vectorizar
    if (file) {
      const text = await this.extractText(file);
      if (text && text.trim().length >= 50) {
        doc.originalFilename = file.originalname;
        doc.mimeType = file.mimetype;
        doc.fileSize = file.size;
        doc.charCount = text.length;
        doc.indexedAt = null;

        await this.docRepo.save(doc);

        // Eliminar chunks anteriores y re-vectorizar
        await this.ragService.removeDocumentChunks(id);
        this.vectorizeInBackground(id, text, doc.title);

        return { ...this.formatDoc(doc), status: 're-indexing' };
      }
    }

    await this.docRepo.save(doc);
    return { ...this.formatDoc(doc), status: 'updated' };
  }

  // ─── DELETE /rag/documents/:id ────────────────────────────
  @Delete(':id')
  async deleteDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('authorization') auth: string,
  ) {
    this.checkAuth(auth);

    const doc = await this.docRepo.findOne({ where: { id } });
    if (!doc) throw new NotFoundException('Documento no encontrado');

    // Eliminar chunks de pgvector primero (FK)
    await this.ragService.removeDocumentChunks(id);
    await this.docRepo.remove(doc);

    this.logger.log(`Documento "${doc.title}" (${id}) eliminado con sus chunks`);
    return { deleted: true, id };
  }

  // ─── Vectorización en background ──────────────────────────
  private vectorizeInBackground(docId: string, text: string, title: string): void {
    this.ragService
      .indexDocument(docId, text, title)
      .then((count) => {
        this.docRepo.update(docId, {
          indexedAt: new Date(),
          chunkCount: count,
        });
        this.logger.log(`Documento ${docId}: ${count} chunks indexados ✔`);
      })
      .catch((err) => {
        this.logger.error(`Error vectorizando ${docId}: ${err.message}`);
        this.docRepo.update(docId, { indexingError: err.message });
      });
  }

  // ─── Extracción de texto según MIME ───────────────────────
  private async extractText(file: Express.Multer.File): Promise<string> {
    if (file.mimetype === 'application/pdf') {
      const parsed = await pdfParse(file.buffer);
      return parsed.text;
    }
    // text/plain
    return file.buffer.toString('utf-8');
  }

  private formatDoc(doc: KnowledgeDocument) {
    return {
      id: doc.id,
      title: doc.title,
      category: doc.category,
      originalFilename: doc.originalFilename,
      mimeType: doc.mimeType,
      fileSize: doc.fileSize,
      charCount: doc.charCount,
      isActive: doc.isActive,
      indexedAt: doc.indexedAt,
      indexingError: doc.indexingError,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }
}
