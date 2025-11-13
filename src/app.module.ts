import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { HttpModule } from '@nestjs/axios';

// Config
import {
  appConfig, databaseConfig, redisConfig, sistemaConfig,
  metaConfig, geminiConfig, ragConfig, storageConfig, botConfig,
  rateLimitConfig, validateConfig,
} from './config/app.config';

// Entities
import { Conversation } from './database/entities/conversation.entity';
import { Message } from './database/entities/message.entity';
import { KnowledgeDocument, KnowledgeChunk } from './database/entities/knowledge.entity';

// Database
import { DatabaseMigrationService } from './database/database-migration.service';

// Services
import { SessionService } from './modules/session/session.service';
import { SistemaApiService } from './modules/client/sistema-api.service';
import {
  CLIENT_REPOSITORY, TICKET_REPOSITORY, PLAN_REPOSITORY,
  INSTALLATION_REPOSITORY, PAYMENT_REPOSITORY,
  NOTIFICATION_REPOSITORY, BOT_CONFIG_REPOSITORY,
} from './modules/client/sistema-api.interfaces';
import { WhatsappApiService } from './modules/whatsapp/whatsapp-api.service';
import { WhatsappMockService } from './modules/whatsapp/whatsapp-mock.service';
import { WHATSAPP_MESSENGER } from './modules/whatsapp/whatsapp-messenger.interface';
import { WhatsappOutboxService } from './modules/whatsapp/whatsapp-outbox.service';
import { OutboxRepositoryService } from './modules/whatsapp/outbox-repository.service';
import { WebhookDedupService } from './modules/whatsapp/webhook-dedup.service';
import { RagService } from './modules/rag/rag.service';
import { SemanticCacheService } from './modules/rag/semantic-cache.service';
import { ReceiptHandlerService } from './modules/payments/receipt-handler.service';
import { OcrExtractorService } from './modules/payments/ocr-extractor.service';
import { ReceiptClassifierService } from './modules/payments/receipt-classifier.service';
import { BotOrchestratorService } from './modules/bot/bot-orchestrator.service';
import { AgentService } from './modules/bot/agent.service';
import { PromptBuilderService } from './modules/bot/prompt-builder.service';
import { SentimentService } from './modules/bot/sentiment.service';
import { ConversationSummarizerService } from './modules/bot/conversation-summarizer.service';
import { PROMPT_SECTIONS } from './modules/bot/prompt-sections/prompt-section.interface';
import { PersonalitySection } from './modules/bot/prompt-sections/personality.section';
import { ClientInfoSection } from './modules/bot/prompt-sections/client-info.section';
import { SentimentHintSection } from './modules/bot/prompt-sections/sentiment-hint.section';
import { EscalationRulesSection } from './modules/bot/prompt-sections/escalation-rules.section';
import { GeneralInstructionsSection } from './modules/bot/prompt-sections/general-instructions.section';
import { ReceiptPendingSection } from './modules/bot/prompt-sections/receipt-pending.section';
import { TechSupportFlowSection } from './modules/bot/prompt-sections/tech-support-flow.section';
import { InstallationFlowSection } from './modules/bot/prompt-sections/installation-flow.section';
import { AgentToolRegistry } from './modules/bot/tools/agent-tool-registry.service';
import { AGENT_TOOLS } from './modules/bot/tools/agent-tool.interface';
import { GetClientDebtTool } from './modules/bot/tools/get-client-debt.tool';
import { SendPaymentQrTool } from './modules/bot/tools/send-payment-qr.tool';
import { CreateSupportTicketTool } from './modules/bot/tools/create-support-ticket.tool';
import { RescheduleTicketTool } from './modules/bot/tools/reschedule-ticket.tool';
import { CheckCoverageTool } from './modules/bot/tools/check-coverage.tool';
import { GetInstallationSlotsTool } from './modules/bot/tools/get-installation-slots.tool';
import { SearchKnowledgeBaseTool } from './modules/bot/tools/search-knowledge-base.tool';
import { CreateInstallationTool } from './modules/bot/tools/create-installation.tool';
import { CloseSupportTicketTool } from './modules/bot/tools/close-support-ticket.tool';
import { ChangePlanTool } from './modules/bot/tools/change-plan.tool';
import { GetAvailablePlansTool } from './modules/bot/tools/get-available-plans.tool';
import { EscalateToAgentTool } from './modules/bot/tools/escalate-to-agent.tool';
import { AudioTranscriberService } from './modules/bot/audio-transcriber.service';
import { MessageFormatterService } from './modules/bot/message-formatter.service';
import { BotConfigCacheService } from './modules/bot/bot-config-cache.service';
import { AdminSignalrNotifierService } from './modules/notifications/admin-signalr-notifier.service';
import { GeminiWarmupService } from './modules/bot/ollama-warmup.service';
import { BillingJobsCompatService } from './modules/bot/billing-jobs-compat.service';
import { GeminiClientService } from './modules/ai/gemini-client.service';
import { ImageIntentDetectorService } from './modules/intent/image-intent-detector.service';
import { MediaStorageService } from './modules/media/media-storage.service';

