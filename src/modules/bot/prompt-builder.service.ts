import { Inject, Injectable } from '@nestjs/common';
import { SessionData } from '../session/session.service';
import { IPromptSection, PROMPT_SECTIONS } from './prompt-sections/prompt-section.interface';

@Injectable()
export class PromptBuilderService {

  constructor(
    @Inject(PROMPT_SECTIONS) private readonly sections: IPromptSection[],
  ) {}

  build(session: SessionData): string {
    return this.sections
      .filter(s => s.applies(session))
      .map(s => s.render(session))
      .filter(Boolean)
      .join('\n\n');
  }

  // Kept as public helper so AgentService tests that call it directly keep working.
  buildSentimentHint(sentiment: string, angryCount: number): string {
    if (sentiment === 'angry' && angryCount >= 2) {
      return `⚠️ ATENCIÓN: El cliente está muy enojado (${angryCount} mensajes consecutivos).\nMuestra empatía inmediata, reconoce su frustración, y ofrece transferir con un agente humano.`;
    }
    if (sentiment === 'frustrated') {
      return `NOTA: El cliente parece frustrado. Reconoce su malestar antes de dar información técnica.`;
    }
    return '';
  }
}
