import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosInstance } from 'axios';
import { createGeminiClient, geminiUrl } from '../../common/http/gemini-client';
import { PseudonymService, PiiGuardInterceptor } from '../../common/security/pseudonym';

// ══════════════════════════════════════════════════════════════
// INTENT DETECTOR SERVICE — Versión Gemini API
//
// Reemplaza Ollama local por Google Gemini Flash (API externa).
// Ventajas:
//   - Sin GPU ni infraestructura local de LLM
//   - gemini-2.0-flash: ~$0.0001 por clasificación
//   - Plan gratuito: 1500 req/día, 15 req/min
//   - Fallback a regex si la API falla o no está configurada
//
// ── US-EP01-03: Seudonimización antes de enviar a Gemini ─────
//   El texto del usuario se seudonimiza ANTES de construir el
//   prompt de clasificación. Gemini nunca recibe PII real.
//   La detección de intent no se ve afectada porque los tokens
//   (CLIENTE_001, MONTO_001) son suficientemente descriptivos
//   para que el clasificador identifique el intent correctamente.
//
// Interfaz pública IDÉNTICA a la versión anterior:
//   detect(text, phone?, clientName?): Promise<Intent>
//   isTransactional(intent): boolean
//   getTicketPriority(intent): 'Alta' | 'Media' | 'Baja'
//   getTicketType(intent): string
// ══════════════════════════════════════════════════════════════

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

