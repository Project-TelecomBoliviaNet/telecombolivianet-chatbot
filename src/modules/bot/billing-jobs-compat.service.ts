import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { SessionService } from '../session/session.service';
import { SistemaApiService } from '../client/sistema-api.service';
import { Message } from '../../database/entities/message.entity';
import { Conversation } from '../../database/entities/conversation.entity';

// ══════════════════════════════════════════════════════════════
// BILLING JOBS COMPAT SERVICE  (US-22)
//
// Garantiza compatibilidad entre el bot y los jobs automáticos
// del sistema (facturación, vencimientos, recordatorios).
//
// Responsabilidades:
//   1. Renovación proactiva del JWT (token de 8h real en C#)
//      ─ Cron cada 6 horas para asegurar nunca expire
//   2. Limpieza de sesiones Redis expiradas (GC de Postgres)
//      ─ Cron a medianoche: purga mensajes > 30 días
//   3. Utilidades de fechas para que el bot entienda el ciclo
//      de facturación (día 1: nuevas facturas, día 5: límite,
//      día 6: vencidas, día 7: recordatorio automático)
//
// IMPORTANTE (US-22, criterio 137):
//   El bot NO envía recordatorios de pago propios.
//   El Notifier Python los envía el día 7 vía outbox → WhatsApp.
//   Si el bot los enviara también se duplicarían los mensajes.
// ══════════════════════════════════════════════════════════════

export interface BillingDateContext {
  dayOfMonth: number;
  isBeforeDeadline: boolean;     // días 1–5
  isDeadlineDay: boolean;        // día 5
  isOverdueDay: boolean;         // día 6
  isReminderDay: boolean;        // día 7 (Notifier Python envía recordatorio automático vía outbox)
  isAfterReminder: boolean;      // días 8+
  daysUntilDeadline: number;     // negativo si ya pasó
  shouldShowOverdueWarning: boolean;
  /** El bot NUNCA envía recordatorios: el Notifier Python los maneja el día 7 vía outbox */
  botShouldSendReminder: false;
}

@Injectable()
export class BillingJobsCompatService {
  private readonly logger = new Logger(BillingJobsCompatService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly sistemaApi: SistemaApiService,
    private readonly sessionService: SessionService,
    @InjectRepository(Message)
    private readonly msgRepo: Repository<Message>,
    @InjectRepository(Conversation)
    private readonly convRepo: Repository<Conversation>,
  ) {}

  // ─── CRON: Renovar JWT proactivamente ─────────────────────
  // El token real del sistema C# dura 8 horas (JwtConfiguration.cs).
  // Corremos cada 6 horas para asegurarnos de que nunca expire
  // durante una atención activa. SistemaApiService tiene su propio
  // interceptor de renovación, pero este cron es la red de seguridad.
  @Cron('0 */6 * * *', { name: 'jwt-renewal' })
  async renewJwtProactively(): Promise<void> {
    this.logger.log('Cron JWT: verificando y renovando token del sistema C#...');
    try {
      // onModuleInit de SistemaApiService tiene la lógica de login;
      // llamamos un endpoint liviano para forzar la renovación vía interceptor.
      await this.sistemaApi.getActivePlans();
      this.logger.log('Cron JWT: token verificado correctamente ✔');
    } catch (err) {
      this.logger.error(`Cron JWT: error al renovar token — ${err.message}`);
      // El error no se propaga: la próxima llamada real intentará renovar también
    }
  }

