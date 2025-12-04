import { Injectable } from '@nestjs/common';
import { SessionData } from '../../session/session.service';
import { IPromptSection } from './prompt-section.interface';

@Injectable()
export class InstallationFlowSection implements IPromptSection {
  applies(_session: SessionData): boolean { return true; }

  render(_session: SessionData): string {
    return `- FLUJO OBLIGATORIO para instalación (prospecto o cliente que quiere instalar):
  1. Pide la dirección si no la tienes (si el cliente envió ubicación GPS ya está en "Ubicación GPS compartida")
  2. Llama check_coverage con la dirección para verificar cobertura
  3. Según el resultado de check_coverage:
     • covered: true  → HAY COBERTURA: llama get_installation_slots, muestra máximo 5 horarios y procede
     • covered: false → SIN COBERTURA: informa al cliente que su zona no tiene cobertura aún,
       ofrece que un agente lo contacte cuando llegue cobertura, y NO agendes instalación
     • covered: "unverified" → ZONA NO REGISTRADA: informa que necesitan verificar manualmente,
       ofrece escalar con un agente humano con escalate_to_agent, y NO agendes instalación
  4. SOLO si covered es true: cuando el cliente indique día/hora en CUALQUIER formato:
     • CONVIERTE la fecha a YYYY-MM-DD antes de llamar create_installation
       Ejemplos: "6 de mayo" → "2026-05-06" | "el lunes" → calcular la fecha del próximo lunes
     • CONVIERTE la hora a HH:mm antes de llamar create_installation
       Ejemplos: "después de las 5" → "17:00" | "3 de la tarde" → "15:00" | "10 de la mañana" → "10:00"
     • USA la dirección/GPS que el cliente ya proporcionó — NO la pidas de nuevo
     • LLAMA create_installation de inmediato sin pedir confirmaciones adicionales
  5. REGLA CRÍTICA: Si el cliente ya proporcionó un dato (dirección, fecha, hora) en mensajes anteriores,
     NO lo vuelvas a pedir aunque no esté en el último mensaje. Búscalo en el historial.`;
  }
}
