/**
 * @file faq.service.ts
 * @description Servicio CRUD de FAQs con cache en memoria.
 *
 * RESPONSABILIDADES (SRP):
 *   Este servicio hace exactamente dos cosas:
 *   1. Operaciones CRUD sobre la tabla `faqs` (PostgreSQL via TypeORM).
 *   2. Mantener un cache en memoria de las FAQs activas, invalidado
 *      automáticamente cada CACHE_TTL_MS y manualmente en cada mutación.
 *
 * El FaqMatcherService es quien hace el matching semántico —
 * FaqService solo provee los datos al Matcher, sin acoplarse a él.
 *
 * CACHE:
 *   Las FAQs activas se cargan en memoria al primer acceso y se
 *   refrescan cada 5 minutos (configurable). Esto garantiza que
 *   el matching sea O(n) en memoria sin ir a la BD en cada mensaje.
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Faq } from '../../database/entities/faq.entity';
import {
  CreateFaqDto,
  UpdateFaqDto,
  ListFaqsQuery,
  FaqResponseDto,
  FaqListResponseDto,
} from './faq.dto';

// ─── Constantes ───────────────────────────────────────────────────────────────

/** TTL del cache de FAQs activas en memoria: 5 minutos */
const CACHE_TTL_MS = 5 * 60 * 1000;

const DEFAULT_PAGE  = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT     = 100;

// ─── Servicio ─────────────────────────────────────────────────────────────────

@Injectable()
export class FaqService {
  private readonly logger = new Logger(FaqService.name);

  /** Cache de FAQs activas para el matcher */
  private activeFaqsCache: Faq[]        = [];
  private cacheLoadedAt:   number       = 0;
  private cacheValid                    = false;

  constructor(
    @InjectRepository(Faq)
    private readonly faqRepo: Repository<Faq>,
  ) {}

  // ─── API pública — CRUD ───────────────────────────────────────────────────

  async create(dto: CreateFaqDto): Promise<FaqResponseDto> {
    this.validateQuestion(dto.question);
    this.validateAnswer(dto.answer);

    const faq = this.faqRepo.create({
      question: dto.question.trim(),
      answer:   dto.answer.trim(),
      tags:     dto.tags     ?? [],
      priority: dto.priority ?? 5,
      isActive: dto.isActive ?? true,
    });

    const saved = await this.faqRepo.save(faq);
    this.invalidateCache();

    this.logger.log(`FAQ creada: id=${saved.id} | question="${saved.question.substring(0, 50)}"`);
    return this.toDto(saved);
  }

  async findAll(query: ListFaqsQuery): Promise<FaqListResponseDto> {
    const page  = Math.max(1, query.page  ?? DEFAULT_PAGE);
    const limit = Math.min(MAX_LIMIT, Math.max(1, query.limit ?? DEFAULT_LIMIT));
    const skip  = (page - 1) * limit;

    const qb = this.faqRepo.createQueryBuilder('faq');

    if (query.tag) {
      // simple-array almacena como "tag1,tag2,tag3" — búsqueda por LIKE
      qb.andWhere('faq.tags LIKE :tag', { tag: `%${query.tag}%` });
    }

    if (query.active === true) {
      qb.andWhere('faq.is_active = :active', { active: true });
    }

    qb.orderBy('faq.priority', 'DESC')
      .addOrderBy('faq.created_at', 'DESC')
      .skip(skip)
      .take(limit);

    const [items, total] = await qb.getManyAndCount();

    return {
      items: items.map(this.toDto),
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    };
  }

  async findOne(id: string): Promise<FaqResponseDto> {
    const faq = await this.faqRepo.findOne({ where: { id } });
    if (!faq) throw new NotFoundException(`FAQ ${id} no encontrada`);
    return this.toDto(faq);
  }

