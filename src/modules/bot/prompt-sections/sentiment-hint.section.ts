import { Injectable } from '@nestjs/common';
import { SessionData } from '../../session/session.service';
import { IPromptSection } from './prompt-section.interface';

@Injectable()
export class SentimentHintSection implements IPromptSection {
  applies(session: SessionData): boolean {
    return session.lastSentiment === 'angry' || session.lastSentiment === 'frustrated';
  }

  render(session: SessionData): string {
    if (session.lastSentiment === 'angry' && session.angryCount >= 2) {
      return `⚠️ ATENCIÓN: El cliente está muy enojado (${session.angryCount} mensajes consecutivos).\nMuestra empatía inmediata, reconoce su frustración, y ofrece transferir con un agente humano.`;
    }
    if (session.lastSentiment === 'frustrated') {
      return `NOTA: El cliente parece frustrado. Reconoce su malestar antes de dar información técnica.`;
    }
    return '';
  }
}
