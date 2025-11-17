import { ConfigService } from '@nestjs/config';
import { WhatsappMockService } from './whatsapp-mock.service';
import { IWhatsappMessenger } from './whatsapp-messenger.interface';

// ══════════════════════════════════════════════════════════════
// CONTRATO: WhatsappMockService implementa IWhatsappMessenger
//
// Verifica que el mock tiene todos los métodos requeridos por la
// interfaz y que su comportamiento es predecible en tests.
// ══════════════════════════════════════════════════════════════

function makeMock(): WhatsappMockService {
  const config = { get: jest.fn() } as unknown as ConfigService;
  return new WhatsappMockService(config);
}

describe('WhatsappMockService — contrato IWhatsappMessenger', () => {

  it('CT-01 — implements IWhatsappMessenger (verificación estructural)', () => {
    const mock: IWhatsappMessenger = makeMock();
    expect(typeof mock.sendText).toBe('function');
    expect(typeof mock.sendImage).toBe('function');
    expect(typeof mock.sendList).toBe('function');
    expect(typeof mock.sendButtons).toBe('function');
    expect(typeof mock.markAsRead).toBe('function');
    expect(typeof mock.downloadMedia).toBe('function');
  });

  it('CT-02 — sendText registra el mensaje y retorna un ID', async () => {
    const mock = makeMock();
    const id = await mock.sendText('591700000001', 'Hola test');
    expect(id).toBeTruthy();
    expect(mock.sentMessages).toHaveLength(1);
    expect(mock.sentMessages[0].to).toBe('591700000001');
    expect(mock.sentMessages[0].content).toBe('Hola test');
  });

  it('CT-03 — sendImage registra la URL de imagen', async () => {
    const mock = makeMock();
    const id = await mock.sendImage('591700000001', 'https://img.example.com/qr.png', 'QR de pago');
    expect(id).toBeTruthy();
    expect(mock.sentMessages[0].type).toBe('image');
  });

  it('CT-04 — sendList registra el mensaje de lista', async () => {
    const mock = makeMock();
    const id = await mock.sendList(
      '591700000001',
      'Selecciona una opción',
      'Ver opciones',
      [{ title: 'Pagos', rows: [{ id: 'saldo', title: 'Ver saldo' }] }],
    );
    expect(id).toBeTruthy();
    expect(mock.sentMessages[0].content).toBe('Selecciona una opción');
  });

  it('CT-05 — sendButtons registra botones', async () => {
    const mock = makeMock();
    const id = await mock.sendButtons('591700000001', '¿Confirmar?', [
      { id: 'si', title: 'Sí' },
      { id: 'no', title: 'No' },
    ]);
    expect(id).toBeTruthy();
    expect(mock.sentMessages[0].type).toBe('buttons');
  });

  it('CT-06 — markAsRead no lanza excepción (no-op)', async () => {
    const mock = makeMock();
    await expect(mock.markAsRead('wamid.TESTMSG')).resolves.not.toThrow();
  });

  it('CT-07 — downloadMedia retorna un Buffer válido', async () => {
    const mock = makeMock();
    const buf = await mock.downloadMedia('any-media-id');
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('CT-08 — clearHistory vacía sentMessages', async () => {
    const mock = makeMock();
    await mock.sendText('591700000001', 'mensaje 1');
    await mock.sendText('591700000001', 'mensaje 2');
    expect(mock.sentMessages).toHaveLength(2);
    mock.clearHistory();
    expect(mock.sentMessages).toHaveLength(0);
  });

  it('CT-09 — lastMessageTo retorna el último mensaje del número', async () => {
    const mock = makeMock();
    await mock.sendText('591700000001', 'primero');
    await mock.sendText('591700000001', 'segundo');
    expect(mock.lastMessageTo('591700000001')).toBe('segundo');
  });

  it('CT-10 — lastMessageTo retorna undefined para número sin mensajes', () => {
    const mock = makeMock();
    expect(mock.lastMessageTo('591700000099')).toBeUndefined();
  });
});
