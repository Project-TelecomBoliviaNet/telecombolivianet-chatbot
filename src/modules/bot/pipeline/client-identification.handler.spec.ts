import { ClientIdentificationHandler } from './client-identification.handler';
import { MessageContext } from './message-context';
import { SessionData } from '../../session/session.service';

// ══════════════════════════════════════════════════════════════════════════════
// FIX-21 — ClientIdentificationHandler
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

const makeCtx = (overrides: Partial<MessageContext> = {}): MessageContext =>
  ({
    phone:     '59170000001',
    messageId: 'MSG-001',
    type:      'text',
    session:   makeSession(),
    ...overrides,
  } as MessageContext);

const CLIENT_DATA = {
  Id:         'C-123',
  FullName:   'Roberto Mamani',
  Status:     'Activo',
  PlanId:     'PLAN-1',
  PlanName:   'Plan Plata',
  TotalDebt:  150.0,
  TbnCode:    'TBN-0042',
};

describe('ClientIdentificationHandler', () => {
  const sessionMock    = {
    setClientData:  jest.fn(),
    updateSession:  jest.fn(),
    getSession:     jest.fn(),
  };
  const clientRepoMock = { getClientByPhone: jest.fn() };
  const convRepoMock   = { upsert: jest.fn() };
  let handler: ClientIdentificationHandler;

  beforeEach(() => {
    jest.resetAllMocks();
    sessionMock.setClientData.mockResolvedValue(undefined);
    sessionMock.updateSession.mockResolvedValue(undefined);
    sessionMock.getSession.mockResolvedValue(makeSession());
    convRepoMock.upsert.mockResolvedValue(undefined);
    handler = new ClientIdentificationHandler(
      sessionMock as any,
      clientRepoMock as any,
      convRepoMock as any,
    );
  });

  // ── Cliente ya identificado ─────────────────────────────────────────────────

  it('no consulta la API si el cliente ya está identificado en sesión', async () => {
    const session = makeSession({ clientId: 'C-123', clientName: 'Roberto Mamani' });
    const ctx     = makeCtx({ session });
    const next    = jest.fn().mockResolvedValue(undefined);

    await handler.handle(ctx, next);

    expect(clientRepoMock.getClientByPhone).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('no re-identifica si clientName es __prospect__', async () => {
    const session = makeSession({ clientId: null, clientName: '__prospect__' });
    const ctx     = makeCtx({ session });
    const next    = jest.fn().mockResolvedValue(undefined);

    await handler.handle(ctx, next);

    expect(clientRepoMock.getClientByPhone).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  // ── Identificación nueva ────────────────────────────────────────────────────

  it('identifica al cliente cuando la sesión es nueva', async () => {
    clientRepoMock.getClientByPhone.mockResolvedValue(CLIENT_DATA);
    const afterIdentify = makeSession({ clientId: 'C-123', clientName: 'Roberto Mamani' });
    sessionMock.getSession.mockResolvedValue(afterIdentify);

    const ctx  = makeCtx({ phone: '59178901234', session: makeSession() });
    const next = jest.fn().mockResolvedValue(undefined);

    await handler.handle(ctx, next);

    expect(clientRepoMock.getClientByPhone).toHaveBeenCalledWith('59178901234');
    expect(sessionMock.setClientData).toHaveBeenCalledWith('59178901234', {
      clientId:     'C-123',
      clientName:   'Roberto Mamani',
      clientStatus: 'Activo',
      planId:       'PLAN-1',
      planName:     'Plan Plata',
      totalDebt:    150.0,
      tbnCode:      'TBN-0042',
    });
    expect(ctx.updatedSession).toBe(afterIdentify);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('marca como prospect si getClientByPhone devuelve null', async () => {
    clientRepoMock.getClientByPhone.mockResolvedValue(null);
    sessionMock.getSession.mockResolvedValue(makeSession({ clientName: '__prospect__' }));

    const ctx  = makeCtx({ session: makeSession() });
    const next = jest.fn().mockResolvedValue(undefined);

    await handler.handle(ctx, next);

    expect(sessionMock.updateSession).toHaveBeenCalledWith(
      '59170000001', { clientName: '__prospect__' },
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('si getClientByPhone lanza error, igualmente llama next()', async () => {
    clientRepoMock.getClientByPhone.mockRejectedValue(new Error('Backend no disponible'));
    sessionMock.getSession.mockResolvedValue(makeSession());

    const ctx  = makeCtx({ session: makeSession() });
    const next = jest.fn().mockResolvedValue(undefined);

    await expect(handler.handle(ctx, next)).resolves.not.toThrow();
    expect(next).toHaveBeenCalledTimes(1);
  });

  // ── Ubicación ───────────────────────────────────────────────────────────────

  it('guarda la ubicación en sesión si el tipo es location', async () => {
    const session = makeSession({ clientId: 'C-123', clientName: 'Ana' });
    const ctx = makeCtx({
      session,
      type:            'location',
      locationLat:     -16.5,
      locationLng:     -68.15,
      locationName:    'Plaza Murillo',
      locationAddress: 'La Paz',
    });

    await handler.handle(ctx, jest.fn().mockResolvedValue(undefined));

    expect(sessionMock.updateSession).toHaveBeenCalledWith(
      '59170000001',
      {
        lastLocation: {
          lat:     -16.5,
          lng:     -68.15,
          name:    'Plaza Murillo',
          address: 'La Paz',
        },
      },
    );
  });

  it('no guarda ubicación si las coordenadas son undefined', async () => {
    const session = makeSession({ clientId: 'C-123', clientName: 'Ana' });
    const ctx = makeCtx({
      session,
      type:        'location',
      locationLat: undefined,
      locationLng: undefined,
    });

    await handler.handle(ctx, jest.fn().mockResolvedValue(undefined));

    expect(sessionMock.updateSession).not.toHaveBeenCalled();
  });
});
