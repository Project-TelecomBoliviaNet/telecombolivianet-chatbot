import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { GeminiClientService } from '../ai/gemini-client.service';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// Verifica que Gemini esté disponible al arrancar la aplicación.
@Injectable()
export class GeminiWarmupService implements OnApplicationBootstrap {
  private readonly logger = new Logger(GeminiWarmupService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly geminiClient: GeminiClientService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const apiKey = this.config.get<string>('gemini.apiKey');
    const model  = this.config.get<string>('gemini.chatModel');

    if (!apiKey && !this.geminiClient.isUsingOAuth()) {
      this.logger.warn('GEMINI_API_KEY no configurada — el chatbot usará fallback regex');
      return;
    }

    try {
      const url     = this.geminiClient.buildUrl(GEMINI_BASE, model, 'generateContent', apiKey);
      const headers = await this.geminiClient.getAuthHeaders();
      await axios.post(url, {
        contents: [{ role: 'user', parts: [{ text: 'ok' }] }],
        generationConfig: { maxOutputTokens: 1 },
      }, { timeout: 8000, headers });
      const authMode = this.geminiClient.isUsingOAuth() ? 'OAuth2' : 'API key';
      this.logger.log(`Gemini conectado ✔ (modelo: ${model}, auth: ${authMode})`);
    } catch (err) {
      this.logger.warn(`Gemini no disponible al arrancar: ${String(err)} | body: ${JSON.stringify((err as any).response?.data)}`);
    }
  }
}
