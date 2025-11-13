import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  UpdateDateColumn, OneToMany, Unique,
} from 'typeorm';
import { Message } from './message.entity';

@Entity('conversations')
@Unique('uq_conversations_phone_number', ['phoneNumber'])
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

  @Column({ name: 'summary', type: 'text', nullable: true })
  summary: string | null;

  @OneToMany(() => Message, (m) => m.conversation, { cascade: true })
  messages: Message[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