  // ─── CRON: Purga de mensajes antiguos de PostgreSQL ───────
  // Los mensajes en Redis expiran solos (TTL 24h).
  // En PostgreSQL conservamos mensajes 30 días para auditoría,
  // luego eliminamos para mantener el tamaño de la tabla.
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT, { name: 'message-purge' })
  async purgeOldMessages(): Promise<void> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);

    try {
      const result = await this.msgRepo.delete({
        createdAt: LessThan(cutoff),
      });
      if ((result.affected ?? 0) > 0) {
        this.logger.log(`Purga mensajes: ${result.affected} mensajes > 30 días eliminados`);
      }
    } catch (err) {
      this.logger.error(`Purga mensajes fallida: ${err.message}`);
    }
  }

  // ─── CRON: Limpiar conversaciones inactivas de Redis ──────
  // Redis maneja el TTL (24h) automáticamente, pero este cron
  // marca como no-escaladas las conversaciones cuya sesión Redis
  // expiró para mantener consistencia con PostgreSQL.
  @Cron('0 2 * * *', { name: 'redis-session-sync' })  // 02:00 cada día
  async syncExpiredEscalations(): Promise<void> {
    try {
      // Buscar conversaciones marcadas como escaladas en DB
      const escalated = await this.convRepo.find({
        where: { isEscalated: true },
        select: ['id', 'phoneNumber', 'escalatedAt'],
      });

      let synced = 0;
      for (const conv of escalated) {
        // Si la sesión Redis ya expiró (no existe), limpiar estado en DB
        const session = await this.sessionService.getSession(conv.phoneNumber);
        if (!session.isEscalated) {
          await this.convRepo.update(conv.id, {
            isEscalated: false,
            agentName: null,
          });
          synced++;
        }
      }

      if (synced > 0) {
        this.logger.log(`Sync sesiones: ${synced} conversaciones de-escaladas por TTL expirado`);
      }
    } catch (err) {
      this.logger.error(`Sync sesiones fallido: ${err.message}`);
    }
  }

  // ─── Utilidades de fechas para el ciclo de facturación ────

  /**
   * Retorna el contexto de fechas de facturación para hoy.
   * Usado por el bot para dar información precisa (US-04, US-22).
   *
   * Ciclo de Telecom Bolivianet:
   *  - Día 1:  Se generan nuevas facturas
   *  - Día 5:  Fecha límite de pago
   *  - Día 6:  Facturas pasan a estado "Vencida"
   *  - Día 7:  Notifier Python envía recordatorio automático vía outbox → WhatsApp
   *  - Día 7+: El bot NO envía recordatorios adicionales (duplicaría)
   */
  getBillingDateContext(date: Date = new Date()): BillingDateContext {
    const day = date.getDate();

    return {
      dayOfMonth: day,
      isBeforeDeadline: day >= 1 && day <= 5,
      isDeadlineDay: day === 5,
      isOverdueDay: day === 6,
      isReminderDay: day === 7,
      isAfterReminder: day > 7,
      daysUntilDeadline: 5 - day,
      shouldShowOverdueWarning: day >= 6,
      // Constante false: el bot NUNCA envía recordatorios propios (US-22 crit. 137)
      // El Notifier Python los despacha el día 7 leyendo el outbox de la BD.
      botShouldSendReminder: false,
    };
  }

  /**
   * Explica al cliente si el bot puede ver su factura del mes actual.
   * Antes del día 1, la factura del mes nuevo aún no existe en el sistema.
   * US-22, criterio 135.
   */
  getInvoiceAvailabilityNote(date: Date = new Date()): string | null {
    const day = date.getDate();
    const month = date.getMonth(); // 0-based

    if (day === 1) {
      // Hoy se generan facturas — puede haber un delay de minutos
      return `ℹ️ Hoy se generan las facturas del mes. Si tu factura aún no aparece, espera unos minutos.`;
    }

    // Antes del día 1 (último día del mes anterior), avisamos que el nuevo mes aún no tiene factura
    if (day >= 28) {
      const nextMonth = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
        'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'][(month + 1) % 12];
      return `ℹ️ La factura de *${nextMonth}* se generará el día 1 del mes próximo.`;
    }

    return null;
  }

  /**
   * Determina si un ticket de soporte debe escalar su SLA
   * dependiendo de si hay facturas vencidas relacionadas.
   * Ayuda a priorizar tickets de clientes con deuda activa.
   */
  getEffectiveSlaHours(basePriority: 'Alta' | 'Media' | 'Baja', hasOverdueInvoices: boolean): number {
    const base = basePriority === 'Alta' ? 4 : basePriority === 'Media' ? 8 : 24;
    // Clientes con facturas vencidas y servicio suspendido merecen atención más rápida
    return hasOverdueInvoices && basePriority !== 'Alta' ? Math.floor(base / 2) : base;
  }
}
