import { Inject, Injectable, Logger } from '@nestjs/common';
import { IPlanRepository, PLAN_REPOSITORY } from '../../client/sistema-api.interfaces';
import { SessionData } from '../../session/session.service';
import { AgentTool } from './agent-tool.interface';

@Injectable()
export class GetAvailablePlansTool implements AgentTool {
  private readonly logger = new Logger(GetAvailablePlansTool.name);

  constructor(
    @Inject(PLAN_REPOSITORY) private readonly planRepo: IPlanRepository,
  ) {}

  getName(): string { return 'get_available_plans'; }
  requiresIdentification(): boolean { return false; }

  getDeclaration(): object {
    return {
      name: this.getName(),
      description:
        'Obtiene los planes de internet disponibles con nombres, velocidades y precios actuales. ' +
        'Usar SIEMPRE que el cliente pregunte qué planes hay, cuánto cuestan, qué velocidades ofrecen, ' +
        'o cuando necesite elegir un plan para instalación o cambio de plan.',
      parameters: { type: 'OBJECT', properties: {}, required: [] },
    };
  }

  async execute(_args: Record<string, unknown>, _session: SessionData): Promise<unknown> {
    try {
      const plans = await this.planRepo.getActivePlans();

      if (plans.length === 0) {
        return {
          available: false,
          message:   'No hay planes disponibles en este momento. Contacta a un agente para más información.',
        };
      }

      return {
        available: true,
        plans: plans.map((p) => ({
          id:           p.Id,
          name:         p.Name,
          speedMbps:    p.SpeedMbps,
          priceMonthly: p.PriceMonthly,
        })),
      };
    } catch (err: any) {
      this.logger.error(`GetAvailablePlansTool error: ${err.message}`);
      return { available: false, error: `No se pudieron obtener los planes: ${err.message}` };
    }
  }
}
