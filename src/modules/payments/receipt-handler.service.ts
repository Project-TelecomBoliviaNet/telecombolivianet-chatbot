import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import { WhatsappApiService } from '../whatsapp/whatsapp-api.service';
import { IPaymentRepository, PAYMENT_REPOSITORY } from '../client/sistema-api.interfaces';
import { SessionData } from '../session/session.service';
import { OcrExtractorService, OcrResult } from './ocr-extractor.service';
import { ReceiptClassifierService } from './receipt-classifier.service';

// Re-exportar OcrResult para compatibilidad con BotOrchestratorService
export { OcrResult };
export type ReceiptType = 'bank' | 'cash' | 'unknown';

// ══════════════════════════════════════════════════════════════
// RECEIPT HANDLER SERVICE (US-06)
//
// Orquesta el flujo de comprobantes:
//   1. Descarga imagen de Meta (WhatsappApiService)
//   2. Extrae texto via OCR (OcrExtractorService)
//   3. Clasifica si es comprobante (ReceiptClassifierService)
//   4. Guarda imagen en almacenamiento local
//   5. Registra en sistema C# (SistemaApiService)
// ══════════════════════════════════════════════════════════════

@Injectable()
export class ReceiptHandlerService {
  private readonly logger = new Logger(ReceiptHandlerService.name);
  private readonly storageType: string;
  private readonly localPath: string;

  constructor(
    private readonly config:      ConfigService,
    private readonly whatsappApi: WhatsappApiService,
    @Inject(PAYMENT_REPOSITORY) private readonly paymentRepo: IPaymentRepository,
    private readonly ocr:         OcrExtractorService,
    private readonly classifier:  ReceiptClassifierService,
  ) {
    this.storageType = config.get<string>('storage.type') ?? 'local';
    this.localPath   = config.get<string>('storage.localPath') ?? './uploads';

    if (this.storageType === 'local') {
      fs.mkdirSync(this.localPath, { recursive: true });
    }
  }

  async handle(
    imageId:  string,
    caption:  string | undefined,
    session:  SessionData,
  ): Promise<OcrResult | null> {
    try {
      this.logger.debug(`Descargando imagen ${imageId}`);
      const imageBuffer = await this.whatsappApi.downloadMedia(imageId);

      const ocrResult = await this.ocr.extract(imageBuffer);
      this.logger.debug(`OCR: monto=${ocrResult.amount}, banco=${ocrResult.bank}`);

      const scored = this.classifier.classify(ocrResult, caption);

      let isReceipt:   boolean;
      let receiptType: ReceiptType = scored.receiptType;

      if (scored.verdict === 'YES') {
        isReceipt = true;
        this.logger.debug(`OCR confirmó comprobante (tipo: ${receiptType})`);
      } else if (scored.verdict === 'NO') {
        isReceipt = false;
        this.logger.log(`Imagen ${imageId} rechazada por OCR: sin contenido de pago`);
      } else {
        isReceipt = true;
        receiptType = 'unknown';
        ocrResult.rawText = `[VERIFICAR] ${ocrResult.rawText}`.trim();
        this.logger.log(`Imagen ${imageId} ambigua — enviada a cola para revisión manual`);
      }

      if (!isReceipt) {
        return { rawText: ocrResult.rawText, amount: null, bank: null, date: null, isReceipt: false, receiptType: 'unknown' };
      }

      const fileName = `comprobante_${uuidv4()}.jpg`;
      const imageUrl = await this.saveImage(imageBuffer, fileName);

      const typeTag       = receiptType === 'cash' ? '[RECIBO_EFECTIVO]' : '';
      const rawTextTagged = `${typeTag}${ocrResult.rawText}`.substring(0, 1000);

      await this.paymentRepo.submitWhatsappReceipt({
        ClientId:       session.clientId,
        ImageUrl:       imageUrl,
        MessageText:    caption || ocrResult.rawText.substring(0, 500),
        DeclaredAmount: ocrResult.amount,
        OcrBank:        ocrResult.bank,
        OcrDate:        ocrResult.date,
        OcrRawText:     rawTextTagged,
        PhoneNumber:    session.phoneNumber,
      });

      return { ...ocrResult, isReceipt: true, receiptType };
    } catch (err) {
      this.logger.error(`Error procesando comprobante: ${(err as Error).message}`, (err as Error).stack);
      return null;
    }
  }

  private async saveImage(buffer: Buffer, fileName: string): Promise<string> {
    if (this.storageType === 'supabase') {
      const supabaseUrl    = (this.config.get<string>('storage.supabase.url') || '').replace(/\/$/, '');
      const supabaseKey    =  this.config.get<string>('storage.supabase.key') || '';
      const supabaseBucket =  this.config.get<string>('storage.supabase.bucket') || 'chatbot-uploads';

      const uploadUrl = `${supabaseUrl}/storage/v1/object/${supabaseBucket}/${fileName}`;
      await axios.post(uploadUrl, buffer, {
        headers: {
          Authorization: `Bearer ${supabaseKey}`,
          'Content-Type': 'image/jpeg',
        },
        maxBodyLength: Infinity,
      });
      return `${supabaseUrl}/storage/v1/object/public/${supabaseBucket}/${fileName}`;
    }

    // Modo local: ruta relativa /chatbot-uploads/<file> — Nginx la proxea a chatbot:3001/uploads/
    const filePath = path.join(this.localPath, fileName);
    fs.mkdirSync(this.localPath, { recursive: true });
    fs.writeFileSync(filePath, buffer);
    return `/chatbot-uploads/${fileName}`;
  }
}
