import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { GeminiClientService } from '../ai/gemini-client.service';

export enum Intent {
  CONSULTA_DEUDA        = 'CONSULTA_DEUDA',
  SOLICITAR_QR          = 'SOLICITAR_QR',
  ENVIO_COMPROBANTE     = 'ENVIO_COMPROBANTE',
  SOLICITAR_INSTALACION = 'SOLICITAR_INSTALACION',
  CANCELAR_INSTALACION  = 'CANCELAR_INSTALACION',
  SIN_CONEXION          = 'SIN_CONEXION',
  VELOCIDAD_LENTA       = 'VELOCIDAD_LENTA',
  PROBLEMA_ROUTER       = 'PROBLEMA_ROUTER',
  CERRAR_TICKET         = 'CERRAR_TICKET',
  SOLICITAR_AGENTE      = 'SOLICITAR_AGENTE',
  CONSULTA_PERIODO      = 'CONSULTA_PERIODO',
  SALUDO                = 'SALUDO',
  MENU                  = 'MENU',
  CONFIRMAR             = 'CONFIRMAR',
  CANCELAR              = 'CANCELAR',
  NINGUNO               = 'NINGUNO',
}

const CLASSIFICATION_SYSTEM = `
Eres un clasificador de intenciones para el chatbot de Telecom Bolivianet,
empresa de internet por fibra óptica en Bolivia.

Lee el mensaje del cliente y responde con EXACTAMENTE UNA de estas palabras,
sin explicación ni texto adicional:

SALUDO           → saludos: "hola", "buenas", "buen día", etc.
CONSULTA_DEUDA   → preguntas por deuda, saldo, facturas, cuánto debe
SOLICITAR_QR     → quiere pagar, pedir QR, código de pago, cómo pago
SOLICITAR_INSTALACION → quiere contratar, nueva instalación, preguntas sobre planes, precios, cobertura, información del servicio
CANCELAR_INSTALACION  → cancelar o reprogramar instalación ya agendada
SIN_CONEXION     → sin internet, red caída, no conecta, se cortó el servicio
VELOCIDAD_LENTA  → internet lento, tarda, buffering, baja velocidad
PROBLEMA_ROUTER  → falla router o módem, luces raras, reinicio del equipo
CERRAR_TICKET    → problema resuelto, quiere cerrar ticket de soporte
SOLICITAR_AGENTE → quiere persona real, agente humano, hablar con alguien
CONSULTA_PERIODO → cuándo vence, fecha límite, período de pago
MENU             → pedir opciones, ayuda general
CONFIRMAR        → sí, ok, de acuerdo, acepto, correcto, dale
CANCELAR         → no, cancelar, no quiero, dejar así
NINGUNO          → cualquier otro caso

REGLAS:
- Responde SOLO la palabra en mayúsculas, NADA más
- Ignora faltas de ortografía, jerga boliviana, abreviaciones de WhatsApp
- "qiero camviar plan" → SOLICITAR_INSTALACION
- "cuanto me sale el internet" → SOLICITAR_INSTALACION
- "no m llega el net" → SIN_CONEXION
- "kiero pagar" → SOLICITAR_QR
- "cuanto debo" → CONSULTA_DEUDA
`.trim();

const FALLBACK_RULES: Array<{ intent: Intent; patterns: RegExp[] }> = [
  { intent: Intent.SALUDO,
    patterns: [/^hola\b/i, /^buenas?\b/i, /^hey\b/i, /^buen(os|as)/i] },
  // CONSULTA_PERIODO antes que CONSULTA_DEUDA — "cuándo debo pagar" es periodo, no deuda
  { intent: Intent.CONSULTA_PERIODO,
    patterns: [/cu[aá]ndo.*pag/i, /fecha.*pag/i, /venci/i, /fecha.*l[íi]mite/i,
               /\bperiodo\b/i, /\bplazo\b/i, /fecha.*vencimiento/i] },
  { intent: Intent.CONSULTA_DEUDA,
    patterns: [/\bdebo\b/i, /\bdeuda\b/i, /\bsaldo\b/i, /\bfactura/i, /\bcuota/i, /\bpendiente/i] },
  { intent: Intent.SOLICITAR_QR,
    patterns: [/\bqr\b/i, /c[oó]mo pago/i, /quiero pagar/i, /realizar.*pago/i, /punto.*pago/i] },
  { intent: Intent.SIN_CONEXION,
    patterns: [/sin internet/i, /no.*internet/i, /no funciona/i, /sin conexi/i, /se cort/i,
               /sin señal/i, /no conecta/i, /ca[íi]da/i, /sin se[ñn]/i] },
  { intent: Intent.VELOCIDAD_LENTA,
    patterns: [/\blento\b/i, /poca velocidad/i, /baja velocidad/i, /\blag\b/i, /buffering/i,
               /no carga/i, /tard[ao]\b/i, /tarde mucho/i, /demora/i] },
  { intent: Intent.PROBLEMA_ROUTER,
    patterns: [/\brouter\b/i, /\bm[oó]dem\b/i, /luz roja/i, /luz amarilla/i,
               /parpadea/i, /reinicia/i, /\baparato\b/i, /se apaga/i, /equipo.*falla/i] },
  { intent: Intent.CANCELAR_INSTALACION,
    patterns: [/cancelar.*instal/i, /reagendar/i, /cambiar.*cita/i, /cambiar.*horario/i,
               /no puedo.*d[íi]a/i, /\bcita\b/i] },
  { intent: Intent.SOLICITAR_INSTALACION,
    patterns: [/instala/i, /contratar/i, /nuevo.*servicio/i, /\bservicio\b/i,
               /nuevo cliente/i, /\bplan\b/i, /\bprecio/i, /informaci/i] },
  { intent: Intent.CERRAR_TICKET,
    patterns: [/ya funciona/i, /se solucion/i, /cerrar.*ticket/i, /resuelto/i,
               /solucionado/i, /ya est[aá] bien/i, /ya est[aá] resuelto/i] },
  { intent: Intent.SOLICITAR_AGENTE,
    patterns: [/\bagente\b/i, /\bhumano\b/i, /\bpersona\b/i, /\boperador\b/i, /hablar con/i] },
  { intent: Intent.CONFIRMAR,
    patterns: [/^s[íi]/i, /\bde acuerdo\b/i, /^ok\b/i, /\bconfirmo\b/i, /\bperfecto\b/i] },
  { intent: Intent.CANCELAR,
    patterns: [/^no\b/i, /\bcancelar\b/i, /\bno quiero\b/i, /dejar as[íi]/i] },
  { intent: Intent.MENU,
    patterns: [/\bmen[uú]/i, /\bopciones\b/i, /\bayuda\b/i] },
];

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

