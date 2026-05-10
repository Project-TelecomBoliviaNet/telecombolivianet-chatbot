import { ConfigService } from '@nestjs/config';
import { OutboxRepositoryService, OutboxEntry } from './outbox-repository.service';

// ══════════════════════════════════════════════════════════════
// TESTS UNITARIOS — OutboxRepositoryService
// Redis completamente mockeado — sin conexión real.
// ══════════════════════════════════════════════════════════════

const store = new Map<string, string>();

function applyImpl() {
  redisMock.get.mockImplementation((key: string) =>
    Promise.resolve(store.get(key) ?? null));
  redisMock.setex.mockImplementation((key: string, _ttl: number, value: string) => {
    store.set(key, value);
    return Promise.resolve('OK');
  });
  redisMock.del.mockImplementation((key: string) => {
    store.delete(key);
    return Promise.resolve(1);
  });
  redisMock.ttl.mockImplementation(() => Promise.resolve(1800));
  redisMock.keys.mockImplementation((pattern: string) => {
    const prefix = pattern.replace('*', '');
    const matches = [...store.keys()].filter(k => k.startsWith(prefix));
    return Promise.resolve(matches);
  });
  redisMock.on.mockImplementation(() => redisMock);
  redisMock.disconnect.mockImplementation(() => undefined);
}

const redisMock = {
  get:        jest.fn(),
  setex:      jest.fn(),
  del:        jest.fn(),
  ttl:        jest.fn(),
  keys:       jest.fn(),
  on:         jest.fn(),
  disconnect: jest.fn(),
};

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => redisMock),
}));

applyImpl();

function makeSvc(): OutboxRepositoryService {
  const config = {
    get: jest.fn((key: string) => {
      const cfg: Record<string, any> = {
        'redis.host': 'localhost', 'redis.port': 6379,
        'redis.password': '', 'redis.db': 0,
      };
      return cfg[key] ?? null;
    }),
  } as unknown as ConfigService;
  const svc = new OutboxRepositoryService(config);
  svc.onModuleInit();
  return svc;
}

describe('OutboxRepositoryService', () => {
  let svc: OutboxRepositoryService;

  beforeEach(() => {
    jest.clearAllMocks();
    store.clear();
    applyImpl();
    svc = makeSvc();
  });

  afterEach(() => svc.onModuleDestroy());

  it('OR-01 — push() guarda la entrada con attempts=0', async () => {
    await svc.push('591700000001', 'Hola mundo');
    const entry = await svc.get('591700000001');
    expect(entry).not.toBeNull();
    expect(entry!.text).toBe('Hola mundo');
    expect(entry!.attempts).toBe(0);
  });

  it('OR-02 — get() retorna null para número sin outbox', async () => {
    const entry = await svc.get('591799999999');
    expect(entry).toBeNull();
  });

  it('OR-03 — remove() borra la entrada del outbox', async () => {
    await svc.push('591700000001', 'mensaje');
    await svc.remove('591700000001');
    expect(await svc.get('591700000001')).toBeNull();
  });

  it('OR-04 — markAsProcessing() retorna true primera vez', async () => {
    await svc.push('591700000001', 'mensaje');
    const acquired = await svc.markAsProcessing('591700000001');
    expect(acquired).toBe(true);
  });

  it('OR-05 — markAsProcessing() retorna false si ya está en procesamiento (no stale)', async () => {
    await svc.push('591700000001', 'mensaje');
    await svc.markAsProcessing('591700000001');
    // Segunda llamada — processingAt está recién seteado (no stale)
    const second = await svc.markAsProcessing('591700000001');
    expect(second).toBe(false);
  });

  it('OR-06 — revertToPending() limpia el processingAt', async () => {
    await svc.push('591700000001', 'mensaje');
    await svc.markAsProcessing('591700000001');
    await svc.revertToPending('591700000001');
    const entry = await svc.get('591700000001');
    expect(entry!.processingAt).toBeUndefined();
  });

  it('OR-07 — incrementAttempts() incrementa el contador', async () => {
    await svc.push('591700000001', 'mensaje');
    await svc.incrementAttempts('591700000001');
    const entry = await svc.get('591700000001');
    expect(entry!.attempts).toBe(1);
  });

  it('OR-08 — getAllPhones() retorna los números con outbox pendiente', async () => {
    await svc.push('591700000001', 'a');
    await svc.push('591700000002', 'b');
    const phones = await svc.getAllPhones();
    expect(phones).toContain('591700000001');
    expect(phones).toContain('591700000002');
  });

  it('OR-09 — getAllPhones() retorna array vacío cuando no hay mensajes pendientes', async () => {
    const phones = await svc.getAllPhones();
    expect(phones).toHaveLength(0);
  });

  it('OR-10 — get() retorna null y limpia entrada corrupta', async () => {
    store.set('wa:outbox:591700000001', 'NOT_VALID_JSON{{{');
    const entry = await svc.get('591700000001');
    expect(entry).toBeNull();
    expect(store.has('wa:outbox:591700000001')).toBe(false);
  });
});
