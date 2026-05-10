import { Injectable, Logger } from '@nestjs/common';
import { WhatsappApiService } from '../../whatsapp/whatsapp-api.service';
import { MediaStorageService } from '../../media/media-storage.service';
import { MessageContext } from './message-context';
import { MessageHandler } from './message-handler';

@Injectable()
export class MediaDownloadHandler implements MessageHandler {
  private readonly logger = new Logger(MediaDownloadHandler.name);

  constructor(
    private readonly whatsapp: WhatsappApiService,
    private readonly mediaStorage: MediaStorageService,
  ) {}

  async handle(ctx: MessageContext, next: () => Promise<void>): Promise<void> {
    if (ctx.type === 'audio' && ctx.audioId) {
      try {
        ctx.audioBuffer   = await this.whatsapp.downloadMedia(ctx.audioId);
        ctx.audioMediaUrl = await this.mediaStorage.saveMedia(ctx.audioBuffer, 'audio', ctx.audioId);
      } catch (err) {
        this.logger.error(`Error descargando audio ${ctx.audioId}: ${String(err)}`);
        ctx.audioBuffer = null;
      }
    }

    if (ctx.type === 'image' && ctx.imageId) {
      try {
        const buf        = await this.whatsapp.downloadMedia(ctx.imageId);
        ctx.imageMediaUrl = await this.mediaStorage.saveMedia(buf, 'image', ctx.imageId);
      } catch (err) {
        this.logger.error(`Error descargando imagen ${ctx.imageId}: ${String(err)}`);
      }
    }

    ctx.locationText = (ctx.type === 'location' && ctx.locationLat != null && ctx.locationLng != null)
      ? `📍 Ubicación: https://maps.google.com/?q=${ctx.locationLat},${ctx.locationLng}` +
        (ctx.locationName    ? `\n📌 ${ctx.locationName}`    : '') +
        (ctx.locationAddress ? `\n🏠 ${ctx.locationAddress}` : '')
      : null;

    ctx.userContent = ctx.locationText
      ?? ctx.text
      ?? (ctx.imageId ? (ctx.imageCaption || '[imagen]') : ctx.audioId ? '🎤 Nota de voz' : '[media]');

    ctx.incomingMediaUrl  = ctx.imageMediaUrl ?? ctx.audioMediaUrl;
    ctx.incomingMediaType = ctx.imageMediaUrl ? 'image' : ctx.audioId ? 'audio' : undefined;

    await next();
  }
}
