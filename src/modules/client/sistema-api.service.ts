import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import {
  IClientRepository, ITicketRepository, IPlanRepository,
  IInstallationRepository, IPaymentRepository,
  INotificationRepository, IBotConfigRepository,
} from './sistema-api.interfaces';

// ══════════════════════════════════════════════════════════════
// SISTEMA API SERVICE (US-20) — ACTUALIZADO BLOQUE-1B
//
// Cambios respecto a la versión anterior:
//  - ClientBotDto ahora incluye PlanSpeedMbps (campo unificado
//    que mapea a SpeedMb en .NET — el sistema es simétrico)
//  - getClientInvoices usa la ruta /api/clients/{id}/invoices/bot
//    que devuelve formato PascalCase compatible con InvoiceDto del bot
//  - getClientByPhone normaliza el número antes de enviarlo
//  - InvoiceDto.Status ahora acepta "Pendiente" | "Vencida" | "Pagada"
//    en español (consistente con el backend .NET)
// ══════════════════════════════════════════════════════════════

// ─── DTOs de respuesta del sistema C# (PascalCase) ───────────
export interface ClientBotDto {
  Id: string;
  TbnCode: string;
  FullName: string;
  PhoneMain: string;
  Status: string;           // 'Activo' | 'Suspendido' | 'Cancelado' | 'DadoDeBaja'
  PlanId: string;
  PlanName: string;
  PlanSpeedMbps: number;    // velocidad simétrica del plan (SpeedMb en .NET)
  TotalDebt: number;
  PendingMonths: number;
  Zone: string;
}

export interface InvoiceDto {
  Id: string;
  Month: number;
  Year: number;
  Amount: number;
  DueDate: string;
  Status: string;           // 'Pendiente' | 'Vencida' | 'Pagada'
  PaidAt: string | null;
}

export interface PlanDto {
  Id: string;
  Name: string;
  SpeedMbps: number;        // mapea a SpeedMb en .NET (simétrico)
  DownloadSpeedMbps: number;
  UploadSpeedMbps: number;
  PriceMonthly: number;
  IsActive: boolean;
}

export interface TicketCreateDto {
  ClientId: string;
  Subject: string;
  Type: string;             // 'SoporteTecnico' | 'InstalacionNueva' | 'CambioPlan' | etc.
  Priority: string;         // 'Alta' | 'Media' | 'Baja'
  Description: string;
  SlaDurationHours?: number;
  Origin?: string;          // 'Bot' | 'Manual' | 'Automatico'
  AutoAssign?: boolean;     // true → asigna al técnico con menor carga
  ImageUrl?: string;        // imagen adjunta enviada por el cliente desde WhatsApp
}

export interface SlotDto {
  Fecha: string;            // 'YYYY-MM-DD'
  HoraInicio: string;       // 'HH:mm'
  Disponibles: number;
}