@Injectable()
export class IntentDetectorService implements OnModuleInit {
  private readonly logger = new Logger(IntentDetectorService.name);
  private http: AxiosInstance;
  private apiKey: string;
  private chatModel: string;
  private geminiAvailable = false;

  constructor(
    private readonly config: ConfigService,
    private readonly geminiClient: GeminiClientService,
  ) {}

  async onModuleInit() {
    this.apiKey    = this.config.get<string>('gemini.apiKey');
    this.chatModel = this.config.get<string>('gemini.chatModel');
    this.http = axios.create({ timeout: 10000 });

    if (!this.geminiClient.isEnabled()) {
      this.logger.warn('Gemini no configurado — usando fallback regex');
      return;
    }

    try {
      await this.callGemini('hola', 5);
      this.geminiAvailable = true;
      const authMode = this.geminiClient.isUsingOAuth() ? 'OAuth2 (Vertex AI)' : 'API key';
      this.logger.log(`IntentDetector Gemini activo → ${this.chatModel} (${authMode})`);
    } catch {
      this.geminiAvailable = false;
      this.logger.warn('Gemini no disponible al arrancar — usando fallback regex');
    }
  }

  async detect(text: string): Promise<Intent> {
    if (!text?.trim()) return Intent.NINGUNO;

    // Regex primero: cubre ~90% de los casos sin costo de API
    const regexResult = this.detectWithRegex(text);
    if (regexResult !== Intent.NINGUNO) return regexResult;

    // Gemini solo para mensajes ambiguos que el regex no clasifica
    if (this.geminiAvailable) {
      try {
        return await this.detectWithGemini(text);
      } catch (err) {
        this.logger.warn(`Gemini intent falló: ${String(err)}`);
      }
    }

    return Intent.NINGUNO;
  }

  private async detectWithGemini(text: string): Promise<Intent> {
    const raw = await this.callGemini(
      `${CLASSIFICATION_SYSTEM}\n\nMensaje del cliente: ${text.trim().substring(0, 300)}`,
      10,
    );
    const cleaned = raw.trim().toUpperCase().replace(/[^A-Z_]/g, '');

    if (cleaned in Intent) {
      this.logger.debug(`Gemini intent: "${text.substring(0, 50)}" → ${cleaned}`);
      return Intent[cleaned as keyof typeof Intent];
    }

    for (const key of Object.keys(Intent)) {
      if (cleaned.includes(key)) {
        this.logger.debug(`Gemini intent (extraído): "${text.substring(0, 50)}" → ${key}`);
        return Intent[key as keyof typeof Intent];
      }
    }

    this.logger.debug(`Gemini devolvió "${cleaned}" inválido, usando regex`);
    return this.detectWithRegex(text);
  }

  // ─── Llamada REST a Gemini (Vertex AI u OAuth2 según config) ────
  private async callGemini(prompt: string, maxTokens: number): Promise<string> {
    const url     = this.geminiClient.buildUrl(GEMINI_BASE, this.chatModel, 'generateContent', this.apiKey);
    const headers = await this.geminiClient.getAuthHeaders();
    const res = await this.http.post(url, {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, maxOutputTokens: maxTokens },
    }, { headers });
    return res.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  }

  private detectWithRegex(text: string): Intent {
    const lower = text.toLowerCase().trim();
    for (const rule of FALLBACK_RULES) {
      if (rule.patterns.some(p => p.test(lower))) return rule.intent;
    }
    return Intent.NINGUNO;
  }

  isTransactional(intent: Intent): boolean {
    return ![Intent.NINGUNO, Intent.MENU, Intent.SALUDO].includes(intent);
  }

  getTicketPriority(intent: Intent): 'Alta' | 'Media' | 'Baja' {
    if (intent === Intent.SIN_CONEXION) return 'Alta';
    if ([Intent.VELOCIDAD_LENTA, Intent.PROBLEMA_ROUTER].includes(intent)) return 'Media';
    return 'Baja';
  }

  getTicketType(intent: Intent): string {
    switch (intent) {
      case Intent.SIN_CONEXION:
      case Intent.VELOCIDAD_LENTA:
      case Intent.PROBLEMA_ROUTER:
        return 'SoporteTecnico';
      case Intent.SOLICITAR_INSTALACION:
        return 'InstalacionNueva';
      default:
        return 'SoporteTecnico';
    }
  }
}
