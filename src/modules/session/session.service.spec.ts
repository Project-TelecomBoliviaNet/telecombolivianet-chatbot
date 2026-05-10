import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SessionService, SessionData } from './session.service';

// ══════════════════════════════════════════════════════════════
// TESTS UNITARIOS — SessionService
// Redis está completamente mockeado — no requiere conexión real.
// ══════════════════════════════════════════════════════════════

// ─── Mock de ioredis ──────────────────────────────────────────
const store = new Map<string, string>();

// Implementaciones independientes — se re-aplican en beforeEach para que
// jest.clearAllMocks() (que en Jest ≥30 también resetea implementaciones) no
// deje los mocks sin lógica entre tests.
function applyStoreImpl() {
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
  redisMock.eval.mockImplementation(
    (script: string, _numKeys: number, key: string, ...args: string[]) => {
      // LUA_ACQUIRE — SET NX PX
      if (script.includes('NX')) {
        if (store.has(key)) return Promise.resolve(null);
        store.set(key, args[0]);
        return Promise.resolve('OK');
      }
      // LUA_PATCH — atomic merge (identified by cjson usage)
      if (script.includes('cjson')) {
        const raw  = store.get(key) ?? args[1]; // args[1] = defaultJson
        const sess = JSON.parse(raw);
        const patch = JSON.parse(args[0]);       // args[0] = patchJson
        Object.assign(sess, patch);
        store.set(key, JSON.stringify(sess));
        return Promise.resolve('OK');
      }
      // LUA_RELEASE — DEL if token matches
      if (store.get(key) === args[0]) {
        store.delete(key);
        return Promise.resolve(1);
      }
      return Promise.resolve(0);
    });
  redisMock.keys.mockImplementation(() => Promise.resolve([]));
  redisMock.ttl.mockImplementation(() => Promise.resolve(1800));
}

const redisMock = {
  get:        jest.fn(),
  setex:      jest.fn(),
  del:        jest.fn(),
  eval:       jest.fn(),
  keys:       jest.fn(),
  ttl:        jest.fn(),
  on:         jest.fn(),
  disconnect: jest.fn(),
};

// Aplica las implementaciones una vez al cargar el módulo
applyStoreImpl();

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => redisMock),
}));

// ─── Mock de ConfigService ───────────────────────────────────
const CONFIG_MAP: Record<string, unknown> = {
  'redis.host':     'localhost',
  'redis.port':     6379,
  'redis.password': undefined,
  'redis.db':       0,
  'redis.sessionTtl': 86400,
  'rag.contextMessages': 5,
};

const configMock = {
  get: jest.fn((key: string) => CONFIG_MAP[key]),
};

