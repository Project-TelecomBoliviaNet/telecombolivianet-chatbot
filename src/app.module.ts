import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { HttpModule } from '@nestjs/axios';

// Config
import {
  appConfig, databaseConfig, redisConfig, sistemaConfig,
  metaConfig, geminiConfig, ragConfig, storageConfig, botConfig,
  rateLimitConfig, securityConfig,
} from './config/app.config';

// Entities
import { Conversation } from './database/entities/conversation.entity';
import { Message } from './database/entities/message.entity';
import { KnowledgeDocument, KnowledgeChunk } from './database/entities/knowledge.entity';
import { Faq } from './database/entities/faq.entity';

// Services
import { SessionService } from './modules/session/session.service';
import { SistemaApiService } from './modules/client/sistema-api.service';
import { IntentDetectorService } from './modules/intent/intent-detector.service';
import { WhatsappApiService } from './modules/whatsapp/whatsapp-api.service';
import { WhatsappMockService } from './modules/whatsapp/whatsapp-mock.service';
import { MessageFormatterService } from './modules/bot/message-formatter.service';
import { RagService } from './modules/rag/rag.service';
import { QueryReformulationService } from './modules/rag/query-reformulation.service';
import { ReceiptHandlerService } from './modules/payments/receipt-handler.service';
import { BotOrchestratorService } from './modules/bot/bot-orchestrator.service';
import { BotRemoteConfigService } from './modules/bot/bot-remote-config.service';
import { ConversationSummaryService } from './modules/bot/conversation-summary.service';
import { AdminSignalrNotifierService } from './modules/notifications/admin-signalr-notifier.service';
import { GeminiHealthService } from './modules/bot/gemini-health.service';
import { BillingJobsCompatService } from './modules/bot/billing-jobs-compat.service';
import { PaymentHandler } from './modules/bot/handlers/payment.handler';
import { SupportHandler } from './modules/bot/handlers/support.handler';
import { InstallationHandler } from './modules/bot/handlers/installation.handler';

// Controllers
import { WhatsappWebhookController } from './modules/whatsapp/whatsapp-webhook.controller';
import { SimulatorController } from './modules/whatsapp/simulator.controller';
import { AdminNotifyController } from './modules/admin/admin-notify.controller';
import { HealthController } from './modules/bot/health.controller';
import { MonitorController } from './modules/admin/monitor.controller';
import { RagDocumentsController } from './modules/rag/rag-documents.controller';

// Middleware
import { PhoneRateLimiterMiddleware } from './common/middleware/phone-rate-limiter.middleware';
// Security
import { SecurityModule } from './common/security/security.module';
// Features
import { FaqModule } from './modules/faq/faq.module';

// ─── Detectar modo mock ───────────────────────────────────────
const IS_MOCK = process.env.WHATSAPP_MOCK === 'true';

// Provider condicional: en mock usa WhatsappMockService,
// en producción usa WhatsappApiService real.
const whatsappProvider = {
  provide: WhatsappApiService,
  useClass: IS_MOCK ? WhatsappMockService : WhatsappApiService,
};

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        appConfig, databaseConfig, redisConfig, sistemaConfig,
        metaConfig, geminiConfig, ragConfig, storageConfig, botConfig,
        rateLimitConfig, securityConfig,
      ],
    }),

    HttpModule.registerAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        timeout: cfg.get<number>('app.httpTimeoutMs') ?? 10000,
        maxRedirects: 3,
      }),
    }),

    ScheduleModule.forRoot(),

    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        type: 'postgres',
        host: cfg.get('database.host'),
        port: cfg.get('database.port'),
        username: cfg.get('database.username'),
        password: cfg.get('database.password'),
        database: cfg.get('database.database'),
        entities: [Conversation, Message, KnowledgeDocument, KnowledgeChunk, Faq],
        synchronize: cfg.get('database.synchronize'),
        logging: cfg.get('database.logging'),
        extra: { max: 10 },
      }),
    }),

    TypeOrmModule.forFeature([Conversation, Message, KnowledgeDocument, KnowledgeChunk, Faq]),

    SecurityModule,
    FaqModule,
  ],

  controllers: [
    WhatsappWebhookController,
    ...(IS_MOCK ? [SimulatorController] : []),
    AdminNotifyController,
    HealthController,
    MonitorController,
    RagDocumentsController,
  ],

  providers: [
    SessionService,
    SistemaApiService,
    IntentDetectorService,

    // WhatsApp real o mock según WHATSAPP_MOCK env
    whatsappProvider,
    ...(IS_MOCK ? [WhatsappMockService] : []),

    BotRemoteConfigService,
    MessageFormatterService,
    BotOrchestratorService,
    ConversationSummaryService,

    // Handlers especializados (SRP — extraídos del orquestador)
    PaymentHandler,
    SupportHandler,
    InstallationHandler,

    // GeminiHealthService reemplaza OllamaWarmupService
    GeminiHealthService,

    BillingJobsCompatService,

    RagService,
    QueryReformulationService,
    ReceiptHandlerService,
    AdminSignalrNotifierService,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(PhoneRateLimiterMiddleware)
      .forRoutes({ path: 'webhook', method: RequestMethod.POST });
  }
}
