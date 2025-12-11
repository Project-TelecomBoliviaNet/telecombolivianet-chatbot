import { Injectable, Logger } from '@nestjs/common';

export interface OcrResult {
  rawText:     string;
  amount:      number | null;
  bank:        string | null;
  date:        string | null;
  isReceipt:   boolean;
  receiptType: 'bank' | 'cash' | 'unknown';
}

@Injectable()
export class OcrExtractorService {
  private readonly logger = new Logger(OcrExtractorService.name);

  async extract(imageBuffer: Buffer): Promise<OcrResult> {
    try {
      const Tesseract = await import('tesseract.js');
      const { data } = await Tesseract.recognize(imageBuffer, 'spa+eng', {
        logger: () => {},
      });

      const text = data.text || '';
      return {
        rawText:     text,
        amount:      this.extractAmount(text),
        bank:        this.extractBank(text),
        date:        this.extractDate(text),
        isReceipt:   true,
        receiptType: 'unknown',
      };
    } catch (err) {
      this.logger.warn(`OCR falló: ${(err as Error).message}. Continuando sin OCR.`);
      return { rawText: '', amount: null, bank: null, date: null, isReceipt: true, receiptType: 'unknown' };
    }
  }

  extractAmount(text: string): number | null {
    const patterns = [
      /total[:\s]+bs\.?\s*([\d.,]+)/i,
      /monto[:\s]+bs\.?\s*([\d.,]+)/i,
      /importe[:\s]+bs\.?\s*([\d.,]+)/i,
      /bs\.?\s*([\d.,]+)/i,
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const num = parseFloat(match[1].replace(',', '.'));
        if (!isNaN(num) && num > 0 && num < 100000) return num;
      }
    }
    return null;
  }

  extractBank(text: string): string | null {
    const banks = [
      'BCP', 'Banco Crédito', 'Banco Económico', 'BNB', 'Banco Nacional',
      'Banco Mercantil', 'Banco Ganadero', 'Banco Bisa', 'Banco Fie',
      'Banco Prodem', 'Banco Solidario', 'Banco Unión',
      'Tigo Money', 'Banco Pyme', 'QR Bolivia',
    ];
    const upper = text.toUpperCase();
    for (const bank of banks) {
      if (upper.includes(bank.toUpperCase())) return bank;
    }
    return null;
  }

  extractDate(text: string): string | null {
    const match = text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    return match ? match[0] : null;
  }
}
