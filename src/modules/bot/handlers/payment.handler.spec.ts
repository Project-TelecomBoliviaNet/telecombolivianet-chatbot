import { PaymentHandler } from './payment.handler';
import { MessageSource } from '../../../database/entities/message.entity';

// ══════════════════════════════════════════════════════════════
// TESTS UNITARIOS — PaymentHandler (US-03, US-04, US-05, US-06)
// Instanciación directa — todos los servicios están mockeados.
// ══════════════════════════════════════════════════════════════

const makeSession = (overrides: Record<string, unknown> = {}) => ({
  phoneNumber: '59170000001',
  clientId: 'C001',
  clientName: 'Ana Flores',
  clientStatus: 'Activo',
  planName: 'Plan Plata',
  totalDebt: 150,
  tbnCode: 'TBN001',
  activeTicketId: null,
  activeInstallationId: null,
  pendingAction: null,
  pendingTechIssue: null,
  isEscalated: false,
  ragFailCount: 0,
  messages: [],
  ...overrides,
});

const pendingInvoices = [
  { Id: 'I1', Month: 4, Year: 2025, Amount: 100, DueDate: '2025-04-05', Status: 'Pendiente', PaidAt: null },
  { Id: 'I2', Month: 5, Year: 2025, Amount: 50,  DueDate: '2025-05-05', Status: 'Pendiente', PaidAt: null },
];

