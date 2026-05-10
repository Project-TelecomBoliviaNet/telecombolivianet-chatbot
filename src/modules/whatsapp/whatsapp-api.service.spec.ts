import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WhatsappApiService } from './whatsapp-api.service';

// ══════════════════════════════════════════════════════════════
// TESTS UNITARIOS — WhatsappApiService
// axios está completamente mockeado para evitar llamadas reales
// a la Meta Cloud API.
// ══════════════════════════════════════════════════════════════

// ─── Mock de axios ─────────────────────────────────────────────
const mockPost = jest.fn();
const mockGet  = jest.fn();

jest.mock('axios', () => ({
  create: jest.fn(() => ({
    post:              mockPost,
    get:               mockGet,
    interceptors:      { request: { use: jest.fn() }, response: { use: jest.fn() } },
  })),
  get: jest.fn(),
  default: {
    create: jest.fn(() => ({
      post:              mockPost,
      get:               mockGet,
      interceptors:      { request: { use: jest.fn() }, response: { use: jest.fn() } },
    })),
    get: jest.fn(),
  },
}));

// ─── Mock de ConfigService ─────────────────────────────────────
const configMock = {
  get: jest.fn((key: string) => {
    const cfg: Record<string, unknown> = {
      'meta.phoneNumberId': '591700000000',
      'meta.apiVersion':    'v18.0',
      'meta.apiUrl':        'https://graph.facebook.com',
      'meta.accessToken':   'TEST_TOKEN',
    };
    return cfg[key] ?? null;
  }),
};

describe('WhatsappApiService', () => {
  let service: WhatsappApiService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappApiService,
        { provide: ConfigService, useValue: configMock },
      ],
    }).compile();

    service = module.get<WhatsappApiService>(WhatsappApiService);
  });

  // ── TC-WA-01 · sendText envía el payload correcto ────────────

  describe('sendText()', () => {
    it('TC-WA-01 — envía mensaje de texto con estructura correcta', async () => {
      mockPost.mockResolvedValueOnce({
        data: { messages: [{ id: 'wamid.ABCD1234' }] },
      });

      const msgId = await service.sendText('59170000001', 'Hola, ¿en qué podemos ayudarte?');

      expect(mockPost).toHaveBeenCalledWith(
        expect.stringContaining('/messages'),
        expect.objectContaining({
          messaging_product: 'whatsapp',
          recipient_type:    'individual',
          to:                '59170000001',
          type:              'text',
          text:              expect.objectContaining({ body: 'Hola, ¿en qué podemos ayudarte?' }),
        }),
      );
      expect(msgId).toBe('wamid.ABCD1234');
    });

    it('TC-WA-02 — preview_url es false (evita enlaces expandidos)', async () => {
      mockPost.mockResolvedValueOnce({ data: { messages: [{ id: 'wamid.X' }] } });

      await service.sendText('59170000001', 'Mensaje de prueba');

      expect(mockPost).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          text: expect.objectContaining({ preview_url: false }),
        }),
      );
    });
  });

  // ── TC-WA-03 · sendImage envía imagen con link y caption ─────

  describe('sendImage()', () => {
    it('TC-WA-03 — envía imagen con URL y caption opcional', async () => {
      mockPost.mockResolvedValueOnce({ data: { messages: [{ id: 'wamid.IMG1' }] } });

      const msgId = await service.sendImage(
        '59170000001',
        'https://storage.example.com/qr.png',
        'Tu QR de pago',
      );

      expect(mockPost).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          type:  'image',
          image: expect.objectContaining({
            link:    'https://storage.example.com/qr.png',
            caption: 'Tu QR de pago',
          }),
        }),
      );
      expect(msgId).toBe('wamid.IMG1');
    });

    it('TC-WA-04 — envía imagen sin caption cuando no se proporciona', async () => {
      mockPost.mockResolvedValueOnce({ data: { messages: [{ id: 'wamid.IMG2' }] } });

      await service.sendImage('59170000001', 'https://img.example.com/img.png');

      expect(mockPost).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          image: expect.not.objectContaining({ caption: expect.anything() }),
        }),
      );
    });
  });

  // ── TC-WA-05 · markAsRead no lanza aunque el servidor falle ──

  describe('markAsRead()', () => {
    it('TC-WA-05 — no lanza excepción si el servidor falla (fire-and-forget)', async () => {
      mockPost.mockRejectedValueOnce(new Error('Network error'));

      await expect(
        service.markAsRead('wamid.SOME_MESSAGE_ID')
      ).resolves.not.toThrow();
    });

    it('TC-WA-06 — llama POST con status=read y el messageId correcto', async () => {
      mockPost.mockResolvedValueOnce({});

      await service.markAsRead('wamid.TESTMSG');

      expect(mockPost).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          messaging_product: 'whatsapp',
          status:            'read',
          message_id:        'wamid.TESTMSG',
        }),
      );
    });
  });

  // ── TC-WA-07 · sendButtons envía interactive/button ──────────

  describe('sendButtons()', () => {
    it('TC-WA-07 — envía mensaje con botones de respuesta rápida', async () => {
      mockPost.mockResolvedValueOnce({ data: { messages: [{ id: 'wamid.BTN1' }] } });

      await service.sendButtons(
        '59170000001',
        '¿Deseas consultar tu saldo?',
        [
          { id: 'si', title: 'Sí' },
          { id: 'no', title: 'No' },
        ],
      );

      expect(mockPost).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          type: 'interactive',
          interactive: expect.objectContaining({
            type: 'button',
            body: { text: '¿Deseas consultar tu saldo?' },
            action: expect.objectContaining({
              buttons: expect.arrayContaining([
                expect.objectContaining({ reply: { id: 'si', title: 'Sí' } }),
                expect.objectContaining({ reply: { id: 'no', title: 'No' } }),
              ]),
            }),
          }),
        }),
      );
    });
  });

  // ── TC-WA-08 · sendList envía lista interactiva ───────────────

  describe('sendList()', () => {
    it('TC-WA-08 — envía lista interactiva con secciones', async () => {
      mockPost.mockResolvedValueOnce({ data: { messages: [{ id: 'wamid.LST1' }] } });

      await service.sendList(
        '59170000001',
        'Selecciona una opción',
        'Ver opciones',
        [
          {
            title: 'Pagos',
            rows: [{ id: 'saldo', title: 'Ver saldo', description: 'Tu deuda actual' }],
          },
        ],
      );

      expect(mockPost).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          type: 'interactive',
          interactive: expect.objectContaining({
            type: 'list',
            action: expect.objectContaining({
              button: 'Ver opciones',
              sections: expect.arrayContaining([
                expect.objectContaining({ title: 'Pagos' }),
              ]),
            }),
          }),
        }),
      );
    });
  });
});