  async update(id: string, dto: UpdateFaqDto): Promise<FaqResponseDto> {
    const faq = await this.faqRepo.findOne({ where: { id } });
    if (!faq) throw new NotFoundException(`FAQ ${id} no encontrada`);

    if (dto.question !== undefined) {
      this.validateQuestion(dto.question);
      faq.question = dto.question.trim();
    }
    if (dto.answer !== undefined) {
      this.validateAnswer(dto.answer);
      faq.answer = dto.answer.trim();
    }
    if (dto.tags     !== undefined) faq.tags     = dto.tags;
    if (dto.priority !== undefined) faq.priority = dto.priority;
    if (dto.isActive !== undefined) faq.isActive = dto.isActive;

    const saved = await this.faqRepo.save(faq);
    this.invalidateCache();

    this.logger.log(`FAQ actualizada: id=${id}`);
    return this.toDto(saved);
  }

  async remove(id: string): Promise<void> {
    const faq = await this.faqRepo.findOne({ where: { id } });
    if (!faq) throw new NotFoundException(`FAQ ${id} no encontrada`);

    await this.faqRepo.remove(faq);
    this.invalidateCache();

    this.logger.log(`FAQ eliminada: id=${id}`);
  }

  /**
   * Incrementa el contador de matches de una FAQ.
   * Llamado por FaqMatcherService cada vez que una FAQ es usada.
   * Non-blocking: los errores se loggean pero no bloquean la respuesta.
   */
  async incrementMatchCount(id: string): Promise<void> {
    await this.faqRepo
      .createQueryBuilder()
      .update(Faq)
      .set({ matchCount: () => 'match_count + 1' })
      .where('id = :id', { id })
      .execute()
      .catch((err) =>
        this.logger.warn(`No se pudo incrementar matchCount de FAQ ${id}: ${err.message}`),
      );
  }

  // ─── Cache de FAQs activas (para FaqMatcherService) ──────────────────────

  /**
   * Retorna las FAQs activas desde el cache en memoria.
   * Si el cache es inválido o expiró, lo recarga desde la BD.
   *
   * Usado por FaqMatcherService — O(1) la mayoría de las veces.
   */
  async getActiveFaqs(): Promise<Faq[]> {
    if (this.isCacheValid()) {
      return this.activeFaqsCache;
    }

    await this.refreshCache();
    return this.activeFaqsCache;
  }

  // ─── Métodos privados ─────────────────────────────────────────────────────

  private isCacheValid(): boolean {
    return this.cacheValid && (Date.now() - this.cacheLoadedAt) < CACHE_TTL_MS;
  }

  private async refreshCache(): Promise<void> {
    try {
      this.activeFaqsCache = await this.faqRepo.find({
        where:  { isActive: true },
        order:  { priority: 'DESC', createdAt: 'DESC' },
      });
      this.cacheLoadedAt = Date.now();
      this.cacheValid    = true;

      this.logger.debug(
        `Cache de FAQs refrescado: ${this.activeFaqsCache.length} FAQs activas`,
      );
    } catch (err) {
      this.logger.error(`Error refrescando cache de FAQs: ${err.message}`);
      // Mantener el cache anterior si existe (degradación controlada)
    }
  }

  private invalidateCache(): void {
    this.cacheValid = false;
    this.logger.debug('Cache de FAQs invalidado');
  }

  private validateQuestion(question: string): void {
    if (!question?.trim()) {
      throw new BadRequestException('La pregunta no puede estar vacía');
    }
    if (question.trim().length < 5) {
      throw new BadRequestException('La pregunta debe tener al menos 5 caracteres');
    }
    if (question.trim().length > 500) {
      throw new BadRequestException('La pregunta no puede superar 500 caracteres');
    }
  }

  private validateAnswer(answer: string): void {
    if (!answer?.trim()) {
      throw new BadRequestException('La respuesta no puede estar vacía');
    }
    if (answer.trim().length < 10) {
      throw new BadRequestException('La respuesta debe tener al menos 10 caracteres');
    }
  }

  private toDto(faq: Faq): FaqResponseDto {
    return {
      id:         faq.id,
      question:   faq.question,
      answer:     faq.answer,
      tags:       faq.tags ?? [],
      priority:   faq.priority,
      isActive:   faq.isActive,
      matchCount: faq.matchCount,
      createdAt:  faq.createdAt,
      updatedAt:  faq.updatedAt,
    };
  }
}
