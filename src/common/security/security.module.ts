/**
 * @file security.module.ts
 * @description Módulo NestJS que agrupa todos los servicios de seguridad.
 *
 * Exporta PseudonymService y PiiGuardInterceptor para que cualquier
 * módulo que los importe pueda inyectarlos.
 *
 * ConfigModule debe ser global (isGlobal: true) en AppModule para que
 * los servicios aquí puedan acceder a ConfigService sin importarlo.
 */

import { Module } from '@nestjs/common';
import { PseudonymService }     from './pseudonym/pseudonym.service';
import { PiiGuardInterceptor }  from './pseudonym/pii-guard.interceptor';

@Module({
  providers: [
    PseudonymService,
    PiiGuardInterceptor,
  ],
  exports: [
    PseudonymService,
    PiiGuardInterceptor,
  ],
})
export class SecurityModule {}
