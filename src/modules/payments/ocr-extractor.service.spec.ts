import { OcrExtractorService } from './ocr-extractor.service';

// ══════════════════════════════════════════════════════════════
// TESTS UNITARIOS — OcrExtractorService
//
// No usa Tesseract real — verifica los extractores de datos sobre
// textos ya procesados (output del OCR). Tesseract se mockea
// para el test de extract() que involucra imagen real.
// ══════════════════════════════════════════════════════════════

// Mock de tesseract.js — evita llamadas al OCR real
jest.mock('tesseract.js', () => ({
  recognize: jest.fn(),
}));

describe('OcrExtractorService — extractAmount()', () => {
  let svc: OcrExtractorService;

  beforeEach(() => { svc = new OcrExtractorService(); });

  it('OE-01 — extrae monto con patrón "Total: Bs. 250.00"', () => {
    expect(svc.extractAmount('Total: Bs. 250.00')).toBe(250);
  });

  it('OE-02 — extrae monto con patrón "Monto Bs.150"', () => {
    expect(svc.extractAmount('Monto Bs.150')).toBe(150);
  });

  it('OE-03 — extrae monto con patrón "Importe: Bs. 75,50"', () => {
    expect(svc.extractAmount('Importe: Bs. 75,50')).toBe(75.5);
  });

  it('OE-04 — extrae monto con patrón simple "Bs. 300"', () => {
    expect(svc.extractAmount('Bs. 300')).toBe(300);
  });

  it('OE-05 — retorna null cuando no hay monto', () => {
    expect(svc.extractAmount('Hola mundo sin montos')).toBeNull();
  });

  it('OE-06 — retorna null para montos ≥ 100000 (datos corruptos)', () => {
    expect(svc.extractAmount('Bs. 999999')).toBeNull();
  });

  it('OE-07 — retorna null para monto cero', () => {
    expect(svc.extractAmount('Bs. 0')).toBeNull();
  });
});

describe('OcrExtractorService — extractBank()', () => {
  let svc: OcrExtractorService;

  beforeEach(() => { svc = new OcrExtractorService(); });

  it('OE-08 — detecta BCP (case insensitive)', () => {
    expect(svc.extractBank('Pago realizado con bcp')).toBe('BCP');
  });

  it('OE-09 — detecta Banco Unión', () => {
    expect(svc.extractBank('Transferencia desde Banco Unión Santa Cruz')).toBe('Banco Unión');
  });

  it('OE-10 — detecta Tigo Money', () => {
    expect(svc.extractBank('Tigo Money confirmado')).toBe('Tigo Money');
  });

  it('OE-11 — detecta QR Bolivia', () => {
    expect(svc.extractBank('QR Bolivia pagado')).toBe('QR Bolivia');
  });

  it('OE-12 — retorna null cuando no hay banco reconocido', () => {
    expect(svc.extractBank('Sin información bancaria')).toBeNull();
  });
});

describe('OcrExtractorService — extractDate()', () => {
  let svc: OcrExtractorService;

  beforeEach(() => { svc = new OcrExtractorService(); });

  it('OE-13 — extrae fecha con formato DD/MM/YYYY', () => {
    expect(svc.extractDate('Fecha: 06/05/2026')).toBe('06/05/2026');
  });

  it('OE-14 — extrae fecha con formato DD-MM-YY', () => {
    expect(svc.extractDate('Fecha pago: 06-05-26')).toBe('06-05-26');
  });

  it('OE-15 — retorna null cuando no hay fecha', () => {
    expect(svc.extractDate('Sin fecha en el texto')).toBeNull();
  });
});

describe('OcrExtractorService — extract() con Tesseract mockeado', () => {
  let svc: OcrExtractorService;
  const Tesseract = require('tesseract.js');

  beforeEach(() => {
    svc = new OcrExtractorService();
    jest.clearAllMocks();
  });

  it('OE-16 — retorna OcrResult completo cuando Tesseract tiene éxito', async () => {
    Tesseract.recognize.mockResolvedValue({
      data: { text: 'Transferencia BCP\nTotal: Bs. 200.00\nFecha: 05/05/2026' },
    });

    const result = await svc.extract(Buffer.from('fake-image'));
    expect(result.rawText).toContain('Transferencia');
    expect(result.amount).toBe(200);
    expect(result.bank).toBe('BCP');
    expect(result.date).toBe('05/05/2026');
  });

  it('OE-17 — retorna OcrResult vacío cuando Tesseract falla', async () => {
    Tesseract.recognize.mockRejectedValue(new Error('OCR error'));

    const result = await svc.extract(Buffer.from('bad-image'));
    expect(result.rawText).toBe('');
    expect(result.amount).toBeNull();
    expect(result.bank).toBeNull();
    expect(result.date).toBeNull();
  });
});
