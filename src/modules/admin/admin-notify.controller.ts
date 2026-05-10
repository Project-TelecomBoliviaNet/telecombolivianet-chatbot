import {
  Controller, Post, Body, Headers, UnauthorizedException, Logger, Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SessionService } from '../session/session.service';
import { WhatsappApiService } from '../whatsapp/whatsapp-api.service';
import { MessageFormatterService } from '../bot/message-formatter.service';
import { IClientRepository, CLIENT_REPOSITORY } from '../client/sistema-api.interfaces';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { Conversation } from '../../database/entities/conversation.entity';
import { Message, MessageRole, MessageSource } from '../../database/entities/message.entity';

// ══════════════════════════════════════════════════════════════
// ADMIN NOTIFY CONTROLLER
// Endpoint para que el sistema C# envíe eventos al bot:
// - POST /bot/notify-client → mensajes personalizados del admin
//   (cancelación de instalación por admin, mensajes libres)
//
// NOTA: Aprobación/Rechazo de comprobantes NO pasa por aquí.
// El WhatsAppReceiptService de C# envía esos mensajes directo.
// ══════════════════════════════════════════════════════════════

export enum BotEventType {
  INSTALLATION_CANCELLED = 'INSTALLATION_CANCELLED',
  CUSTOM_MESSAGE = 'CUSTOM_MESSAGE',
  BOT_RESUME = 'BOT_RESUME',
}

export interface NotifyClientDto {
  PhoneNumber: string;
  EventType: BotEventType;
  AgentName?: string;
  Metadata?: {
    Message?: string;
    Reason?: string;
    InstallationDate?: string;
  };
}

@Controller('bot')
export class AdminNotifyController {
  private readonly logger = new Logger(AdminNotifyController.name);
  private readonly internalToken: string;

  constructor(
    private readonly config: ConfigService,
    private readonly session: SessionService,
    private readonly whatsapp: WhatsappApiService,
    private readonly formatter: MessageFormatterService,
    @Inject(CLIENT_REPOSITORY) private readonly clientRepo: IClientRepository,
    @InjectRepository(Conversation) private readonly convRepo: Repository<Conversation>,
    @InjectRepository(Message) private readonly msgRepo: Repository<Message>,
  ) {
    this.internalToken = config.get<string>('sistema.botStaticToken') ?? '';
  }

  private checkAuth(auth: string): void {
    if (!auth?.startsWith('Bearer ') || auth.slice(7) !== this.internalToken) {
      throw new UnauthorizedException('Token inválido');
    }
  }

  @Post('notify-client')
  async notifyClient(
    @Body() dto: NotifyClientDto,
    @Headers('authorization') auth: string,
  ): Promise<{ ok: boolean }> {
    this.checkAuth(auth);

    const { PhoneNumber, EventType, AgentName, Metadata } = dto;
    this.logger.log(`Notificación C# → Bot: ${EventType} para ${PhoneNumber}`);

    switch (EventType) {

      // ── Instalación cancelada por el admin ───────────────
      case BotEventType.INSTALLATION_CANCELLED: {
        const reason = Metadata?.Reason || 'motivo no especificado';
        const dateStr = Metadata?.InstallationDate ? ` del ${Metadata.InstallationDate}` : '';
        const msg =
          `⚠️ Tu instalación agendada${dateStr} fue cancelada por nuestro equipo.\n\n` +
          `*Motivo:* ${reason}\n\n` +
          `Disculpa los inconvenientes. ¿Deseas reagendar para otro horario disponible?`;

        await this.whatsapp.sendText(PhoneNumber, msg);
        await this.session.updateSession(PhoneNumber, { activeInstallationId: null });
        await this.persistAdminMessage(PhoneNumber, msg, AgentName);
        break;
      }

      // ── El admin devuelve el control al bot (US-19) ───────
      case BotEventType.BOT_RESUME: {
        await this.session.deescalate(PhoneNumber);
        await this.convRepo.update(
          { phoneNumber: PhoneNumber },
          { isEscalated: false, agentName: null },
        );

        await this.whatsapp.sendText(PhoneNumber, this.formatter.botResumed());
        break;
      }

      // ── Mensaje personalizado del admin al cliente (US-18) ─
      case BotEventType.CUSTOM_MESSAGE: {
        if (!Metadata?.Message) break;

        const agentLabel = AgentName ? `*${AgentName}:* ` : '';
        await this.whatsapp.sendText(PhoneNumber, `${agentLabel}${Metadata.Message}`);
        await this.persistAdminMessage(PhoneNumber, Metadata.Message, AgentName);
        break;
      }

      default:
        this.logger.warn(`EventType desconocido: ${EventType}`);
    }

    return { ok: true };
  }

  // ─── Backfill de nombres de cliente ──────────────────────────────────────
  // POST /bot/backfill-client-names
  // Actualiza client_name en Conversations para todos los registros sin nombre.
  // Operación idempotente — puede ejecutarse múltiples veces sin efecto secundario.
  @Post('backfill-client-names')
  async backfillClientNames(
    @Headers('authorization') auth: string,
  ): Promise<{ processed: number; updated: number; notFound: number }> {
    this.checkAuth(auth);

    const conversations = await this.convRepo.find({
      where: { clientName: IsNull() },
      select: ['id', 'phoneNumber'],
    });

    let updated = 0;
    let notFound = 0;

    for (const conv of conversations) {
      try {
        const client = await this.clientRepo.getClientByPhone(conv.phoneNumber);
        if (client?.FullName) {
          await this.convRepo.update({ id: conv.id }, {
            clientName: client.FullName,
            clientId:   client.Id,
          });
          updated++;
        } else {
          notFound++;
        }
      } catch (err) {
        this.logger.warn(`backfill: error para ${conv.phoneNumber}: ${err?.message}`);
        notFound++;
      }
    }

    this.logger.log(`backfill-client-names: processed=${conversations.length} updated=${updated} notFound=${notFound}`);
    return { processed: conversations.length, updated, notFound };
  }

  private async persistAdminMessage(
    phone: string,
    content: string,
    agentName?: string,
  ): Promise<void> {
    try {
      let conv = await this.convRepo.findOne({ where: { phoneNumber: phone } });
      if (!conv) {
        conv = await this.convRepo.save(this.convRepo.create({ phoneNumber: phone }));
      }

      if (agentName) {
        await this.convRepo.update({ id: conv.id }, { agentName });
      }

      await this.msgRepo.save(
        this.msgRepo.create({
          conversationId: conv.id,
          role: MessageRole.ADMIN,
          content,
          source: MessageSource.ADMIN,
        }),
      );
    } catch (err) {
      this.logger.error(`Error persistiendo mensaje admin: ${err.message}`);
    }
  }
}
