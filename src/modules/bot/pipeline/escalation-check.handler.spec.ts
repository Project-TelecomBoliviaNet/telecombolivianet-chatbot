import { EscalationCheckHandler } from './escalation-check.handler';
import { MessageContext } from './message-context';
import { SessionData } from '../../session/session.service';
import { MessageSource } from '../../../database/entities/message.entity';

// ══════════════════════════════════════════════════════════════════════════════
// FIX-21 — EscalationCheckHandler
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
    phone:       '59170000001',
    messageId:   'MSG-001',
    type:        'text',
    userContent: 'Hola',
    session:     makeSession(),
    ...overrides,
  } as MessageContext);

describe('EscalationCheckHandler', () => {
  const sessionMock     = {};
  const persistenceMock = { persistMessage: jest.fn() };
  let handler: EscalationCheckHandler;

  beforeEach(() => {
    jest.resetAllMocks();
    persistenceMock.persistMessage.mockResolvedValue(undefined);
    handler = new EscalationCheckHandler(sessionMock as any, persistenceMock as any);
  });

  // ── Sin escalada ────────────────────────────────────────────────────────────

  it('llama a next() cuando la sesión NO está escalada', async () => {
    const ctx  = makeCtx({ session: makeSession({ isEscalated: false }) });
    const next = jest.fn().mockResolvedValue(undefined);

    await handler.handle(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(persistenceMock.persistMessage).not.toHaveBeenCalled();
  });

  it('pasa la cadena normalmente si session es undefined', async () => {
    const ctx  = makeCtx({ session: undefined });
    const next = jest.fn().mockResolvedValue(undefined);

    await handler.handle(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  // ── Con escalada ─────────────────────────────────────────────────────────────

  it('persiste el mensaje del usuario cuando la sesión está escalada', async () => {
    const session = makeSession({ isEscalated: true });
    const ctx = makeCtx({
      session,
      userContent:      'Necesito ayuda',
      incomingMediaUrl:  'https://cdn/img.jpg',
      incomingMediaType: 'image',
    });
    const next = jest.fn().mockResolvedValue(undefined);

    await handler.handle(ctx, next);

    expect(persistenceMock.persistMessage).toHaveBeenCalledWith(
      session,
      'user',
      'Necesito ayuda',
      MessageSource.ADMIN,
      undefined,
      'https://cdn/img.jpg',
      'image',
    );
  });

  it('NO llama a next() cuando la sesión está escalada', async () => {
    const ctx  = makeCtx({ session: makeSession({ isEscalated: true }) });
    const next = jest.fn().mockResolvedValue(undefined);

    await handler.handle(ctx, next);

    expect(next).not.toHaveBeenCalled();
  });
});
