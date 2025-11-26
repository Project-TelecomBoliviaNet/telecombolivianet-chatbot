import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Conversation } from '../../../database/entities/conversation.entity';
import { Message, MessageRole, MessageSource } from '../../../database/entities/message.entity';
import { SessionData } from '../../session/session.service';

/**
 * FIX-21: Servicio compartido de persistencia de mensajes.
 * Extrae la lógica de convRepo + msgRepo del orquestador para que
 * los handlers del pipeline puedan persistir mensajes sin depender
 * directamente del orquestador.
 */
@Injectable()
export class MessagePersistenceService {
  private readonly logger = new Logger(MessagePersistenceService.name);

  constructor(
    @InjectRepository(Conversation) private readonly convRepo: Repository<Conversation>,
    @InjectRepository(Message)      private readonly msgRepo:  Repository<Message>,
  ) {}

  async persistMessage(
    session: SessionData,
    role: 'user' | 'bot' | 'admin',
    content: string,
    source: MessageSource | null,
    chunkId?: string,
    mediaUrl?: string,
    mediaType?: string,
  ): Promise<void> {
    try {
      let conv = await this.convRepo.findOne({ where: { phoneNumber: session.phoneNumber } });
      if (!conv) {
        conv = this.convRepo.create({ phoneNumber: session.phoneNumber });
        conv = await this.convRepo.save(conv);
      }

      await this.msgRepo.save(
        this.msgRepo.create({
          conversationId: conv.id,
          role:           role as MessageRole,
          content,
          source,
          chunkId:        chunkId   || null,
          mediaUrl:       mediaUrl  || null,
          mediaType:      mediaType || null,
        }),
      );
    } catch (err) {
      this.logger.error(`Error persistiendo mensaje para ${session.phoneNumber}: ${(err as Error).message}`);
    }
  }
}
