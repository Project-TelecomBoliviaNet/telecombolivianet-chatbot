import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  IClientRepository, CLIENT_REPOSITORY,
  IPaymentRepository, PAYMENT_REPOSITORY,
} from '../../client/sistema-api.interfaces';
import { WhatsappApiService } from '../../whatsapp/whatsapp-api.service';
import { MediaStorageService } from '../../media/media-storage.service';
import { SessionData } from '../../session/session.service';
import { AgentTool } from './agent-tool.interface';

@Injectable()
export class SendPaymentQrTool implements AgentTool {
  private readonly logger = new Logger(SendPaymentQrTool.name);
  constructor(
    private readonly config:                                  ConfigService,
    @Inject(CLIENT_REPOSITORY)  private readonly clientRepo:  IClientRepository,
    @Inject(PAYMENT_REPOSITORY) private readonly paymentRepo: IPaymentRepository,
    private readonly whatsapp:       WhatsappApiService,
    private readonly mediaStorage:   MediaStorageService,
  ) {}

  getName(): string { return 'send_payment_qr'; }
  requiresIdentification(): boolean { return true; }

  getDeclaration(): object {
    return {
      name: this.getName(),
      description: 'Envía el código QR de pago al cliente. Usar cuando quiera pagar o pida el código QR.',
      parameters: { type: 'OBJECT', properties: {}, required: [] },
    };
  }

  async execute(_args: Record<string, unknown>, session: SessionData): Promise<unknown> {
    let freshDebt = 0;
    try {
      const pending = await this.clientRepo.getPendingInvoices(session.clientId!);
      freshDebt = pending.reduce((sum, inv) => sum + inv.Amount, 0);
    } catch (err: any) {
      this.logger.warn(`No se pudo verificar deuda, usando valor de sesión: ${err.message}`);
      freshDebt = session.totalDebt;
    }

    if (freshDebt <= 0) {
      return {
        sent:   false,
        reason: 'El cliente no tiene deuda pendiente — no es necesario enviar QR.',
      };
    }

    const storagePublicUrl = this.config.get<string>('storage.publicUrl') || '';
    if (!storagePublicUrl) {
      this.logger.warn('STORAGE_PUBLIC_URL no configurada: no se puede enviar imagen QR a Meta');
      return {
        sent:   false,
        reason:
          'La URL pública del servidor no está configurada. ' +
          'Indica al cliente que puede comunicarse con el equipo de atención para recibir su QR de pago.',
      };
    }

    try {
      const qrBuffer = await this.paymentRepo.getCompanyQrBuffer();
      const imageUrl = await this.mediaStorage.saveMedia(
        qrBuffer, 'image', `qr_${session.tbnCode || session.clientId}`,
      );

      const caption =
        `📋 *Código QR de pago — TelecomBoliviaNet*\n\n` +
        `Tu saldo pendiente es: *Bs. ${freshDebt.toFixed(2)}*\n\n` +
        `Escanea este QR con tu aplicación bancaria e ingresa el monto correspondiente.\n\n` +
        `✅ Una vez realizado el pago, envíanos el *comprobante* como imagen para registrarlo.`;

      await this.whatsapp.sendImage(session.phoneNumber, imageUrl, caption);

      return {
        sent:       true,
        totalDebt:  freshDebt,
        clientName: session.clientName,
        message:    'Imagen QR enviada con instrucciones de comprobante.',
        _localUrl:  imageUrl,
      };
    } catch (err: any) {
      if (err.response?.status === 404) {
        return {
          sent:   false,
          reason:
            'El código QR de pago aún no está configurado en el sistema. ' +
            'Comunícate con atención al cliente para que te lo proporcionen.',
        };
      }
      this.logger.error(`SendPaymentQrTool error: ${err.message}`);
      return { sent: false, error: `No se pudo enviar el QR: ${err.message}` };
    }
  }
}
