import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import axios from 'axios';

// ══════════════════════════════════════════════════════════════
// GeminiClientService
//
// Centraliza la autenticación con Gemini.
// Soporta dos modos:
//   - Vertex AI (cuenta de servicio → billing en Google Cloud)
//     Activo cuando GOOGLE_SERVICE_ACCOUNT_JSON está configurado.
//     Usa scope cloud-platform y endpoint aiplatform.googleapis.com
//   - API Key (fallback → billing en AI Studio)
//     Usa endpoint generativelanguage.googleapis.com
// ══════════════════════════════════════════════════════════════

@Injectable()
export class GeminiClientService implements OnModuleInit {
  private readonly logger = new Logger(GeminiClientService.name);
  private auth: GoogleAuth | null = null;
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;
  private projectId: string | null = null;
  private location = 'us-central1';

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    this.location = this.config.get<string>('gemini.location') || 'us-central1';
    const credJson = this.config.get<string>('gemini.serviceAccountJson');
    if (!credJson) {
      this.logger.warn('GOOGLE_SERVICE_ACCOUNT_JSON no configurado — usando API key (AI Studio billing)');
      return;
    }
    try {
      const credentials = JSON.parse(credJson);
      this.projectId = credentials.project_id || null;
      this.auth = new GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
      this.logger.log(
        `GeminiClientService: Vertex AI habilitado — proyecto: ${this.projectId}, región: ${this.location}`,
      );
    } catch (err) {
      this.logger.error(
        `GeminiClientService: error parseando JSON de cuenta de servicio: ${(err as Error).message}`,
      );
    }
  }

  // ─── Token OAuth2 con caché (se renueva 60s antes de expirar) ─
  async getAccessToken(): Promise<string | null> {
    if (!this.auth) return null;
    if (this.cachedToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.cachedToken;
    }
    try {
      const client = await this.auth.getClient() as OAuth2Client;
      const tokenResponse = await client.getAccessToken();
      this.cachedToken = tokenResponse.token;
      this.tokenExpiresAt = Date.now() + 3_600_000;
      return this.cachedToken;
    } catch (err: any) {
      this.cachedToken = null;
      this.tokenExpiresAt = 0;
      throw err;
    }
  }

  // ─── Headers de autenticación ──────────────────────────────────
  async getAuthHeaders(): Promise<Record<string, string>> {
    const token = await this.getAccessToken();
    if (token) return { Authorization: `Bearer ${token}` };
    return {};
  }

  // ─── URL según modo: Vertex AI u OAuth2 vs API key ─────────────
  // base y apiKey se ignoran cuando Vertex AI está activo.
  buildUrl(base: string, model: string, method: string, apiKey: string): string {
    if (this.auth && this.projectId) {
      return (
        `https://${this.location}-aiplatform.googleapis.com/v1` +
        `/projects/${this.projectId}/locations/${this.location}` +
        `/publishers/google/models/${model}:${method}`
      );
    }
    return `${base}/${model}:${method}?key=${apiKey}`;
  }

  // ─── Embedding unificado ───────────────────────────────────────
  // Vertex AI usa endpoint `predict` con formato `instances`.
  // AI Studio usa endpoint `embedContent` con formato `content`.
  async embedText(text: string, model: string, taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY' = 'RETRIEVAL_DOCUMENT'): Promise<number[]> {
    if (this.auth && this.projectId) {
      const url =
        `https://${this.location}-aiplatform.googleapis.com/v1` +
        `/projects/${this.projectId}/locations/${this.location}` +
        `/publishers/google/models/${model}:predict`;
      const headers = await this.getAuthHeaders();
      const res = await axios.post(
        url,
        { instances: [{ content: text, task_type: taskType }] },
        { headers, timeout: 30_000 },
      );
      return res.data?.predictions?.[0]?.embeddings?.values as number[];
    }
    const apiKey = this.config.get<string>('gemini.apiKey');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`;
    const res = await axios.post(
      url,
      { model: `models/${model}`, content: { parts: [{ text }] } },
      { timeout: 30_000 },
    );
    return res.data?.embedding?.values as number[];
  }

  // ─── Helpers de estado ─────────────────────────────────────────
  isUsingOAuth(): boolean {
    return this.auth !== null;
  }

  isEnabled(): boolean {
    return this.auth !== null || !!this.config.get<string>('gemini.apiKey');
  }
}
