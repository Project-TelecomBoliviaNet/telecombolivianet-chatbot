import {
  serializeAction,
  deserializeAction,
  PendingAction,
} from './pending-action';

// ══════════════════════════════════════════════════════════════
// TESTS UNITARIOS — pending-action.ts
// Cubre: serialización, deserialización, compatibilidad legacy.
// Sin dependencias externas — pura lógica de datos.
// ══════════════════════════════════════════════════════════════

describe('serializeAction()', () => {
  it('serializa a JSON válido', () => {
    const action: PendingAction = { type: 'CONFIRM_CLOSE_TICKET', ticketId: 'ABC123' };
    const result = serializeAction(action);
    expect(() => JSON.parse(result)).not.toThrow();
    expect(JSON.parse(result)).toMatchObject({ type: 'CONFIRM_CLOSE_TICKET', ticketId: 'ABC123' });
  });

  it('serializa acción sin payload opcional', () => {
    const action: PendingAction = { type: 'AWAITING_SLOT_SELECTION' };
    const result = serializeAction(action);
    expect(JSON.parse(result).type).toBe('AWAITING_SLOT_SELECTION');
  });

  it('serializa AWAITING_ADDRESS con fecha y hora', () => {
    const action: PendingAction = {
      type: 'AWAITING_ADDRESS',
      slotDate: '2025-06-10',
      slotTime: '09:00',
    };
    const parsed = JSON.parse(serializeAction(action));
    expect(parsed.slotDate).toBe('2025-06-10');
    expect(parsed.slotTime).toBe('09:00');
  });
});

describe('deserializeAction()', () => {
  it('retorna null para null', () => {
    expect(deserializeAction(null)).toBeNull();
  });

  it('retorna null para string vacío', () => {
    expect(deserializeAction('')).toBeNull();
  });

  it('retorna null para JSON inválido', () => {
    expect(deserializeAction('{')).toBeNull();
  });

  it('retorna null para JSON sin campo type', () => {
    expect(deserializeAction('{"ticketId":"A1"}')).toBeNull();
  });

  // ── Formato nuevo (JSON) ──────────────────────────────────
  describe('formato nuevo (JSON)', () => {
    it('deserializa CONFIRM_CLOSE_TICKET con ticketId', () => {
      const raw = serializeAction({ type: 'CONFIRM_CLOSE_TICKET', ticketId: 'TK001' });
      const result = deserializeAction(raw);
      expect(result).toEqual({ type: 'CONFIRM_CLOSE_TICKET', ticketId: 'TK001' });
    });

    it('deserializa AWAITING_ADDRESS con slotDate y slotTime', () => {
      const raw = serializeAction({ type: 'AWAITING_ADDRESS', slotDate: '2025-07-01', slotTime: '14:00' });
      const result = deserializeAction(raw);
      expect(result?.type).toBe('AWAITING_ADDRESS');
      expect(result?.slotDate).toBe('2025-07-01');
      expect(result?.slotTime).toBe('14:00');
    });

    it('deserializa todos los tipos simples', () => {
      const simpleTypes = [
        'AWAITING_SLOT_SELECTION',
        'AWAITING_TICKET_DETAILS',
        'AWAITING_RAG_FEEDBACK',
        'AWAITING_TICKET_ID_TO_CLOSE',
      ] as const;

      for (const type of simpleTypes) {
        const raw = serializeAction({ type });
        const result = deserializeAction(raw);
        expect(result?.type).toBe(type);
      }
    });
  });

  // ── Formato legacy (strings crudos) ──────────────────────
  describe('compatibilidad con formato legacy', () => {
    it('parsea CONFIRM_CLOSE_TICKET:ID correctamente', () => {
      const result = deserializeAction('CONFIRM_CLOSE_TICKET:ABC456');
      expect(result).toEqual({ type: 'CONFIRM_CLOSE_TICKET', ticketId: 'ABC456' });
    });

    it('parsea CONFIRM_CANCEL_INSTALLATION:ID correctamente', () => {
      const result = deserializeAction('CONFIRM_CANCEL_INSTALLATION:INST789');
      expect(result).toEqual({ type: 'CONFIRM_CANCEL_INSTALLATION', installationId: 'INST789' });
    });

    it('parsea AWAITING_ADDRESS:fecha|hora correctamente', () => {
      const result = deserializeAction('AWAITING_ADDRESS:2025-01-15|09:00');
      expect(result?.type).toBe('AWAITING_ADDRESS');
      expect(result?.slotDate).toBe('2025-01-15');
      expect(result?.slotTime).toBe('09:00');
    });

    it('retorna null si AWAITING_ADDRESS no tiene separador |', () => {
      const result = deserializeAction('AWAITING_ADDRESS:2025-01-15-09:00');
      expect(result).toBeNull();
    });

    it('parsea AWAITING_SLOT_SELECTION como estado simple', () => {
      const result = deserializeAction('AWAITING_SLOT_SELECTION');
      expect(result).toEqual({ type: 'AWAITING_SLOT_SELECTION' });
    });

    it('parsea AWAITING_RAG_FEEDBACK como estado simple', () => {
      const result = deserializeAction('AWAITING_RAG_FEEDBACK');
      expect(result).toEqual({ type: 'AWAITING_RAG_FEEDBACK' });
    });

    it('retorna null para string legacy desconocido', () => {
      const result = deserializeAction('UNKNOWN_STATE:data');
      expect(result).toBeNull();
    });

    it('maneja IDs con dos puntos en CONFIRM_CLOSE_TICKET (bug legacy)', () => {
      // El bug original de split(':')[1] habría roto este caso
      const result = deserializeAction('CONFIRM_CLOSE_TICKET:TK:001:EXTRA');
      expect(result?.ticketId).toBe('TK:001:EXTRA');
    });
  });

  // ── Roundtrip ─────────────────────────────────────────────
  describe('roundtrip serialize → deserialize', () => {
    it('es idempotente para todos los tipos con payload', () => {
      const actions: PendingAction[] = [
        { type: 'CONFIRM_CLOSE_TICKET', ticketId: 'T001' },
        { type: 'CONFIRM_CANCEL_INSTALLATION', installationId: 'I002' },
        { type: 'AWAITING_ADDRESS', slotDate: '2025-08-20', slotTime: '10:00' },
        { type: 'AWAITING_TICKET_DETAILS', ticketId: 'T003' },
        { type: 'AWAITING_SLOT_SELECTION' },
        { type: 'AWAITING_RAG_FEEDBACK' },
        { type: 'AWAITING_TICKET_ID_TO_CLOSE' },
      ];

      for (const action of actions) {
        const serialized = serializeAction(action);
        const deserialized = deserializeAction(serialized);
        expect(deserialized?.type).toBe(action.type);
      }
    });
  });
});
