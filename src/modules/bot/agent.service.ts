import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { SessionData, GeminiContent } from '../session/session.service';
import { GeminiClientService } from '../ai/gemini-client.service';
import { PromptBuilderService } from './prompt-builder.service';
import { SentimentService, SentimentLabel } from './sentiment.service';
import { ConversationSummarizerService } from './conversation-summarizer.service';

// ══════════════════════════════════════════════════════════════
// AGENT SERVICE
//
// Responsabilidad única: ejecutar el loop ReAct con Gemini.
//   Reason → Act → Observe → Respond
//
// La construcción del prompt, detección de sentimiento y
// resúmenes de conversación fueron extraídos a sus propios
// servicios (SRP):
//   - PromptBuilderService        → buildSystemPrompt
//   - SentimentService            → detectSentiment
//   - ConversationSummarizerService → summarize / generateGeneralAnswer
// ══════════════════════════════════════════════════════════════

const GEMINI_BASE     = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_REACT_LOOPS = 5;

export type ToolExecutor = (name: string, args: Record<string, any>) => Promise<any>;

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly http: AxiosInstance;
  private readonly apiKey: string;
  private readonly chatModel: string;
  private readonly maxTokens: number;

  constructor(
    private readonly config:      ConfigService,
    private readonly geminiClient: GeminiClientService,
    private readonly promptBuilder: PromptBuilderService,
    private readonly sentiment:     SentimentService,
    private readonly summarizer:    ConversationSummarizerService,
  ) {
    this.apiKey    = config.get<string>('gemini.apiKey');
    this.chatModel = config.get<string>('gemini.chatModel') ?? 'gemini-2.0-flash';
    this.maxTokens = config.get<number>('gemini.maxTokens') ?? 400;
    this.http      = axios.create({ timeout: 60000 });
  }

  // Delegaciones hacia servicios especializados — mantienen
  // la interfaz pública que BotOrchestratorService ya usa.
  buildSystemPrompt(session: SessionData): string {
    return this.promptBuilder.build(session);
  }

  async detectSentiment(text: string, lastBotMessage?: string): Promise<SentimentLabel> {
    return this.sentiment.detect(text, lastBotMessage);
  }

  async summarizeConversation(messages: GeminiContent[]): Promise<string> {
    return this.summarizer.summarize(messages);
  }

  async generateGeneralAnswer(question: string, conversationContext: string): Promise<string> {
    return this.summarizer.generateGeneralAnswer(question, conversationContext);
  }

  // ─── LOOP REACT PRINCIPAL ─────────────────────────────────
  async run(
    userMessage: string,
    session: SessionData,
    history: GeminiContent[],
    toolExecutor: ToolExecutor,
    toolDeclarations: object[] = [],
    appendSystemContext?: string,
  ): Promise<{ response: string; toolsCalled: string[] }> {
    const startMs    = Date.now();
    const toolsCalled: string[] = [];

    const contents: any[] = [
      ...history,
      { role: 'user', parts: [{ text: userMessage }] },
    ];

    const url         = this.geminiClient.buildUrl(GEMINI_BASE, this.chatModel, 'generateContent', this.apiKey);
    const authHeaders = await this.geminiClient.getAuthHeaders();
    let finalResponse = '';

    for (let loop = 0; loop < MAX_REACT_LOOPS; loop++) {
      let geminiResponse: any;

      const systemText = appendSystemContext
        ? `${this.promptBuilder.build(session)}\n\n${appendSystemContext}`
        : this.promptBuilder.build(session);

      try {
        const res = await this.http.post(url, {
          system_instruction: {
            parts: [{ text: systemText }],
          },
          contents,
          tools: [{ functionDeclarations: toolDeclarations }],
          tool_config: { function_calling_config: { mode: 'AUTO' } },
          generationConfig: {
            temperature:      0.4,
            maxOutputTokens:  this.maxTokens,
          },
        }, { headers: authHeaders });
        geminiResponse = res.data?.candidates?.[0]?.content;
      } catch (err) {
        this.logger.error(`Gemini error en loop ${loop}: ${(err as any).message} | body: ${JSON.stringify((err as any).response?.data)}`);
        return {
          response: '😔 Tuve un problema al procesar tu consulta. Por favor intenta de nuevo.',
          toolsCalled,
        };
      }

      if (!geminiResponse) {
        this.logger.warn(`Gemini devolvió respuesta vacía en loop ${loop}`);
        return {
          response: '😔 No pude generar una respuesta. Por favor intenta de nuevo.',
          toolsCalled,
        };
      }

      const parts: any[]          = geminiResponse?.parts ?? [];
      const functionCallParts     = parts.filter(p => p.functionCall);
      const textParts             = parts.filter(p => p.text);

      if (functionCallParts.length === 0) {
        finalResponse = textParts.map(p => p.text).join('').trim();
        break;
      }

      const toolResultParts: any[] = [];
      for (const part of functionCallParts) {
        const { name, args } = part.functionCall;
        toolsCalled.push(name);
        this.logger.debug(`Ejecutando herramienta: ${name} args=${JSON.stringify(args)}`);

        let result: any;
        try {
          result = await toolExecutor(name, args ?? {});
        } catch (err) {
          this.logger.warn(`Error en herramienta ${name}: ${(err as Error).message}`);
          result = { error: `Error ejecutando ${name}: ${(err as Error).message}` };
        }

        toolResultParts.push({
          functionResponse: { name, response: { result } },
        });
      }

      contents.push({ role: 'model', parts });
      contents.push({ role: 'user',  parts: toolResultParts });
    }

    if (!finalResponse) {
      this.logger.warn(`Agente no generó respuesta tras ${MAX_REACT_LOOPS} loops`);
      finalResponse = '😔 No pude procesar tu consulta. ¿Puedes reformularla?';
    }

    this.logger.log(JSON.stringify({
      event:          'agent_run',
      durationMs:     Date.now() - startMs,
      toolsCalled,
      responseLength: finalResponse.length,
      sentiment:      session.lastSentiment,
    }));

    return { response: finalResponse, toolsCalled };
  }
}
