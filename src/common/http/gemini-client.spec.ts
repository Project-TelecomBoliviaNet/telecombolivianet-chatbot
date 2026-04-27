import { geminiUrl, createGeminiClient } from './gemini-client';

// ══════════════════════════════════════════════════════════════
// TESTS UNITARIOS — gemini-client.ts
// Cubre: geminiUrl() y verificación de la configuración del cliente.
// El retry interceptor se verifica indirectamente usando el cliente
// real sin red (los test de integración cubrirían el retry completo).
// ══════════════════════════════════════════════════════════════

describe('geminiUrl()', () => {
  it('construye URL correcta para generateContent', () => {
    expect(geminiUrl('gemini-2.0-flash', 'generateContent'))
      .toBe('/v1beta/models/gemini-2.0-flash:generateContent');
  });

  it('construye URL correcta para embedContent', () => {
    expect(geminiUrl('text-embedding-004', 'embedContent'))
      .toBe('/v1beta/models/text-embedding-004:embedContent');
  });

  it('nunca incluye la API key en la URL', () => {
    const url = geminiUrl('gemini-2.0-flash', 'generateContent');
    expect(url).not.toContain('key=');
    expect(url).not.toContain('?');
    expect(url).not.toContain('AIza');
  });

  it('concatena modelo y acción con dos puntos', () => {
    const url = geminiUrl('test-model', 'testAction');
    expect(url).toContain('test-model:testAction');
  });
});

describe('createGeminiClient()', () => {
  it('devuelve un objeto con método post (instancia axios)', () => {
    const client = createGeminiClient('test-key-32chars-padding-here!!');
    expect(typeof client.post).toBe('function');
    expect(typeof client.get).toBe('function');
  });

  it('crea clientes distintos para distintas keys', () => {
    const c1 = createGeminiClient('key-one');
    const c2 = createGeminiClient('key-two');
    expect(c1).not.toBe(c2);
  });

  it('acepta timeout personalizado sin error', () => {
    expect(() => createGeminiClient('key', 8_000)).not.toThrow();
    expect(() => createGeminiClient('key', 60_000)).not.toThrow();
  });

  it('los defaults de baseURL apuntan a Gemini', () => {
    // Verificamos a través de los defaults del cliente creado
    const client = createGeminiClient('key') as any;
    const baseURL = client.defaults?.baseURL ?? '';
    expect(baseURL).toContain('generativelanguage.googleapis.com');
  });

  it('el header x-goog-api-key tiene la key correcta', () => {
    const client = createGeminiClient('mi-api-key-secreta') as any;
    const headers = client.defaults?.headers ?? {};
    // axios puede anidar en common o directamente
    const allHeaders = { ...headers, ...headers.common };
    const keyHeader = allHeaders['x-goog-api-key'];
    expect(keyHeader).toBe('mi-api-key-secreta');
  });

  it('el baseURL no contiene la API key', () => {
    const client = createGeminiClient('secret-api-key') as any;
    const baseURL = client.defaults?.baseURL ?? '';
    expect(baseURL).not.toContain('secret-api-key');
  });
});

describe('retry interceptor behavior', () => {
  it('el cliente tiene interceptor de response registrado', () => {
    // Verificamos que el interceptor fue añadido inspeccionando
    // los handlers registrados en la instancia axios
    const client = createGeminiClient('key') as any;
    const handlers = client.interceptors?.response?.handlers ?? [];
    // axios registra handlers como array de {fulfilled, rejected}
    expect(handlers.length).toBeGreaterThan(0);
  });
});
