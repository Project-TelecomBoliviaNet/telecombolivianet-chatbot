import { Inject, Injectable, Logger } from '@nestjs/common';
import { ITicketRepository, TICKET_REPOSITORY } from '../../client/sistema-api.interfaces';
import { SessionService, SessionData } from '../../session/session.service';
import { AdminSignalrNotifierService } from '../../notifications/admin-signalr-notifier.service';
import { AgentTool } from './agent-tool.interface';

const ISSUE_TYPE_MAP: Record<string, { type: string; priority: string; slaHours: number }> = {
  sin_conexion:    { type: 'SoporteTecnico', priority: 'Alta',  slaHours: 4 },
  velocidad_lenta: { type: 'SoporteTecnico', priority: 'Media', slaHours: 8 },
  problema_router: { type: 'SoporteTecnico', priority: 'Media', slaHours: 8 },
};

@Injectable()
export class CreateSupportTicketTool implements AgentTool {
  private readonly logger = new Logger(CreateSupportTicketTool.name);

  constructor(
    @Inject(TICKET_REPOSITORY) private readonly ticketRepo: ITicketRepository,
    private readonly sessionService: SessionService,
    private readonly adminNotifier:  AdminSignalrNotifierService,
  ) {}

  getName(): string { return 'create_support_ticket'; }
  requiresIdentification(): boolean { return true; }

  getDeclaration(): object {
    return {
      name: this.getName(),
      description:
        'Crea un ticket de soporte técnico. ' +
        'IMPORTANTE: usa primero search_knowledge_base para ofrecer pasos de autodiagnóstico. ' +
        'Solo crea el ticket si: (a) el cliente ya intentó los pasos y el problema persiste, ' +
        'o (b) la base de conocimiento no tiene información relevante, ' +
        'o (c) el cliente pide explícitamente que se cree un ticket.',
      parameters: {
        type: 'OBJECT',
        properties: {
          issue_type: {
            type: 'STRING',
            enum: ['sin_conexion', 'velocidad_lenta', 'problema_router'],
            description: 'Tipo de problema técnico detectado',
          },
          description: {
            type: 'STRING',
            description: 'Descripción del problema en palabras del cliente',
          },
          force_new: {
            type: 'BOOLEAN',
            description: 'true para crear un nuevo ticket aunque ya exista uno activo (usar solo si el cliente lo confirma explícitamente)',
          },
        },
        required: ['issue_type', 'description'],
      },
    };
  }

  async execute(args: Record<string, unknown>, session: SessionData): Promise<unknown> {
    if (session.activeTicketId && !args.force_new) {
      return {
        created:          false,
        existingTicketId: session.activeTicketId,
        message:
          `Ya tienes un ticket activo (${session.activeTicketId}). ` +
          `¿Confirmas que quieres abrir uno nuevo de todas formas? ` +
          `Si es así, indica que deseas crear un nuevo ticket.`,
      };
    }

    const issueType   = (args.issue_type   as string) || 'sin_conexion';
    const description = (args.description  as string) || 'Sin descripción';
    const mapped      = ISSUE_TYPE_MAP[issueType] ?? ISSUE_TYPE_MAP.sin_conexion;

    try {
      const ticket = await this.ticketRepo.createTicket({
        ClientId:         session.clientId!,
        Subject:          this.ticketRepo.buildTicketSubject({
          type:       mapped.type,
          tbnCode:    session.tbnCode    || 'NUEVO',
          clientName: session.clientName || 'Cliente',
          priority:   mapped.priority,
        }),
        Type:             mapped.type,
        Priority:         mapped.priority,
        Description:      `Reporte via WhatsApp (bot IA): ${description}`,
        SlaDurationHours: mapped.slaHours,
        Origin:           'Bot',
        AutoAssign:       true,
      });

      const ticketRef = ticket.TicketNumber ?? ticket.Id;
      await this.sessionService.updateSession(session.phoneNumber, { activeTicketId: ticket.Id });

      if (mapped.priority === 'Alta') {
        await this.adminNotifier.notifyHighPriorityTicket({
          phoneNumber: session.phoneNumber,
          clientName:  session.clientName ?? 'Desconocido',
          ticketId:    ticketRef,
          description,
        });
      } else {
        await this.adminNotifier.notifyTicketCreated({
          phoneNumber: session.phoneNumber,
          clientName:  session.clientName ?? 'Desconocido',
          ticketId:    ticketRef,
          priority:    mapped.priority,
        });
      }

      return {
        created:      true,
        ticketNumber: ticketRef,
        priority:     mapped.priority,
        slaHours:     mapped.slaHours,
        issueType,
        message:
          `Ticket ${ticketRef} registrado con prioridad ${mapped.priority}. ` +
          `Un técnico se pondrá en contacto contigo en las próximas ${mapped.slaHours} horas.`,
      };
    } catch (err: any) {
      this.logger.error(`CreateSupportTicketTool error: ${err.message}`);
      return { created: false, error: `No se pudo crear el ticket: ${err.message}` };
    }
  }
}
