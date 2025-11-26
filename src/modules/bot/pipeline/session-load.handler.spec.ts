import { SessionLoadHandler } from './session-load.handler';
import { MessageContext } from './message-context';
import { SessionData } from '../../session/session.service';

// ══════════════════════════════════════════════════════════════════════════════
// FIX-21 — SessionLoadHandler
// ══════════════════════════════════════════════════════════════════════════════

const makeCtx = (overrides: Partial<MessageContext> = {}): MessageContext =>
  ({ phone: '59170000001', messageId: 'MSG-001', type: 'text', ...overrides } as MessageContext);

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

describe('SessionLoadHandler', () => {
  const sessionMock = { getSession: jest.fn() };
  let handler: SessionLoadHandler;

  beforeEach(() => {
    jest.resetAllMocks();
    handler = new SessionLoadHandler(sessionMock as any);
  });

  it('carga la sesión y la asigna a ctx.session', async () => {
    const session = makeSession({ clientId: 'C-123', clientName: 'Ana López' });
    sessionMock.getSession.mockResolvedValue(session);

    const ctx = makeCtx({ phone: '59171234567' });
    await handler.handle(ctx, jest.fn().mockResolvedValue(undefined));

    expect(sessionMock.getSession).toHaveBeenCalledWith('59171234567');
    expect(ctx.session).toBe(session);
  });

  it('llama a next() después de cargar la sesión', async () => {
    sessionMock.getSession.mockResolvedValue(makeSession());
    const next = jest.fn().mockResolvedValue(undefined);

    await handler.handle(makeCtx(), next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('asigna sesión vacía para un número nuevo', async () => {
    const emptySession = makeSession();
    sessionMock.getSession.mockResolvedValue(emptySession);

    const ctx = makeCtx();
    await handler.handle(ctx, jest.fn().mockResolvedValue(undefined));

    expect(ctx.session).toEqual(emptySession);
    expect(ctx.session!.clientId).toBeNull();
  });
});
