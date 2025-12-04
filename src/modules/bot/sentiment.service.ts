import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { GeminiClientService } from '../ai/gemini-client.service';
import { ConfigService } from '@nestjs/config';

// ══════════════════════════════════════════════════════════════
// SENTIMENT SERVICE
//
// Responsabilidad única: detectar el estado emocional del cliente
// a partir de su último mensaje, usando Gemini como clasificador.
// Separado de AgentService para que se pueda testear, reemplazar
// o desactivar independientemente del loop ReAct (SRP).
// ══════════════════════════════════════════════════════════════

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export type SentimentLabel = 'neutral' | 'frustrated' | 'angry' | 'happy';
const VALID_LABELS: readonly SentimentLabel[] = ['neutral', 'frustrated', 'angry', 'happy'];

@Injectable()
export class SentimentService {
  private readonly logger = new Logger(SentimentService.name);
  private readonly http: AxiosInstance;
  private readonly apiKey: string;
  private readonly chatModel: string;

  constructor(
    private readonly config: ConfigService,
    private readonly geminiClient: GeminiClientService,
  ) {
    this.apiKey    = config.get<string>('gemini.apiKey');
    this.chatModel = config.get<string>('gemini.chatModel') ?? 'gemini-2.0-flash';
    this.http      = axios.create({ timeout: 10000 });
  }

  // lastBotMessage: último mensaje del bot antes de este texto,
  // necesario para interpretar respuestas cortas como "no" o "sí"
  // en contexto (ej: respuesta a pregunta cerrada ≠ frustración).
  async detect(
    text: string,
    lastBotMessage?: string,
  ): Promise<SentimentLabel> {
    if (!this.apiKey && !this.geminiClient.isUsingOAuth()) return 'neutral';
    try {
      const url     = this.geminiClient.buildUrl(GEMINI_BASE, this.chatModel, 'generateContent', this.apiKey);
      const headers = await this.geminiClient.getAuthHeaders();

      const contextLine = lastBotMessage
        ? `Contexto: el bot acaba de preguntar: "${lastBotMessage.substring(0, 120)}"\n`
        : '';

      const prompt =
        `${contextLine}` +
        `Clasifica el sentimiento del CLIENTE con UNA sola palabra (neutral/frustrated/angry/happy).\n` +
        `Si el mensaje es una respuesta corta a una pregunta cerrada (ej: "no", "sí", "ok"), clasifica como neutral.\n` +
        `Mensaje del cliente: "${text.substring(0, 200)}"`;

      const res = await this.http.post(url, {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 5 },
      }, { headers });

      const raw = res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toLowerCase() ?? '';
      return VALID_LABELS.includes(raw as SentimentLabel)
        ? (raw as SentimentLabel)
        : 'neutral';
    } catch {
      return 'neutral';
    }
  }
}
