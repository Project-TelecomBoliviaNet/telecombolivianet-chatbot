import { SessionData } from '../../session/session.service';

export const AGENT_TOOLS   = Symbol('AGENT_TOOLS');
export const ESCALATE_TOOL = 'escalate_to_agent';

export interface AgentTool {
  getName(): string;
  requiresIdentification(): boolean;
  getDeclaration(): object;
  execute(args: Record<string, unknown>, session: SessionData): Promise<unknown>;
}
