import { Inject, Injectable, Logger } from '@nestjs/common';
import { IInstallationRepository, INSTALLATION_REPOSITORY } from '../../client/sistema-api.interfaces';
import { SessionService, SessionData } from '../../session/session.service';
import { AdminSignalrNotifierService } from '../../notifications/admin-signalr-notifier.service';
import { AgentTool } from './agent-tool.interface';

@Injectable()
export class CreateInstallationTool implements AgentTool {
  private readonly logger = new Logger(CreateInstallationTool.name);

  constructor(
    @Inject(INSTALLATION_REPOSITORY) private readonly installationRepo: IInstallationRepository,
    private readonly sessionService: SessionService,
    private readonly adminNotifier:  AdminSignalrNotifierService,
  ) {}

  getName(): string { return 'create_installation'; }
  requiresIdentification(): boolean { return false; }

  getDeclaration(): object {
    return {
      name: this.getName(),
      description:
        'Agenda una instalación de servicio de internet. ' +
        'Llamar cuando el cliente haya proporcionado dirección Y alguna indicación de fecha/hora. ' +
        'IMPORTANTE — convierte TÚ MISMO antes de llamar: ' +
        'fecha → YYYY-MM-DD (ej: "6 de mayo" → "2026-05-06", "el miércoles que viene" → calcula la fecha exacta); ' +
        'hora → HH:mm (ej: "después de las 5" → "17:00", "3 de la tarde" → "15:00", "mediodía" → "12:00"). ' +
        'NO pidas de nuevo datos que el cliente ya dio en la conversación. ' +
        'Para prospectos sin plan activo, usa get_available_plans primero (incluir plan_id).',
      parameters: {
        type: 'OBJECT',
        properties: {
          fecha: {
            type: 'STRING',
            description: 'Fecha de instalación en formato YYYY-MM-DD',
          },
          hora: {
            type: 'STRING',
            description: 'Hora de instalación en formato HH:mm (ej: 09:00)',
          },
          direccion: {
            type: 'STRING',
            description: 'Dirección completa donde se realizará la instalación',
          },
          plan_id: {
            type: 'STRING',
            description: 'ID del plan elegido (obtenido de get_available_plans). Requerido para prospectos sin plan activo.',
          },
        },
        required: ['fecha', 'hora', 'direccion'],
      },
    };
  }

  async execute(args: Record<string, unknown>, session: SessionData): Promise<unknown> {
    const fecha     = (args.fecha     as string) || '';
    const hora      = (args.hora      as string) || '';
    const direccion = (args.direccion as string) || '';

    if (!fecha || !hora || !direccion) {
      return { created: false, error: 'Se requiere fecha, hora y dirección para agendar la instalación.' };
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      return { created: false, error: 'Formato de fecha incorrecto. Usa YYYY-MM-DD (ej: 2025-05-15).' };
    }
    if (!/^\d{2}:\d{2}$/.test(hora)) {
      return { created: false, error: 'Formato de hora incorrecto. Usa HH:mm (ej: 09:00).' };
    }

    const resolvedPlanId = (args.plan_id as string) || session.planId || null;
    if (!resolvedPlanId) {
      return {
        created: false,
        error:
          'No se pudo determinar el plan. Usa get_available_plans para ver los planes disponibles ' +
          'y pide al cliente que elija uno antes de agendar.',
      };
    }

    try {
      const result = await this.installationRepo.createInstallation({
        ClienteId:  session.clientId || null,
        PlanId:     resolvedPlanId,
        Fecha:      fecha,
        HoraInicio: hora,
        Direccion:  direccion,
        Notas:      'Agendado via WhatsApp (agente IA)',
      });

      await this.sessionService.updateSession(session.phoneNumber, {
        activeInstallationId: result.InstalacionId,
      });

      await this.adminNotifier.notifyTicketCreated({
        phoneNumber: session.phoneNumber,
        clientName:  session.clientName ?? 'Prospecto',
        ticketId:    result.InstalacionId,
        priority:    'InstalacionNueva',
      });

      return {
        created:       true,
        instalacionId: result.InstalacionId,
        fecha,
        hora,
        direccion,
        message: `Instalación agendada para el ${fecha} a las ${hora} en ${direccion}.`,
      };
    } catch (err: any) {
      this.logger.error(`CreateInstallationTool error: ${err.message}`);
      return { created: false, error: `No se pudo agendar la instalación: ${err.message}` };
    }
  }
}
