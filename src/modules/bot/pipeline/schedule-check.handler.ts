import { Injectable, Logger } from '@nestjs/common';
import { BotConfigCacheService, BotHorarioConfig } from '../bot-config-cache.service';
import { MessageSenderService } from './message-sender.service';
import { MessageContext } from './message-context';
import { MessageHandler } from './message-handler';

/**
 * FIX-21: Si el mensaje llega fuera del horario de atención configurado,
 * envía el mensaje de fuera de horario y detiene la cadena.
 */
@Injectable()
export class ScheduleCheckHandler implements MessageHandler {
  private readonly logger = new Logger(ScheduleCheckHandler.name);

  constructor(
    private readonly botConfigCache: BotConfigCacheService,
    private readonly sender:         MessageSenderService,
  ) {}

  async handle(ctx: MessageContext, next: () => Promise<void>): Promise<void> {
    const cfg = await this.botConfigCache.getConfig();
    if (!this.isWithinSchedule(cfg.Horario)) {
      await this.sender.send(ctx.session!, cfg.Horario.MensajeFueraHorario);
      this.logger.debug(`Mensaje fuera de horario enviado a ${ctx.phone}.`);
      return;
    }
    await next();
  }

  private isWithinSchedule(horario: BotHorarioConfig): boolean {
    const now      = new Date();
    const jsDay    = now.getDay();
    const cfgIndex = jsDay === 0 ? 6 : jsDay - 1;

    if (!horario.DiasActivos[cfgIndex]) return false;

    const [startH, startM] = horario.HoraInicio.split(':').map(Number);
    const [endH,   endM]   = horario.HoraFin.split(':').map(Number);
    const current          = now.getHours() * 60 + now.getMinutes();

    return current >= startH * 60 + startM && current < endH * 60 + endM;
  }
}