describe('SessionService', () => {
  let service: SessionService;
  const PHONE = '59170000001';

  beforeEach(async () => {
    store.clear();
    jest.clearAllMocks();
    // Re-aplica implementaciones porque clearAllMocks las borra en Jest ≥30
    applyStoreImpl();
    configMock.get.mockImplementation((key: string) => CONFIG_MAP[key]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SessionService,
        { provide: ConfigService, useValue: configMock },
      ],
    }).compile();

    service = module.get<SessionService>(SessionService);
    // Inicializa Redis manualmente (igual que hace NestJS en onModuleInit)
    service.onModuleInit();
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  // ─── getSession() ──────────────────────────────────────────

  describe('getSession()', () => {
    it('retorna sesión por defecto para un número nuevo', async () => {
      const session = await service.getSession(PHONE);
      expect(session.phoneNumber).toBe(PHONE);
      expect(session.clientId).toBeNull();
      expect(session.isEscalated).toBe(false);
      expect(session.messages).toEqual([]);
    });

    it('retorna la sesión guardada correctamente', async () => {
      await service.updateSession(PHONE, { clientName: 'Virginia López' });
      const session = await service.getSession(PHONE);
      expect(session.clientName).toBe('Virginia López');
    });
  });

  // ─── saveSession() / updateSession() ──────────────────────

  describe('saveSession() / updateSession()', () => {
    it('persiste campos parciales sin perder el resto', async () => {
      await service.updateSession(PHONE, { clientId: 'C001', clientName: 'Ana' });
      await service.updateSession(PHONE, { planName: 'Plan Oro' });

      const session = await service.getSession(PHONE);
      expect(session.clientId).toBe('C001');
      expect(session.clientName).toBe('Ana');
      expect(session.planName).toBe('Plan Oro');
    });

    it('llama a setex con el TTL correcto', async () => {
      await service.saveSession({ phoneNumber: PHONE, clientId: null, clientName: null, clientStatus: null, planId: null, planName: null, totalDebt: 0, tbnCode: null, activeTicketId: null, activeInstallationId: null, pendingAction: null, pendingTechIssue: null, isEscalated: false, ragFailCount: 0, ragLastFailAt: 0, lastSentiment: 'neutral', angryCount: 0, ratingSent: false, lastLocation: null, pendingImageId: null, pendingImageCaption: null, messages: [] });
      expect(redisMock.setex).toHaveBeenCalledWith(
        `session:${PHONE}`,
        86400,
        expect.any(String),
      );
    });
  });

  // ─── addMessage() ──────────────────────────────────────────

  describe('addMessage()', () => {
    it('agrega mensajes correctamente', async () => {
      await service.addMessage(PHONE, 'user', 'Hola');
      await service.addMessage(PHONE, 'bot', 'Buenas, ¿en qué te ayudo?');

      const session = await service.getSession(PHONE);
      expect(session.messages).toHaveLength(2);
      expect(session.messages[0].role).toBe('user');
      expect(session.messages[1].role).toBe('bot');
    });

    it('recorta al límite MAX_MESSAGES (5)', async () => {
      for (let i = 0; i < 7; i++) {
        await service.addMessage(PHONE, 'user', `Mensaje ${i}`);
      }
      const session = await service.getSession(PHONE);
      expect(session.messages).toHaveLength(5);
      expect(session.messages[0].content).toBe('Mensaje 2');
    });

    it('incluye timestamp en cada mensaje', async () => {
      const before = Date.now();
      await service.addMessage(PHONE, 'user', 'test');
      const after = Date.now();

      const session = await service.getSession(PHONE);
      // Usa el último mensaje (el que acabamos de añadir) para evitar
      // depender de cuántos mensajes previos haya en el store.
      const msg = session.messages[session.messages.length - 1];
      expect(msg.content).toBe('test');
      expect(msg.timestamp).toBeGreaterThanOrEqual(before);
      expect(msg.timestamp).toBeLessThanOrEqual(after);
    });
  });

  // ─── setClientData() ───────────────────────────────────────

  describe('setClientData()', () => {
    it('guarda todos los campos del cliente', async () => {
      await service.setClientData(PHONE, {
        clientId: 'C123',
        clientName: 'Roberto Mamani',
        clientStatus: 'Activo',
        planId: 'PLAN001',
        planName: 'Plan Plata',
        totalDebt: 150.0,
        tbnCode: 'TBN001',
      });

      const session = await service.getSession(PHONE);
      expect(session.clientId).toBe('C123');
      expect(session.clientName).toBe('Roberto Mamani');
      expect(session.clientStatus).toBe('Activo');
      expect(session.planName).toBe('Plan Plata');
      expect(session.totalDebt).toBe(150.0);
      expect(session.tbnCode).toBe('TBN001');
    });
  });

  // ─── escalate() / deescalate() ────────────────────────────

  describe('escalate() / deescalate()', () => {
    it('marca la sesión como escalada', async () => {
      await service.escalate(PHONE);
      const session = await service.getSession(PHONE);
      expect(session.isEscalated).toBe(true);
    });

    it('devuelve el control al bot y resetea ragFailCount', async () => {
      await service.escalate(PHONE);
      await service.updateSession(PHONE, { ragFailCount: 3 });

      await service.deescalate(PHONE);

      const session = await service.getSession(PHONE);
      expect(session.isEscalated).toBe(false);
      expect(session.ragFailCount).toBe(0);
    });
  });

  // ─── incrementRagFail() / resetRagFail() ──────────────────

  describe('incrementRagFail() / resetRagFail()', () => {
    it('incrementa el contador en cada llamada', async () => {
      const count1 = await service.incrementRagFail(PHONE);
      const count2 = await service.incrementRagFail(PHONE);
      expect(count1).toBe(1);
      expect(count2).toBe(2);
    });

    it('resetea el contador a cero', async () => {
      await service.incrementRagFail(PHONE);
      await service.incrementRagFail(PHONE);
      await service.resetRagFail(PHONE);

      const session = await service.getSession(PHONE);
      expect(session.ragFailCount).toBe(0);
    });
  });

  // ─── setPendingAction() ────────────────────────────────────

  describe('setPendingAction()', () => {
    it('guarda y limpia la acción pendiente', async () => {
      await service.setPendingAction(PHONE, 'AWAITING_SLOT_SELECTION');
      let session = await service.getSession(PHONE);
      expect(session.pendingAction).toBe('AWAITING_SLOT_SELECTION');

      await service.setPendingAction(PHONE, null);
      session = await service.getSession(PHONE);
      expect(session.pendingAction).toBeNull();
    });
  });

  // ─── getContextText() ──────────────────────────────────────

  describe('getContextText()', () => {
    it('formatea el historial en texto legible', async () => {
      await service.addMessage(PHONE, 'user', 'Cuánto debo?');
      await service.addMessage(PHONE, 'bot', 'Tienes 150 Bs pendientes.');

      const text = await service.getContextText(PHONE);
      expect(text).toContain('Cliente: Cuánto debo?');
      expect(text).toContain('Bot: Tienes 150 Bs pendientes.');
    });

    it('retorna string vacío si no hay mensajes', async () => {
      const FRESH = '59170000003'; // phone único — nunca usado en otros tests
      const text = await service.getContextText(FRESH);
      expect(text).toBe('');
    });
  });

  // ─── deleteSession() ───────────────────────────────────────

  describe('deleteSession()', () => {
    it('elimina la sesión de Redis', async () => {
      await service.updateSession(PHONE, { clientName: 'Test' });
      await service.deleteSession(PHONE);

      expect(redisMock.del).toHaveBeenCalledWith(`session:${PHONE}`);

      // Después de eliminar retorna sesión vacía
      const session = await service.getSession(PHONE);
      expect(session.clientId).toBeNull();
    });
  });

  // ─── patchSession() — FIX-09 ──────────────────────────────

  describe('patchSession() — atomic Lua patch (FIX-09)', () => {
    it('crea sesión con defaults si no existe y aplica el patch', async () => {
      await service.patchSession(PHONE, { clientId: 'C-NEW' });
      const session = await service.getSession(PHONE);
      expect(session.clientId).toBe('C-NEW');
      expect(session.isEscalated).toBe(false); // default preservado
    });

    it('fusiona campos parciales sin borrar los existentes', async () => {
      await service.updateSession(PHONE, { clientId: 'C001', clientName: 'Ana' });
      await service.patchSession(PHONE, { planName: 'Plan Oro' });
      const session = await service.getSession(PHONE);
      expect(session.clientId).toBe('C001');   // campo previo preservado
      expect(session.clientName).toBe('Ana');  // campo previo preservado
      expect(session.planName).toBe('Plan Oro'); // campo nuevo aplicado
    });

    it('sobrescribe solo los campos del patch', async () => {
      await service.updateSession(PHONE, { clientId: 'C001', ragFailCount: 3 });
      await service.patchSession(PHONE, { ragFailCount: 0 });
      const session = await service.getSession(PHONE);
      expect(session.ragFailCount).toBe(0);
      expect(session.clientId).toBe('C001');   // no afectado
    });

    it('no usa distributed lock (sin eval NX)', async () => {
      jest.clearAllMocks();
      applyStoreImpl();
      await service.patchSession(PHONE, { isEscalated: true });
      const evalCalls = redisMock.eval.mock.calls as string[][];
      const hasLockAcquire = evalCalls.some(([script]) => script.includes('NX'));
      expect(hasLockAcquire).toBe(false);
    });

    it('patchSession múltiple sobre la misma sesión acumula todos los cambios', async () => {
      await service.patchSession(PHONE, { clientId: 'C001' });
      await service.patchSession(PHONE, { clientName: 'Roberto' });
      await service.patchSession(PHONE, { totalDebt: 250 });
      const session = await service.getSession(PHONE);
      expect(session.clientId).toBe('C001');
      expect(session.clientName).toBe('Roberto');
      expect(session.totalDebt).toBe(250);
    });
  });

  // ─── withLock() — FIX-03 ──────────────────────────────────

  describe('withLock() — distributed lock (FIX-03)', () => {
    it('adquiere lock (eval NX) y lo libera al terminar', async () => {
      const lockKey = `session:lock:${PHONE}`;
      let wasLocked = false;

      await service.withLock(PHONE, async () => {
        // Mientras fn ejecuta, el lock key debe estar en el store
        wasLocked = store.has(lockKey);
        return 'done';
      });

      expect(wasLocked).toBe(true);
      expect(store.has(lockKey)).toBe(false);
    });

    it('libera el lock incluso si fn lanza excepción', async () => {
      const lockKey = `session:lock:${PHONE}`;

      await expect(
        service.withLock(PHONE, async () => { throw new Error('test error'); }),
      ).rejects.toThrow('test error');

      expect(store.has(lockKey)).toBe(false);
    });

    it('retorna el valor de fn', async () => {
      const result = await service.withLock(PHONE, async () => 42);
      expect(result).toBe(42);
    });

    it('usa eval para acquire y release (Lua scripts)', async () => {
      await service.withLock(PHONE, async () => 'ok');
      // eval debe haberse llamado dos veces: acquire + release
      expect(redisMock.eval).toHaveBeenCalledTimes(2);
      // Primera llamada incluye 'NX' (acquire)
      const [acquireScript] = (redisMock.eval.mock.calls[0] as string[]);
      expect(acquireScript).toContain('NX');
    });
  });
});
