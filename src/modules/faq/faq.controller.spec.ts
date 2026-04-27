/**
 * @file faq.controller.spec.ts
 * @description Tests del FaqController — endpoints REST de gestión de FAQs.
 *
 * Criterios de aceptación validados:
 *   AC-01: POST /admin/faq crea una FAQ y retorna 201.
 *   AC-02: GET  /admin/faq retorna lista paginada.
 *   AC-03: GET  /admin/faq/:id retorna detalle.
 *   AC-04: PATCH /admin/faq/:id actualiza parcialmente.
 *   AC-05: DELETE /admin/faq/:id elimina y retorna 204.
 *   AC-06: Todos los endpoints requieren autenticación Bearer.
 *   AC-07: Validaciones de body (question/answer requeridos, priority 1-10).
 */

import {
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { FaqController } from './faq.controller';
import { FaqService }    from './faq.service';
import {
  FaqResponseDto,
  FaqListResponseDto,
} from './faq.dto';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const VALID_TOKEN  = 'valid-static-token';
const AUTH_HEADER  = `Bearer ${VALID_TOKEN}`;

const mockFaqService = {
  create:  jest.fn(),
  findAll: jest.fn(),
  findOne: jest.fn(),
  update:  jest.fn(),
  remove:  jest.fn(),
};

const mockConfig = {
  get: jest.fn((key: string) =>
    key === 'sistema.botStaticToken' ? VALID_TOKEN : undefined,
  ),
};

// ─── DTO factories ────────────────────────────────────────────────────────────

function makeFaqDto(overrides: Partial<FaqResponseDto> = {}): FaqResponseDto {
  return {
    id:         'faq-uuid-001',
    question:   '¿Cuándo vence el pago?',
    answer:     'El pago vence el día 5 de cada mes.',
    tags:       ['pagos'],
    priority:   5,
    isActive:   true,
    matchCount: 0,
    createdAt:  new Date(),
    updatedAt:  new Date(),
    ...overrides,
  };
}

function makeListDto(items: FaqResponseDto[] = []): FaqListResponseDto {
  return { items, total: items.length, page: 1, limit: 20, pages: 1 };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

describe('FaqController (US-EP04-01)', () => {
  let controller: FaqController;

  beforeEach(() => {
    jest.clearAllMocks();

    // Instanciación directa — más simple y sin problemas de inyección del módulo
    controller = new FaqController(
      mockFaqService as unknown as FaqService,
      mockConfig as any,
    );
  });

  // ─── AC-06: autenticación ──────────────────────────────────────────────────

  describe('autenticación', () => {
    it('AC-06: POST sin token lanza UnauthorizedException', async () => {
      await expect(
        controller.create(undefined, { question: 'P', answer: 'R' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('AC-06: GET sin token lanza UnauthorizedException', async () => {
      await expect(controller.findAll(undefined)).rejects.toThrow(UnauthorizedException);
    });

    it('AC-06: token inválido lanza UnauthorizedException', async () => {
      await expect(
        controller.create('Bearer wrong-token', { question: 'P', answer: 'R' }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  // ─── POST /admin/faq ───────────────────────────────────────────────────────

  describe('POST /admin/faq', () => {
    it('AC-01: crea FAQ y retorna el DTO', async () => {
      const dto = makeFaqDto();
      mockFaqService.create.mockResolvedValue(dto);

      const result = await controller.create(AUTH_HEADER, {
        question: '¿Cuándo vence el pago?',
        answer:   'El pago vence el día 5 de cada mes.',
        tags:     ['pagos'],
        priority: 5,
      });

      expect(result.id).toBe('faq-uuid-001');
      expect(mockFaqService.create).toHaveBeenCalled();
    });

    it('AC-07: lanza BadRequestException si falta question', async () => {
      await expect(
        controller.create(AUTH_HEADER, { question: '', answer: 'Una respuesta válida.' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('AC-07: lanza BadRequestException si falta answer', async () => {
      await expect(
        controller.create(AUTH_HEADER, { question: '¿Pregunta válida?', answer: '' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('AC-07: lanza BadRequestException si priority está fuera de rango', async () => {
      await expect(
        controller.create(AUTH_HEADER, {
          question: '¿Pregunta válida?',
          answer:   'Respuesta válida completa.',
          priority: 11,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('AC-07: lanza BadRequestException si priority es 0', async () => {
      await expect(
        controller.create(AUTH_HEADER, {
          question: '¿Pregunta válida?',
          answer:   'Respuesta válida completa.',
          priority: 0,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── GET /admin/faq ────────────────────────────────────────────────────────

  describe('GET /admin/faq', () => {
    it('AC-02: retorna lista paginada', async () => {
      const list = makeListDto([makeFaqDto()]);
      mockFaqService.findAll.mockResolvedValue(list);

      const result = await controller.findAll(AUTH_HEADER);

      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(mockFaqService.findAll).toHaveBeenCalled();
    });

    it('AC-02: pasa parámetros de filtrado al servicio', async () => {
      mockFaqService.findAll.mockResolvedValue(makeListDto());

      await controller.findAll(AUTH_HEADER, 'pagos', 'true', '2', '5');

      expect(mockFaqService.findAll).toHaveBeenCalledWith({
        tag:    'pagos',
        active: true,
        page:   2,
        limit:  5,
      });
    });

    it('AC-02: active=false se pasa como booleano false', async () => {
      mockFaqService.findAll.mockResolvedValue(makeListDto());

      await controller.findAll(AUTH_HEADER, undefined, 'false');

      expect(mockFaqService.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ active: false }),
      );
    });

    it('AC-02: active sin valor se pasa como undefined', async () => {
      mockFaqService.findAll.mockResolvedValue(makeListDto());

      await controller.findAll(AUTH_HEADER, undefined, undefined);

      expect(mockFaqService.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ active: undefined }),
      );
    });
  });

  // ─── GET /admin/faq/:id ────────────────────────────────────────────────────

  describe('GET /admin/faq/:id', () => {
    it('AC-03: retorna el detalle de la FAQ', async () => {
      const dto = makeFaqDto();
      mockFaqService.findOne.mockResolvedValue(dto);

      const result = await controller.findOne(AUTH_HEADER, 'faq-uuid-001');

      expect(result.id).toBe('faq-uuid-001');
    });

    it('AC-03: propaga NotFoundException del servicio', async () => {
      mockFaqService.findOne.mockRejectedValue(new NotFoundException());

      await expect(
        controller.findOne(AUTH_HEADER, 'nonexistent-id'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── PATCH /admin/faq/:id ──────────────────────────────────────────────────

  describe('PATCH /admin/faq/:id', () => {
    it('AC-04: actualiza parcialmente la FAQ', async () => {
      const updated = makeFaqDto({ isActive: false });
      mockFaqService.update.mockResolvedValue(updated);

      const result = await controller.update(AUTH_HEADER, 'faq-uuid-001', { isActive: false });

      expect(result.isActive).toBe(false);
      expect(mockFaqService.update).toHaveBeenCalledWith('faq-uuid-001', { isActive: false });
    });
  });

  // ─── DELETE /admin/faq/:id ─────────────────────────────────────────────────

  describe('DELETE /admin/faq/:id', () => {
    it('AC-05: elimina la FAQ y no retorna contenido', async () => {
      mockFaqService.remove.mockResolvedValue(undefined);

      const result = await controller.remove(AUTH_HEADER, 'faq-uuid-001');

      expect(result).toBeUndefined();
      expect(mockFaqService.remove).toHaveBeenCalledWith('faq-uuid-001');
    });
  });
});
