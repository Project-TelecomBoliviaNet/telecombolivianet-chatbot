import { SessionData } from '../../session/session.service';

/**
 * FIX-21: Contexto compartido que fluye a través del pipeline de mensajes.
 * Cada handler puede leer y enriquecer este objeto.
 * Para detener la cadena, un handler setea shouldStop = true y no llama next().
 */
export interface MessageContext {
  // ── Entrada (del webhook de Meta) ────────────────────────────────────────
  phone: string;
  messageId: string;
  type: string;
  text?: string;
  interactiveId?: string;
  imageId?: string;
  imageCaption?: string;
  audioId?: string;
  locationLat?: number;
  locationLng?: number;
  locationName?: string;
  locationAddress?: string;

  // ── Computado por MediaDownloadHandler ───────────────────────────────────
  audioBuffer?: Buffer | null;
  audioMediaUrl?: string;
  imageMediaUrl?: string;
  locationText?: string | null;
  userContent?: string;
  incomingMediaUrl?: string;
  incomingMediaType?: 'image' | 'audio';

  // ── Computado por SessionLoadHandler ─────────────────────────────────────
  session?: SessionData;

  // ── Computado por MessagePersistHandler ──────────────────────────────────
  isFirstContact?: boolean;

  // ── Computado por ClientIdentificationHandler ─────────────────────────────
  updatedSession?: SessionData;

  // ── Computado por TextResolverHandler ────────────────────────────────────
  effectiveText?: string | null;
}
