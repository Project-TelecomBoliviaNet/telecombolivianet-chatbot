import { Injectable, Logger } from '@nestjs/common';
import { SessionData } from '../../session/session.service';
import { AgentTool, ESCALATE_TOOL } from './agent-tool.interface';

@Injectable()
export class EscalateToAgentTool implements AgentTool {
  private readonly logger = new Logger(EscalateToAgentTool.name);

  getName(): string { return ESCALATE_TOOL; }
  requiresIdentification(): boolean { return false; }

  getDeclaration(): object {
    return {
      name: this.getName(),
      description:
        'Transfiere la conversación a un agente humano. ' +
        'Usar ÚNICAMENTE en estos tres casos: ' +
        '(1) el cliente pide EXPLÍCITAMENTE hablar con una persona ("agente", "operadora", "humano", "persona real"); ' +
        '(2) el cliente está muy enojado por segunda vez consecutiva Y no hay solución posible con las herramientas; ' +
        '(3) check_coverage devuelve covered:"unverified" y el cliente quiere continuar. ' +
        'NUNCA escalar por errores de herramientas, problemas de API, o falta de información. ' +
        'Si una herramienta retorna { error } o falla: informa el error amigablemente y ofrece alternativas.',
      parameters: {
        type: 'OBJECT',
        properties: {
          reason: {
            type: 'STRING',
            description: 'Motivo de la escalación',
          },
        },
        required: [],
      },
    };
  }

  execute(args: Record<string, unknown>, _session: SessionData): Promise<unknown> {
    const reason = (args.reason as string) || 'Solicitud del cliente o situación no resuelta por el bot';
    this.logger.log(`Escalación solicitada por agente IA. Motivo: ${reason}`);
    return Promise.resolve({
      queued:  true,
      reason,
      message: 'Solicitud de transferencia a agente humano registrada.',
    });
  }
}
