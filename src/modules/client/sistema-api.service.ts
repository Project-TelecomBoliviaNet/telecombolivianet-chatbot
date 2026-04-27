import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

// ══════════════════════════════════════════════════════════════
// SISTEMA API SERVICE (US-20) — ACTUALIZADO BLOQUE-1B
//
// Cambios respecto a la versión anterior:
//  - ClientBotDto ahora incluye PlanSpeedMbps (campo unificado
//    que mapea a SpeedMb en .NET — el sistema es simétrico)
//  - getClientInvoices usa la ruta correcta /api/clients/{id}/invoices
//    con el parámetro year (no /bot)
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
  SpeedMbps: number;          // velocidad simétrica (igual subida y bajada)
  DownloadSpeedMbps: number;  // alias explícito para el formatter
  UploadSpeedMbps: number;    // alias explícito para el formatter
  PriceMonthly: number;
  IsActive: boolean;
}

// ─── Config remota del bot ────────────────────────────────
export interface BotMenuOpcion {
  Numero: string;
  Etiqueta: string;
  Intent: string;
  Activa: boolean;
}
export interface BotRemoteConfig {
  Menu: {
    TituloMenu: string;
    Opciones: BotMenuOpcion[];
  };
  Horario: {
    HoraInicio: string;
    HoraFin: string;
    DiasActivos: boolean[];
    MensajeFueraHorario: string;
  };
  Mensajes: {
    Bienvenida: string;
    Despedida: string;
    NoEntendido: string;
    EscaladoAgente: string;
  };
  PalabrasClave: string[];
}

export interface TicketCreateDto {
  ClientId: string;
  Subject: string;          // REQUERIDO — se construye automáticamente en el bot
  Type: string;             // 'SoporteTecnico' | 'InstalacionNueva' | etc.
  Priority: string;         // 'Alta' | 'Media' | 'Baja'
  Description: string;
  SlaDurationHours?: number;
  Origin?: string;          // 'Bot' | 'Manual' | 'Automatico'
}

export interface SlotDto {
  Fecha: string;            // 'YYYY-MM-DD'
  HoraInicio: string;       // 'HH:mm'
  Disponibles: number;
}

@Injectable()
export class SistemaApiService implements OnModuleInit {
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
    const marginMin = config.get<number>('sistema.jwtRefreshMarginMinutes');
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

    // El backend devuelve { success: true, data: { Token: "..." } } (PascalCase)
    // pero versiones antiguas devolvían { token: "..." } (flat, camelCase) — soportar ambas.
    this.token = res.data.data?.Token ?? res.data.data?.token ?? res.data.token ?? null;
    if (!this.token) throw new Error('Login exitoso pero no se recibió token en la respuesta');
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
  // Usa la ruta /bot que devuelve el formato exacto que espera el chatbot:
  // { success: true, data: { Invoices: [...] } }
  async getClientInvoices(clientId: string, year?: number): Promise<InvoiceDto[]> {
    const res = await this.http.get(`/api/clients/${clientId}/invoices/bot`, {
      params: { year: year || new Date().getFullYear() },
    });
    return res.data.data?.Invoices || res.data.data?.invoices || [];
  }

  async getPendingInvoices(clientId: string): Promise<InvoiceDto[]> {
    const invoices = await this.getClientInvoices(clientId);
    return invoices.filter((i) => i.Status === 'Pendiente' || i.Status === 'Vencida');
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
      SpeedMbps:         p.SpeedMb,        // .NET devuelve SpeedMb (simétrico)
      DownloadSpeedMbps: p.SpeedMb,        // simétrico — misma velocidad
      UploadSpeedMbps:   p.SpeedMb,        // simétrico — misma velocidad
      PriceMonthly:      p.MonthlyPrice,
      IsActive:          p.IsActive,
    }));
  }

  // ─── US-05: QR de pago ────────────────────────────────────
  // Descarga la imagen QR del backend C# como buffer binario.
  // El backend genera el QR a partir del código TBN del cliente.
  // QR global de la empresa (uno para todos los clientes)
  async getCompanyQrBuffer(): Promise<Buffer> {
    const res = await this.http.get('/api/bot-config/company-qr', {
      responseType: 'arraybuffer',
    });
    return Buffer.from(res.data);
  }

  // Mantiene compatibilidad con QR por cliente si se sigue usando
  async getQrImageBuffer(clientId: string): Promise<Buffer> {
    const res = await this.http.get(`/api/clients/${clientId}/qr`, {
      responseType: 'arraybuffer',
    });
    return Buffer.from(res.data);
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
  async createInstallation(payload: {
    ClienteId: string | null;
    PlanNombre: string;   // Nombre del plan (la sesión no guarda el GUID)
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
  // FIX: ahora incluye Subject generado automáticamente
  async createTicket(dto: TicketCreateDto): Promise<{ Id: string }> {
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

  // ─── Config remota del bot ────────────────────────────────
  async getBotConfig(): Promise<BotRemoteConfig | null> {
    try {
      const res = await this.http.get('/api/bot-config/public');
      return res.data.data as BotRemoteConfig;
    } catch (err) {
      this.logger.warn(`getBotConfig error: ${err.message}`);
      return null;
    }
  }
}
