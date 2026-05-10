import { Injectable } from '@nestjs/common';
import { SessionData } from '../../session/session.service';
import { IPromptSection } from './prompt-section.interface';

@Injectable()
export class ReceiptPendingSection implements IPromptSection {
  applies(session: SessionData): boolean {
    return session.messages.slice(-4).some(m => m.content === '[comprobante de pago]');
  }

  render(_session: SessionData): string {
    return `- COMPROBANTE EN REVISIÓN: el cliente acaba de enviar un comprobante de pago. NO llames get_client_debt ni menciones la deuda pendiente — el pago está siendo verificado. Si el cliente pregunta por su deuda responde: "Tu comprobante está siendo revisado por nuestro equipo. Te notificaremos cuando se confirme el pago."`;
  }
}
