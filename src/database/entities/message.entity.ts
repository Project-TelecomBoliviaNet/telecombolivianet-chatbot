import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  ManyToOne, JoinColumn,
} from 'typeorm';
import { Conversation } from './conversation.entity';

export enum MessageRole {
  USER = 'user',
  BOT = 'bot',
  ADMIN = 'admin',
}

export enum MessageSource {
  INTENT = 'intent',
  RAG = 'rag',
  AGENT = 'agent',
  ADMIN = 'admin',
  SYSTEM = 'system',
  ESCALATION = 'escalation',
}

@Entity('messages')
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'conversation_id', type: 'uuid' })
  conversationId: string;

  @ManyToOne(() => Conversation, (c) => c.messages, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversation_id' })
  conversation: Conversation;

  @Column({ type: 'enum', enum: MessageRole })
  role: MessageRole;

  @Column({ type: 'text' })
  content: string;

  @Column({ type: 'enum', enum: MessageSource, nullable: true })
  source: MessageSource | null;

  @Column({ name: 'chunk_id', type: 'uuid', nullable: true })
  chunkId: string | null;

  @Column({ name: 'meta_message_id', length: 100, nullable: true })
  metaMessageId: string | null;

  @Column({ name: 'media_url', type: 'varchar', length: 500, nullable: true })
  mediaUrl: string | null;

  @Column({ name: 'media_type', type: 'varchar', length: 20, nullable: true })
  mediaType: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
