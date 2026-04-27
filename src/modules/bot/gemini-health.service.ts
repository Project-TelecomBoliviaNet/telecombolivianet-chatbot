import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createGeminiClient, geminiUrl } from '../../common/http/gemini-client';

// ══════════════════════════════════════════════════════════════
// GEMINI HEALTH SERVICE
//
// Verifica al arrancar que la API key sea válida y que los tres
// modelos configurados respondan. No bloquea el arranque si
// Gemini no está disponible (el chatbot cae a regex fallback).
//
// Usa el cliente centralizado con API key en header (no en URL).
// ══════════════════════════════════════════════════════════════

@Injectable()
export class GeminiHealthService implements OnApplicationBootstrap {
  private readonly logger = new Logger(GeminiHealthService.name);

  constructor(private readonly config: ConfigService) {}

  async onApplicationBootstrap(): Promise<void> {
    const apiKey      = this.config.get<string>('gemini.apiKey');
    const intentModel = this.config.get<string>('gemini.intentModel');
    const embedModel  = this.config.get<string>('gemini.embedModel');
    const ragModel    = this.config.get<string>('gemini.ragModel');

    if (!apiKey) {
      this.logger.warn(
        '⚠️  GEMINI_API_KEY no configurada.\n' +
        '   El chatbot usará detección por REGEX (modo degradado).\n' +
        '   El pipeline RAG estará DESHABILITADO.\n' +
        '   Obtén tu API key en: https://aistudio.google.com/app/apikey',
      );
      return;
    }

    // Cliente compartido con API key en header x-goog-api-key
    const http = createGeminiClient(apiKey, 8000);

    this.logger.log('Verificando conectividad con Google Gemini API…');

    const [intentOk, embedOk, ragOk] = await Promise.all([
      this.checkGenerate(http, intentModel),
      this.checkEmbed(http, embedModel),
      this.checkGenerate(http, ragModel),
    ]);

    this.logResult('Intent model', intentModel, intentOk, 'usará regex fallback');
    this.logResult('Embed model',  embedModel,  embedOk,  'RAG deshabilitado');
    this.logResult('RAG model',    ragModel,    ragOk,    'respuestas RAG no disponibles');

    if (intentOk && embedOk && ragOk) {
      this.logger.log('✔ Gemini API lista — todos los modelos respondiendo correctamente');
    } else {
      this.logger.warn('Gemini API parcialmente disponible — revisa los logs anteriores');
    }
  }

  private async checkGenerate(http: ReturnType<typeof createGeminiClient>, model: string): Promise<boolean> {
    try {
      const res = await http.post(geminiUrl(model, 'generateContent'), {
        contents: [{ parts: [{ text: 'ok' }] }],
        generationConfig: { maxOutputTokens: 1, temperature: 0 },
      });
      return res.status === 200;
    } catch {
      return false;
    }
  }

  private async checkEmbed(http: ReturnType<typeof createGeminiClient>, model: string): Promise<boolean> {
    try {
      const res = await http.post(geminiUrl(model, 'embedContent'), {
        model: `models/${model}`,
        content: { parts: [{ text: 'test' }] },
        taskType: 'RETRIEVAL_QUERY',
      });
      return res.status === 200;
    } catch {
      return false;
    }
  }

  private logResult(label: string, model: string, ok: boolean, failNote: string): void {
    if (ok) {
      this.logger.log(`✔ ${label} OK → ${model}`);
    } else {
      this.logger.warn(`✘ ${label} no disponible → ${model} (${failNote})`);
    }
  }
}