// Controllers
import { WhatsappWebhookController } from './modules/whatsapp/whatsapp-webhook.controller';
import { SimulatorController } from './modules/whatsapp/simulator.controller';
import { AdminNotifyController } from './modules/admin/admin-notify.controller';
import { HealthController } from './modules/bot/health.controller';
import { MonitorController } from './modules/admin/monitor.controller';
import { RagDocumentsController } from './modules/rag/rag-documents.controller';

// Middleware
import { PhoneRateLimiterMiddleware } from './common/middleware/phone-rate-limiter.middleware';

// Pipeline handlers (FIX-21: Chain of Responsibility)
import { MESSAGE_PIPELINE } from './modules/bot/pipeline/message-handler';
import { MessagePersistenceService } from './modules/bot/pipeline/message-persistence.service';
import { MessageSenderService } from './modules/bot/pipeline/message-sender.service';
import { MarkAsReadHandler } from './modules/bot/pipeline/mark-as-read.handler';
import { SessionLoadHandler } from './modules/bot/pipeline/session-load.handler';
import { MediaDownloadHandler } from './modules/bot/pipeline/media-download.handler';
import { EscalationCheckHandler } from './modules/bot/pipeline/escalation-check.handler';
import { MessagePersistHandler } from './modules/bot/pipeline/message-persist.handler';
import { ScheduleCheckHandler } from './modules/bot/pipeline/schedule-check.handler';
import { ClientIdentificationHandler } from './modules/bot/pipeline/client-identification.handler';
import { DebounceHandler } from './modules/bot/pipeline/debounce.handler';

// ─── Detectar modo mock ───────────────────────────────────────
const IS_MOCK = process.env.WHATSAPP_MOCK === 'true';

