import { Injectable, Inject } from '@nestjs/common';
import { SessionData } from '../../session/session.service';
import { ToolExecutor } from '../agent.service';
import { AgentTool, AGENT_TOOLS } from './agent-tool.interface';

export interface BotMediaSent {
  localUrl:  string;
  mediaType: 'image' | 'audio';
}

// ══════════════════════════════════════════════════════════════
// AGENT TOOL REGISTRY (FIX-22: Command Pattern)
//
// Sustituye el switch de 678 líneas de ToolRegistryService por
// un Map de objetos Command independientes.
//
// buildExecutor(session) → { executor, getMediaSent }
//   Misma interfaz que el antiguo ToolRegistryService para que
//   BotOrchestratorService no requiera cambios en su lógica.
//
// La validación requiresIdentification() está centralizada aquí:
//   si el tool lo requiere y session.clientId es null, el registry
//   devuelve un error uniforme sin delegar al tool.
// ══════════════════════════════════════════════════════════════

@Injectable()
export class AgentToolRegistry {
  private readonly tools: Map<string, AgentTool>;

  constructor(@Inject(AGENT_TOOLS) tools: AgentTool[]) {
    this.tools = new Map(tools.map((t) => [t.getName(), t]));
  }

  getDeclarations(): object[] {
    return [...this.tools.values()].map((t) => t.getDeclaration());
  }

  buildExecutor(
    session: SessionData,
  ): { executor: ToolExecutor; getMediaSent: () => BotMediaSent[] } {
    const mediaSent: BotMediaSent[] = [];

    const executor: ToolExecutor = async (name: string, args: Record<string, any>) => {
      const tool = this.tools.get(name);
      if (!tool) throw new Error(`Herramienta desconocida: ${name}`);

      if (tool.requiresIdentification() && !session.clientId) {
        return { error: 'Por favor identifícate primero para continuar.' };
      }

      const result = (await tool.execute(args, session)) as Record<string, unknown>;

      if (result?.['_localUrl']) {
        mediaSent.push({ localUrl: result['_localUrl'] as string, mediaType: 'image' });
      }

      return result;
    };

    return { executor, getMediaSent: () => mediaSent };
  }
}
