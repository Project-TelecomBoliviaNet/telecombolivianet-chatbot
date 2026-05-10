import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom, timeout, catchError, of } from 'rxjs';
import { INotificationRepository, NOTIFICATION_REPOSITORY } from '../client/sistema-api.interfaces';

// ══════════════════════════════════════════════════════════════
// ADMIN SIGNALR NOTIFIER SERVICE  (US-17 / US-12) — ACTUALIZADO
//
// Envía notificaciones en tiempo real al panel admin de C#
// mediante el endpoint POST /api/bot-events que existe ahora.
//
// Cambios en este bloque:
//  - Ya no usa SISTEMA_BOT_STATIC_TOKEN (token estático)
//  - Obtiene el JWT dinámico desde SistemaApiService (mismo
//    token que usa para todas las llamadas al backend)
//  - SistemaApiService se inyecta directamente
// ══════════════════════════════════════════════════════════════

export enum AdminEventType {
  TICKET_ALTA             = 'TICKET_ALTA',
  TICKET_CREATED          = 'TICKET_CREATED',
  TICKET_CLOSED           = 'TICKET_CLOSED',
  TICKET_RESCHEDULED      = 'TICKET_RESCHEDULED',
  CONVERSATION_ESCALATED  = 'CONVERSATION_ESCALATED',
}

export interface AdminNotificationPayload {
  EventType:   AdminEventType;   // PascalCase — requerido por .NET
  PhoneNumber: string;
  ClientName?: string;
  TicketId?:   string;
  Priority?:   string;
  Reason?:     string;
  Timestamp:   string;           // ISO-8601
}

@Injectable()
export class AdminSignalrNotifierService implements OnModuleInit {
  private readonly logger = new Logger(AdminSignalrNotifierService.name);
  private readonly notifyUrl: string;

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
    @Inject(NOTIFICATION_REPOSITORY) private readonly notificationRepo: INotificationRepository,
  ) {
    const apiUrl = this.config.get<string>('sistema.apiUrl');
    this.notifyUrl = `${apiUrl}/api/bot-events`;
  }

  onModuleInit() {
    this.logger.log(`AdminSignalrNotifier listo → ${this.notifyUrl}`);
  }

  // ─── TICKET ALTA PRIORIDAD (US-12) ────────────────────────
  async notifyHighPriorityTicket(params: {
    phoneNumber: string;
    clientName: string;
    ticketId: string;
    description?: string;
  }): Promise<void> {
    await this.send({
      EventType:   AdminEventType.TICKET_ALTA,
      PhoneNumber: params.phoneNumber,
      ClientName:  params.clientName,
      TicketId:    params.ticketId,
      Priority:    'Alta',
      Reason:      params.description,
      Timestamp:   new Date().toISOString(),
    });
  }

  // ─── TICKET CREADO (cualquier prioridad) ──────────────────
  async notifyTicketCreated(params: {
    phoneNumber: string;
    clientName: string;
    ticketId: string;
    priority: string;
  }): Promise<void> {
    await this.send({
      EventType:   AdminEventType.TICKET_CREATED,
      PhoneNumber: params.phoneNumber,
      ClientName:  params.clientName,
      TicketId:    params.ticketId,
      Priority:    params.priority,
      Timestamp:   new Date().toISOString(),
    });
  }

  // ─── TICKET CERRADO ───────────────────────────────────────
  async notifyTicketClosed(params: {
    phoneNumber: string;
    clientName: string;
    ticketId: string;
  }): Promise<void> {
    await this.send({
      EventType:   AdminEventType.TICKET_CLOSED,
      PhoneNumber: params.phoneNumber,
      ClientName:  params.clientName,
      TicketId:    params.ticketId,
      Timestamp:   new Date().toISOString(),
    });
  }

  // ─── TICKET REAGENDADO ────────────────────────────────────
  async notifyTicketRescheduled(params: {
    phoneNumber: string;
    clientName: string;
    ticketId: string;
    fecha: string;
    hora: string;
  }): Promise<void> {
    await this.send({
      EventType:   AdminEventType.TICKET_RESCHEDULED,
      PhoneNumber: params.phoneNumber,
      ClientName:  params.clientName,
      TicketId:    params.ticketId,
      Reason:      `Reagendado para ${params.fecha} a las ${params.hora}`,
      Timestamp:   new Date().toISOString(),
    });
  }

  // ─── CONVERSACIÓN ESCALADA (US-17) ────────────────────────
  async notifyEscalation(params: {
    phoneNumber: string;
    clientName?: string;
    reason?: string;
  }): Promise<void> {
    await this.send({
      EventType:   AdminEventType.CONVERSATION_ESCALATED,
      PhoneNumber: params.phoneNumber,
      ClientName:  params.clientName,
      Reason:      params.reason ?? 'Solicitado por el cliente o fallo en RAG',
      Timestamp:   new Date().toISOString(),
    });
  }

  // ─── ENVÍO HTTP (fire-and-forget, no bloquea el bot) ──────
  private async send(payload: AdminNotificationPayload): Promise<void> {
    try {
      // Obtener JWT dinámico desde SistemaApiService
      // El token se renueva automáticamente por el interceptor interno.
      // Accedemos al token interno vía el getter expuesto.
      const token = this.notificationRepo.getCurrentToken();
      const headers: Record<string, string> = token
        ? { Authorization: `Bearer ${token}` }
        : {};

      await firstValueFrom(
        this.http
          .post(this.notifyUrl, payload, { headers })
          .pipe(
            timeout(3000),
            catchError((err) => {
              this.logger.warn(
                `SignalR notify falló (${payload.EventType}): ${err.message}`,
              );
              return of(null);
            }),
          ),
      );

      this.logger.log(
        `Admin notificado → ${payload.EventType} [${payload.PhoneNumber}]`,
      );
    } catch (err) {
      this.logger.error(`Error inesperado en AdminSignalrNotifier: ${err.message}`);
    }
  }
}
