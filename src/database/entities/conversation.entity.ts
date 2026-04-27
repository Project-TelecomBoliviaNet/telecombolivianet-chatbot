import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  UpdateDateColumn, OneToMany,
} from 'typeorm';
import { Message } from './message.entity';

@Entity('conversations')
export class Conversation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'phone_number', length: 20 })
  phoneNumber: string;

  @Column({ name: 'client_id', type: 'uuid', nullable: true })
  clientId: string | null;

  @Column({ name: 'client_name', length: 200, nullable: true })
  clientName: string | null;

  @Column({ name: 'is_escalated', default: false })
  isEscalated: boolean;

  @Column({ name: 'escalated_at', type: 'timestamp', nullable: true })
  escalatedAt: Date | null;

  @Column({ name: 'agent_name', length: 200, nullable: true })
  agentName: string | null;

  @Column({ name: 'rag_fail_count', default: 0 })
  ragFailCount: number;

  // ── EP-06: Resumen y categoría del escalado ────────────────

  /**
   * Resumen estructurado generado por IA al escalar (US-EP06-01).
   * Briefing para el agente humano: motivo, acciones previas, estado.
   */
  @Column({ name: 'escalation_summary', type: 'text', nullable: true })
  escalationSummary: string | null;

  /**
   * Categoría del motivo de escalado (US-EP06-02).
   * Valores: FACTURACION | SOPORTE_TECNICO | INSTALACION | INFORMACION | OTRO
   */
  @Column({ name: 'escalation_category', length: 50, nullable: true })
  escalationCategory: string | null;

  @OneToMany(() => Message, (m) => m.conversation, { cascade: true })
  messages: Message[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