// Provider condicional: en mock usa WhatsappMockService,
// en producción usa WhatsappApiService real.
// Registrado bajo dos tokens para compatibilidad gradual:
//   WHATSAPP_MESSENGER — token de interfaz (DIP)
//   WhatsappApiService — token de clase (compatibilidad legacy)
const whatsappProvider = [
  {
    provide: WHATSAPP_MESSENGER,
    useClass: IS_MOCK ? WhatsappMockService : WhatsappApiService,
  },
  {
    provide: WhatsappApiService,
    useClass: IS_MOCK ? WhatsappMockService : WhatsappApiService,
  },
];

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateConfig,
      load: [
        appConfig, databaseConfig, redisConfig, sistemaConfig,
        metaConfig, geminiConfig, ragConfig, storageConfig, botConfig,
        rateLimitConfig,
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
        entities: [Conversation, Message, KnowledgeDocument, KnowledgeChunk],
        synchronize: cfg.get('database.synchronize'),
        logging: cfg.get('database.logging'),
        extra: { max: 10 },
      }),
    }),

    TypeOrmModule.forFeature([Conversation, Message, KnowledgeDocument, KnowledgeChunk]),
  ],

  controllers: [
    WhatsappWebhookController,
    ...(IS_MOCK ? [SimulatorController] : []),  // Solo en modo mock
    AdminNotifyController,
    HealthController,
    MonitorController,
    RagDocumentsController,
  ],

  providers: [
    DatabaseMigrationService,
    SessionService,
    SistemaApiService,
    // ─── ISP: tokens de dominio — todos apuntan a SistemaApiService ──────────
    { provide: CLIENT_REPOSITORY,       useExisting: SistemaApiService },
    { provide: TICKET_REPOSITORY,       useExisting: SistemaApiService },
    { provide: PLAN_REPOSITORY,         useExisting: SistemaApiService },
    { provide: INSTALLATION_REPOSITORY, useExisting: SistemaApiService },
    { provide: PAYMENT_REPOSITORY,      useExisting: SistemaApiService },
    { provide: NOTIFICATION_REPOSITORY, useExisting: SistemaApiService },
    { provide: BOT_CONFIG_REPOSITORY,   useExisting: SistemaApiService },

    // WhatsApp real o mock según WHATSAPP_MOCK env
    ...whatsappProvider,
    ...(IS_MOCK ? [WhatsappMockService] : []),
    OutboxRepositoryService,
    WhatsappOutboxService,
    WebhookDedupService,

    GeminiClientService,
    SentimentService,
    ConversationSummarizerService,

    // ─── OCP: prompt sections — agregar un flujo = nueva clase ───────────────
    PersonalitySection,
    ClientInfoSection,
    SentimentHintSection,
    EscalationRulesSection,
    GeneralInstructionsSection,
    ReceiptPendingSection,
    TechSupportFlowSection,
    InstallationFlowSection,
    {
      provide: PROMPT_SECTIONS,
      useFactory: (
        personality:    PersonalitySection,
        clientInfo:     ClientInfoSection,
        sentimentHint:  SentimentHintSection,
        escalation:     EscalationRulesSection,
        instructions:   GeneralInstructionsSection,
        receiptPending: ReceiptPendingSection,
        techSupport:    TechSupportFlowSection,
        installation:   InstallationFlowSection,
      ) => [personality, clientInfo, sentimentHint, escalation, instructions, receiptPending, techSupport, installation],
      inject: [
        PersonalitySection, ClientInfoSection, SentimentHintSection,
        EscalationRulesSection, GeneralInstructionsSection, ReceiptPendingSection,
        TechSupportFlowSection, InstallationFlowSection,
      ],
    },
    PromptBuilderService,

    AgentService,

    // ─── Command Pattern (FIX-22): cada herramienta como proveedor ───────────
    GetClientDebtTool,
    SendPaymentQrTool,
    CreateSupportTicketTool,
    RescheduleTicketTool,
    CheckCoverageTool,
    GetInstallationSlotsTool,
    SearchKnowledgeBaseTool,
    CreateInstallationTool,
    CloseSupportTicketTool,
    ChangePlanTool,
    GetAvailablePlansTool,
    EscalateToAgentTool,
    {
      provide: AGENT_TOOLS,
      useFactory: (
        t1:  GetClientDebtTool,
        t2:  SendPaymentQrTool,
        t3:  CreateSupportTicketTool,
        t4:  RescheduleTicketTool,
        t5:  CheckCoverageTool,
        t6:  GetInstallationSlotsTool,
        t7:  SearchKnowledgeBaseTool,
        t8:  CreateInstallationTool,
        t9:  CloseSupportTicketTool,
        t10: ChangePlanTool,
        t11: GetAvailablePlansTool,
        t12: EscalateToAgentTool,
      ) => [t1, t2, t3, t4, t5, t6, t7, t8, t9, t10, t11, t12],
      inject: [
        GetClientDebtTool,       SendPaymentQrTool,       CreateSupportTicketTool,
        RescheduleTicketTool,    CheckCoverageTool,        GetInstallationSlotsTool,
        SearchKnowledgeBaseTool, CreateInstallationTool,  CloseSupportTicketTool,
        ChangePlanTool,          GetAvailablePlansTool,   EscalateToAgentTool,
      ],
    },
    AgentToolRegistry,

    AudioTranscriberService,
    MessageFormatterService,
    BotConfigCacheService,
    BotOrchestratorService,
    GeminiWarmupService,
    BillingJobsCompatService,

    SemanticCacheService,
    RagService,
    OcrExtractorService,
    ReceiptClassifierService,
    ReceiptHandlerService,
    AdminSignalrNotifierService,
    ImageIntentDetectorService,
    MediaStorageService,

    // ─── Pipeline services (FIX-21) ───────────────────────────────────────
    MessagePersistenceService,
    MessageSenderService,
    MarkAsReadHandler,
    SessionLoadHandler,
    DebounceHandler,
    MediaDownloadHandler,
    EscalationCheckHandler,
    MessagePersistHandler,
    ScheduleCheckHandler,
    ClientIdentificationHandler,
    {
      provide: MESSAGE_PIPELINE,
      useFactory: (
        markAsRead:    MarkAsReadHandler,
        sessionLoad:   SessionLoadHandler,
        debounce:      DebounceHandler,
        mediaDownload: MediaDownloadHandler,
        escalation:    EscalationCheckHandler,
        persist:       MessagePersistHandler,
        schedule:      ScheduleCheckHandler,
        clientId:      ClientIdentificationHandler,
      ) => [markAsRead, sessionLoad, debounce, mediaDownload, escalation, persist, schedule, clientId],
      inject: [
        MarkAsReadHandler, SessionLoadHandler, DebounceHandler, MediaDownloadHandler,
        EscalationCheckHandler, MessagePersistHandler, ScheduleCheckHandler,
        ClientIdentificationHandler,
      ],
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(PhoneRateLimiterMiddleware)
      .forRoutes({ path: 'webhook', method: RequestMethod.POST });
  }
}
