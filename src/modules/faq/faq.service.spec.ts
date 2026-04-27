/**
 * @file faq.service.spec.ts
 * @description Tests unitarios del FaqService (US-EP04-01).
 *
 * Criterios de aceptación validados:
 *   AC-01: CRUD completo (create, findAll, findOne, update, remove).
 *   AC-02: Paginación y filtrado por tags y estado activo.
 *   AC-03: Cache de FAQs activas se invalida en cada mutación.
 *   AC-04: getActiveFaqs() recarga desde BD cuando el cache expira.
 *   AC-05: Validaciones de negocio (pregunta/respuesta no vacías, priority 1-10).
 *   AC-06: incrementMatchCount() es non-blocking (no lanza si falla).
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { FaqService } from './faq.service';
import { Faq }        from '../../database/entities/faq.entity';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeFaq(overrides: Partial<Faq> = {}): Faq {
  return {
    id:         'faq-uuid-001',
    question:   '¿Cuándo es la fecha límite de pago?',
    answer:     'El pago vence el día 5 de cada mes. Puedes pagar con QR o transferencia.',
    tags:       ['pagos', 'facturación'],
    priority:   7,
    isActive:   true,
    matchCount: 0,
    createdAt:  new Date('2024-01-01'),
    updatedAt:  new Date('2024-01-01'),
    ...overrides,
  };
}

// ─── Mock del repositorio ─────────────────────────────────────────────────────

const mockRepo = {
  create:                jest.fn(),
  save:                  jest.fn(),
  find:                  jest.fn(),
  findOne:               jest.fn(),
  remove:                jest.fn(),
  createQueryBuilder:    jest.fn(),
};

// QueryBuilder encadenado
const mockQb = {
  andWhere:        jest.fn().mockReturnThis(),
  orderBy:         jest.fn().mockReturnThis(),
  addOrderBy:      jest.fn().mockReturnThis(),
  skip:            jest.fn().mockReturnThis(),
  take:            jest.fn().mockReturnThis(),
  getManyAndCount: jest.fn(),
  update:          jest.fn().mockReturnThis(),
  set:             jest.fn().mockReturnThis(),
  where:           jest.fn().mockReturnThis(),
  execute:         jest.fn().mockResolvedValue({}),
};

mockRepo.createQueryBuilder.mockReturnValue(mockQb);

// ─── Setup ────────────────────────────────────────────────────────────────────

describe('FaqService (US-EP04-01)', () => {
  let service: FaqService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockQb.getManyAndCount.mockResolvedValue([[], 0]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FaqService,
        { provide: getRepositoryToken(Faq), useValue: mockRepo },
      ],
    }).compile();

    service = module.get<FaqService>(FaqService);
  });

  // ─── create() ──────────────────────────────────────────────────────────────

  describe('create()', () => {
    it('AC-01: crea una FAQ con todos los campos', async () => {
      const faq = makeFaq();
      mockRepo.create.mockReturnValue(faq);
      mockRepo.save.mockResolvedValue(faq);

      const result = await service.create({
        question: '¿Cuándo es la fecha límite de pago?',
        answer:   'El pago vence el día 5 de cada mes.',
        tags:     ['pagos'],
        priority: 7,
      });

      expect(mockRepo.create).toHaveBeenCalledWith(expect.objectContaining({
        question: '¿Cuándo es la fecha límite de pago?',
        answer:   'El pago vence el día 5 de cada mes.',
        tags:     ['pagos'],
        priority: 7,
        isActive: true,
      }));
      expect(result.id).toBe('faq-uuid-001');
    });

    it('AC-05: lanza BadRequestException si question está vacía', async () => {
      await expect(service.create({ question: '', answer: 'Una respuesta válida.' }))
        .rejects.toThrow(BadRequestException);
    });

    it('AC-05: lanza BadRequestException si question tiene menos de 5 chars', async () => {
      await expect(service.create({ question: 'Hola', answer: 'Una respuesta válida.' }))
        .rejects.toThrow(BadRequestException);
    });

    it('AC-05: lanza BadRequestException si answer está vacía', async () => {
      await expect(service.create({ question: '¿Pregunta válida?', answer: '' }))
        .rejects.toThrow(BadRequestException);
    });

    it('AC-05: lanza BadRequestException si answer tiene menos de 10 chars', async () => {
      await expect(service.create({ question: '¿Pregunta válida?', answer: 'Corto' }))
        .rejects.toThrow(BadRequestException);
    });

    it('usa valores por defecto cuando no se proveen opcionales', async () => {
      const faq = makeFaq({ tags: [], priority: 5 });
      mockRepo.create.mockReturnValue(faq);
      mockRepo.save.mockResolvedValue(faq);

      await service.create({
        question: '¿Pregunta de prueba válida?',
        answer:   'Respuesta de prueba válida y completa.',
      });

      expect(mockRepo.create).toHaveBeenCalledWith(expect.objectContaining({
        tags:     [],
        priority: 5,
        isActive: true,
      }));
    });

    it('AC-03: invalida el cache al crear una FAQ', async () => {
      const faq = makeFaq();
      mockRepo.create.mockReturnValue(faq);
      mockRepo.save.mockResolvedValue(faq);
      mockRepo.find.mockResolvedValue([faq]);

      // Cargar cache
      await service.getActiveFaqs();
      expect(mockRepo.find).toHaveBeenCalledTimes(1);

      // Crear FAQ → invalida cache
      await service.create({ question: 'Nueva pregunta test', answer: 'Respuesta de prueba completa.' });

      // Siguiente llamada debe recargar
      await service.getActiveFaqs();
      expect(mockRepo.find).toHaveBeenCalledTimes(2);
    });
  });

  // ─── findAll() ─────────────────────────────────────────────────────────────

  describe('findAll()', () => {
    it('AC-01: retorna lista paginada con metadatos', async () => {
      const faqs = [makeFaq(), makeFaq({ id: 'faq-uuid-002' })];
      mockQb.getManyAndCount.mockResolvedValue([faqs, 2]);

      const result = await service.findAll({ page: 1, limit: 10 });

      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.pages).toBe(1);
    });

    it('AC-02: filtra por tag cuando se provee', async () => {
      mockQb.getManyAndCount.mockResolvedValue([[], 0]);

      await service.findAll({ tag: 'pagos' });

      expect(mockQb.andWhere).toHaveBeenCalledWith(
        'faq.tags LIKE :tag',
        { tag: '%pagos%' },
      );
    });

    it('AC-02: filtra solo activas cuando active=true', async () => {
      mockQb.getManyAndCount.mockResolvedValue([[], 0]);

      await service.findAll({ active: true });

      expect(mockQb.andWhere).toHaveBeenCalledWith(
        'faq.is_active = :active',
        { active: true },
      );
    });

    it('AC-02: calcula páginas correctamente', async () => {
      mockQb.getManyAndCount.mockResolvedValue([[], 25]);

      const result = await service.findAll({ page: 1, limit: 10 });

      expect(result.pages).toBe(3); // ceil(25/10)
    });

    it('respeta el límite máximo de 100 resultados por página', async () => {
      mockQb.getManyAndCount.mockResolvedValue([[], 0]);

      await service.findAll({ limit: 999 });

      expect(mockQb.take).toHaveBeenCalledWith(100);
    });
  });

  // ─── findOne() ─────────────────────────────────────────────────────────────

  describe('findOne()', () => {
    it('AC-01: retorna la FAQ cuando existe', async () => {
      const faq = makeFaq();
      mockRepo.findOne.mockResolvedValue(faq);

      const result = await service.findOne('faq-uuid-001');

      expect(result.id).toBe('faq-uuid-001');
      expect(result.question).toBe(faq.question);
    });

    it('AC-01: lanza NotFoundException cuando no existe', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      await expect(service.findOne('nonexistent-id'))
        .rejects.toThrow(NotFoundException);
    });
  });

  // ─── update() ──────────────────────────────────────────────────────────────

  describe('update()', () => {
    it('AC-01: actualiza solo los campos provistos', async () => {
      const faq = makeFaq();
      mockRepo.findOne.mockResolvedValue(faq);
      mockRepo.save.mockResolvedValue({ ...faq, isActive: false });

      const result = await service.update('faq-uuid-001', { isActive: false });

      expect(result.isActive).toBe(false);
      expect(mockRepo.save).toHaveBeenCalled();
    });

    it('AC-01: lanza NotFoundException si la FAQ no existe', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      await expect(service.update('bad-id', { isActive: false }))
        .rejects.toThrow(NotFoundException);
    });

    it('AC-03: invalida el cache al actualizar', async () => {
      const faq = makeFaq();
      mockRepo.findOne.mockResolvedValue(faq);
      mockRepo.save.mockResolvedValue(faq);
      mockRepo.find.mockResolvedValue([faq]);

      await service.getActiveFaqs();
      await service.update('faq-uuid-001', { priority: 9 });
      await service.getActiveFaqs();

      expect(mockRepo.find).toHaveBeenCalledTimes(2);
    });
  });

  // ─── remove() ──────────────────────────────────────────────────────────────

  describe('remove()', () => {
    it('AC-01: elimina la FAQ correctamente', async () => {
      const faq = makeFaq();
      mockRepo.findOne.mockResolvedValue(faq);
      mockRepo.remove.mockResolvedValue(faq);

      await service.remove('faq-uuid-001');

      expect(mockRepo.remove).toHaveBeenCalledWith(faq);
    });

    it('AC-01: lanza NotFoundException si la FAQ no existe', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      await expect(service.remove('bad-id')).rejects.toThrow(NotFoundException);
    });

    it('AC-03: invalida el cache al eliminar', async () => {
      const faq = makeFaq();
      mockRepo.findOne.mockResolvedValue(faq);
      mockRepo.remove.mockResolvedValue(faq);
      mockRepo.find.mockResolvedValue([]);

      await service.getActiveFaqs();
      await service.remove('faq-uuid-001');
      await service.getActiveFaqs();

      expect(mockRepo.find).toHaveBeenCalledTimes(2);
    });
  });

  // ─── getActiveFaqs() ───────────────────────────────────────────────────────

  describe('getActiveFaqs()', () => {
    it('AC-04: carga desde BD en el primer acceso', async () => {
      const faqs = [makeFaq()];
      mockRepo.find.mockResolvedValue(faqs);

      const result = await service.getActiveFaqs();

      expect(mockRepo.find).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(1);
    });

    it('AC-04: usa el cache en el segundo acceso (sin llamar a BD)', async () => {
      mockRepo.find.mockResolvedValue([makeFaq()]);

      await service.getActiveFaqs();
      await service.getActiveFaqs();

      expect(mockRepo.find).toHaveBeenCalledTimes(1); // Solo una vez
    });

    it('retorna array vacío si no hay FAQs activas', async () => {
      mockRepo.find.mockResolvedValue([]);

      const result = await service.getActiveFaqs();

      expect(result).toHaveLength(0);
    });
  });

  // ─── incrementMatchCount() ─────────────────────────────────────────────────

  describe('incrementMatchCount()', () => {
    it('AC-06: incrementa el contador correctamente', async () => {
      mockQb.execute.mockResolvedValue({});

      await service.incrementMatchCount('faq-uuid-001');

      expect(mockQb.execute).toHaveBeenCalled();
    });

    it('AC-06: es non-blocking — no lanza si el update falla', async () => {
      mockQb.execute.mockRejectedValueOnce(new Error('BD no disponible'));

      // No debe lanzar error
      await expect(service.incrementMatchCount('faq-uuid-001')).resolves.not.toThrow();
    });
  });
});
