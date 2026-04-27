import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SessionService, SessionData } from '../../session/session.service';
import { SistemaApiService } from '../../client/sistema-api.service';
import { AdminSignalrNotifierService } from '../../notifications/admin-signalr-notifier.service';
import { MessageFormatterService } from '../message-formatter.service';
import { WhatsappApiService } from '../../whatsapp/whatsapp-api.service';
import { MessageSource } from '../../../database/entities/message.entity';
import { SendFn } from './payment.handler';
import { serializeAction } from '../../../common/pending-action';

// ══════════════════════════════════════════════════════════════
// INSTALLATION HANDLER — US-09, US-10, US-11
//
// Responsabilidad única: flujo completo de instalaciones.
//   - Consulta de slots disponibles (US-09)
//   - Selección de slot + dirección + confirmación (US-10)
//   - Cancelación y reagendamiento (US-11)
// ══════════════════════════════════════════════════════════════

@Injectable()
export class InstallationHandler {
  private readonly logger = new Logger(InstallationHandler.name);
  private readonly installationDaysAhead: number;

  constructor(
    private readonly config: ConfigService,
    private readonly session: SessionService,
    private readonly sistemaApi: SistemaApiService,
    private readonly adminNotifier: AdminSignalrNotifierService,
    private readonly formatter: MessageFormatterService,
    private readonly whatsapp: WhatsappApiService,
  ) {
    this.installationDaysAhead = config.get<number>('bot.installationDaysAhead') ?? 7;
  }

  // ─── Solicitar instalación — mostrar slots (US-09) ────────
  async handleInstallationRequest(session: SessionData, send: SendFn): Promise<void> {
    try {
      const slots = await this.sistemaApi.getInstallationSlots(this.installationDaysAhead);
      await send(this.formatter.slotsAvailable(slots), MessageSource.INTENT);

      if (slots.length > 0) {
        await this.session.setPendingAction(
          session.phoneNumber,
          serializeAction({ type: 'AWAITING_SLOT_SELECTION' }),
        );
      }
    } catch (err) {
      this.logger.error(`handleInstallationRequest error: ${err.message}`);
      await send('😔 No pude obtener los horarios disponibles. Por favor intenta de nuevo.');
    }
  }

  // ─── Seleccionar slot de texto libre (US-10) ─────────────
  async handleSlotSelection(text: string, session: SessionData, send: SendFn): Promise<void> {
    const timeMatch = text.match(/(\d{1,2}:\d{2})/);
    const dateMatch = text.match(/(lunes|martes|mi[eé]rcoles|jueves|viernes)/i);

    if (!timeMatch || !dateMatch) {
      await send('🤔 No entendí el horario. Por favor escribe la fecha y hora. Ejemplo: *Lunes 09:00*');
      return;
    }

    const dayNames: Record<string, number> = {
      lunes: 1, martes: 2, miércoles: 3, miercoles: 3, jueves: 4, viernes: 5,
    };
    const targetDay = dayNames[dateMatch[1].toLowerCase()];
    if (!targetDay) {
      await send('🤔 No reconocí el día. Escribe el día completo. Ejemplo: *Lunes 09:00*');
      return;
    }

    const today = new Date();
    const daysUntil = (targetDay - today.getDay() + 7) % 7 || 7;
    const targetDate = new Date(today);
    targetDate.setDate(today.getDate() + daysUntil);

    // Componentes locales para evitar offset UTC-4 de Bolivia
    const y = targetDate.getFullYear();
    const m = String(targetDate.getMonth() + 1).padStart(2, '0');
    const d = String(targetDate.getDate()).padStart(2, '0');
    const slotDate = `${y}-${m}-${d}`;
    const slotTime = timeMatch[1];

    await this.session.setPendingAction(
      session.phoneNumber,
      serializeAction({ type: 'AWAITING_ADDRESS', slotDate, slotTime }),
    );
    await send(this.formatter.askInstallationAddress(), MessageSource.INTENT);
  }

  // ─── Confirmar instalación con dirección (US-10) ──────────
  async handleAddressAndConfirm(
    direccion: string,
    slotDate: string,
    slotTime: string,
    session: SessionData,
    send: SendFn,
  ): Promise<void> {
    try {
      const result = await this.sistemaApi.createInstallation({
        ClienteId:  session.clientId,
        PlanNombre: session.planName || 'PLATA',
        Fecha:      slotDate,
        HoraInicio: slotTime,
        Direccion:  direccion,
        Notas:      'Agendado via WhatsApp',
      });

      await this.session.updateSession(session.phoneNumber, {
        activeInstallationId: result.InstalacionId,
        pendingAction: null,
      });

      await send(
        this.formatter.installationConfirmed(slotDate, slotTime, direccion),
        MessageSource.INTENT,
      );

      await this.adminNotifier.notifyTicketCreated({
        phoneNumber: session.phoneNumber,
        clientName:  session.clientName ?? 'Prospecto',
        ticketId:    result.InstalacionId,
        priority:    'InstalacionNueva',
      });
    } catch (err) {
      this.logger.error(`createInstallation error: ${err.message}`);
      await send(this.formatter.slotNoLongerAvailable(), MessageSource.INTENT);
      await this.handleInstallationRequest(session, send);
    }
  }

  // ─── Cancelar instalación (US-11) ────────────────────────
  async handleCancelInstallation(session: SessionData, send: SendFn): Promise<void> {
    if (!session.activeInstallationId) {
      await send('🤔 No encontré una instalación agendada asociada a tu número.');
      return;
    }

    await this.session.setPendingAction(
      session.phoneNumber,
      serializeAction({
        type: 'CONFIRM_CANCEL_INSTALLATION',
        installationId: session.activeInstallationId,
      }),
    );
    await send(this.formatter.confirmCancelInstallation(), MessageSource.INTENT);
  }

  // ─── Confirmar cancelación de instalación ────────────────
  async confirmCancelInstallation(
    installationId: string,
    confirmed: boolean,
    session: SessionData,
    send: SendFn,
  ): Promise<void> {
    if (confirmed) {
      await this.sistemaApi.cancelInstallation(
        installationId,
        'Cancelado por el cliente via WhatsApp',
      );
      await this.session.updateSession(session.phoneNumber, {
        activeInstallationId: null,
        pendingAction: null,
      });
      await send(this.formatter.installationCancelled(), MessageSource.INTENT);

      // Ofrecer reagendar con botones interactivos
      await this.whatsapp.sendButtons(session.phoneNumber, '¿Deseas reagendar tu instalación?', [
        { id: 'reagendar_si', title: 'Sí, reagendar' },
        { id: 'reagendar_no', title: 'No, gracias' },
      ]);
    } else {
      await this.session.setPendingAction(session.phoneNumber, null);
      await send('👍 Tu instalación sigue agendada. ¡Te esperamos!');
    }
  }
}
