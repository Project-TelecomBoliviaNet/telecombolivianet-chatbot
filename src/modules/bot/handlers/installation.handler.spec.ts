import { InstallationHandler } from './installation.handler';
import { MessageSource } from '../../../database/entities/message.entity';
import { serializeAction } from '../../../common/pending-action';

// ══════════════════════════════════════════════════════════════
// TESTS UNITARIOS — InstallationHandler (US-09, US-10, US-11)
// ══════════════════════════════════════════════════════════════

const makeSession = (overrides = {}) => ({
  phoneNumber: '59170000001',
  clientId: 'C001',
  clientName: 'María García',
  clientStatus: 'Activo',
  planName: 'Plan Oro',
  totalDebt: 0,
  tbnCode: 'TBN002',
  activeTicketId: null,
  activeInstallationId: null,
  pendingAction: null,
  pendingTechIssue: null,
  isEscalated: false,
  ragFailCount: 0,
  messages: [],
  ...overrides,
});

const makeSlots = () => [
  { Fecha: '2025-06-09', HoraInicio: '09:00', Disponibles: 2 },
  { Fecha: '2025-06-10', HoraInicio: '14:00', Disponibles: 1 },
];

describe('InstallationHandler', () => {
  let handler: InstallationHandler;
  let send: jest.Mock;
  let sessionSvc: any;
  let sistemaApi: any;
  let adminNotifier: any;
  let formatter: any;
  let whatsapp: any;
  let config: any;

  beforeEach(() => {
    send = jest.fn().mockResolvedValue(undefined);

    sessionSvc = {
      updateSession: jest.fn().mockResolvedValue({}),
      setPendingAction: jest.fn().mockResolvedValue(undefined),
    };

    sistemaApi = {
      getInstallationSlots: jest.fn().mockResolvedValue(makeSlots()),
      createInstallation: jest.fn().mockResolvedValue({ InstalacionId: 'INST-001', TicketId: 'TK-001' }),
      cancelInstallation: jest.fn().mockResolvedValue(undefined),
    };

    adminNotifier = {
      notifyTicketCreated: jest.fn().mockResolvedValue(undefined),
    };

    formatter = {
      slotsAvailable: jest.fn().mockReturnValue('slots disponibles'),
      askInstallationAddress: jest.fn().mockReturnValue('pide dirección'),
      installationConfirmed: jest.fn().mockReturnValue('instalación confirmada'),
      installationCancelled: jest.fn().mockReturnValue('instalación cancelada'),
      confirmCancelInstallation: jest.fn().mockReturnValue('confirmar cancelar'),
      slotNoLongerAvailable: jest.fn().mockReturnValue('slot no disponible'),
    };

    whatsapp = {
      sendButtons: jest.fn().mockResolvedValue('msg-id'),
    };

    config = {
      get: jest.fn((key: string) => {
        if (key === 'bot.installationDaysAhead') return 7;
        return undefined;
      }),
    };

    handler = new InstallationHandler(config, sessionSvc, sistemaApi, adminNotifier, formatter, whatsapp);
  });

  // ─── handleInstallationRequest() — US-09 ─────────────────
  describe('handleInstallationRequest() — US-09', () => {
    it('obtiene slots y los muestra', async () => {
      await handler.handleInstallationRequest(makeSession(), send);

      expect(sistemaApi.getInstallationSlots).toHaveBeenCalledWith(7);
      expect(formatter.slotsAvailable).toHaveBeenCalledWith(makeSlots());
      expect(send).toHaveBeenCalledWith('slots disponibles', MessageSource.INTENT);
    });

    it('activa AWAITING_SLOT_SELECTION cuando hay slots', async () => {
      await handler.handleInstallationRequest(makeSession(), send);

      expect(sessionSvc.setPendingAction).toHaveBeenCalledWith(
        '59170000001',
        serializeAction({ type: 'AWAITING_SLOT_SELECTION' }),
      );
    });

    it('NO activa AWAITING_SLOT_SELECTION cuando no hay slots', async () => {
      sistemaApi.getInstallationSlots.mockResolvedValueOnce([]);
      await handler.handleInstallationRequest(makeSession(), send);

      expect(sessionSvc.setPendingAction).not.toHaveBeenCalled();
    });

    it('maneja error de la API con mensaje amigable', async () => {
      sistemaApi.getInstallationSlots.mockRejectedValueOnce(new Error('timeout'));
      await handler.handleInstallationRequest(makeSession(), send);

      expect(send).toHaveBeenCalledWith(expect.stringContaining('No pude obtener'));
    });
  });

  // ─── handleSlotSelection() — US-10 ──────────────────────
  describe('handleSlotSelection() — US-10', () => {
    it('parsea "Lunes 09:00" y pide dirección', async () => {
      await handler.handleSlotSelection('Lunes 09:00', makeSession(), send);

      expect(sessionSvc.setPendingAction).toHaveBeenCalledWith(
        '59170000001',
        expect.stringContaining('AWAITING_ADDRESS'),
      );
      expect(send).toHaveBeenCalledWith('pide dirección', MessageSource.INTENT);
    });

    it('parsea "martes a las 14:00" correctamente', async () => {
      await handler.handleSlotSelection('martes a las 14:00', makeSession(), send);

      const callArg = sessionSvc.setPendingAction.mock.calls[0][1];
      const parsed = JSON.parse(callArg);
      expect(parsed.type).toBe('AWAITING_ADDRESS');
      expect(parsed.slotTime).toBe('14:00');
    });

    it('rechaza texto sin hora válida', async () => {
      await handler.handleSlotSelection('quiero el lunes', makeSession(), send);

      expect(send).toHaveBeenCalledWith(expect.stringContaining('No entendí'));
      expect(sessionSvc.setPendingAction).not.toHaveBeenCalled();
    });

    it('rechaza texto sin día válido', async () => {
      await handler.handleSlotSelection('a las 09:00', makeSession(), send);

      expect(send).toHaveBeenCalledWith(expect.stringContaining('No entendí'));
    });

    it('acepta variante con tilde: "miércoles 10:00"', async () => {
      await handler.handleSlotSelection('miércoles 10:00', makeSession(), send);
      expect(sessionSvc.setPendingAction).toHaveBeenCalled();
    });

    it('acepta variante sin tilde: "miercoles 10:00"', async () => {
      await handler.handleSlotSelection('miercoles 10:00', makeSession(), send);
      expect(sessionSvc.setPendingAction).toHaveBeenCalled();
    });
  });

  // ─── handleAddressAndConfirm() — US-10 ──────────────────
  describe('handleAddressAndConfirm() — US-10', () => {
    it('crea la instalación con todos los datos correctos', async () => {
      await handler.handleAddressAndConfirm('Av. 6 de Agosto 123', '2025-06-09', '09:00', makeSession(), send);

      expect(sistemaApi.createInstallation).toHaveBeenCalledWith({
        ClienteId: 'C001',
        PlanNombre: 'Plan Oro',
        Fecha: '2025-06-09',
        HoraInicio: '09:00',
        Direccion: 'Av. 6 de Agosto 123',
        Notas: 'Agendado via WhatsApp',
      });
    });

    it('guarda el ID de instalación en la sesión', async () => {
      await handler.handleAddressAndConfirm('Calle Test 1', '2025-06-09', '09:00', makeSession(), send);

      expect(sessionSvc.updateSession).toHaveBeenCalledWith(
        '59170000001',
        expect.objectContaining({ activeInstallationId: 'INST-001' }),
      );
    });

    it('notifica al admin de la nueva instalación', async () => {
      await handler.handleAddressAndConfirm('Dir 1', '2025-06-09', '09:00', makeSession(), send);

      expect(adminNotifier.notifyTicketCreated).toHaveBeenCalledWith(
        expect.objectContaining({ priority: 'InstalacionNueva' }),
      );
    });

    it('muestra slot no disponible y nueva lista si falla la creación', async () => {
      sistemaApi.createInstallation.mockRejectedValueOnce(new Error('slot ocupado'));
      await handler.handleAddressAndConfirm('Dir 1', '2025-06-09', '09:00', makeSession(), send);

      expect(formatter.slotNoLongerAvailable).toHaveBeenCalled();
      expect(sistemaApi.getInstallationSlots).toHaveBeenCalled(); // muestra slots nuevamente
    });
  });

  // ─── handleCancelInstallation() — US-11 ─────────────────
  describe('handleCancelInstallation() — US-11', () => {
    it('pide confirmación si hay instalación activa', async () => {
      await handler.handleCancelInstallation(makeSession({ activeInstallationId: 'INST-999' }), send);

      expect(sessionSvc.setPendingAction).toHaveBeenCalledWith(
        '59170000001',
        serializeAction({ type: 'CONFIRM_CANCEL_INSTALLATION', installationId: 'INST-999' }),
      );
      expect(formatter.confirmCancelInstallation).toHaveBeenCalled();
    });

    it('informa que no hay instalación si la sesión no tiene una', async () => {
      await handler.handleCancelInstallation(makeSession(), send);

      expect(send).toHaveBeenCalledWith(expect.stringContaining('No encontré'));
      expect(sessionSvc.setPendingAction).not.toHaveBeenCalled();
    });
  });

  // ─── confirmCancelInstallation() ────────────────────────
  describe('confirmCancelInstallation()', () => {
    it('cancela la instalación y ofrece reagendar cuando se confirma', async () => {
      await handler.confirmCancelInstallation('INST-001', true, makeSession(), send);

      expect(sistemaApi.cancelInstallation).toHaveBeenCalledWith('INST-001', expect.any(String));
      expect(sessionSvc.updateSession).toHaveBeenCalledWith(
        '59170000001',
        expect.objectContaining({ activeInstallationId: null }),
      );
      expect(formatter.installationCancelled).toHaveBeenCalled();
      expect(whatsapp.sendButtons).toHaveBeenCalledWith(
        '59170000001',
        expect.any(String),
        expect.arrayContaining([expect.objectContaining({ id: 'reagendar_si' })]),
      );
    });

    it('mantiene la instalación activa cuando se rechaza', async () => {
      await handler.confirmCancelInstallation('INST-001', false, makeSession(), send);

      expect(sistemaApi.cancelInstallation).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith(expect.stringContaining('sigue agendada'));
    });
  });
});
