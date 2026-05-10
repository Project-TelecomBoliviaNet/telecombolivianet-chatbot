import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SistemaApiService } from './sistema-api.service';

// ══════════════════════════════════════════════════════════════
// TESTS UNITARIOS — SistemaApiService
// Verifica integración con el backend C# (endpoints /api/clients/...).
// axios está completamente mockeado — no realiza llamadas reales.
// ══════════════════════════════════════════════════════════════

// ─── Mock de axios (http client interno) ────────────────────────
const mockGet  = jest.fn();
const mockPost = jest.fn();
const mockPatch = jest.fn();

const mockHttpInstance = {
  get:          mockGet,
  post:         mockPost,
  patch:        mockPatch,
  interceptors: {
    request:  { use: jest.fn() },
    response: { use: jest.fn() },
  },
};

jest.mock('axios', () => ({
  create: jest.fn(() => mockHttpInstance),
  post:   jest.fn(),
  default: {
    create: jest.fn(() => mockHttpInstance),
    post:   jest.fn(),
  },
}));

// ─── Mock de ConfigService ─────────────────────────────────────
const configMock = {
  get: jest.fn((key: string) => {
    const cfg: Record<string, unknown> = {
      'sistema.apiUrl':                'http://backend:5000',
      'sistema.botEmail':              'bot@telecombolivianet.bo',
      'sistema.botPassword':           'BotP4ss!',
      'sistema.jwtRefreshMarginMinutes': 5,
    };
    return cfg[key] ?? null;
  }),
};

// ─── Cliente de ejemplo ─────────────────────────────────────────
const CLIENT_DTO = {
  Id:            'uuid-001',
  TbnCode:       'TBN-001',
  FullName:      'Juan Mamani',
  PhoneMain:     '70000001',
  Status:        'Activo',
  PlanId:        'plan-uuid',
  PlanName:      'Plan Plata',
  PlanSpeedMbps: 10,
  TotalDebt:     150,
  PendingMonths: 1,
  Zone:          'Norte',
};

const INVOICES = [
  { Id: 'inv-001', Month: 4, Year: 2026, Amount: 150, DueDate: '2026-04-05', Status: 'Pendiente', PaidAt: null },
  { Id: 'inv-002', Month: 3, Year: 2026, Amount: 150, DueDate: '2026-03-05', Status: 'Pagada',    PaidAt: '2026-03-03' },
];

