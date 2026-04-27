import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SessionData } from '../../session/session.service';
import { SistemaApiService } from '../../client/sistema-api.service';
import { WhatsappApiService } from '../../whatsapp/whatsapp-api.service';
import { MessageFormatterService } from '../message-formatter.service';
import { ReceiptHandlerService } from '../../payments/receipt-handler.service';
import { MessageSource } from '../../../database/entities/message.entity';

// ══════════════════════════════════════════════════════════════
// PAYMENT HANDLER — US-03, US-04, US-05, US-06
//
// Responsabilidad única: toda la lógica de pagos.
//   - Consulta de deuda (US-03)
//   - Información de período de pago (US-04)
//   - Generación y envío de QR (US-05)
//   - Procesamiento de comprobante con Gemini Vision (US-06)
// ══════════════════════════════════════════════════════════════

@Injectable()
export class PaymentHandler {
  private readonly logger = new Logger(PaymentHandler.name);

  constructor(
    private readonly config: ConfigService,
    private readonly sistemaApi: SistemaApiService,
    private readonly whatsapp: WhatsappApiService,
    private readonly formatter: MessageFormatterService,
    private readonly receiptHandler: ReceiptHandlerService,
  ) {}

  // ─── Consulta de deuda (US-03) ────────────────────────────
  async handleDebt(session: SessionData, send: SendFn): Promise<void> {
    try {
      const invoices = await this.sistemaApi.getPendingInvoices(session.clientId);
      await send(this.formatter.debtSummary(session.clientName, invoices), MessageSource.INTENT);
    } catch (err) {
      this.logger.error(`handleDebt error: ${err.message}`);
      await send('😔 No pude obtener tu información de deuda. Por favor intenta de nuevo.');
    }
  }

  // ─── Período de pago (US-04) ──────────────────────────────
  async handlePaymentPeriodInfo(session: SessionData, send: SendFn): Promise<void> {
    const dayOfMonth = new Date().getDate();

    if (session.clientId) {
      try {
        const invoices = await this.sistemaApi.getPendingInvoices(session.clientId);
        await send(
          this.formatter.paymentPeriodWithDebt(session.clientName, invoices, dayOfMonth),
          MessageSource.INTENT,
        );
        return;
      } catch {
        // Si falla la API, respondemos con info general
      }
    }

    await send(this.formatter.paymentPeriodInfo(dayOfMonth), MessageSource.INTENT);
  }

  // ─── QR de pago (US-05) ───────────────────────────────────
  async handleQr(session: SessionData, send: SendFn): Promise<void> {
    try {
      if (session.clientStatus === 'Suspendido') {
        await send(
          this.formatter.suspendedClientQr(session.clientName, session.totalDebt),
          MessageSource.INTENT,
        );
      } else if (session.totalDebt <= 0) {
        await send(this.formatter.noDebtForQr(session.clientName), MessageSource.INTENT);
        return;
      } else {
        const invoices = await this.sistemaApi.getPendingInvoices(session.clientId);
        await send(this.formatter.debtSummary(session.clientName, invoices), MessageSource.INTENT);
      }

      const qrBuffer = await this.sistemaApi.getCompanyQrBuffer();

      const fs = await import('fs');
      const path = await import('path');
      const uploadDir = this.config.get<string>('storage.localPath') || './uploads';
      fs.mkdirSync(uploadDir, { recursive: true });
      const fileName = `qr_${session.tbnCode}_${Date.now()}.png`;
      const filePath = path.join(uploadDir, fileName);
      fs.writeFileSync(filePath, qrBuffer);
      const port = this.config.get<number>('app.port') || 3001;
      const qrPublicUrl = `http://localhost:${port}/uploads/${fileName}`;

      await this.whatsapp.sendImage(
        session.phoneNumber,
        qrPublicUrl,
        `QR de pago — ${session.clientName}`,
      );
      await send(
        this.formatter.qrInstruction(session.clientName, session.tbnCode, session.totalDebt),
        MessageSource.INTENT,
      );
    } catch (err) {
      this.logger.error(`handleQr error: ${err.message}`);
      await send('😔 No pude generar el QR. Por favor intenta de nuevo o contáctanos.');
    }
  }

  // ─── Comprobante de pago (US-06) ──────────────────────────
  async handleReceipt(
    imageId: string,
    caption: string | undefined,
    session: SessionData,
    send: SendFn,
  ): Promise<void> {
    const ocrResult = await this.receiptHandler.handle(imageId, caption, session);

    if (!ocrResult) {
      await send('😔 Hubo un problema al procesar tu comprobante. Por favor envíalo de nuevo o contáctanos.');
      return;
    }

    const isKnownClient = session.clientName && session.clientName !== '__prospect__';
    if (isKnownClient) {
      await send(
        this.formatter.receiptReceivedWithOcr(
          session.clientName,
          ocrResult.amount,
          ocrResult.bank,
          ocrResult.date,
        ),
        MessageSource.INTENT,
      );
    } else {
      await send(this.formatter.receiptReceivedUnknown(), MessageSource.INTENT);
    }
  }
}

// Tipo del callback de envío inyectado por el orquestador
export type SendFn = (text: string, source?: MessageSource, chunkId?: string) => Promise<void>;
