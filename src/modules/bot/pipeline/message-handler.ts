import { MessageContext } from './message-context';

/**
 * FIX-21: Contrato para cada paso del pipeline de mensajes entrantes.
 * Los handlers forman una cadena: cada uno llama next() para pasar al siguiente
 * o no lo llama para detener la cadena (cortocircuito).
 */
export interface MessageHandler {
  handle(ctx: MessageContext, next: () => Promise<void>): Promise<void>;
}

/** Token de inyección para el array ordenado de handlers. */
export const MESSAGE_PIPELINE = Symbol('MESSAGE_PIPELINE');
