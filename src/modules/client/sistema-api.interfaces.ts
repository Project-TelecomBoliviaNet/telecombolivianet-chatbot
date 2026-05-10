import {
  ClientBotDto, InvoiceDto, PlanDto,
  TicketCreateDto, SlotDto,
} from './sistema-api.service';

// ─── Injection tokens ─────────────────────────────────────────
export const CLIENT_REPOSITORY       = Symbol('CLIENT_REPOSITORY');
export const TICKET_REPOSITORY       = Symbol('TICKET_REPOSITORY');
export const PLAN_REPOSITORY         = Symbol('PLAN_REPOSITORY');
export const INSTALLATION_REPOSITORY = Symbol('INSTALLATION_REPOSITORY');
export const PAYMENT_REPOSITORY      = Symbol('PAYMENT_REPOSITORY');
export const NOTIFICATION_REPOSITORY = Symbol('NOTIFICATION_REPOSITORY');
export const BOT_CONFIG_REPOSITORY   = Symbol('BOT_CONFIG_REPOSITORY');

// ─── ISP: cada interfaz expone sólo los métodos del dominio ───

export interface IClientRepository {
  getClientByPhone(phone: string): Promise<ClientBotDto | null>;
  getClientInvoices(clientId: string, year?: number): Promise<InvoiceDto[]>;
  getPendingInvoices(clientId: string): Promise<InvoiceDto[]>;
  requestPlanChange(clientId: string, newPlanId: string, notes?: string): Promise<{ changeId: string }>;
}

export interface ITicketRepository {
  createTicket(dto: TicketCreateDto): Promise<{ Id: string; TicketNumber?: string }>;
  buildTicketSubject(params: { type: string; tbnCode: string; clientName: string; priority: string }): string;
  rescheduleTicket(ticketId: string, fecha: string, hora: string): Promise<void>;
  closeTicket(ticketId: string, resolutionNote?: string): Promise<void>;
  updateTicket(ticketId: string, description: string): Promise<void>;
}

export interface IPlanRepository {
  getActivePlans(): Promise<PlanDto[]>;
}

export interface IInstallationRepository {
  getInstallationSlots(diasAdelante?: number): Promise<SlotDto[]>;
  createInstallation(payload: {
    ClienteId: string | null;
    PlanId: string;
    Fecha: string;
    HoraInicio: string;
    Direccion: string;
    Notas?: string;
  }): Promise<{ InstalacionId: string; TicketId: string }>;
  cancelInstallation(id: string, motivo: string): Promise<void>;
}

export interface IPaymentRepository {
  getCompanyQrBuffer(): Promise<Buffer>;
  submitWhatsappReceipt(payload: {
    ClientId: string | null;
    ImageUrl: string;
    MessageText: string;
    DeclaredAmount: number | null;
    OcrBank: string | null;
    OcrDate: string | null;
    OcrRawText: string;
    PhoneNumber: string;
  }): Promise<{ id: string }>;
}

export interface INotificationRepository {
  getCurrentToken(): string | null;
  postDeliveryStatus(waMessageId: string, status: string, timestamp: string): Promise<void>;
}

export interface IBotConfigRepository {
  getBotConfigPublic(): Promise<any>;
}
