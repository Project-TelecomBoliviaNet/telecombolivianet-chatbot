import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SessionService } from '../../session/session.service';
import { IClientRepository, CLIENT_REPOSITORY } from '../../client/sistema-api.interfaces';
import { Conversation } from '../../../database/entities/conversation.entity';
import { MessageContext } from './message-context';
import { MessageHandler } from './message-handler';

/**
 * FIX-21: Identifica el cliente por número de teléfono (consulta API backend)
 * y actualiza la sesión con sus datos. También guarda la ubicación si el
 * mensaje es de tipo location.
 */
@Injectable()
export class ClientIdentificationHandler implements MessageHandler {
  private readonly logger = new Logger(ClientIdentificationHandler.name);

  constructor(
    private readonly session: SessionService,
    @Inject(CLIENT_REPOSITORY) private readonly clientRepo: IClientRepository,
    @InjectRepository(Conversation) private readonly convRepo: Repository<Conversation>,
  ) {}

  async handle(ctx: MessageContext, next: () => Promise<void>): Promise<void> {
    ctx.updatedSession = await this.identifyClient(ctx.phone, ctx.session!);

    if (ctx.type === 'location' && ctx.locationLat != null && ctx.locationLng != null) {
      await this.session.updateSession(ctx.phone, {
        lastLocation: {
          lat:     ctx.locationLat,
          lng:     ctx.locationLng,
          name:    ctx.locationName,
          address: ctx.locationAddress,
        },
      });
    }

    await next();
  }

  private async identifyClient(phone: string, session: any): Promise<any> {
    const isKnown = session.clientId ||
      (session.clientId === null && session.clientName === '__prospect__');

    if (isKnown) {
      if (session.clientId && session.clientName && session.clientName !== '__prospect__') {
        this.convRepo.upsert(
          { phoneNumber: phone, clientId: session.clientId, clientName: session.clientName },
          ['phoneNumber'],
        ).catch((err) => this.logger.warn(`Sync clientName para ${phone}: ${err?.message}`));
      }
      return session;
    }

    try {
      const client = await this.clientRepo.getClientByPhone(phone);
      if (client) {
        await this.session.setClientData(phone, {
          clientId:     client.Id,
          clientName:   client.FullName,
          clientStatus: client.Status,
          planId:       client.PlanId,
          planName:     client.PlanName,
          totalDebt:    client.TotalDebt,
          tbnCode:      client.TbnCode,
        });
        await this.convRepo.upsert(
          { phoneNumber: phone, clientId: client.Id, clientName: client.FullName },
          ['phoneNumber'],
        );
        return this.session.getSession(phone);
      } else {
        await this.session.updateSession(phone, { clientName: '__prospect__' });
      }
    } catch (err) {
      this.logger.error(`Error identificando cliente ${phone}: ${(err as Error).message}`);
    }

    return this.session.getSession(phone);
  }
}