@Injectable()
export class SistemaApiService implements OnModuleInit,
  IClientRepository, ITicketRepository, IPlanRepository,
  IInstallationRepository, IPaymentRepository,
  INotificationRepository, IBotConfigRepository {
  private readonly logger = new Logger(SistemaApiService.name);
  private http: AxiosInstance;
  private token: string | null = null;
  private tokenExpiresAt: Date | null = null;

  // ─── Getter para uso interno entre servicios ──────────────
  // AdminSignalrNotifierService lo usa para autenticar la llamada
  // a /api/bot-events con el mismo JWT del bot (sin duplicar lógica).
  getCurrentToken(): string | null {
    return this.token;
  }
  private readonly refreshMarginMs: number;

  constructor(private readonly config: ConfigService) {
    const marginMin = config.get<number>('sistema.jwtRefreshMarginMinutes') ?? 60;
    this.refreshMarginMs = marginMin * 60 * 1000;
  }

  async onModuleInit() {
    const baseURL = this.config.get<string>('sistema.apiUrl');
    this.http = axios.create({
      baseURL,
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' },
    });

    // Interceptor: agrega JWT en cada request
    this.http.interceptors.request.use(async (cfg) => {
      await this.ensureToken();
      if (this.token) {
        cfg.headers['Authorization'] = `Bearer ${this.token}`;
      }
      return cfg;
    });

    // Interceptor: renueva JWT automáticamente si el backend devuelve 401
    this.http.interceptors.response.use(
      (res) => res,
      async (err) => {
        if (err.response?.status === 401 && !err.config?._retried) {
          err.config._retried = true;
          this.logger.warn('JWT rechazado con 401 — renovando token y reintentando...');
          await this.login();
          err.config.headers['Authorization'] = `Bearer ${this.token}`;
          return this.http.request(err.config);
        }
        return Promise.reject(err);
      },
    );

    // Obtener token inicial
    try {
      await this.login();
    } catch (err) {
      this.logger.warn(`No se pudo conectar al sistema C# al iniciar: ${err.message}`);
    }
  }

  // ─── AUTENTICACIÓN ────────────────────────────────────────
  private async login(): Promise<void> {
    const email = this.config.get<string>('sistema.botEmail');
    const password = this.config.get<string>('sistema.botPassword');

    const res = await axios.post(
      `${this.config.get('sistema.apiUrl')}/api/auth/login`,
      { Email: email, Password: password },  // PascalCase requerido
    );

    // OkResult → { success, data } (lowercase), LoginResponseDto → { Token } (PascalCase)
    const loginData = res.data.data;
    this.token = loginData?.Token ?? loginData?.token ?? res.data.token;
    // El token dura 8h según JwtConfiguration.cs
    this.tokenExpiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
    this.logger.log(`JWT del bot renovado. Expira: ${this.tokenExpiresAt.toISOString()}`);
  }

  private async ensureToken(): Promise<void> {
    if (!this.token || !this.tokenExpiresAt) {
      await this.login();
      return;
    }
    const expiresIn = this.tokenExpiresAt.getTime() - Date.now();
    if (expiresIn <= this.refreshMarginMs) {
      await this.login();
    }
  }

  // ─── US-01: Identificar cliente por teléfono ──────────────
  // FIX: ahora llama al endpoint correcto /api/clients/by-phone
  async getClientByPhone(phone: string): Promise<ClientBotDto | null> {
    try {
      // Normalizar: quitar prefijo 591 si viene del webhook de Meta
      const normalized = phone.startsWith('591') && phone.length > 3
        ? phone.slice(3)
        : phone;

      const res = await this.http.get('/api/clients/by-phone', {
        params: { phone: normalized },
      });
      return res.data.data as ClientBotDto;
    } catch (err) {
      if (err.response?.status === 404) return null;
      this.logger.error(`getClientByPhone error: ${err.message}`);
      throw err;
    }
  }

  // ─── US-03: Facturas del cliente ──────────────────────────
  async getClientInvoices(clientId: string, year?: number): Promise<InvoiceDto[]> {
    const res = await this.http.get(`/api/clients/${clientId}/invoices/bot`, {
      params: { year: year || new Date().getFullYear() },
    });
    // El endpoint devuelve { success: true, data: { Invoices: [...] } }
    return res.data.data?.Invoices || [];
  }

  async getPendingInvoices(clientId: string): Promise<InvoiceDto[]> {
    const invoices = await this.getClientInvoices(clientId);
    return invoices.filter((i) => i.Status === 'Pendiente' || i.Status === 'Vencida');
  }

  // ─── QR global de la empresa (Bot Config) ────────────────
  // GET /api/bot-config/company-qr → bytes de la imagen PNG
  async getCompanyQrBuffer(): Promise<Buffer> {
    const res = await this.http.get('/api/bot-config/company-qr', {
      responseType: 'arraybuffer',
    });
    return Buffer.from(res.data);
  }

  // ─── US-05: Planes activos ────────────────────────────────
  async getActivePlans(): Promise<PlanDto[]> {
    const res = await this.http.get('/api/plans', {
      params: { onlyActive: true },
    });
    // Mapear SpeedMb → SpeedMbps para compatibilidad interna del bot
    const raw = res.data.data || [];
    return raw.map((p: any) => ({
      Id:                p.Id,
      Name:              p.Name,
      SpeedMbps:         p.SpeedMb,      // FIX: .NET devuelve SpeedMb (simétrico)
      DownloadSpeedMbps: p.DownloadSpeedMbps ?? p.SpeedMb,
      UploadSpeedMbps:   p.UploadSpeedMbps ?? p.SpeedMb,
      PriceMonthly:      p.MonthlyPrice,
      IsActive:          p.IsActive,
    }));
  }

  // ─── US-06: Registrar comprobante WhatsApp ────────────────
  async submitWhatsappReceipt(payload: {
    ClientId: string | null;
    ImageUrl: string;
    MessageText: string;
    DeclaredAmount: number | null;
    OcrBank: string | null;
    OcrDate: string | null;
    OcrRawText: string;
    PhoneNumber: string;
  }): Promise<{ id: string }> {
    const res = await this.http.post('/api/payments/whatsapp-receipt', payload);
    return res.data.data;
  }

  // ─── US-09: Slots de instalación disponibles ─────────────
  // NOTA: Este endpoint aún no existe en .NET — se implementa en Bloque 1a
  async getInstallationSlots(diasAdelante = 7): Promise<SlotDto[]> {
    const res = await this.http.get('/api/instalaciones/slots-disponibles', {
      params: { dias: diasAdelante },
    });
    return res.data.data || [];
  }

  // ─── US-10: Crear instalación ─────────────────────────────
  // NOTA: Este endpoint aún no existe en .NET — se implementa en Bloque 1a
  // ─── US-10: Crear instalación ─────────────────────────────
  async createInstallation(payload: {
    ClienteId: string | null;
    PlanId: string;       // GUID del plan (no el nombre — FIX bloque-1a)
    Fecha: string;
    HoraInicio: string;
    Direccion: string;
    Notas?: string;
  }): Promise<{ InstalacionId: string; TicketId: string }> {
    const res = await this.http.post('/api/instalaciones', payload);
    return res.data.data;
  }

  // ─── US-11: Cancelar instalación ─────────────────────────
  // NOTA: Este endpoint aún no existe en .NET — se implementa en Bloque 1a
  async cancelInstallation(id: string, motivo: string): Promise<void> {
    await this.http.patch(`/api/instalaciones/${id}/cancelar`, {
      MotivoCancelacion: motivo,
      CanceladoPor: 'CLIENTE',
    });
  }

  // ─── US-12/13: Crear ticket de soporte ───────────────────
  async createTicket(dto: TicketCreateDto): Promise<{ Id: string; TicketNumber?: string }> {
    const res = await this.http.post('/api/tickets', dto);
    return res.data.data;
  }

  /**
   * Genera el Subject del ticket automáticamente a partir de los datos del cliente.
   * El campo Subject es obligatorio en .NET (máx. 200 chars).
   * Formato: "[Tipo] TBN-XXXX – NombreCliente – Prioridad"
   */
  buildTicketSubject(params: {
    type: string;
    tbnCode: string;
    clientName: string;
    priority: string;
  }): string {
    const typeLabel: Record<string, string> = {
      SoporteTecnico:   'Soporte Técnico',
      InstalacionNueva: 'Instalación Nueva',
      CambioPlan:       'Cambio de Plan',
      RecoleccionEquipo:'Recolección de Equipo',
    };
    const label = typeLabel[params.type] || params.type;
    const subject = `[${label}] ${params.tbnCode} – ${params.clientName} – ${params.priority}`;
    return subject.slice(0, 200); // garantizar máximo de 200 chars
  }

  // ─── Reagendar visita técnica de ticket ──────────────────
  async rescheduleTicket(ticketId: string, fecha: string, hora: string): Promise<void> {
    await this.http.patch(`/api/tickets/${ticketId}/reschedule`, {
      ScheduledDate: fecha,
      ScheduledTime: hora,
    });
  }

  // ─── US-14: Cerrar ticket ─────────────────────────────────
  async closeTicket(ticketId: string, resolutionNote?: string): Promise<void> {
    await this.http.patch(`/api/tickets/${ticketId}/status`, {
      Status: 'Resuelto',
      ...(resolutionNote && { ResolutionMessage: resolutionNote }),
    });
  }

  // ─── Actualizar descripción de ticket ────────────────────
  async updateTicket(ticketId: string, description: string): Promise<void> {
    await this.http.put(`/api/tickets/${ticketId}`, {
      Description: description,
      Priority: null,
    });
  }

  // ─── US-18: Reenviar delivery receipt de Meta al backend ─
  async postDeliveryStatus(waMessageId: string, status: string, timestamp: string): Promise<void> {
    try {
      await this.http.post('/api/notifications/delivery-status', {
        WaMessageId: waMessageId,
        Status: status,
        Timestamp: parseInt(timestamp, 10),
      });
    } catch (err) {
      this.logger.warn(`postDeliveryStatus error wamid=${waMessageId}: ${err.message}`);
    }
  }

  // ─── Cambio de plan ──────────────────────────────────────
  // Llama al endpoint dedicado que crea un PlanChangeRequest
  // (visible en el panel como "Solicitud de cambio de plan").
  async requestPlanChange(
    clientId: string,
    newPlanId: string,
    notes?: string,
  ): Promise<{ changeId: string }> {
    const res = await this.http.post(`/api/clients/${clientId}/plan-change`, {
      NewPlanId: newPlanId,
      Notes:     notes ?? null,
    });
    return { changeId: res.data.data.ChangeId };
  }

  // ─── Bot Config: obtener config pública del bot desde C# ──
  async getBotConfigPublic(): Promise<any> {
    const res = await this.http.get('/api/bot-config/public');
    return res.data?.data ?? null;
  }
}
