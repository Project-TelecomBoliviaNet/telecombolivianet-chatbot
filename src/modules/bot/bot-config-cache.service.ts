import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { IBotConfigRepository, BOT_CONFIG_REPOSITORY } from '../client/sistema-api.interfaces';

// ══════════════════════════════════════════════════════════════
// BOT CONFIG CACHE SERVICE
// Obtiene la configuración del bot desde el backend C# y la
// mantiene en memoria con TTL de 5 minutos.
// Si el backend no responde, usa los valores por defecto para
// que el chatbot funcione sin interrupción.
// ══════════════════════════════════════════════════════════════

export interface BotMenuItemConfig {
  Numero:       string;
  Etiqueta:     string;   // título WhatsApp (máx 24 chars)
  Intent:       string;   // CONSULTA_DEUDA | SOLICITAR_QR | etc.
  Activa:       boolean;
  Descripcion?: string;   // subtítulo WhatsApp (máx 72 chars)
  SoloCliente:  boolean;  // ocultar a prospectos sin identificar
}

export interface BotMenuConfig {
  TituloMenu:    string;
  TituloBoton:   string;
  TituloSeccion: string;
  Opciones:      BotMenuItemConfig[];
}

export interface BotHorarioConfig {
  HoraInicio:          string;   // "08:00"
  HoraFin:             string;   // "20:00"
  DiasActivos:         boolean[]; // [L,M,X,J,V,S,D]
  MensajeFueraHorario: string;
}

export interface BotMensajesConfig {
  Bienvenida:          string;
  BienvenidaProspecto: string; // saludo para contactos sin cuenta identificada
  NoEntendido:         string; // inyectado al prompt del sistema como instrucción de fallback
  EscaladoAgente:      string;
}

export interface BotConfig {
  Menu:     BotMenuConfig;
  Horario:  BotHorarioConfig;
  Mensajes: BotMensajesConfig;
}

// ─── Defaults (idénticos al hardcodeado actual del bot) ───────
// Si el backend C# no responde, el comportamiento no cambia.
const DEFAULT: BotConfig = {
  Menu: {
    TituloMenu:    '¿En qué puedo ayudarte hoy?',
    TituloBoton:   'Ver opciones',
    TituloSeccion: 'Servicios disponibles',
    Opciones: [
      { Numero: '1', Etiqueta: '💳 Mi deuda',        Intent: 'CONSULTA_DEUDA',        Activa: true, Descripcion: 'Consultar facturas pendientes',  SoloCliente: true  },
      { Numero: '2', Etiqueta: '📲 Pagar con QR',     Intent: 'SOLICITAR_QR',          Activa: true, Descripcion: 'Obtener código de pago',          SoloCliente: true  },
      { Numero: '3', Etiqueta: '🔧 Soporte técnico',  Intent: 'SIN_CONEXION',          Activa: true, Descripcion: 'Reportar problemas de conexión',  SoloCliente: true  },
      { Numero: '4', Etiqueta: '📅 Instalación',       Intent: 'SOLICITAR_INSTALACION', Activa: true, Descripcion: 'Agendar o consultar visita',       SoloCliente: false },
      { Numero: '5', Etiqueta: '📋 Información',       Intent: 'SOLICITAR_INSTALACION', Activa: true, Descripcion: 'Planes, precios y cobertura',      SoloCliente: false },
      { Numero: '6', Etiqueta: '👤 Hablar con agente', Intent: 'SOLICITAR_AGENTE',      Activa: true, Descripcion: 'Atención personalizada',           SoloCliente: false },
    ],
  },
  Horario: {
    HoraInicio:  '08:00',
    HoraFin:     '20:00',
    DiasActivos: [true, true, true, true, true, false, false],
    MensajeFueraHorario:
      'Nuestro horario de atención es de lunes a viernes de 8:00 a 20:00. ' +
      'Puedes dejar tu consulta y te responderemos al inicio del próximo día hábil.',
  },
  Mensajes: {
    Bienvenida:          '¡Hola {nombre}! 👋 Soy el asistente virtual de *TelecomBoliviaNet*. ¿En qué puedo ayudarte?',
    BienvenidaProspecto: '¡Hola! 👋 Soy el asistente virtual de *TelecomBoliviaNet*. ¿Ya eres cliente o deseas información sobre nuestros planes?',
    NoEntendido:         'No entendí bien tu consulta. 🤔 ¿Puedes escribirlo de otra forma o elegir una opción del menú?',
    EscaladoAgente:      'Lo siento, no pude resolver tu consulta de forma automática. 😔\n\nTe estoy transfiriendo con un *agente humano* que te atenderá a la brevedad.\n\nPor favor espera un momento. 🙏',
  },
};

