import { Injectable, Logger } from '@nestjs/common';
import { SessionService } from '../../session/session.service';
import { MessageSource } from '../../../database/entities/message.entity';
import { MessagePersistenceService } from './message-persistence.service';
import { MessageContext } from './message-context';
import { MessageHandler } from './message-handler';

/**
 * FIX-21: Si la conversación está escalada a un agente humano, persiste el
 * mensaje del usuario y detiene la cadena (el bot permanece silenciado).
 */
@Injectable()
export class EscalationCheckHandler implements MessageHandler {
  private readonly logger = new Logger(EscalationCheckHandler.name);

  constructor(
    private readonly session:     SessionService,
    private readonly persistence: MessagePersistenceService,
  ) {}

  async handle(ctx: MessageContext, next: () => Promise<void>): Promise<void> {
    if (!ctx.session?.isEscalated) {
      await next();
      return;
    }

    await this.persistence.persistMessage(
      ctx.session, 'user', ctx.userContent!,
      MessageSource.ADMIN, undefined,
      ctx.incomingMediaUrl, ctx.incomingMediaType,
    );
    this.logger.debug(`Conversación ${ctx.phone} escalada. Bot silenciado.`);
  }
}
