/**
 * @file monitor-stats-categories.spec.ts
 * @description Tests del breakdown de categorías de escalado en GET /monitor/stats (US-EP06-02).
 *
 * Criterios de aceptación validados:
 *   AC-01: GET /monitor/stats incluye el campo escalatedByCategory en today.
 *   AC-02: El breakdown muestra conteos por categoría de escalado del día.
 *   AC-03: Si no hay escalados con categoría, escalatedByCategory es objeto vacío.
 *   AC-04: El campo today.escalated muestra el total de escalados del día.
 */

import { MonitorController } from './monitor.controller';
import { ConfigService }     from '@nestjs/config';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const VALID_TOKEN  = 'valid-token';
const AUTH_HEADER  = `Bearer ${VALID_TOKEN}`;

function buildController(rawCategories: Array<{ category: string; count: string }> = []) {
  const convRepo = {
    count: jest.fn()
      .mockResolvedValueOnce(150) // totalConversations
      .mockResolvedValueOnce(12), // escalatedCount

    createQueryBuilder: jest.fn(),
  };

  const msgRepo = {
    createQueryBuilder: jest.fn(),
  };

  // QueryBuilder para messages (todayMessages)
  const msgQb = {
    where: jest.fn().mockReturnThis(),
    getCount: jest.fn().mockResolvedValue(87),
  };
  msgRepo.createQueryBuilder.mockReturnValue(msgQb);

  // QueryBuilder para conversations — multiple calls
  let convQbCallCount = 0;
  const todayConvQb = {
    where:          jest.fn().mockReturnThis(),
    andWhere:       jest.fn().mockReturnThis(),
    select:         jest.fn().mockReturnThis(),
    addSelect:      jest.fn().mockReturnThis(),
    groupBy:        jest.fn().mockReturnThis(),
    getCount:       jest.fn().mockResolvedValue(23),
    getRawMany:     jest.fn().mockResolvedValue(rawCategories),
  };
  convRepo.createQueryBuilder.mockImplementation(() => {
    convQbCallCount++;
    return todayConvQb;
  });

  const config = {
    get: jest.fn((key: string) =>
      key === 'sistema.botStaticToken' ? VALID_TOKEN : undefined,
    ),
  };

  const session = {};

  const controller = new MonitorController(
    config as unknown as ConfigService,
    session as any,
    convRepo as any,
    msgRepo as any,
  );

  return { controller, convRepo, msgRepo, todayConvQb };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MonitorController — GET /monitor/stats con categorías EP-06', () => {

  it('AC-01: la respuesta incluye today.escalatedByCategory', async () => {
    const { controller } = buildController([
      { category: 'SOPORTE_TECNICO', count: '5' },
      { category: 'FACTURACION',     count: '3' },
    ]);

    const result = await controller.getStats(AUTH_HEADER);

    expect(result.today).toHaveProperty('escalatedByCategory');
    expect(typeof result.today.escalatedByCategory).toBe('object');
  });

  it('AC-02: el breakdown muestra conteos correctos por categoría', async () => {
    const { controller } = buildController([
      { category: 'SOPORTE_TECNICO', count: '5' },
      { category: 'FACTURACION',     count: '3' },
      { category: 'INSTALACION',     count: '1' },
    ]);

    const result = await controller.getStats(AUTH_HEADER);
    const breakdown = result.today.escalatedByCategory as Record<string, number>;

    expect(breakdown['SOPORTE_TECNICO']).toBe(5);
    expect(breakdown['FACTURACION']).toBe(3);
    expect(breakdown['INSTALACION']).toBe(1);
  });

  it('AC-03: escalatedByCategory es objeto vacío si no hay escalados con categoría', async () => {
    const { controller } = buildController([]);

    const result = await controller.getStats(AUTH_HEADER);
    const breakdown = result.today.escalatedByCategory as Record<string, number>;

    expect(Object.keys(breakdown)).toHaveLength(0);
  });

  it('AC-04: today.escalated muestra la suma total de escalados del día', async () => {
    const { controller } = buildController([
      { category: 'SOPORTE_TECNICO', count: '5' },
      { category: 'FACTURACION',     count: '3' },
    ]);

    const result = await controller.getStats(AUTH_HEADER);

    expect(result.today.escalated).toBe(8); // 5 + 3
  });

  it('today.escalated es 0 cuando no hay escalados del día', async () => {
    const { controller } = buildController([]);

    const result = await controller.getStats(AUTH_HEADER);

    expect(result.today.escalated).toBe(0);
  });

  it('los campos previos de stats siguen presentes (retrocompatibilidad)', async () => {
    const { controller } = buildController();

    const result = await controller.getStats(AUTH_HEADER);

    // Campos existentes no deben romperse
    expect(result.total).toHaveProperty('conversations');
    expect(result.total).toHaveProperty('escalated');
    expect(result.today).toHaveProperty('conversations');
    expect(result.today).toHaveProperty('messages');
    expect(result).toHaveProperty('generatedAt');
  });

  it('requiere autenticación Bearer', async () => {
    const { controller } = buildController();

    await expect(controller.getStats(undefined)).rejects.toThrow('Token inválido');
    await expect(controller.getStats('Bearer wrong')).rejects.toThrow('Token inválido');
  });
});
