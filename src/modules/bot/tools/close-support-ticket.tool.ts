import { Inject, Injectable, Logger } from '@nestjs/common';
import { ITicketRepository, TICKET_REPOSITORY } from '../../client/sistema-api.interfaces';
import { SessionService, SessionData } from '../../session/session.service';
import { AdminSignalrNotifierService } from '../../notifications/admin-signalr-notifier.service';
import { AgentTool } from './agent-tool.interface';

@Injectable()
export class CloseSupportTicketTool implements AgentTool {
  private readonly logger = new Logger(CloseSupportTicketTool.name);

  constructor(
    @Inject(TICKET_REPOSITORY) private readonly ticketRepo: ITicketRepository,
    private readonly sessionService: SessionService,
    private readonly adminNotifier:  AdminSignalrNotifierService,
  ) {}

  getName(): string { return 'close_support_ticket'; }
  requiresIdentification(): boolean { return false; }

  getDeclaration(): object {
    return {
      name: this.getName(),
      description:
        'Cierra el ticket de soporte activo. ' +
        'LLAMAR OBLIGATORIAMENTE cuando el cliente diga que su problema se solucionó ' +
        '("ya mejoró", "ya funciona", "se arregló", "listo", "sí mejoró", "quedó bien", etc.). ' +
        'Si no se llama, el ticket queda abierto y el próximo reporte del cliente se bloqueará.',
      parameters: {
        type: 'OBJECT',
        properties: {
          ticket_id: {
            type: 'STRING',
            description: 'ID del ticket a cerrar (opcional si hay un ticket activo en la sesión)',
          },
          resolution: {
            type: 'STRING',
            description: 'Nota de resolución del problema',
          },
        },
        required: [],
      },
    };
  }

  async execute(args: Record<string, unknown>, session: SessionData): Promise<unknown> {
    const ticketId   = (args.ticket_id  as string) || session.activeTicketId;
    const resolution = (args.resolution as string) || 'Resuelto por el cliente via WhatsApp';

    if (!ticketId) {
      return {
        closed: false,
        error:  'No se encontró un ticket activo en la sesión. Proporciona el ID del ticket.',
      };
    }

    try {
      await this.ticketRepo.closeTicket(ticketId, resolution);
      await this.sessionService.updateSession(session.phoneNumber, { activeTicketId: null });
      await this.adminNotifier.notifyTicketClosed({
        phoneNumber: session.phoneNumber,
        clientName:  session.clientName ?? 'Desconocido',
        ticketId,
      });

      return {
        closed:   true,
        ticketId,
        message:  `Ticket ${ticketId} cerrado exitosamente.`,
      };
    } catch (err: any) {
      this.logger.error(`CloseSupportTicketTool error: ${err.message}`);
      return { closed: false, error: `No se pudo cerrar el ticket: ${err.message}` };
    }
  }
}
