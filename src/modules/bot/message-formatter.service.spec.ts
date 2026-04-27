import { Test, TestingModule } from '@nestjs/testing';
import { MessageFormatterService } from './message-formatter.service';
import { InvoiceDto, SlotDto } from '../client/sistema-api.service';

// ══════════════════════════════════════════════════════════════
// TESTS UNITARIOS — MessageFormatterService
// Sin dependencias externas — todos los métodos son puros.
// Verifica que los mensajes contienen la información correcta.
// ══════════════════════════════════════════════════════════════

const makeInvoice = (overrides: Partial<InvoiceDto> = {}): InvoiceDto => ({
  Id: 'INV001',
  Month: 5,
  Year: 2025,
  Amount: 150.0,
  DueDate: '2025-05-05',
  Status: 'Pendiente',
  PaidAt: null,
  ...overrides,
});

describe('MessageFormatterService', () => {
  let service: MessageFormatterService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MessageFormatterService],
    }).compile();
    service = module.get<MessageFormatterService>(MessageFormatterService);
  });

  // ─── welcome() ────────────────────────────────────────────
  describe('welcome()', () => {
    it('incluye el nombre del cliente', () => {
      const msg = service.welcome('Ana Flores');
      expect(msg).toContain('Ana Flores');
    });

    it('menciona las opciones del menú', () => {
      const msg = service.welcome('Test');
      expect(msg).toContain('Consultar mi deuda');
    });
  });

  describe('welcomeProspect()', () => {
    it('menciona planes e instalación', () => {
      const msg = service.welcomeProspect();
      expect(msg).toContain('planes');
      expect(msg).toContain('instalación');
    });
  });

  // ─── debtSummary() ────────────────────────────────────────
  describe('debtSummary()', () => {
    it('muestra mensaje de cero deuda cuando no hay facturas', () => {
      const msg = service.debtSummary('Carlos', []);
      expect(msg).toContain('al día');
      expect(msg).toContain('Carlos');
    });

    it('lista las facturas pendientes con montos', () => {
      const invoices = [makeInvoice({ Month: 4, Amount: 120 }), makeInvoice({ Month: 5, Amount: 150 })];
      const msg = service.debtSummary('María', invoices);
      expect(msg).toContain('120.00');
      expect(msg).toContain('150.00');
      expect(msg).toContain('270.00'); // total
    });

    it('marca facturas vencidas con indicador visual', () => {
      const invoices = [makeInvoice({ Status: 'Vencida' })];
      const msg = service.debtSummary('Test', invoices);
      expect(msg).toContain('VENCIDA');
    });
  });

  // ─── qrInstruction() ──────────────────────────────────────
  describe('qrInstruction()', () => {
    it('incluye el código TBN y el monto', () => {
      const msg = service.qrInstruction('Roberto', 'TBN123', 200.5);
      expect(msg).toContain('TBN123');
      expect(msg).toContain('200.50');
    });
  });

  describe('noDebtForQr()', () => {
    it('confirma que no hay deuda', () => {
      expect(service.noDebtForQr('Luis')).toContain('al día');
    });
  });

  describe('suspendedClientQr()', () => {
    it('indica servicio suspendido con deuda', () => {
      const msg = service.suspendedClientQr('Pedro', 350);
      expect(msg).toContain('suspendido');
      expect(msg).toContain('350.00');
    });
  });

  // ─── receiptReceivedWithOcr() ──────────────────────────────
  describe('receiptReceivedWithOcr()', () => {
    it('muestra monto y banco cuando están disponibles', () => {
      const msg = service.receiptReceivedWithOcr('Ana', 150, 'BCP', '10/05/2025');
      expect(msg).toContain('150.00');
      expect(msg).toContain('BCP');
      expect(msg).toContain('10/05/2025');
    });

    it('muestra aviso cuando OCR no detectó datos', () => {
      const msg = service.receiptReceivedWithOcr('Ana', null, null, null);
      expect(msg).toContain('No pudimos leer los datos del comprobante');
    });

    it('muestra solo los datos disponibles parcialmente', () => {
      const msg = service.receiptReceivedWithOcr('Ana', 200, null, null);
      expect(msg).toContain('200.00');
      expect(msg).not.toContain('Banco');
    });
  });

  describe('receiptReceivedUnknown()', () => {
    it('menciona que no se identificó el número', () => {
      expect(service.receiptReceivedUnknown()).toContain('identificar');
    });
  });

  // ─── Soporte técnico ──────────────────────────────────────
  describe('ticketCreated()', () => {
    it('incluye el ID y prioridad del ticket', () => {
      const msg = service.ticketCreated('Mario', 'ABCD1234', 'Alta');
      expect(msg).toContain('ABCD1234'.substring(0, 8).toUpperCase());
      expect(msg).toContain('Alta');
    });

    it('usa icono de emergencia para prioridad Alta', () => {
      expect(service.ticketCreated('X', 'T1', 'Alta')).toContain('🚨');
    });

    it('usa icono de herramienta para prioridad Media/Baja', () => {
      expect(service.ticketCreated('X', 'T1', 'Media')).toContain('🔧');
      expect(service.ticketCreated('X', 'T1', 'Baja')).toContain('🔧');
    });
  });

  describe('ticketClosed()', () => {
    it('confirma el cierre con el ID', () => {
      const msg = service.ticketClosed('CLOSE001');
      expect(msg).toContain('CLOSE001'.substring(0, 8).toUpperCase());
    });
  });

  describe('confirmCloseTicket()', () => {
    it('pide confirmación con el ID del ticket', () => {
      const msg = service.confirmCloseTicket('TK999');
      expect(msg).toContain('TK999'.substring(0, 8).toUpperCase());
      expect(msg).toContain('Sí');
    });
  });

  // ─── Instalaciones ────────────────────────────────────────
  describe('slotsAvailable()', () => {
    it('muestra mensaje de sin slots cuando la lista está vacía', () => {
      const msg = service.slotsAvailable([]);
      expect(msg).toContain('no hay horarios');
    });

    it('lista los slots disponibles agrupados por día', () => {
      const slots: SlotDto[] = [
        { Fecha: '2025-06-09', HoraInicio: '09:00', Disponibles: 2 },
        { Fecha: '2025-06-10', HoraInicio: '14:00', Disponibles: 1 },
      ];
      const msg = service.slotsAvailable(slots);
      expect(msg).toContain('09:00');
      expect(msg).toContain('14:00');
    });
  });

  describe('installationConfirmed()', () => {
    it('incluye fecha, hora y dirección', () => {
      const msg = service.installationConfirmed('2025-06-10', '09:00', 'Av. Principal 123');
      expect(msg).toContain('2025-06-10');
      expect(msg).toContain('09:00');
      expect(msg).toContain('Av. Principal 123');
    });
  });

  // ─── Período de pago ──────────────────────────────────────
  describe('paymentPeriodInfo()', () => {
    it('muestra que quedan días para pagar antes del día 5', () => {
      const msg = service.paymentPeriodInfo(3);
      expect(msg).toContain('Quedan');
      expect(msg).toContain('día(s)');
    });

    it('muestra alerta en día 5 (último día)', () => {
      const msg = service.paymentPeriodInfo(5);
      expect(msg).toContain('último día');
    });

    it('muestra alerta de vencimiento en día 6', () => {
      const msg = service.paymentPeriodInfo(6);
      expect(msg).toContain('Vencida');
    });

    it('muestra que está vencida en días posteriores al 7', () => {
      const msg = service.paymentPeriodInfo(15);
      expect(msg).toContain('Vencida');
    });
  });

  // ─── Escalado ─────────────────────────────────────────────
  describe('escalationNotice()', () => {
    it('menciona transferencia a agente humano', () => {
      expect(service.escalationNotice()).toContain('agente humano');
    });
  });

  describe('fallbackMenu()', () => {
    it('muestra las opciones del menú', () => {
      const msg = service.fallbackMenu();
      expect(msg).toContain('deuda');
      expect(msg).toContain('QR');
      expect(msg).toContain('problema técnico');
    });
  });

  describe('botResumed()', () => {
    it('indica que el agente terminó', () => {
      expect(service.botResumed()).toContain('terminó');
    });
  });
});
