import { Injectable } from '@nestjs/common';

// ══════════════════════════════════════════════════════════════
// IMAGE INTENT DETECTOR SERVICE
//
// Clasifica la intención de una imagen enviada por el cliente
// usando solo la caption (pie de foto) — costo $0, sin IA externa.
//
// Tipos de intención:
//   'payment'   → comprobante de pago (transferencia, QR, recibo)
//   'technical' → problema técnico (modem, router, cables, señal)
//   'unknown'   → no hay señal clara → pedir al usuario que aclare
// ══════════════════════════════════════════════════════════════

export type ImageIntent = 'payment' | 'technical' | 'unknown';

@Injectable()
export class ImageIntentDetectorService {

  detect(caption: string | undefined): ImageIntent {
    const text = (caption ?? '').toLowerCase().trim();

    // ── Señales de comprobante de pago ──────────────────────
    const paymentKeywords = [
      'pago', 'pague', 'pagué', 'comprobante', 'transferencia',
      'depósito', 'deposito', 'qr', 'tigo money', 'recibo',
      'cancelé', 'cancelado', 'abono', 'monto', 'bs.', 'boliviano',
      'factura', 'deuda', 'banco', 'tarjeta',
    ];
    if (paymentKeywords.some(kw => text.includes(kw))) {
      return 'payment';
    }

    // ── Señales de soporte técnico ──────────────────────────
    const technicalKeywords = [
      'modem', 'módem', 'router', 'wifi', 'wi-fi', 'internet',
      'red', 'cable', 'señal', 'antena', 'luz', 'parpadea',
      'apagado', 'no conecta', 'no funciona', 'falla', 'error',
      'problema', 'soporte', 'técnico', 'avería', 'reiniciar',
      'reinicio', 'cortado', 'lento', 'sin conexion', 'sin conexión',
      'no anda', 'roto', 'dañado', 'instalación', 'instalacion',
    ];
    if (technicalKeywords.some(kw => text.includes(kw))) {
      return 'technical';
    }

    // ── Sin señal clara ─────────────────────────────────────
    return 'unknown';
  }
}