describe('SistemaApiService', () => {
  let service: SistemaApiService;

  beforeEach(async () => {
    jest.clearAllMocks();

    // El login inicial se hace en onModuleInit — mockear el post externo de axios
    const axiosDefault = require('axios');
    axiosDefault.post.mockResolvedValue({
      data: { token: 'bot.jwt.token' },
    });
    axiosDefault.default.post = axiosDefault.post;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SistemaApiService,
        { provide: ConfigService, useValue: configMock },
      ],
    }).compile();

    service = module.get<SistemaApiService>(SistemaApiService);
    await service.onModuleInit();
  });

  // ── TC-SIS-01 · getClientByPhone normaliza número con prefijo 591 ─

  describe('getClientByPhone()', () => {
    it('TC-SIS-01 — normaliza número 591XXXXXXXX quitando el prefijo 591', async () => {
      mockGet.mockResolvedValueOnce({ data: { data: CLIENT_DTO } });

      await service.getClientByPhone('59170000001');

      expect(mockGet).toHaveBeenCalledWith(
        '/api/clients/by-phone',
        { params: { phone: '70000001' } },
      );
    });

    it('TC-SIS-02 — retorna null cuando el cliente no existe (404)', async () => {
      mockGet.mockRejectedValueOnce({ response: { status: 404 } });

      const result = await service.getClientByPhone('59199999999');

      expect(result).toBeNull();
    });

    it('TC-SIS-03 — propaga el error si no es 404', async () => {
      mockGet.mockRejectedValueOnce({ response: { status: 500 }, message: 'Server error' });

      await expect(service.getClientByPhone('59170000001')).rejects.toBeTruthy();
    });

    it('TC-SIS-04 — retorna el DTO del cliente cuando existe', async () => {
      mockGet.mockResolvedValueOnce({ data: { data: CLIENT_DTO } });

      const client = await service.getClientByPhone('70000001');

      expect(client).not.toBeNull();
      expect(client!.TbnCode).toBe('TBN-001');
      expect(client!.TotalDebt).toBe(150);
    });

    it('TC-SIS-05 — número sin prefijo 591 se envía tal cual', async () => {
      mockGet.mockResolvedValueOnce({ data: { data: CLIENT_DTO } });

      await service.getClientByPhone('70000001');

      expect(mockGet).toHaveBeenCalledWith(
        '/api/clients/by-phone',
        { params: { phone: '70000001' } },
      );
    });
  });

  // ── TC-SIS-06 · getClientInvoices retorna lista de facturas ───

  describe('getClientInvoices()', () => {
    it('TC-SIS-06 — llama GET /api/clients/:id/invoices/bot con el año actual', async () => {
      const currentYear = new Date().getFullYear();
      mockGet.mockResolvedValueOnce({ data: { data: { Invoices: INVOICES } } });

      await service.getClientInvoices('uuid-001');

      expect(mockGet).toHaveBeenCalledWith(
        '/api/clients/uuid-001/invoices/bot',
        { params: { year: currentYear } },
      );
    });

    it('TC-SIS-07 — retorna el array de facturas correctamente', async () => {
      mockGet.mockResolvedValueOnce({ data: { data: { Invoices: INVOICES } } });

      const invoices = await service.getClientInvoices('uuid-001');

      expect(invoices).toHaveLength(2);
      expect(invoices[0].Status).toBe('Pendiente');
      expect(invoices[1].Status).toBe('Pagada');
    });

    it('TC-SIS-08 — retorna array vacío si Invoices es undefined', async () => {
      mockGet.mockResolvedValueOnce({ data: { data: {} } }); // sin Invoices

      const invoices = await service.getClientInvoices('uuid-001');

      expect(invoices).toEqual([]);
    });
  });

  // ── TC-SIS-09 · getPendingInvoices filtra solo Pendiente y Vencida ──

  describe('getPendingInvoices()', () => {
    it('TC-SIS-09 — retorna solo facturas Pendiente y Vencida', async () => {
      const invoicesConVencida = [
        ...INVOICES,
        { Id: 'inv-003', Month: 2, Year: 2026, Amount: 150, DueDate: '2026-02-05', Status: 'Vencida', PaidAt: null },
      ];
      mockGet.mockResolvedValueOnce({ data: { data: { Invoices: invoicesConVencida } } });

      const pending = await service.getPendingInvoices('uuid-001');

      // Solo Pendiente (inv-001) y Vencida (inv-003) → 2 facturas
      expect(pending).toHaveLength(2);
      pending.forEach((inv) => {
        expect(['Pendiente', 'Vencida']).toContain(inv.Status);
      });
    });

    it('TC-SIS-10 — retorna lista vacía si no hay facturas pendientes', async () => {
      mockGet.mockResolvedValueOnce({ data: { data: { Invoices: [INVOICES[1]] } } }); // solo Pagada

      const pending = await service.getPendingInvoices('uuid-001');

      expect(pending).toHaveLength(0);
    });
  });

  // ── TC-SIS-11 · getActivePlans mapea SpeedMb → SpeedMbps ──────

  describe('getActivePlans()', () => {
    it('TC-SIS-11 — mapea SpeedMb del backend a SpeedMbps internamente', async () => {
      mockGet.mockResolvedValueOnce({
        data: {
          data: [
            { Id: 'plan-1', Name: 'Plan Básico', SpeedMb: 5, MonthlyPrice: 80, IsActive: true },
            { Id: 'plan-2', Name: 'Plan Plata',  SpeedMb: 10, MonthlyPrice: 150, IsActive: true },
          ],
        },
      });

      const plans = await service.getActivePlans();

      expect(plans).toHaveLength(2);
      expect(plans[0].SpeedMbps).toBe(5);  // SpeedMb → SpeedMbps
      expect(plans[1].SpeedMbps).toBe(10);
      expect(plans[0].PriceMonthly).toBe(80);
    });

    it('TC-SIS-12 — retorna array vacío si no hay planes', async () => {
      mockGet.mockResolvedValueOnce({ data: { data: [] } });

      const plans = await service.getActivePlans();

      expect(plans).toEqual([]);
    });
  });
});
