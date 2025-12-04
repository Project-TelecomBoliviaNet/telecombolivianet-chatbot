import { MediaDownloadHandler } from './media-download.handler';
import { MessageContext } from './message-context';

// ══════════════════════════════════════════════════════════════════════════════
// FIX-21 — MediaDownloadHandler
// ══════════════════════════════════════════════════════════════════════════════

const makeCtx = (overrides: Partial<MessageContext> = {}): MessageContext =>
  ({ phone: '59170000001', messageId: 'MSG-001', type: 'text', ...overrides } as MessageContext);

describe('MediaDownloadHandler', () => {
  const whatsappMock     = { downloadMedia: jest.fn() };
  const mediaStorageMock = { saveMedia: jest.fn() };
  let handler: MediaDownloadHandler;

  beforeEach(() => {
    jest.resetAllMocks();
    handler = new MediaDownloadHandler(whatsappMock as any, mediaStorageMock as any);
  });

  // ── Texto ───────────────────────────────────────────────────────────────────

  it('texto simple: establece userContent = ctx.text y llama next()', async () => {
    const ctx  = makeCtx({ type: 'text', text: 'Buenos días' });
    const next = jest.fn().mockResolvedValue(undefined);

    await handler.handle(ctx, next);

    expect(ctx.userContent).toBe('Buenos días');
    expect(next).toHaveBeenCalledTimes(1);
    expect(whatsappMock.downloadMedia).not.toHaveBeenCalled();
  });

  // ── Audio ───────────────────────────────────────────────────────────────────

  it('audio: descarga, guarda y asigna audioBuffer y audioMediaUrl', async () => {
    const buf = Buffer.from('fake-audio');
    whatsappMock.downloadMedia.mockResolvedValue(buf);
    mediaStorageMock.saveMedia.mockResolvedValue('https://cdn/audio.ogg');

    const ctx = makeCtx({ type: 'audio', audioId: 'AUD-001' });
    await handler.handle(ctx, jest.fn().mockResolvedValue(undefined));

    expect(whatsappMock.downloadMedia).toHaveBeenCalledWith('AUD-001');
    expect(mediaStorageMock.saveMedia).toHaveBeenCalledWith(buf, 'audio', 'AUD-001');
    expect(ctx.audioBuffer).toBe(buf);
    expect(ctx.audioMediaUrl).toBe('https://cdn/audio.ogg');
    expect(ctx.userContent).toBe('🎤 Nota de voz');
    expect(ctx.incomingMediaType).toBe('audio');
  });

  it('audio: si descarga falla, audioBuffer = null y la cadena continúa', async () => {
    whatsappMock.downloadMedia.mockRejectedValue(new Error('timeout'));
    const next = jest.fn().mockResolvedValue(undefined);

    const ctx = makeCtx({ type: 'audio', audioId: 'AUD-002' });
    await expect(handler.handle(ctx, next)).resolves.not.toThrow();

    expect(ctx.audioBuffer).toBeNull();
    expect(next).toHaveBeenCalledTimes(1);
  });

  // ── Imagen ──────────────────────────────────────────────────────────────────

  it('imagen: descarga, guarda y asigna imageMediaUrl', async () => {
    const buf = Buffer.from('fake-image');
    whatsappMock.downloadMedia.mockResolvedValue(buf);
    mediaStorageMock.saveMedia.mockResolvedValue('https://cdn/img.jpg');

    const ctx = makeCtx({ type: 'image', imageId: 'IMG-001', imageCaption: 'Mi comprobante' });
    await handler.handle(ctx, jest.fn().mockResolvedValue(undefined));

    expect(ctx.imageMediaUrl).toBe('https://cdn/img.jpg');
    expect(ctx.userContent).toBe('Mi comprobante');   // caption como userContent
    expect(ctx.incomingMediaType).toBe('image');
    expect(ctx.incomingMediaUrl).toBe('https://cdn/img.jpg');
  });

  it('imagen sin caption: userContent = "[imagen]"', async () => {
    whatsappMock.downloadMedia.mockResolvedValue(Buffer.from('x'));
    mediaStorageMock.saveMedia.mockResolvedValue('https://cdn/img.jpg');

    const ctx = makeCtx({ type: 'image', imageId: 'IMG-002', imageCaption: undefined });
    await handler.handle(ctx, jest.fn().mockResolvedValue(undefined));

    expect(ctx.userContent).toBe('[imagen]');
  });

  it('imagen: si descarga falla, la cadena continúa sin lanzar', async () => {
    whatsappMock.downloadMedia.mockRejectedValue(new Error('red'));
    const next = jest.fn().mockResolvedValue(undefined);

    const ctx = makeCtx({ type: 'image', imageId: 'IMG-003' });
    await expect(handler.handle(ctx, next)).resolves.not.toThrow();
    expect(next).toHaveBeenCalledTimes(1);
  });

  // ── Ubicación ───────────────────────────────────────────────────────────────

  it('location: construye locationText con coordenadas y nombre', async () => {
    const ctx = makeCtx({
      type:            'location',
      locationLat:     -16.5,
      locationLng:     -68.15,
      locationName:    'Plaza Murillo',
      locationAddress: 'La Paz, Bolivia',
    });
    await handler.handle(ctx, jest.fn().mockResolvedValue(undefined));

    expect(ctx.locationText).toContain('https://maps.google.com/?q=-16.5,-68.15');
    expect(ctx.locationText).toContain('Plaza Murillo');
    expect(ctx.locationText).toContain('La Paz, Bolivia');
    expect(ctx.userContent).toBe(ctx.locationText);
  });

  it('location sin coordenadas: locationText es null y userContent es "[media]"', async () => {
    const ctx = makeCtx({ type: 'location', locationLat: undefined, locationLng: undefined });
    await handler.handle(ctx, jest.fn().mockResolvedValue(undefined));

    expect(ctx.locationText).toBeNull();
    expect(ctx.userContent).toBe('[media]');
  });
});
