import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SistemaApiService, BotRemoteConfig } from '../client/sistema-api.service';

// ══════════════════════════════════════════════════════════════
// BOT REMOTE CONFIG SERVICE
//
// Carga la configuración del bot desde el backend .NET al
// iniciar y la mantiene en caché con TTL de 5 minutos.
// Si el backend no responde, usa valores por defecto para
// que el chatbot siga funcionando (degradación elegante).
// ══════════════════════════════════════════════════════════════

const CACHE_TTL_MS = 5 * 60 * 1000;

export const DEFAULT_BOT_CONFIG: BotRemoteConfig = {
  Menu: {
    TituloMenu: '¿En qué puedo ayudarte hoy?',
    Opciones: [
      { Numero: '1', Etiqueta: 'Consultar mi deuda',         Intent: 'CONSULTA_DEUDA',        Activa: true },
      { Numero: '2', Etiqueta: 'Obtener QR de pago',         Intent: 'SOLICITAR_QR',          Activa: true },
      { Numero: '3', Etiqueta: 'Reportar problema técnico',  Intent: 'SIN_CONEXION',          Activa: true },
      { Numero: '4', Etiqueta: 'Agendar instalación',        Intent: 'SOLICITAR_INSTALACION', Activa: true },
      { Numero: '5', Etiqueta: 'Información sobre planes',   Intent: 'CONSULTA_PERIODO',      Activa: true },
      { Numero: '6', Etiqueta: 'Hablar con un agente',       Intent: 'SOLICITAR_AGENTE',      Activa: true },
    ],
  },
  Horario: {
    HoraInicio: '08:00',
    HoraFin: '18:00',
    DiasActivos: [true, true, true, true, true, false, false], // Lun-Vie
    MensajeFueraHorario:
      'Estamos fuera de horario de atención. 🕐\n\n' +
      'Nuestro horario es de *Lunes a Viernes de 08:00 a 18:00*.\n\n' +
      'Tu mensaje quedará registrado y te atenderemos al inicio del próximo horario. 😊',
  },
  Mensajes: {
    Bienvenida: '¡Hola {{nombre}}! 👋 Soy el asistente virtual de *Telecom Bolivianet*.',
    Despedida: '¡Hasta luego! Si necesitas algo más, escríbenos. 😊',
    NoEntendido: 'No entendí bien tu consulta. 🤔 Puedo ayudarte con:',
    EscaladoAgente:
      'Lo siento, no pude resolver tu consulta de forma automática. 😔\n\n' +
      'Te estoy transfiriendo con un *agente humano* que te atenderá a la brevedad.\n\n' +
      'Por favor espera un momento. 🙏',
  },
  PalabrasClave: ['menu', 'menú', 'inicio', 'hola', 'ayuda'],
};

@Injectable()
export class BotRemoteConfigService implements OnModuleInit {
  private readonly logger = new Logger(BotRemoteConfigService.name);
  private cached: BotRemoteConfig = DEFAULT_BOT_CONFIG;
  private lastFetch = 0;

  constructor(private readonly sistemaApi: SistemaApiService) {}

  async onModuleInit(): Promise<void> {
    await this.refresh().catch((err) =>
      this.logger.warn(
        `Config remota no disponible al iniciar: ${err.message}. Usando defaults.`,
      ),
    );
  }

  // Devuelve la config cacheada y lanza un refresh en background si expiró.
  get(): BotRemoteConfig {
    if (Date.now() - this.lastFetch > CACHE_TTL_MS) {
      this.refresh().catch((err) =>
        this.logger.warn(`Error al refrescar config del bot: ${err.message}`),
      );
    }
    return this.cached;
  }

  // Construye el bloque de menú como texto formateado.
  buildMenuText(): string {
    const emojis: Record<string, string> = {
      '1': '1️⃣', '2': '2️⃣', '3': '3️⃣', '4': '4️⃣',
      '5': '5️⃣', '6': '6️⃣', '7': '7️⃣', '8': '8️⃣', '9': '9️⃣',
    };
    return this.cached.Menu.Opciones
      .filter((o) => o.Activa)
      .map((o) => `${emojis[o.Numero] ?? `${o.Numero}.`} ${o.Etiqueta}`)
      .join('\n');
  }

  // Verifica si el momento actual está dentro del horario de atención (Bolivia UTC-4).
  isWithinBusinessHours(): boolean {
    const { HoraInicio, HoraFin, DiasActivos } = this.cached.Horario;

    // Ajustar a hora Bolivia (UTC-4)
    const now = new Date(Date.now() - 4 * 60 * 60 * 1000);

    // JS getUTCDay(): 0=Dom, 1=Lun...6=Sáb → DiasActivos: 0=Lun...6=Dom
    const dayIndex = (now.getUTCDay() + 6) % 7;
    if (!DiasActivos[dayIndex]) return false;

    const currentMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    const [sh, sm] = HoraInicio.split(':').map(Number);
    const [eh, em] = HoraFin.split(':').map(Number);

    return currentMin >= sh * 60 + sm && currentMin < eh * 60 + em;
  }

  private async refresh(): Promise<void> {
    const data = await this.sistemaApi.getBotConfig();
    if (data) {
      this.cached = data;
      this.lastFetch = Date.now();
      this.logger.debug('Config del bot actualizada desde el backend.');
    }
  }
}
