// ══════════════════════════════════════════════════════════════
// TEST AISLADO — SessionService.getContextText() sesión vacía
//
// Este test DEBE estar en su propio archivo. La razón:
// jest.mock('ioredis') crea un singleton de módulo dentro de
// cada worker de Jest. Cuando múltiples tests en el MISMO archivo
// comparten el mismo store de ioredis (incluso con instancias
// distintas), los datos de un test contaminan el siguiente.
//
// Al estar en un archivo separado, Jest lo ejecuta en un worker
// propio con un módulo registry limpio → aislamiento garantizado.
// ══════════════════════════════════════════════════════════════

jest.mock('ioredis', () => ({
  __esModule: true,
  default: class {
    private store = new Map<string, string>();
    on() { return this; }
    disconnect() {}
    get(k: string) { return Promise.resolve(this.store.get(k) ?? null); }
    setex(k: string, _: number, v: string) { this.store.set(k, v); return Promise.resolve('OK'); }
    del(k: string) { this.store.delete(k); return Promise.resolve(1); }
  },
}));

import { SessionService } from './session.service';
import { ConfigService } from '@nestjs/config';

const configMock = {
  get: jest.fn((key: string) => ({
    'redis.host': 'localhost', 'redis.port': 6379, 'redis.password': undefined,
    'redis.db': 0, 'redis.sessionTtl': 86400, 'rag.contextMessages': 5,
  }[key])),
};

test('getContextText() retorna string vacío para sesión sin mensajes', async () => {
  const svc = new SessionService(configMock as unknown as ConfigService);
  svc.onModuleInit();

  const text = await svc.getContextText('59170000001');
  expect(text).toBe('');

  svc.onModuleDestroy();
});
