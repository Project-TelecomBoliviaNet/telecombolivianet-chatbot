import { Injectable, Logger } from '@nestjs/common';
import { RagService } from '../../rag/rag.service';
import { SessionService, SessionData } from '../../session/session.service';
import { AgentTool } from './agent-tool.interface';

@Injectable()
export class SearchKnowledgeBaseTool implements AgentTool {
  private readonly logger = new Logger(SearchKnowledgeBaseTool.name);

  constructor(
    private readonly ragService:     RagService,
    private readonly sessionService: SessionService,
  ) {}

  getName(): string { return 'search_knowledge_base'; }
  requiresIdentification(): boolean { return false; }

  getDeclaration(): object {
    return {
      name: this.getName(),
      description:
        'Busca información en la base de conocimiento de la empresa. ' +
        'Usar para preguntas sobre políticas, condiciones de servicio, ' +
        'pasos de soporte técnico documentado, cobertura, o preguntas informativas generales. ' +
        'Para precios y planes actuales usa get_available_plans (datos en tiempo real).',
      parameters: {
        type: 'OBJECT',
        properties: {
          query: {
            type: 'STRING',
            description: 'La pregunta o tema a buscar',
          },
        },
        required: ['query'],
      },
    };
  }

  async execute(args: Record<string, unknown>, session: SessionData): Promise<unknown> {
    const query = (args.query as string) || '';
    if (!query.trim()) return { found: false, error: 'Se requiere una consulta para buscar.' };

    try {
      const contextText = await this.sessionService.getContextText(session.phoneNumber);
      const result = await this.ragService.query(query, contextText);

      if (!result.found) {
        return {
          found:   false,
          message: 'No encontré información específica en la base de conocimiento para esa consulta.',
        };
      }

      return {
        found:      true,
        answer:     result.answer,
        chunkId:    result.chunkId,
        similarity: result.similarity,
      };
    } catch (err: any) {
      this.logger.error(`SearchKnowledgeBaseTool error: ${err.message}`);
      return { found: false, error: `Error en la búsqueda: ${err.message}` };
    }
  }
}
