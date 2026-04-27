// ══════════════════════════════════════════════════════════════
// TESTS UNITARIOS — SessionService
//
// Estrategia de mock sin jest.mock('ioredis'):
// - SessionService nunca llega a llamar new Redis() en tests
// - Usamos buildService() que crea el servicio e inyecta
//   directamente un Map-backed mock en (svc as any).redis
//   ANTES de que onModuleInit() se ejecute
// - Cada test tiene su propio Map aislado → cero contaminación
// ══════════════════════════════════════════════════════════════

// Stub mínimo de ioredis para que el import no falle
jest.mock('ioredis', () => ({
  __esModule: true,
  default: class RedisSub {
    on() { return this; }
    disconnect() {}
    get() { return Promise.resolve(null); }
    setex() { return Promise.resolve('OK'); }
    del() { return Promise.resolve(1); }
  },
}));

import { SessionService } from './session.service';
import { ConfigService } from '@nestjs/config';

const configMock = {
  get: jest.fn((key: string) => ({
    'redis.host':          'localhost',
    'redis.port':          6379,
    'redis.password':      undefined,
    'redis.db':            0,
    'redis.sessionTtl':    86400,
    'rag.contextMessages': 5,
  }[key])),
};

/** Construye un SessionService con un Redis completamente aislado */
function buildService() {
  // Crear el servicio — el constructor NO crea Redis
  const svc = new SessionService(configMock as unknown as ConfigService);

  // Inyectar un redis mock con store propio ANTES de onModuleInit
  // Así onModuleInit asigna this.redis = new Redis()... pero luego
  // lo sobreescribimos con el nuestro inmediatamente
  const store = new Map<string, string>();
  const redisMock = {
    get:        (k: string)                    => Promise.resolve(store.get(k) ?? null),
    setex:      (k: string, _t: number, v: string) => { store.set(k, v); return Promise.resolve('OK'); },
    del:        (k: string)                    => { store.delete(k); return Promise.resolve(1); },
    on:         () => redisMock,
    disconnect: () => {},
  };

  // Sobreescribir ANTES de onModuleInit para evitar que el stub
  // de ioredis cree una instancia con store compartido
  (svc as any).redis = redisMock;

  // onModuleInit intentará new Redis() y sobreescribirá this.redis —
  // pero como el stub de ioredis es una clase simple, la reemplazamos de nuevo:
  svc.onModuleInit();
  (svc as any).redis = redisMock; // restaurar el nuestro

  return svc;
}

const PHONE = '59170000001';

