// ══════════════════════════════════════════════════════════════
// PENDING ACTION — máquina de estados tipada
//
// Reemplaza el sistema anterior de strings crudos como:
//   "CONFIRM_CLOSE_TICKET:A1B2C3"  → parseado con split(':')
//   "AWAITING_ADDRESS:2025-01-06|09:00" → parseado con replace()
//
// Problemas del sistema anterior:
//   - split(':')[1] falla si el ID contiene dos puntos
//   - Sin validación de transiciones de estado
//   - Sin tipado: cualquier string era válido
//
// Solución: objeto serializado como JSON en Redis.
//   { type: 'CONFIRM_CLOSE_TICKET', ticketId: 'A1B2C3' }
// Los datos van en campos tipados, no concatenados en el type.
// ══════════════════════════════════════════════════════════════

export type PendingActionType =
  | 'AWAITING_SLOT_SELECTION'
  | 'AWAITING_ADDRESS'
  | 'AWAITING_TICKET_DETAILS'
  | 'AWAITING_RAG_FEEDBACK'
  | 'AWAITING_TICKET_ID_TO_CLOSE'
  | 'CONFIRM_CLOSE_TICKET'
  | 'CONFIRM_CANCEL_INSTALLATION';

export interface PendingAction {
  type: PendingActionType;
  // Datos opcionales según el tipo de acción
  ticketId?: string;
  installationId?: string;
  slotDate?: string;   // 'YYYY-MM-DD'
  slotTime?: string;   // 'HH:mm'
}

/**
 * Serializa una PendingAction a string JSON para guardar en Redis.
 */
export function serializeAction(action: PendingAction): string {
  return JSON.stringify(action);
}

/**
 * Deserializa el string de Redis a una PendingAction tipada.
 * Devuelve null si el valor no es un JSON válido o no tiene 'type'.
 *
 * Compatible con el formato antiguo de strings crudos:
 * Si el string no empieza con '{', intenta parsear el formato legacy
 * para no romper sesiones Redis existentes durante la migración.
 */
export function deserializeAction(raw: string | null): PendingAction | null {
  if (!raw) return null;

  // Formato nuevo: JSON
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as PendingAction;
      if (parsed?.type) return parsed;
    } catch {
      return null;
    }
  }

  // Formato legacy: strings crudos — compatibilidad hacia atrás
  // Permite migración gradual sin invalidar sesiones activas en Redis
  return parseLegacyAction(raw);
}

function parseLegacyAction(raw: string): PendingAction | null {
  if (raw.startsWith('CONFIRM_CLOSE_TICKET:')) {
    // Usamos indexOf para evitar el problema de split(':') con IDs que contengan ':'
    const ticketId = raw.substring('CONFIRM_CLOSE_TICKET:'.length);
    return { type: 'CONFIRM_CLOSE_TICKET', ticketId };
  }
  if (raw.startsWith('CONFIRM_CANCEL_INSTALLATION:')) {
    const installationId = raw.substring('CONFIRM_CANCEL_INSTALLATION:'.length);
    return { type: 'CONFIRM_CANCEL_INSTALLATION', installationId };
  }
  if (raw.startsWith('AWAITING_ADDRESS:')) {
    const slotInfo = raw.substring('AWAITING_ADDRESS:'.length);
    const pipeIdx = slotInfo.indexOf('|');
    if (pipeIdx === -1) return null;
    return {
      type: 'AWAITING_ADDRESS',
      slotDate: slotInfo.substring(0, pipeIdx),
      slotTime: slotInfo.substring(pipeIdx + 1),
    };
  }
  // Estados simples sin payload
  const simpleStates: PendingActionType[] = [
    'AWAITING_SLOT_SELECTION',
    'AWAITING_TICKET_DETAILS',
    'AWAITING_RAG_FEEDBACK',
    'AWAITING_TICKET_ID_TO_CLOSE',
  ];
  if (simpleStates.includes(raw as PendingActionType)) {
    return { type: raw as PendingActionType };
  }

  return null;
}
