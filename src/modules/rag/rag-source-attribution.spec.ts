/**
 * @file rag-source-attribution.spec.ts
 * @description Tests de US-EP03-01: mostrar fuente del documento en respuestas RAG.
 *
 * Criterios de aceptación validados:
 *   AC-01: La fuente aparece al final del mensaje cuando documentTitle existe.
 *   AC-02: El nombre del documento es el título del knowledge_document.
 *   AC-03: Si no hay título, NO aparece el footer de fuente.
 *   AC-04: El formato de la fuente es reconocible para el usuario.
 *   AC-05: Test de integración: el mensaje final incluye la fuente.
 */

import { MessageFormatterService } from '../bot/message-formatter.service';

describe('US-EP03-01 — Fuente del documento en respuestas RAG', () => {
  let formatter: MessageFormatterService;

  beforeEach(() => {
    formatter = new MessageFormatterService();
  });

  // ─── ragSupportGuide() con fuente ─────────────────────────────────────────

  describe('ragSupportGuide(answer, documentTitle)', () => {
    it('AC-01: incluye footer de fuente cuando documentTitle está presente', () => {
      const result = formatter.ragSupportGuide(
        'Reinicia tu router presionando el botón reset.',
        'Manual técnico Bolivianet 2024',
      );

      expect(result).toContain('📄 *Fuente:*');
      expect(result).toContain('Manual técnico Bolivianet 2024');
    });

    it('AC-04: el footer tiene el formato correcto con separador visual', () => {
      const result = formatter.ragSupportGuide(
        'Pasos para restablecer conexión.',
        'Guía de soporte v2',
      );

      expect(result).toContain('─────────────────');
      expect(result).toContain('📄 *Fuente:* Guía de soporte v2');
    });

    it('AC-03: NO incluye footer si documentTitle es undefined', () => {
      const result = formatter.ragSupportGuide(
        'Reinicia el router.',
        undefined,
      );

      expect(result).not.toContain('📄');
      expect(result).not.toContain('Fuente');
      expect(result).not.toContain('─────────────────');
    });

    it('AC-03: NO incluye footer si documentTitle es cadena vacía', () => {
      const result = formatter.ragSupportGuide('Pasos.', '');

      expect(result).not.toContain('📄');
    });

    it('la respuesta y la fuente aparecen en el orden correcto', () => {
      const answer  = 'Verifica las luces del router.';
      const title   = 'Manual de equipos';
      const result  = formatter.ragSupportGuide(answer, title);

      const answerPos = result.indexOf(answer);
      const sourcePos = result.indexOf('📄');

      // La respuesta va antes que la fuente
      expect(answerPos).toBeLessThan(sourcePos);
    });

    it('mantiene el texto de confirmación Sí/No', () => {
      const result = formatter.ragSupportGuide('Pasos.', 'Doc');
      expect(result).toContain('¿El problema se resolvió');
      expect(result).toContain('Sí');
      expect(result).toContain('No');
    });
  });

  // ─── ragAnswer() con fuente ───────────────────────────────────────────────

  describe('ragAnswer(answer, documentTitle)', () => {
    it('AC-01: incluye footer de fuente cuando documentTitle está presente', () => {
      const result = formatter.ragAnswer(
        'El período de pago vence el día 5 de cada mes.',
        'Política de facturación 2024',
      );

      expect(result).toContain('📄 *Fuente:*');
      expect(result).toContain('Política de facturación 2024');
    });

    it('AC-04: formato correcto con separador visual', () => {
      const result = formatter.ragAnswer(
        'Información sobre planes.',
        'Catálogo de planes Bolivianet',
      );

      expect(result).toContain('─────────────────');
      expect(result).toContain('📄 *Fuente:* Catálogo de planes Bolivianet');
    });

    it('AC-03: NO incluye footer si documentTitle es undefined', () => {
      const result = formatter.ragAnswer('La respuesta del RAG.', undefined);

      expect(result).not.toContain('📄');
      expect(result).toBe('La respuesta del RAG.');
    });

    it('la respuesta aparece antes que la fuente', () => {
      const answer = 'Descripción del servicio.';
      const result = formatter.ragAnswer(answer, 'Contrato de servicio');

      expect(result.indexOf(answer)).toBeLessThan(result.indexOf('📄'));
    });

    it('la respuesta sin documentTitle es el texto original sin modificar', () => {
      const answer = 'Texto con emojis 🌐 y *negritas* sin fuente.';
      expect(formatter.ragAnswer(answer, undefined)).toBe(answer);
    });

    it('AC-02: usa el título exacto del knowledge_document sin modificarlo', () => {
      const titulo = 'Manual técnico de fibra óptica — Revisión 3.1 (2024)';
      const result = formatter.ragAnswer('Respuesta.', titulo);

      expect(result).toContain(titulo);
    });
  });

  // ─── AC-05: integración — mensaje completo al usuario ─────────────────────

  describe('AC-05: integración — mensaje completo para WhatsApp', () => {
    it('ragAnswer: el mensaje completo tiene la estructura esperada', () => {
      const answer = 'Para reiniciar tu router: 1) Desconecta el cable. 2) Espera 30 seg.';
      const title  = 'Manual de equipos Bolivianet';

      const message = formatter.ragAnswer(answer, title);
      const lines   = message.split('\n');

      // Primera línea es la respuesta
      expect(lines[0]).toBe(answer);
      // Contiene el separador
      expect(message).toContain('─────────────────');
      // Termina con la fuente
      expect(message.endsWith(`📄 *Fuente:* ${title}`)).toBe(true);
    });

    it('ragSupportGuide: el mensaje completo incluye guía, pregunta y fuente', () => {
      const answer = 'Paso 1: reinicia. Paso 2: espera 2 minutos.';
      const title  = 'Guía de soporte técnico';

      const message = formatter.ragSupportGuide(answer, title);

      // Tiene el encabezado de guía
      expect(message).toContain('💡 *Antes de crear un ticket');
      // Tiene la respuesta
      expect(message).toContain(answer);
      // Tiene la pregunta de confirmación
      expect(message).toContain('¿El problema se resolvió');
      // Tiene la fuente al final
      expect(message).toContain(`📄 *Fuente:* ${title}`);
    });

    it('la fuente NO aparece en mensajes de error (ragNoSolution)', () => {
      const noSolution = formatter.ragNoSolution();
      expect(noSolution).not.toContain('📄');
      expect(noSolution).not.toContain('Fuente');
    });
  });
});
