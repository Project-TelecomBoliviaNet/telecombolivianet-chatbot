import { Injectable, Logger } from '@nestjs/common';
import { RagService } from '../../rag/rag.service';
import { SessionService, SessionData } from '../../session/session.service';
import { AgentTool } from './agent-tool.interface';

@Injectable()
export class CheckCoverageTool implements AgentTool {
  private readonly logger = new Logger(CheckCoverageTool.name);

  constructor(
    private readonly ragService:     RagService,
    private readonly sessionService: SessionService,
  ) {}

  getName(): string { return 'check_coverage'; }
  requiresIdentification(): boolean { return false; }

  getDeclaration(): object {
    return {
      name: this.getName(),
      description:
        'Verifica si hay cobertura de fibra óptica en la dirección o zona del cliente. ' +
        'SIEMPRE llamar como PRIMER paso cuando el cliente quiera instalar el servicio, ' +
        'antes de mostrar horarios o agendar. ' +
        'Si el cliente compartió ubicación GPS, usarla como address. ' +
        'Devuelve covered:true (hay cobertura → proceder), ' +
        'covered:false (sin cobertura → NO agendar, informar al cliente), ' +
        'covered:"unverified" (zona no registrada → NO agendar, escalar con agente).',
      parameters: {
        type: 'OBJECT',
        properties: {
          address: {
            type: 'STRING',
            description: 'Dirección, zona o barrio a verificar (ej: "Calle Tumusla esq. Potosí", "barrio norte")',
          },
        },
        required: ['address'],
      },
    };
  }

  async execute(args: Record<string, unknown>, session: SessionData): Promise<unknown> {
    const address = ((args.address as string) || '').trim();
    if (!address) return { error: 'Se requiere una dirección para verificar cobertura.' };

    const gpsHint = session.lastLocation
      ? ` (GPS lat=${session.lastLocation.lat}, lng=${session.lastLocation.lng})`
      : '';

    try {
      const contextText = await this.sessionService.getContextText(session.phoneNumber);
      const result = await this.ragService.query(
        `cobertura fibra óptica zona ${address}${gpsHint}`,
        contextText,
      );

      if (result.found && result.answer) {
        return { covered: true, address, source: 'base_conocimiento', message: result.answer };
      }
    } catch (err: any) {
      this.logger.warn(`CheckCoverageTool RAG error: ${err.message}`);
    }

    return {
      covered: 'unverified',
      address,
      message:
        `La zona "${address}" no está registrada en nuestra base de cobertura. ` +
        `Es necesario que un técnico verifique si hay disponibilidad de fibra óptica en el área. ` +
        `Se recomienda conectar al cliente con un agente para coordinar la verificación.`,
    };
  }
}
