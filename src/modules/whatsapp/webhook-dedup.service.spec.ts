import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WebhookDedupService } from './webhook-dedup.service';

// ─── Mock de ioredis ─────────────────────────────────────────
const store = new Map<string, string>();

const redisMock = {
  set:        jest.fn(),
  on:         jest.fn(),
  disconnect: jest.fn(),
};

function applyStoreImpl() {
  // ioredis: set(key, val, 'EX', ttl, 'NX')
  redisMock.set.mockImplementation(
    (key: string, _val: string, _exFlag: string, _ttl: number, nxFlag?: string) => {
      if (nxFlag === 'NX') {
        if (store.has(key)) return Promise.resolve(null); // ya existe → duplicado
        store.set(key, '1');
        return Promise.resolve('OK');
      }
      store.set(key, _val);
      return Promise.resolve('OK');
    },
  );
}

applyStoreImpl();

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => redisMock),
}));

const configMock = {
  get: jest.fn((key: string) => {
    const MAP: Record<string, unknown> = {
      'redis.host': 'localhost', 'redis.port': 6379,
      'redis.password': undefined, 'redis.db': 0,
    };
    return MAP[key];
  }),
};

// ─── Tests ───────────────────────────────────────────────────

describe('WebhookDedupService', () => {
  let service: WebhookDedupService;

  beforeEach(async () => {
    store.clear();
    jest.clearAllMocks();
    applyStoreImpl();
    configMock.get.mockImplementation((key: string) => {
      const MAP: Record<string, unknown> = {
        'redis.host': 'localhost', 'redis.port': 6379,
        'redis.password': undefined, 'redis.db': 0,
      };
      return MAP[key];
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookDedupService,
        { provide: ConfigService, useValue: configMock },
      ],
    }).compile();

    service = module.get<WebhookDedupService>(WebhookDedupService);
    service.onModuleInit();
  });

  afterEach(() => service.onModuleDestroy());

  it('retorna false para un messageId nuevo (no duplicado)', async () => {
    const result = await service.isDuplicate('wamid.unique-001');
    expect(result).toBe(false);
  });

  it('retorna true para un messageId ya procesado (duplicado)', async () => {
    await service.isDuplicate('wamid.dup-001'); // primera llamada marca como procesado
    const result = await service.isDuplicate('wamid.dup-001');
    expect(result).toBe(true);
  });

  it('distintos messageId no interfieren entre sí', async () => {
    const r1 = await service.isDuplicate('wamid.msg-A');
    const r2 = await service.isDuplicate('wamid.msg-B');
    expect(r1).toBe(false);
    expect(r2).toBe(false);
  });

  it('usa SET EX NX con el TTL de 300 segundos', async () => {
    await service.isDuplicate('wamid.ttl-test');
    expect(redisMock.set).toHaveBeenCalledWith(
      'webhook_dedup:wamid.ttl-test',
      '1', 'EX', 300, 'NX',
    );
  });
});
