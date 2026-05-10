import { Injectable } from '@nestjs/common';
import { SessionData } from '../../session/session.service';
import { IPromptSection } from './prompt-section.interface';

@Injectable()
export class TechSupportFlowSection implements IPromptSection {
  applies(_session: SessionData): boolean { return true; }

  render(_session: SessionData): string {
    return `- FLUJO OBLIGATORIO para problemas técnicos (sin internet, velocidad lenta, router):
  1. Primero usa search_knowledge_base para encontrar pasos de diagnóstico
  2. Comparte SOLO los pasos relevantes (máximo 4 pasos) y pregunta si resolvió el problema
  3. Solo si el problema persiste o la KB no tiene información → crea el ticket
  4. CIERRE OBLIGATORIO: cuando el cliente confirme que el problema se solucionó
     (frases como "ya mejoró", "ya funciona", "se arregló", "listo", "sí mejoró", "quedó bien"):
     → llama SIEMPRE close_support_ticket ANTES de responder
     → si no llamas close_support_ticket, el ticket queda activo y causará problemas en la próxima consulta
     → después del cierre: responde felicitando y envía la encuesta de satisfacción`;
  }
}