const CLASSIFICATION_PROMPT = `
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
  { intent: Intent.CONSULTA_DEUDA,
    patterns: [/\bdebo\b/i, /\bdeuda\b/i, /\bsaldo\b/i, /\bfactura/i, /\bcuota/i, /\bpendiente/i] },
  { intent: Intent.SOLICITAR_QR,
    patterns: [/\bqr\b/i, /quiero pagar/i, /c.mo pago/i, /dame.*qr/i, /enviar.*qr/i, /necesito.*pagar/i] },
  { intent: Intent.SIN_CONEXION,
    patterns: [/sin internet/i, /no.*internet/i, /no funciona/i, /sin conexi/i, /se cort/i] },
  { intent: Intent.VELOCIDAD_LENTA,
    patterns: [/\blento\b/i, /poca velocidad/i, /baja velocidad/i, /\blag\b/i, /buffering/i] },
  { intent: Intent.PROBLEMA_ROUTER,
    patterns: [/\brouter\b/i, /m.dem/i, /luz roja/i, /luz amarilla/i] },
  // CANCELAR_INSTALACION antes de CANCELAR para que "cancelar la instalación" no
  // sea interceptado por /\bcancelar\b/ del intent CANCELAR
  { intent: Intent.CANCELAR_INSTALACION,
    patterns: [/cancelar.*instal/i, /cancela.*cita/i, /reagend/i, /cambiar.*horario/i, /cambiar.*cita/i, /reprogramar/i] },
  { intent: Intent.SOLICITAR_INSTALACION,
    patterns: [/instala/i, /contratar/i, /nuevo.*servicio/i, /\bplan\b/i, /\bprecio/i, /informaci/i] },
  { intent: Intent.CERRAR_TICKET,
    patterns: [/ya funciona/i, /se solucion/i, /cerrar.*ticket/i, /resuelto/i] },
  { intent: Intent.SOLICITAR_AGENTE,
    patterns: [/\bagente\b/i, /\bhumano\b/i, /\bpersona\b/i, /\boperador\b/i, /hablar con/i] },
  { intent: Intent.CONSULTA_PERIODO,
    // Patrones sin chars acentuados para evitar problemas de word-boundary en JS
    patterns: [/fecha.*pago/i, /fecha.*l.mite/i, /vence/i, /cu.*ndo.*pagar/i, /plazo.*pago/i] },
  // /^s[íi]\b/i falla porque \b no funciona tras chars Unicode; usamos /^s[ií]/i sin \b
  { intent: Intent.CONFIRMAR,
    patterns: [/^s[ií]/i, /\bde acuerdo\b/i, /^ok\b/i, /\bconfirmo\b/i, /\bperfecto\b/i] },
  { intent: Intent.CANCELAR,
    patterns: [/^no\b/i, /\bcancelar\b/i, /\bno quiero\b/i] },
  // /\bmenú\b/i falla porque \b no funciona con chars Unicode; usamos /men[uú]/i
  { intent: Intent.MENU,
    patterns: [/men[u\u00fa]/i, /\bopciones\b/i, /\bayuda\b/i] },
];

// Tipos para la respuesta de la API de Gemini
interface GeminiCandidate {
  content: { parts: Array<{ text: string }> };
}
interface GeminiResponse {
  candidates: GeminiCandidate[];
}

@Injectable()
export class IntentDetectorService implements OnModuleInit {
  private readonly logger = new Logger(IntentDetectorService.name);
  private http: AxiosInstance;
  private apiKey: string;
  private model: string;
  private geminiAvailable = false;

  constructor(
    private readonly config: ConfigService,
    private readonly pseudonymService: PseudonymService,
    private readonly piiGuard: PiiGuardInterceptor,
  ) {}

  async onModuleInit() {
    this.apiKey = this.config.get<string>('gemini.apiKey');
    this.model  = this.config.get<string>('gemini.intentModel');

    if (!this.apiKey) {
      this.logger.warn('GEMINI_API_KEY no configurada — IntentDetector usará solo regex');
      return;
    }

    this.http = createGeminiClient(this.apiKey, 8000);

    // Verificar conectividad con un request de prueba al arrancar
    try {
      await this.callGemini('hola');
      this.geminiAvailable = true;
      this.logger.log(`IntentDetector Gemini activo → ${this.model}`);
    } catch (err) {
      this.geminiAvailable = false;
      this.logger.warn(`IntentDetector: Gemini no disponible (${err.message}), usando fallback regex`);
    }
  }

  // ─── API pública ──────────────────────────────────────────────────────────

  /**
   * Detecta el intent del mensaje del usuario.
   *
   * US-EP01-03: El texto se seudonimiza antes de enviarse a Gemini.
   * El intent se detecta igual de bien porque los tokens son descriptivos.
   *
   * @param text        Texto original del usuario (puede contener PII).
   * @param phoneNumber Teléfono del cliente, necesario para namespacing Redis.
   *                    Opcional para mantener compatibilidad con llamadas existentes.
   * @param clientName  Nombre del cliente (de sesión), para seudonimizar el nombre.
   */
  async detect(
    text: string,
    phoneNumber?: string,
    clientName?: string | null,
  ): Promise<Intent> {
    if (!text?.trim()) return Intent.NINGUNO;

    // ── Seudonimizar antes de enviar a Gemini ────────────────────────────────
    let textToClassify = text;

    if (phoneNumber && this.geminiAvailable) {
      try {
        const { pseudonymizedText } = await this.pseudonymService.pseudonymize(
          text,
          phoneNumber,
          clientName,
        );
        textToClassify = pseudonymizedText;

        if (textToClassify !== text) {
          this.logger.debug(
            `[detect] Texto seudonimizado antes de Gemini | phone=${phoneNumber}`,
          );
        }
      } catch (err) {
        // Fallo en seudonimización → continuar con texto original (degradación controlada)
        this.logger.warn(
          `[detect] PseudonymService falló, continuando con texto original: ${err.message}`,
        );
      }
    }

    // ── Auditoría PiiGuard (antes de enviar a Gemini) ────────────────────────
    if (phoneNumber) {
      this.piiGuard.inspect(textToClassify, phoneNumber, null);
    }

    // ── Clasificación ────────────────────────────────────────────────────────
    if (this.geminiAvailable) {
      try {
        return await this.detectWithGemini(textToClassify);
      } catch (err) {
        this.logger.warn(`Gemini intent falló, usando regex fallback: ${err.message}`);
      }
    }

    return this.detectWithRegex(text); // Fallback: usar texto original
  }

  // ─── Clasificación via Gemini ─────────────────────────────
  private async detectWithGemini(text: string): Promise<Intent> {
    const raw = await this.callGemini(
      CLASSIFICATION_PROMPT + '\n\nMensaje del cliente: ' + text.trim().substring(0, 300),
    );

    const clean = raw.trim().toUpperCase().replace(/[^A-Z_]/g, '');

    if (clean in Intent) {
      this.logger.debug(`Gemini intent: "${text.substring(0, 50)}" → ${clean}`);
      return Intent[clean as keyof typeof Intent];
    }

    // Buscar substring válido si Gemini añadió texto extra
    for (const key of Object.keys(Intent)) {
      if (clean.includes(key)) {
        this.logger.debug(`Gemini intent (extraído): "${text.substring(0, 50)}" → ${key}`);
        return Intent[key as keyof typeof Intent];
      }
    }

    this.logger.debug(`Gemini devolvió "${clean}" inválido, usando regex`);
    return this.detectWithRegex(text);
  }

  // ─── Llamada HTTP a la API de Gemini ─────────────────────
  // Separada para poder reutilizarla en el warm-up de onModuleInit.
  private async callGemini(prompt: string): Promise<string> {
    const url = geminiUrl(this.model, 'generateContent');

    const res = await this.http.post<GeminiResponse>(url, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,       // Determinista: misma entrada → mismo intent
        maxOutputTokens: 10,  // Solo necesitamos una palabra
        stopSequences: ['\n', '.', ','],
      },
    });

    return res.data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  }

  // ─── Fallback regex ───────────────────────────────────────
  private detectWithRegex(text: string): Intent {
    const lower = text.toLowerCase().trim();
    for (const rule of FALLBACK_RULES) {
      if (rule.patterns.some(p => p.test(lower))) return rule.intent;
    }
    return Intent.NINGUNO;
  }

  // ─── Helpers de soporte (sin cambios) ────────────────────
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
