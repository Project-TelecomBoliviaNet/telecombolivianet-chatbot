import { MarkAsReadHandler } from './mark-as-read.handler';
import { MessageContext } from './message-context';

// ══════════════════════════════════════════════════════════════════════════════
// FIX-21 — MarkAsReadHandler
// ══════════════════════════════════════════════════════════════════════════════

const makeCtx = (overrides: Partial<MessageContext> = {}): MessageContext =>
  ({ phone: '59170000001', messageId: 'MSG-001', type: 'text', ...overrides } as MessageContext);

describe('MarkAsReadHandler', () => {
  const whatsappMock   = { markAsRead: jest.fn() };
  const outboxMock     = { tryDeliverPending: jest.fn() };
  let handler: MarkAsReadHandler;

  beforeEach(() => {
    jest.resetAllMocks();
    whatsappMock.markAsRead.mockResolvedValue(undefined);
    outboxMock.tryDeliverPending.mockResolvedValue(undefined);
    handler = new MarkAsReadHandler(whatsappMock as any, outboxMock as any);
  });

  it('marca el mensaje como leído con el messageId del contexto', async () => {
    const ctx = makeCtx({ messageId: 'MSG-XYZ' });
    await handler.handle(ctx, jest.fn().mockResolvedValue(undefined));
    expect(whatsappMock.markAsRead).toHaveBeenCalledWith('MSG-XYZ');
  });

  it('entrega mensajes pendientes del outbox para el teléfono', async () => {
    const ctx = makeCtx({ phone: '59171111111' });
    await handler.handle(ctx, jest.fn().mockResolvedValue(undefined));
    expect(outboxMock.tryDeliverPending).toHaveBeenCalledWith('59171111111');
  });

  it('llama a next() después de markAsRead y tryDeliverPending', async () => {
    const order: string[] = [];
    whatsappMock.markAsRead.mockImplementation(async () => { order.push('mark'); });
    outboxMock.tryDeliverPending.mockImplementation(async () => { order.push('outbox'); });
    const next = jest.fn().mockImplementation(async () => { order.push('next'); });

    await handler.handle(makeCtx(), next);

    expect(order).toEqual(['mark', 'outbox', 'next']);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('no propaga errores de markAsRead — la cadena continúa', async () => {
    whatsappMock.markAsRead.mockRejectedValue(new Error('Timeout WhatsApp'));
    const next = jest.fn().mockResolvedValue(undefined);

    await expect(handler.handle(makeCtx(), next)).resolves.not.toThrow();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
