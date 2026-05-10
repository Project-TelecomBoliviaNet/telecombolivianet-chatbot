import { Injectable } from '@nestjs/common';
import { OcrResult } from './ocr-extractor.service';

export type ReceiptVerdict = 'YES' | 'NO' | 'AMBIGUOUS';
export type ReceiptType    = 'bank' | 'cash' | 'unknown';

export interface ClassificationResult {
  verdict:     ReceiptVerdict;
  receiptType: ReceiptType;
}

// Listas de palabras clave configurables — facilitan extensión sin
// modificar la lógica de clasificación (OCP).
const BANK_KEYWORDS: readonly string[] = [
  'transferencia', 'depósito', 'deposito', 'comprobante de pago',
  'pago qr', 'qr simple', 'qr factura', 'tigo money',
  'operacion', 'operación', 'transaccion', 'transacción',
];

const CASH_KEYWORDS: readonly string[] = [
  'recibo', 'recibo de pago', 'recibo de cobro',
  'efectivo', 'cancelado', 'cancelada', 'cancelar',
  'cobrado', 'cobrador', 'cobro',
  'telecom', 'bolivianet',
  'mensualidad', 'servicio de internet', 'servicio internet',
];

const NOT_RECEIPT_KEYWORDS: readonly string[] = [
  'whatsapp', 'instagram', 'facebook', 'twitter', 'tiktok', 'youtube',
  'me gusta', 'like', 'compartir', 'seguir', 'reels', 'historia',
  'km/h', 'velocidad',
  'temperatura', 'humedad',
  'puntos', 'nivel', 'score', 'jugador',
];

@Injectable()
export class ReceiptClassifierService {

  classify(ocr: OcrResult, caption: string | undefined): ClassificationResult {
    const combined = `${ocr.rawText} ${caption ?? ''}`.toLowerCase();

    if (ocr.bank || ocr.amount) {
      return { verdict: 'YES', receiptType: ocr.bank ? 'bank' : 'unknown' };
    }

    if (BANK_KEYWORDS.some(kw => combined.includes(kw))) {
      return { verdict: 'YES', receiptType: 'bank' };
    }

    if (CASH_KEYWORDS.some(kw => combined.includes(kw))) {
      return { verdict: 'YES', receiptType: 'cash' };
    }

    if (combined.trim().length < 20) {
      return { verdict: 'NO', receiptType: 'unknown' };
    }

    if (NOT_RECEIPT_KEYWORDS.some(kw => combined.includes(kw))) {
      return { verdict: 'NO', receiptType: 'unknown' };
    }

    return { verdict: 'AMBIGUOUS', receiptType: 'unknown' };
  }
}
