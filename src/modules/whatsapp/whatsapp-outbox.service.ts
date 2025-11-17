import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { WhatsappApiService } from './whatsapp-api.service';
import { OutboxRepositoryService } from './outbox-repository.service';

// ══════════════════════════════════════════════════════════════
// WHATSAPP OUTBOX SERVICE
//
// Garantiza la entrega de mensajes aunque Meta Cloud API esté
// caída temporalmente. Ya no depende de SessionService —
// ahora usa OutboxRepositoryService (SRP).
//
// Estrategia de dos niveles:
//   1. tryDeliverPending(phone) — llamado en cada mensaje entrante
//   2. @Cron cada 2 min — para cuando el usuario no escribe de nuevo
//
// Límites:
//   - MAX_ATTEMPTS = 5 → tras 5 fallos (≈10 min) se descarta
//   - TTL del outbox en Redis = 30 min (en OutboxRepositoryService)
// ══════════════════════════════════════════════════════════════

const MAX_ATTEMPTS = 5;

@Injectable()
export class WhatsappOutboxService {
  private readonly logger = new Logger(WhatsappOutboxService.name);
  private cronRunning = false;

  constructor(
    private readonly outboxRepo: OutboxRepositoryService,
    private readonly whatsapp:   WhatsappApiService,
  ) {}

  async enqueue(phone: string, text: string): Promise<void> {
    await this.outboxRepo.push(phone, text);
    this.logger.warn(JSON.stringify({ event: 'outbox_enqueued', phone, length: text.length }));
  }

  async tryDeliverPending(phone: string): Promise<void> {
    const entry = await this.outboxRepo.get(phone);
    if (!entry) return;

    const acquired = await this.outboxRepo.markAsProcessing(phone);
    if (!acquired) return;

    try {
      await this.whatsapp.sendText(phone, entry.text);
      await this.outboxRepo.remove(phone);
      this.logger.log(JSON.stringify({
        event: 'outbox_delivered_on_incoming', phone,
        attempts: entry.attempts, ageMs: Date.now() - entry.addedAt,
      }));
    } catch {
      await this.outboxRepo.revertToPending(phone);
    }
  }

  @Cron('*/2 * * * *')
  async retryOutbox(): Promise<void> {
    if (this.cronRunning) return;
    this.cronRunning = true;

    try {
      const phones = await this.outboxRepo.getAllPhones();
      if (phones.length === 0) return;

      this.logger.debug(`Outbox cron: ${phones.length} mensaje(s) pendiente(s)`);

      for (const phone of phones) {
        const entry = await this.outboxRepo.get(phone);
        if (!entry) continue;

        if (entry.attempts >= MAX_ATTEMPTS) {
          this.logger.warn(JSON.stringify({
            event: 'outbox_discarded', phone,
            attempts: entry.attempts, ageMs: Date.now() - entry.addedAt,
            preview: entry.text.slice(0, 100),
          }));
          await this.outboxRepo.remove(phone);
          continue;
        }

        const acquired = await this.outboxRepo.markAsProcessing(phone);
        if (!acquired) continue;

        try {
          await this.whatsapp.sendText(phone, entry.text);
          await this.outboxRepo.remove(phone);
          this.logger.log(JSON.stringify({
            event: 'outbox_delivered_by_cron', phone,
            attempts: entry.attempts + 1, ageMs: Date.now() - entry.addedAt,
          }));
        } catch {
          await this.outboxRepo.revertToPending(phone);
          await this.outboxRepo.incrementAttempts(phone);
        }
      }
    } finally {
      this.cronRunning = false;
    }
  }
}