const CACHE_TTL_MS      = 60 * 1_000;       // 1 min — config se refleja rápido tras guardar
const CACHE_FALLBACK_MS = 5 * 60 * 1_000;  // 5 min — si el backend cae, usar caché vieja

@Injectable()
export class BotConfigCacheService implements OnModuleInit {
  private readonly logger = new Logger(BotConfigCacheService.name);
  private cached: BotConfig = DEFAULT;
  private lastFetch = 0;

  constructor(
    @Inject(BOT_CONFIG_REPOSITORY) private readonly botConfigRepo: IBotConfigRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
  }

  // Retorna la config cacheada, refrescando si pasaron más de 5 min.
  async getConfig(): Promise<BotConfig> {
    if (Date.now() - this.lastFetch > CACHE_TTL_MS) {
      await this.refresh();
    }
    return this.cached;
  }

  // Fuerza un refresh inmediato (útil en tests o debug).
  async forceRefresh(): Promise<BotConfig> {
    await this.refresh();
    return this.cached;
  }

  private async refresh(): Promise<void> {
    try {
      const raw = await this.botConfigRepo.getBotConfigPublic();
      if (raw) {
        this.cached = this.normalize(raw);
        this.lastFetch = Date.now();
        this.logger.log('BotConfig sincronizado desde el backend C#.');
      }
    } catch (err) {
      const staleSecs = this.lastFetch
        ? Math.round((Date.now() - this.lastFetch) / 1_000)
        : null;

      if (this.lastFetch && Date.now() - this.lastFetch < CACHE_FALLBACK_MS) {
        // Caché reciente — sirvió hace menos de 5 min, seguro reutilizarla
        this.logger.warn(
          `BotConfig backend no disponible (caché de hace ${staleSecs}s). Usando caché.`,
        );
      } else {
        // Sin caché o muy vieja — se usa DEFAULT silenciosamente
        this.logger.warn(
          `BotConfig backend no disponible${staleSecs !== null ? ` (caché de hace ${staleSecs}s, demasiado vieja)` : ''}. ` +
          `Usando configuración por defecto.`,
        );
        this.cached = DEFAULT;
      }
    }
  }

  private normalize(raw: any): BotConfig {
    return {
      Menu: {
        TituloMenu:    raw?.Menu?.TituloMenu    || DEFAULT.Menu.TituloMenu,
        TituloBoton:   raw?.Menu?.TituloBoton   || DEFAULT.Menu.TituloBoton,
        TituloSeccion: raw?.Menu?.TituloSeccion || DEFAULT.Menu.TituloSeccion,
        Opciones: Array.isArray(raw?.Menu?.Opciones)
          ? raw.Menu.Opciones.map((o: any) => ({
              Numero:      String(o.Numero      ?? ''),
              Etiqueta:    String(o.Etiqueta    ?? ''),
              Intent:      String(o.Intent      ?? 'SOLICITAR_AGENTE'),
              Activa:      Boolean(o.Activa),
              Descripcion: o.Descripcion ?? '',
              SoloCliente: Boolean(o.SoloCliente),
            }))
          : DEFAULT.Menu.Opciones,
      },
      Horario: {
        HoraInicio:  raw?.Horario?.HoraInicio  || DEFAULT.Horario.HoraInicio,
        HoraFin:     raw?.Horario?.HoraFin     || DEFAULT.Horario.HoraFin,
        DiasActivos: Array.isArray(raw?.Horario?.DiasActivos)
          ? raw.Horario.DiasActivos
          : DEFAULT.Horario.DiasActivos,
        MensajeFueraHorario: raw?.Horario?.MensajeFueraHorario || DEFAULT.Horario.MensajeFueraHorario,
      },
      Mensajes: {
        Bienvenida:          raw?.Mensajes?.Bienvenida          || DEFAULT.Mensajes.Bienvenida,
        BienvenidaProspecto: raw?.Mensajes?.BienvenidaProspecto || DEFAULT.Mensajes.BienvenidaProspecto,
        NoEntendido:         raw?.Mensajes?.NoEntendido         || DEFAULT.Mensajes.NoEntendido,
        EscaladoAgente:      raw?.Mensajes?.EscaladoAgente      || DEFAULT.Mensajes.EscaladoAgente,
      },
    };
  }
}
