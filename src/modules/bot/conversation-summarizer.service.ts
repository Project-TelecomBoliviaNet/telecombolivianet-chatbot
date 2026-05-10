import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { ConfigService } from '@nestjs/config';
import { GeminiClientService } from '../ai/gemini-client.service';
import { GeminiContent } from '../session/session.service';

// ══════════════════════════════════════════════════════════════
// CONVERSATION SUMMARIZER SERVICE
//
// Responsabilidad única: generar resúmenes y respuestas generales
// a partir del historial de conversación usando Gemini.
// Separado de AgentService para que los cambios en cómo se
// resume una conversación no toquen la lógica del loop ReAct (SRP).
// ══════════════════════════════════════════════════════════════

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

@Injectable()
export class ConversationSummarizerService {
  private readonly logger = new Logger(ConversationSummarizerService.name);
  private readonly http: AxiosInstance;
  private readonly apiKey: string;
  private readonly chatModel: string;

  constructor(
    private readonly config: ConfigService,
    private readonly geminiClient: GeminiClientService,
  ) {
    this.apiKey    = config.get<string>('gemini.apiKey');
    this.chatModel = config.get<string>('gemini.chatModel') ?? 'gemini-2.0-flash';
    this.http      = axios.create({ timeout: 30000 });
  }

  async summarize(messages: GeminiContent[]): Promise<string> {
    if ((!this.apiKey && !this.geminiClient.isUsingOAuth()) || messages.length < 4) return '';
    try {
      const transcript = messages
        .map(m => `${m.role === 'user' ? 'Cliente' : 'Bot'}: ${m.parts[0]?.text ?? ''}`)
        .join('\n');

      const url     = this.geminiClient.buildUrl(GEMINI_BASE, this.chatModel, 'generateContent', this.apiKey);
      const headers = await this.geminiClient.getAuthHeaders();
      const res     = await this.http.post(url, {
        contents: [{
          role: 'user',
          parts: [{ text: `Resume esta conversación de soporte en máximo 2 oraciones. Incluye qué necesitaba el cliente y si se resolvió.\n\n${transcript}` }],
        }],
        generationConfig: { temperature: 0, maxOutputTokens: 120 },
      }, { headers });
      return res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
    } catch {
      return '';
    }
  }

  async generateGeneralAnswer(question: string, conversationContext: string): Promise<string> {
    if (!this.apiKey && !this.geminiClient.isUsingOAuth()) return '';
    try {
      const url     = this.geminiClient.buildUrl(GEMINI_BASE, this.chatModel, 'generateContent', this.apiKey);
      const headers = await this.geminiClient.getAuthHeaders();
      const res     = await this.http.post(url, {
        system_instruction: {
          parts: [{ text: `Eres el asistente de Telecom Bolivianet. Responde con sentido común y en español boliviano. NO inventes precios ni datos técnicos específicos. Si no puedes responder con certeza, ofrece conectar con un agente.` }],
        },
        contents: [{
          role: 'user',
          parts: [{ text: conversationContext ? `${conversationContext}\nCliente: ${question}` : question }],
        }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 300 },
      }, { headers });
      return res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
    } catch {
      return '';
    }
  }
}
