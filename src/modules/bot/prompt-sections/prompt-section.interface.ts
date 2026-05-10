import { SessionData } from '../../session/session.service';

export const PROMPT_SECTIONS = Symbol('PROMPT_SECTIONS');

// OCP: cada sección del prompt es una clase independiente.
// Agregar un nuevo flujo = crear una nueva clase, sin tocar PromptBuilderService.
export interface IPromptSection {
  applies(session: SessionData): boolean;
  render(session: SessionData): string;
}
