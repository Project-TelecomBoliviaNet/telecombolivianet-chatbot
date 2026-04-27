/**
 * @file faq.dto.ts
 * @description DTOs de entrada y salida para el CRUD de FAQs.
 *
 * Separar DTOs de la entidad sigue el principio de OCP:
 * la entidad puede evolucionar sin romper la interfaz pública de la API.
 */

// ─── Entrada ──────────────────────────────────────────────────────────────────

export interface CreateFaqDto {
  question:  string;
  answer:    string;
  tags?:     string[];
  priority?: number;
  isActive?: boolean;
}

export interface UpdateFaqDto {
  question?:  string;
  answer?:    string;
  tags?:      string[];
  priority?:  number;
  isActive?:  boolean;
}

export interface ListFaqsQuery {
  /** Filtrar por tag (ej: "pagos") */
  tag?:    string;
  /** Solo activas (true) o todas (false/undefined) */
  active?: boolean;
  /** Número de página (1-based) */
  page?:   number;
  /** Resultados por página */
  limit?:  number;
}

// ─── Salida ───────────────────────────────────────────────────────────────────

export interface FaqResponseDto {
  id:         string;
  question:   string;
  answer:     string;
  tags:       string[];
  priority:   number;
  isActive:   boolean;
  matchCount: number;
  createdAt:  Date;
  updatedAt:  Date;
}

export interface FaqListResponseDto {
  items:  FaqResponseDto[];
  total:  number;
  page:   number;
  limit:  number;
  pages:  number;
}

// ─── Resultado de matching ────────────────────────────────────────────────────

export interface FaqMatchResult {
  /** Si se encontró una FAQ con suficiente similitud */
  found:       boolean;
  /** Respuesta pre-aprobada a enviar al usuario */
  answer:      string;
  /** Score de similitud coseno [0, 1] */
  score:       number;
  /** ID de la FAQ para métricas */
  faqId:       string;
  /** Pregunta canónica de la FAQ (para logs) */
  faqQuestion: string;
}
