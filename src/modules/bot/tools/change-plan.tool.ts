import { Inject, Injectable, Logger } from '@nestjs/common';
import { IClientRepository, CLIENT_REPOSITORY } from '../../client/sistema-api.interfaces';
import { AdminSignalrNotifierService } from '../../notifications/admin-signalr-notifier.service';
import { SessionData } from '../../session/session.service';
import { AgentTool } from './agent-tool.interface';

@Injectable()
export class ChangePlanTool implements AgentTool {
  private readonly logger = new Logger(ChangePlanTool.name);

  constructor(
    @Inject(CLIENT_REPOSITORY) private readonly clientRepo: IClientRepository,
    private readonly adminNotifier: AdminSignalrNotifierService,
  ) {}

  getName(): string { return 'change_plan'; }
  requiresIdentification(): boolean { return true; }

  getDeclaration(): object {
    return {
      name: this.getName(),
      description:
        'Registra una solicitud formal de cambio de plan para el cliente. ' +
        'SIEMPRE llamar get_available_plans primero para obtener el plan_id correcto. ' +
        'Solo disponible para clientes registrados.',
      parameters: {
        type: 'OBJECT',
        properties: {
          plan_id: {
            type: 'STRING',
            description: 'ID (UUID) del plan destino, obtenido de get_available_plans. Campo obligatorio.',
          },
          requested_plan: {
            type: 'STRING',
            description: 'Nombre del plan que el cliente quiere (para mostrar en la respuesta)',
          },
          reason: {
            type: 'STRING',
            description: 'Motivo del cambio indicado por el cliente',
          },
        },
        required: ['plan_id', 'requested_plan'],
      },
    };
  }

  async execute(args: Record<string, unknown>, session: SessionData): Promise<unknown> {
    const planId        = ((args.plan_id        as string) || '').trim();
    const requestedPlan = ((args.requested_plan as string) || 'No especificado').trim();
    const reason        = ((args.reason         as string) || 'Solicitud del cliente via WhatsApp').trim();

    if (!planId) {
      return { created: false, error: 'Se requiere el ID del plan destino (usa get_available_plans primero).' };
    }
    if (session.planId && session.planId === planId) {
      return { created: false, error: `El cliente ya tiene activo el plan "${requestedPlan}".` };
    }

    try {
      const result = await this.clientRepo.requestPlanChange(
        session.clientId!,
        planId,
        `Plan solicitado: ${requestedPlan}. Motivo: ${reason}. Plan actual: ${session.planName ?? 'N/D'}. Via WhatsApp.`,
      );

      await this.adminNotifier.notifyTicketCreated({
        phoneNumber: session.phoneNumber,
        clientName:  session.clientName ?? 'Desconocido',
        ticketId:    result.changeId,
        priority:    'Media',
      });

      return {
        created:       true,
        changeId:      result.changeId,
        requestedPlan,
        currentPlan:   session.planName ?? 'N/D',
        message:
          `Solicitud de cambio al plan "${requestedPlan}" registrada correctamente. ` +
          `Se aplicará el 1ro del mes siguiente una vez aprobada por el administrador.`,
      };
    } catch (err: any) {
      const backendMsg: string = err.response?.data?.message ?? err.message;
      this.logger.error(`ChangePlanTool error: ${backendMsg}`);
      return { created: false, error: `No se pudo registrar la solicitud: ${backendMsg}` };
    }
  }
}
