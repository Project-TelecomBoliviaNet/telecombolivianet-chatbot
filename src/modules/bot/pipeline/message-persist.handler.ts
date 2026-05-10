import { Injectable } from '@nestjs/common';
import { SessionService } from '../../session/session.service';
import { MessagePersistenceService } from './message-persistence.service';
import { MessageContext } from './message-context';
import { MessageHandler } from './message-handler';

/**
 * FIX-21: Persiste el mensaje entrante del usuario en Redis + BD,
 * y detecta si es el primer contacto (para el menú de bienvenida).
 */
@Injectable()
export class MessagePersistHandler implements MessageHandler {
  constructor(
    private readonly session:     SessionService,
    private readonly persistence: MessagePersistenceService,
  ) {}

  async handle(ctx: MessageContext, next: () => Promise<void>): Promise<void> {
    ctx.isFirstContact = ctx.session!.messages.length === 0;

    await this.session.addMessage(ctx.phone, 'user', ctx.userContent!);
    await this.persistence.persistMessage(
      ctx.session!, 'user', ctx.userContent!,
      null, undefined,
      ctx.incomingMediaUrl, ctx.incomingMediaType,
    );

    await next();
  }
}