describe('PaymentHandler', () => {
  let handler: PaymentHandler;
  let send: jest.Mock;
  let sistemaApi: any;
  let formatter: any;
  let whatsapp: any;
  let receiptHandler: any;
  let config: any;

  beforeEach(() => {
    send = jest.fn().mockResolvedValue(undefined);

    sistemaApi = {
      getPendingInvoices:  jest.fn().mockResolvedValue(pendingInvoices),
      getQrImageBuffer:    jest.fn().mockResolvedValue(Buffer.from('fake-qr-image-data')),
    };

    formatter = {
      debtSummary:              jest.fn().mockReturnValue('resumen de deuda'),
      paymentPeriodInfo:        jest.fn().mockReturnValue('info periodo general'),
      paymentPeriodWithDebt:    jest.fn().mockReturnValue('periodo con deuda detallado'),
      noDebtForQr:              jest.fn().mockReturnValue('sin deuda, no hace falta QR'),
      suspendedClientQr:        jest.fn().mockReturnValue('cliente suspendido, aquí el QR'),
      qrInstruction:            jest.fn().mockReturnValue('instrucciones del QR'),
      receiptReceivedWithOcr:   jest.fn().mockReturnValue('comprobante recibido con datos OCR'),
      receiptReceivedUnknown:   jest.fn().mockReturnValue('comprobante recibido, número desconocido'),
    };

    whatsapp = { sendImage: jest.fn().mockResolvedValue('msg-id') };

    receiptHandler = {
      handle: jest.fn().mockResolvedValue({
        rawText: 'texto del comprobante',
        amount: 150,
        bank: 'BCP',
        date: '10/05/2025',
      }),
    };

    config = {
      get: jest.fn((key: string) => {
        if (key === 'storage.localPath') return '/tmp/test-uploads';
        if (key === 'app.port') return 3001;
        return undefined;
      }),
    };

    handler = new PaymentHandler(config, sistemaApi, whatsapp, formatter, receiptHandler);
  });

  // ─── handleDebt() — US-03 ────────────────────────────────
  describe('handleDebt() — US-03', () => {
    it('obtiene facturas y envía resumen al cliente', async () => {
      await handler.handleDebt(makeSession(), send);

      expect(sistemaApi.getPendingInvoices).toHaveBeenCalledWith('C001');
      expect(formatter.debtSummary).toHaveBeenCalledWith('Ana Flores', pendingInvoices);
      expect(send).toHaveBeenCalledWith('resumen de deuda', MessageSource.INTENT);
    });

    it('envía mensaje de error cuando la API falla', async () => {
      sistemaApi.getPendingInvoices.mockRejectedValueOnce(new Error('timeout de red'));
      await handler.handleDebt(makeSession(), send);
      expect(send).toHaveBeenCalledWith(expect.stringContaining('No pude obtener'));
    });
  });

  // ─── handlePaymentPeriodInfo() — US-04 ───────────────────
  describe('handlePaymentPeriodInfo() — US-04', () => {
    it('muestra info con deuda para cliente registrado (clientId presente)', async () => {
      await handler.handlePaymentPeriodInfo(makeSession(), send);

      expect(sistemaApi.getPendingInvoices).toHaveBeenCalled();
      expect(formatter.paymentPeriodWithDebt).toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith('periodo con deuda detallado', MessageSource.INTENT);
    });

    it('muestra info general para prospecto (sin clientId)', async () => {
      await handler.handlePaymentPeriodInfo(makeSession({ clientId: null }), send);

      expect(sistemaApi.getPendingInvoices).not.toHaveBeenCalled();
      expect(formatter.paymentPeriodInfo).toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith('info periodo general', MessageSource.INTENT);
    });

    it('cae a info general si la API falla para cliente registrado', async () => {
      sistemaApi.getPendingInvoices.mockRejectedValueOnce(new Error('DB error'));
      await handler.handlePaymentPeriodInfo(makeSession(), send);
      expect(formatter.paymentPeriodInfo).toHaveBeenCalled();
    });
  });

  // ─── handleQr() — US-05 ──────────────────────────────────
  describe('handleQr() — US-05', () => {
    it('envía resumen de deuda y luego imagen QR para cliente con deuda', async () => {
      await handler.handleQr(makeSession({ totalDebt: 150 }), send);

      expect(sistemaApi.getPendingInvoices).toHaveBeenCalled();
      expect(sistemaApi.getQrImageBuffer).toHaveBeenCalledWith('C001');
      expect(whatsapp.sendImage).toHaveBeenCalled();
      expect(formatter.qrInstruction).toHaveBeenCalled();
    });

    it('NO genera QR si el cliente está al día (totalDebt = 0)', async () => {
      await handler.handleQr(makeSession({ totalDebt: 0 }), send);

      expect(formatter.noDebtForQr).toHaveBeenCalled();
      expect(sistemaApi.getQrImageBuffer).not.toHaveBeenCalled();
    });

    it('genera QR igualmente para cliente suspendido con deuda', async () => {
      await handler.handleQr(makeSession({ clientStatus: 'Suspendido', totalDebt: 300 }), send);

      expect(formatter.suspendedClientQr).toHaveBeenCalled();
      expect(sistemaApi.getQrImageBuffer).toHaveBeenCalled();
    });

    it('envía mensaje de error si falla la descarga del QR', async () => {
      sistemaApi.getQrImageBuffer.mockRejectedValueOnce(new Error('error al generar QR'));
      await handler.handleQr(makeSession({ totalDebt: 100 }), send);
      expect(send).toHaveBeenCalledWith(expect.stringContaining('No pude generar'));
    });
  });

  // ─── handleReceipt() — US-06 ─────────────────────────────
  describe('handleReceipt() — US-06', () => {
    it('muestra datos OCR extraídos para cliente conocido', async () => {
      await handler.handleReceipt('IMG001', 'pago bs 150', makeSession(), send);

      expect(receiptHandler.handle).toHaveBeenCalledWith('IMG001', 'pago bs 150', expect.any(Object));
      expect(formatter.receiptReceivedWithOcr).toHaveBeenCalledWith('Ana Flores', 150, 'BCP', '10/05/2025');
      expect(send).toHaveBeenCalledWith('comprobante recibido con datos OCR', MessageSource.INTENT);
    });

    it('muestra mensaje genérico para prospecto (clientName = __prospect__)', async () => {
      const session = makeSession({ clientName: '__prospect__' });
      await handler.handleReceipt('IMG002', undefined, session, send);

      expect(formatter.receiptReceivedUnknown).toHaveBeenCalled();
    });

    it('muestra mensaje genérico para sesión sin clientName', async () => {
      const session = makeSession({ clientName: null });
      await handler.handleReceipt('IMG003', undefined, session, send);

      expect(formatter.receiptReceivedUnknown).toHaveBeenCalled();
    });

    it('envía mensaje de error si el handler de recibo devuelve null', async () => {
      receiptHandler.handle.mockResolvedValueOnce(null);
      await handler.handleReceipt('IMG004', undefined, makeSession(), send);

      expect(send).toHaveBeenCalledWith(expect.stringContaining('problema al procesar'));
      expect(formatter.receiptReceivedWithOcr).not.toHaveBeenCalled();
    });
  });
});
