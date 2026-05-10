import { Injectable } from '@nestjs/common';
import { SessionData } from '../../session/session.service';
import { IPromptSection } from './prompt-section.interface';

@Injectable()
export class ClientInfoSection implements IPromptSection {
  applies(_session: SessionData): boolean { return true; }

  render(session: SessionData): string {
    const isProspect   = !session.clientId;
    const locationHint = this.buildLocationHint(session);
    const clientInfo   = isProspect
      ? `El cliente NO está registrado en el sistema (prospecto).
NO puede consultar deuda ni recibir QR de pago.
Solo puede solicitar información sobre planes, precios e instalación.${locationHint}`
      : `Cliente identificado:
  Nombre: ${session.clientName}
  Código TBN: ${session.tbnCode ?? 'N/D'}
  Estado de cuenta: ${session.clientStatus}
  Deuda actual: Bs. ${session.totalDebt?.toFixed(2) ?? '0.00'}
  Plan contratado: ${session.planName ?? 'N/D'}
  ${session.activeTicketId       ? `Ticket activo: ${session.activeTicketId}` : ''}
  ${session.activeInstallationId ? `Instalación activa: ${session.activeInstallationId}` : ''}${locationHint}`;

    return `ESTADO DEL CLIENTE:\n${clientInfo}`;
  }

  private buildLocationHint(session: SessionData): string {
    if (!session.lastLocation) return '';
    const { lat, lng, address, name } = session.lastLocation;
    return `\n  Ubicación GPS compartida: lat=${lat}, lng=${lng}` +
      (address ? `, dirección: ${address}` : '') +
      (name    ? `, zona: ${name}` : '');
  }
}
