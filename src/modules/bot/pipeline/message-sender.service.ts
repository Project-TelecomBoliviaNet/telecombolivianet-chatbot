import { Injectable, Logger } from '@nestjs/common';
import { SessionService, SessionData } from '../../session/session.service';
import { WhatsappApiService } from '../../whatsapp/whatsapp-api.service';
import { WhatsappOutboxService } from '../../whatsapp/whatsapp-outbox.service';
import { MessageSource } from '../../../database/entities/message.entity';
import { MessagePersistenceService } from './message-persistence.service';

/**
 * FIX-21: Encapsula el envío de mensajes al cliente con reintentos y fallback
 * al outbox. Extrae la lógica del método privado `send()` del orquestador.
 */
@Injectable()
export class MessageSenderService {
  private readonly logger = new Logger(MessageSenderService.name);

  constructor(
    private readonly session:      SessionService,
    private readonly whatsapp:     WhatsappApiService,
    private readonly outbox:       WhatsappOutboxService,
    private readonly persistence:  MessagePersistenceService,
  ) {}

  async send(
    session: SessionData,
    text: string,
    source: MessageSource = MessageSource.SYSTEM,
    chunkId?: string,
  ): Promise<void> {
    await this.session.addMessage(session.phoneNumber, 'bot', text);
    await this.persistence.persistMessage(session, 'bot', text, source, chunkId);

    try {
      await this.whatsapp.sendText(session.phoneNumber, text);
    } catch (primaryErr) {
      this.logger.error(JSON.stringify({
        event:  'whatsapp_primary_send_failed',
        phone:  session.phoneNumber,
        length: text.length,
        error:  String(primaryErr),
      }));

      await new Promise((r) => setTimeout(r, 5_000));
      try {
        await this.whatsapp.sendText(session.phoneNumber, text);
        this.logger.log(JSON.stringify({ event: 'whatsapp_send_recovered', phone: session.phoneNumber }));
      } catch {
        await this.outbox.enqueue(session.phoneNumber, text);
      }
    }
  }
}
