import { ReceiptClassifierService } from './receipt-classifier.service';
import { OcrResult } from './ocr-extractor.service';

// ══════════════════════════════════════════════════════════════
// TESTS UNITARIOS — ReceiptClassifierService
//
// Verifica las reglas de clasificación sin llamadas externas.
// ══════════════════════════════════════════════════════════════

function makeOcr(overrides: Partial<OcrResult> = {}): OcrResult {
  return {
    rawText: '',
    amount: null,
    bank: null,
    date: null,
    isReceipt: true,
    receiptType: 'unknown',
    ...overrides,
  };
}

describe('ReceiptClassifierService', () => {
  let svc: ReceiptClassifierService;

  beforeEach(() => { svc = new ReceiptClassifierService(); });

  // ── YES por datos extraídos ──────────────────────────────────

  it('RC-01 — YES bank cuando OCR detectó banco', () => {
    const result = svc.classify(makeOcr({ bank: 'BCP' }), undefined);
    expect(result.verdict).toBe('YES');
    expect(result.receiptType).toBe('bank');
  });

  it('RC-02 — YES cuando OCR detectó monto (sin banco)', () => {
    const result = svc.classify(makeOcr({ amount: 150 }), undefined);
    expect(result.verdict).toBe('YES');
    expect(result.receiptType).toBe('unknown');
  });

  // ── YES por palabras clave bancarias ─────────────────────────

  it('RC-03 — YES bank por "transferencia" en rawText', () => {
    const result = svc.classify(makeOcr({ rawText: 'Transferencia exitosa realizada' }), undefined);
    expect(result.verdict).toBe('YES');
    expect(result.receiptType).toBe('bank');
  });

  it('RC-04 — YES bank por "pago qr" en caption', () => {
    const result = svc.classify(makeOcr(), 'pago qr realizado');
    expect(result.verdict).toBe('YES');
    expect(result.receiptType).toBe('bank');
  });

  it('RC-05 — YES bank por "comprobante de pago"', () => {
    const result = svc.classify(makeOcr({ rawText: 'Comprobante de Pago N° 1234' }), undefined);
    expect(result.verdict).toBe('YES');
    expect(result.receiptType).toBe('bank');
  });

  // ── YES por palabras clave de efectivo ────────────────────────

  it('RC-06 — YES cash por "recibo" en rawText', () => {
    const result = svc.classify(makeOcr({ rawText: 'Recibo de cobro mensualidad' }), undefined);
    expect(result.verdict).toBe('YES');
    expect(result.receiptType).toBe('cash');
  });

  it('RC-07 — YES cash por "cancelado"', () => {
    const result = svc.classify(makeOcr({ rawText: 'Pago cancelado por el cobrador' }), undefined);
    expect(result.verdict).toBe('YES');
    expect(result.receiptType).toBe('cash');
  });

  it('RC-08 — YES cash por "bolivianet" en el texto', () => {
    const result = svc.classify(makeOcr({ rawText: 'Telecom Bolivianet S.R.L.' }), undefined);
    expect(result.verdict).toBe('YES');
    expect(result.receiptType).toBe('cash');
  });

  // ── NO por texto insuficiente ─────────────────────────────────

  it('RC-09 — NO cuando rawText y caption tienen menos de 20 caracteres', () => {
    const result = svc.classify(makeOcr({ rawText: 'Foto' }), undefined);
    expect(result.verdict).toBe('NO');
  });

  it('RC-10 — NO para captura de WhatsApp', () => {
    const result = svc.classify(makeOcr({ rawText: 'WhatsApp Web enviado ayer a las 3pm mensajes' }), undefined);
    expect(result.verdict).toBe('NO');
  });

  it('RC-11 — NO para captura de Instagram con likes', () => {
    const result = svc.classify(makeOcr({ rawText: 'instagram me gusta reels historia compartir' }), undefined);
    expect(result.verdict).toBe('NO');
  });

  it('RC-12 — NO para imagen de velocímetro', () => {
    const result = svc.classify(makeOcr({ rawText: 'Viaje velocidad km/h autopista Santa Cruz' }), undefined);
    expect(result.verdict).toBe('NO');
  });

  // ── AMBIGUOUS ─────────────────────────────────────────────────

  it('RC-13 — AMBIGUOUS cuando hay texto pero sin señales de pago', () => {
    const result = svc.classify(
      makeOcr({ rawText: 'Este es un texto suficientemente largo sin señales claras de pago bancario' }),
      undefined,
    );
    expect(result.verdict).toBe('AMBIGUOUS');
    expect(result.receiptType).toBe('unknown');
  });

  it('RC-14 — caption suma al texto combinado para detección', () => {
    const result = svc.classify(
      makeOcr({ rawText: 'texto sin clave' }),
      'aquí va la transferencia de pago',
    );
    expect(result.verdict).toBe('YES');
  });
});
