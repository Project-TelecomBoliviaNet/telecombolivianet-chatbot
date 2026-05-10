import { AgentToolRegistry } from './agent-tool-registry.service';
import { AgentTool } from './agent-tool.interface';
import { SessionData } from '../../session/session.service';

// ══════════════════════════════════════════════════════════════════════════════
// FIX-22 — AgentToolRegistry (Command Pattern)
// Verifica: dispatch por nombre, validación de identificación centralizada,
// seguimiento de media enviada, getDeclarations() y herramienta desconocida.
// ══════════════════════════════════════════════════════════════════════════════

const makeSession = (overrides: Partial<SessionData> = {}): SessionData => ({
  phoneNumber:         '59170000001',
  clientId:            null,
  clientName:          null,
  clientStatus:        null,
  planId:              null,
  planName:            null,
  totalDebt:           0,
  tbnCode:             null,
  activeTicketId:      null,
  activeInstallationId: null,
  pendingAction:       null,
  pendingTechIssue:    null,
  isEscalated:         false,
  ragFailCount:        0,
  ragLastFailAt:       0,
  lastSentiment:       'neutral',
  angryCount:          0,
  ratingSent:          false,
  lastLocation:        null,
  pendingImageId:      null,
  pendingImageCaption: null,
  messages:            [],
  ...overrides,
});

// ── Helpers de stub ────────────────────────────────────────────────────────────

function makeTool(
  name: string,
  opts: { requiresId?: boolean; result?: unknown } = {},
): AgentTool {
  return {
    getName:                 () => name,
    requiresIdentification: () => opts.requiresId ?? false,
    getDeclaration:          () => ({ name, description: `stub ${name}` }),
    execute:                 jest.fn().mockResolvedValue(opts.result ?? { ok: true }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AgentToolRegistry', () => {
  // ── Construcción ─────────────────────────────────────────────────────────────

  it('registra todas las herramientas por nombre', () => {
    const t1 = makeTool('tool_a');
    const t2 = makeTool('tool_b');
    const registry = new AgentToolRegistry([t1, t2]);

    const decls = registry.getDeclarations();

    expect(decls).toHaveLength(2);
    expect(decls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'tool_a' }),
        expect.objectContaining({ name: 'tool_b' }),
      ]),
    );
  });

  it('getDeclarations retorna el mismo objeto que getDeclaration() del tool', () => {
    const tool = makeTool('my_tool');
    const registry = new AgentToolRegistry([tool]);

    expect(registry.getDeclarations()[0]).toEqual(tool.getDeclaration());
  });

  // ── Dispatch básico ────────────────────────────────────────────────────────────

  it('executor llama al tool correcto con los args dados', async () => {
    const tool = makeTool('get_debt', { result: { totalDebt: 150 } });
    const registry = new AgentToolRegistry([tool]);
    const { executor } = registry.buildExecutor(makeSession({ clientId: 'C-001' }));

    const result = await executor('get_debt', { foo: 'bar' });

    expect(tool.execute).toHaveBeenCalledWith({ foo: 'bar' }, expect.objectContaining({ clientId: 'C-001' }));
    expect(result).toEqual({ totalDebt: 150 });
  });

  it('executor lanza Error para herramienta desconocida', async () => {
    const registry = new AgentToolRegistry([makeTool('known_tool')]);
    const { executor } = registry.buildExecutor(makeSession());

    await expect(executor('ghost_tool', {})).rejects.toThrow('Herramienta desconocida: ghost_tool');
  });

  // ── Validación de identificación ────────────────────────────────────────────

  it('retorna error uniforme si el tool requiere ID y session.clientId es null', async () => {
    const tool = makeTool('secure_tool', { requiresId: true });
    const registry = new AgentToolRegistry([tool]);
    const { executor } = registry.buildExecutor(makeSession({ clientId: null }));

    const result = await executor('secure_tool', {});

    expect(result).toEqual({ error: expect.stringContaining('identif') });
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('ejecuta el tool si requiere ID y el cliente está identificado', async () => {
    const tool = makeTool('secure_tool', { requiresId: true, result: { data: 'ok' } });
    const registry = new AgentToolRegistry([tool]);
    const { executor } = registry.buildExecutor(makeSession({ clientId: 'C-123' }));

    const result = await executor('secure_tool', {});

    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ data: 'ok' });
  });

  it('ejecuta el tool sin ID si no lo requiere', async () => {
    const tool = makeTool('public_tool', { requiresId: false });
    const registry = new AgentToolRegistry([tool]);
    const { executor } = registry.buildExecutor(makeSession({ clientId: null }));

    await executor('public_tool', {});

    expect(tool.execute).toHaveBeenCalledTimes(1);
  });

  // ── Seguimiento de media ────────────────────────────────────────────────────

  it('getMediaSent acumula imágenes devueltas con _localUrl', async () => {
    const tool = makeTool('img_tool', { result: { _localUrl: '/uploads/img.jpg', ok: true } });
    const registry = new AgentToolRegistry([tool]);
    const { executor, getMediaSent } = registry.buildExecutor(makeSession({ clientId: 'C-001' }));

    await executor('img_tool', {});

    expect(getMediaSent()).toEqual([
      { localUrl: '/uploads/img.jpg', mediaType: 'image' },
    ]);
  });

  it('getMediaSent acumula múltiples imágenes de llamadas sucesivas', async () => {
    const tool = makeTool('img_tool', { result: { _localUrl: '/img/a.jpg' } });
    const registry = new AgentToolRegistry([tool]);
    const { executor, getMediaSent } = registry.buildExecutor(makeSession({ clientId: 'C-001' }));

    await executor('img_tool', {});
    await executor('img_tool', {});

    expect(getMediaSent()).toHaveLength(2);
  });

  it('getMediaSent está vacío cuando no hay _localUrl en la respuesta', async () => {
    const tool = makeTool('text_tool', { result: { message: 'sin imagen' } });
    const registry = new AgentToolRegistry([tool]);
    const { executor, getMediaSent } = registry.buildExecutor(makeSession({ clientId: 'C-001' }));

    await executor('text_tool', {});

    expect(getMediaSent()).toHaveLength(0);
  });

  // ── Aislamiento de estado entre executors ──────────────────────────────────

  it('cada llamada a buildExecutor crea un mediaSent independiente', async () => {
    const tool = makeTool('img_tool', { result: { _localUrl: '/img/x.jpg' } });
    const registry = new AgentToolRegistry([tool]);

    const { executor: ex1, getMediaSent: ms1 } = registry.buildExecutor(makeSession({ clientId: 'C-1' }));
    const { executor: _ex2, getMediaSent: ms2 } = registry.buildExecutor(makeSession({ clientId: 'C-2' }));

    await ex1('img_tool', {});

    expect(ms1()).toHaveLength(1);
    expect(ms2()).toHaveLength(0); // executor2 no usó ex1
  });
});
