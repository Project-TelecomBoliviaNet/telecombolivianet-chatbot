import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IInstallationRepository, INSTALLATION_REPOSITORY } from '../../client/sistema-api.interfaces';
import { SessionData } from '../../session/session.service';
import { AgentTool } from './agent-tool.interface';

@Injectable()
export class GetInstallationSlotsTool implements AgentTool {
  private readonly logger = new Logger(GetInstallationSlotsTool.name);

  constructor(
    private readonly config: ConfigService,
    @Inject(INSTALLATION_REPOSITORY) private readonly installationRepo: IInstallationRepository,
  ) {}

  getName(): string { return 'get_installation_slots'; }
  requiresIdentification(): boolean { return false; }

  getDeclaration(): object {
    return {
      name: this.getName(),
      description:
        'Obtiene los horarios disponibles para instalación. ' +
        'Llamar DESPUÉS de check_coverage cuando el cliente quiera contratar el servicio.',
      parameters: { type: 'OBJECT', properties: {}, required: [] },
    };
  }

  async execute(_args: Record<string, unknown>, _session: SessionData): Promise<unknown> {
    const daysAhead = this.config.get<number>('bot.installationDaysAhead') ?? 7;

    try {
      const slots = await this.installationRepo.getInstallationSlots(daysAhead);

      if (slots.length === 0) {
        return {
          available: false,
          message:   'No hay horarios disponibles para los próximos días. Se puede contactar al admin.',
        };
      }

      return {
        available:  true,
        slotCount:  slots.length,
        slots:      slots.map((s) => ({
          date:      s.Fecha,
          time:      s.HoraInicio,
          remaining: s.Disponibles,
        })),
      };
    } catch (err: any) {
      this.logger.error(`GetInstallationSlotsTool error: ${err.message}`);
      return { available: false, error: `No se pudieron obtener los horarios: ${err.message}` };
    }
  }
}
