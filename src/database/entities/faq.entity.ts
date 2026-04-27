/**
 * @file faq.entity.ts
 * @description Entidad de Preguntas Frecuentes para el chatbot.
 *
 * Las FAQs permiten que el admin pre-configure respuestas aprobadas
 * para preguntas recurrentes. El FaqMatcherService las consulta ANTES
 * del RAG completo para responder en ~50ms en vez de 2-4 segundos.
 */

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('faqs')
export class Faq {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Pregunta canónica tal como la redactó el admin.
   * Ejemplo: "¿Cuándo es la fecha límite de pago?"
   */
  @Column({ type: 'text' })
  question: string;

  /**
   * Respuesta pre-aprobada por el admin.
   * Se enviará directamente al usuario cuando haya match semántico.
   */
  @Column({ type: 'text' })
  answer: string;

  /**
   * Etiquetas para categorización y filtrado.
   * Ejemplo: ["pagos", "facturación"]
   */
  @Column({ type: 'simple-array', default: '' })
  tags: string[];

  /**
   * Prioridad de matching: 1 (más baja) a 10 (más alta).
   * Si dos FAQs tienen scores similares, gana la de mayor prioridad.
   */
  @Column({ type: 'int', default: 5 })
  priority: number;

  /**
   * Solo las FAQs activas participan en el matching.
   * Permite desactivar sin eliminar.
   */
  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  /**
   * Cuántas veces fue esta FAQ la respuesta enviada al usuario.
   * Para métricas de efectividad.
   */
  @Column({ name: 'match_count', type: 'int', default: 0 })
  matchCount: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
