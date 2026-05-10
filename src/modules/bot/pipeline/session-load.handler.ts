import { Injectable } from '@nestjs/common';
import { SessionService } from '../../session/session.service';
import { MessageContext } from './message-context';
import { MessageHandler } from './message-handler';

@Injectable()
export class SessionLoadHandler implements MessageHandler {
  constructor(private readonly session: SessionService) {}

  async handle(ctx: MessageContext, next: () => Promise<void>): Promise<void> {
    ctx.session = await this.session.getSession(ctx.phone);
    await next();
  }
}