describe('SessionService', () => {

  describe('getSession()', () => {
    it('retorna sesión por defecto para número nuevo', async () => {
      const svc = buildService();
      const session = await svc.getSession(PHONE);
      expect(session.phoneNumber).toBe(PHONE);
      expect(session.clientId).toBeNull();
      expect(session.isEscalated).toBe(false);
      expect(session.messages).toEqual([]);
      expect(session.pendingTechIssue).toBeNull();
      svc.onModuleDestroy();
    });

    it('retorna la sesión guardada', async () => {
      const svc = buildService();
      await svc.updateSession(PHONE, { clientName: 'Virginia López' });
      expect((await svc.getSession(PHONE)).clientName).toBe('Virginia López');
      svc.onModuleDestroy();
    });
  });

  describe('updateSession()', () => {
    it('persiste campos parciales sin perder el resto', async () => {
      const svc = buildService();
      await svc.updateSession(PHONE, { clientId: 'C001', clientName: 'Ana' });
      await svc.updateSession(PHONE, { planName: 'Plan Oro' });

      const session = await svc.getSession(PHONE);
      expect(session.clientId).toBe('C001');
      expect(session.clientName).toBe('Ana');
      expect(session.planName).toBe('Plan Oro');
      svc.onModuleDestroy();
    });
  });

  describe('addMessage()', () => {
    it('agrega mensajes en orden correcto', async () => {
      const svc = buildService();
      await svc.addMessage(PHONE, 'user', 'Hola');
      await svc.addMessage(PHONE, 'bot', '¿En qué te ayudo?');

      const session = await svc.getSession(PHONE);
      expect(session.messages).toHaveLength(2);
      expect(session.messages[0].role).toBe('user');
      expect(session.messages[0].content).toBe('Hola');
      expect(session.messages[1].role).toBe('bot');
      svc.onModuleDestroy();
    });

    it('recorta al límite MAX_MESSAGES (5)', async () => {
      const svc = buildService();
      for (let i = 0; i < 7; i++) await svc.addMessage(PHONE, 'user', `Msg ${i}`);

      const session = await svc.getSession(PHONE);
      expect(session.messages).toHaveLength(5);
      expect(session.messages[0].content).toBe('Msg 2');
      svc.onModuleDestroy();
    });

    it('incluye timestamp numérico válido', async () => {
      const svc = buildService();
      await svc.addMessage(PHONE, 'user', 'test');
      const { timestamp } = (await svc.getSession(PHONE)).messages[0];
      expect(typeof timestamp).toBe('number');
      expect(timestamp).toBeGreaterThan(1_580_000_000_000);
      svc.onModuleDestroy();
    });
  });

  describe('setClientData()', () => {
    it('guarda todos los campos del cliente', async () => {
      const svc = buildService();
      await svc.setClientData(PHONE, {
        clientId: 'C123', clientName: 'Roberto Mamani', clientStatus: 'Activo',
        planName: 'Plan Plata', totalDebt: 150.0, tbnCode: 'TBN001',
      });
      const session = await svc.getSession(PHONE);
      expect(session.clientId).toBe('C123');
      expect(session.clientName).toBe('Roberto Mamani');
      expect(session.clientStatus).toBe('Activo');
      expect(session.totalDebt).toBe(150.0);
      expect(session.tbnCode).toBe('TBN001');
      svc.onModuleDestroy();
    });
  });

  describe('escalate() / deescalate()', () => {
    it('marca como escalada', async () => {
      const svc = buildService();
      await svc.escalate(PHONE);
      expect((await svc.getSession(PHONE)).isEscalated).toBe(true);
      svc.onModuleDestroy();
    });

    it('de-escala y resetea ragFailCount', async () => {
      const svc = buildService();
      await svc.escalate(PHONE);
      await svc.updateSession(PHONE, { ragFailCount: 3 });
      await svc.deescalate(PHONE);
      const session = await svc.getSession(PHONE);
      expect(session.isEscalated).toBe(false);
      expect(session.ragFailCount).toBe(0);
      svc.onModuleDestroy();
    });
  });

  describe('incrementRagFail() / resetRagFail()', () => {
    it('incrementa acumulativamente', async () => {
      const svc = buildService();
      expect(await svc.incrementRagFail(PHONE)).toBe(1);
      expect(await svc.incrementRagFail(PHONE)).toBe(2);
      svc.onModuleDestroy();
    });

    it('resetea a cero', async () => {
      const svc = buildService();
      await svc.incrementRagFail(PHONE);
      await svc.resetRagFail(PHONE);
      expect((await svc.getSession(PHONE)).ragFailCount).toBe(0);
      svc.onModuleDestroy();
    });
  });

  describe('setPendingAction()', () => {
    it('guarda y limpia la acción pendiente', async () => {
      const svc = buildService();
      const action = '{"type":"AWAITING_SLOT_SELECTION"}';
      await svc.setPendingAction(PHONE, action);
      expect((await svc.getSession(PHONE)).pendingAction).toBe(action);
      await svc.setPendingAction(PHONE, null);
      expect((await svc.getSession(PHONE)).pendingAction).toBeNull();
      svc.onModuleDestroy();
    });
  });

  describe('getContextText()', () => {
    it('formatea el historial correctamente', async () => {
      const svc = buildService();
      await svc.addMessage(PHONE, 'user', 'Cuánto debo?');
      await svc.addMessage(PHONE, 'bot', 'Tienes 150 Bs pendientes.');
      const text = await svc.getContextText(PHONE);
      expect(text).toContain('Cliente: Cuánto debo?');
      expect(text).toContain('Bot: Tienes 150 Bs pendientes.');
      svc.onModuleDestroy();
    });

    // NOTA: el test "retorna string vacío para sesión sin mensajes" está en
    // session.service.isolated.spec.ts — ver comentario en ese archivo.
  });

  describe('deleteSession()', () => {
    it('elimina la sesión y retorna default al consultar', async () => {
      const svc = buildService();
      await svc.updateSession(PHONE, { clientName: 'Test' });
      await svc.deleteSession(PHONE);
      expect((await svc.getSession(PHONE)).clientId).toBeNull();
      svc.onModuleDestroy();
    });
  });
});
