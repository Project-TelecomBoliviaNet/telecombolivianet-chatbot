/**
 * @file faq.module.ts
 * @description Módulo NestJS de Preguntas Frecuentes.
 *
 * DEPENDENCIA CIRCULAR RESUELTA:
 *   FaqMatcherService.match() necesita RagService.embed() para vectorizar.
 *   RagService.query() necesita FaqMatcherService.match() como primera capa.
 *
 *   Solución: late binding vía setter.
 *   1. FaqModule importa RagService (puede hacerlo — no hay ciclo en imports).
 *   2. En onModuleInit, FaqModule llama ragService.setFaqMatcher(matcher).
 *   3. RagService guarda la referencia y la usa en query().
 *
 *   Este patrón es preferible a forwardRef() porque:
 *   - forwardRef() puede causar dependencias undefined en orden incorrecto.
 *   - El setter es explícito: queda claro quién "conecta" los dos servicios.
 */

import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Faq }               from '../../database/entities/faq.entity';
import { FaqService }        from './faq.service';
import { FaqMatcherService } from './faq-matcher.service';
import { FaqController }     from './faq.controller';
import { RagService }        from '../rag/rag.service';
import { QueryReformulationService } from '../rag/query-reformulation.service';
import { SecurityModule }    from '../../common/security/security.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Faq]),
    SecurityModule,
  ],
  controllers: [FaqController],
  providers: [
    FaqService,
    FaqMatcherService,
    RagService,
    QueryReformulationService,
  ],
  exports: [
    FaqService,
    FaqMatcherService,
  ],
})
export class FaqModule implements OnModuleInit {
  constructor(
    private readonly ragService:     RagService,
    private readonly faqMatcher:     FaqMatcherService,
  ) {}

  /**
   * Conecta FaqMatcherService con RagService después de que ambos
   * están completamente construidos e inicializados.
   */
  onModuleInit(): void {
    this.ragService.setFaqMatcher(this.faqMatcher);
  }
}
