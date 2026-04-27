import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';

// ══════════════════════════════════════════════════════════════
// GEMINI HTTP CLIENT — cliente centralizado
//
// Correcciones aplicadas:
//   1. API key en header x-goog-api-key (NO en query string).
//      El query string expone la clave en logs de servidor,
//      proxies, CDNs y balanceadores. El header es la forma
//      correcta según la documentación oficial de Google.
//   2. Una sola instancia compartida entre todos los servicios
//      que llaman a Gemini (Intent, RAG, Receipt, Health).
//   3. Retry con backoff exponencial en errores 429 / 5xx.
//      El plan gratuito de Gemini tiene límite de 15 req/min —
//      un retry inteligente evita que un pico de tráfico
//      haga que el bot responda "no pude procesar".
// ══════════════════════════════════════════════════════════════

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';

/**
 * Crea un cliente axios configurado para Gemini API.
 * La API key se envía siempre como header x-goog-api-key.
 * Nunca como parámetro de query string.
 */
export function createGeminiClient(apiKey: string, timeoutMs = 30_000): AxiosInstance {
  const instance = axios.create({
    baseURL: GEMINI_BASE_URL,
    timeout: timeoutMs,
    headers: {
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json',
    },
  });

  // Interceptor de retry: reintenta automáticamente en 429 y 5xx
  // con backoff exponencial (1s, 2s, 4s) hasta 3 intentos.
  instance.interceptors.response.use(
    (response) => response,
    async (error) => {
      const config = error.config as AxiosRequestConfig & { _retryCount?: number };
      const status = error.response?.status;

      const isRetryable = status === 429 || (status >= 500 && status < 600);
      const retryCount  = config._retryCount ?? 0;
      const maxRetries  = 3;

      if (isRetryable && retryCount < maxRetries) {
        config._retryCount = retryCount + 1;
        const delayMs = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s
        await new Promise((r) => setTimeout(r, delayMs));
        return instance.request(config);
      }

      return Promise.reject(error);
    },
  );

  return instance;
}

/**
 * Construye la ruta de un endpoint de Gemini sin incluir la API key.
 * Ejemplo: geminiUrl('gemini-2.0-flash', 'generateContent')
 *   → '/v1beta/models/gemini-2.0-flash:generateContent'
 */
export function geminiUrl(model: string, action: string): string {
  return `/v1beta/models/${model}:${action}`;
}
