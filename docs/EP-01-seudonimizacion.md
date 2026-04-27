# EP-01 · Seudonimización de Datos ante el LLM

> Implementación de la User Story EP-01 (US-EP01-01 a US-EP01-05).
> Basada en la arquitectura de seudonimización del Proyecto de Grado de Mamani Condori (2026).

---

## ¿Qué se implementó?

Antes de esta implementación, el chatbot enviaba datos reales del cliente
directamente a la API de Google Gemini:

```
Gemini recibía → "Hola Juan Mamani, tu deuda es Bs 350, CLI-4821"
```

Con esta implementación, Gemini nunca recibe PII:

```
Gemini recibe  → "Hola PERSONA_001, tu deuda es MONTO_001, CLIENTE_001"
```

---

## Archivos creados

```
src/common/security/
├── security.module.ts                          ← Módulo NestJS exportable
└── pseudonym/
    ├── index.ts                                ← Barrel de exportaciones
    ├── sensitive-entity.types.ts               ← Tipos e interfaces (sin lógica)
    ├── sensitive-entities.catalog.ts           ← Catálogo de entidades + patrones
    ├── pseudonym.service.ts                    ← Servicio core de seudonimización
    ├── pseudonym-expired.error.ts              ← Error tipado para TTL expirado
    ├── pii-guard.interceptor.ts                ← Auditor de PII saliente
    ├── sensitive-entities.catalog.spec.ts      ← Tests del catálogo (≥5 positivos/negativos)
    ├── pseudonym.service.spec.ts               ← Tests del servicio (≥85% cobertura)
    └── pii-guard.interceptor.spec.ts           ← Tests del guardia
```

## Archivos modificados

| Archivo | Cambio |
|---------|--------|
| `src/config/app.config.ts` | Agrega `securityConfig` con `pseudonymTtlSeconds` y `piiGuardMode` |
| `src/app.module.ts` | Importa `SecurityModule` y registra `securityConfig` |
| `src/modules/intent/intent-detector.service.ts` | Inyecta `PseudonymService` y `PiiGuardInterceptor`; seudonimiza antes de llamar a Gemini |
| `src/modules/bot/bot-orchestrator.service.ts` | Pasa `phoneNumber` y `clientName` a `intentDetector.detect()` |
| `.env.example` | Agrega `PSEUDONYM_TTL_SECONDS` y `PII_GUARD_MODE` |

---

## Flujo de datos (post-implementación)

```
Usuario WhatsApp
      │
      ▼
BotOrchestratorService.handleIncoming(from, text, clientName)
      │
      ▼
IntentDetectorService.detect(text, phoneNumber, clientName)
      │
      ├── PseudonymService.pseudonymize(text, phone, clientName)
      │     ├── Detecta PII con patrones del catálogo
      │     ├── Reemplaza por tokens (CLIENTE_001, MONTO_001...)
      │     └── Persiste tabla en Redis (TTL: 5 min)
      │
      ├── PiiGuardInterceptor.inspect(pseudoText, phone)
      │     └── Alerta si aún hay PII en el texto tokenizado
      │
      └── Gemini Flash (recibe SOLO texto tokenizado)
            │
            ▼
          Intent detectado
```

---

## Entidades sensibles configuradas

| Tipo | Token | Ejemplo detectado | Ejemplo token |
|------|-------|-------------------|---------------|
| `TICKET_NUMBER` | `TICKET_NNN` | `TKT-7890` | `TICKET_001` |
| `CLIENT_ID` | `CLIENTE_NNN` | `CLI-4821` | `CLIENTE_001` |
| `TBN_CODE` | `TBN_NNN` | `TBN-2024-A` | `TBN_001` |
| `INVOICE_NUMBER` | `FACTURA_NNN` | `FACT-2024-001` | `FACTURA_001` |
| `AMOUNT_BOB` | `MONTO_NNN` | `Bs 350` | `MONTO_001` |
| `PHONE_NUMBER` | `TELEFONO_NNN` | `76543210` | `TELEFONO_001` |
| `PLAN_NAME` | `PLAN_NNN` | `Plan Fibra 100Mb` | `PLAN_001` |
| `FULL_NAME` | `PERSONA_NNN` | `Juan Mamani` (vía sesión) | `PERSONA_001` |

---

## Variables de entorno nuevas

| Variable | Default | Descripción |
|----------|---------|-------------|
| `PSEUDONYM_TTL_SECONDS` | `300` | TTL de la tabla Redis en segundos |
| `PII_GUARD_MODE` | `permissive` | `permissive` (solo alerta) o `strict` (bloquea) |

---

## Cómo ejecutar los tests

```bash
# Tests del catálogo de entidades
npm test -- sensitive-entities.catalog.spec

# Tests del PseudonymService
npm test -- pseudonym.service.spec

# Tests del PiiGuardInterceptor
npm test -- pii-guard.interceptor.spec

# Tests de integración IntentDetector + seudonimización
npm test -- intent-detector-pseudonym.spec

# Todos los tests con cobertura
npm run test:cov
```

---

## Guía de migración para los próximos flujos (EP-01-04)

El siguiente paso es integrar la seudonimización + re-hidratación en el
**RagService** (US-EP01-04). El patrón a seguir es:

```typescript
// 1. Seudonimizar la query del usuario
const { pseudonymizedText, mappingKey } = await this.pseudonymService.pseudonymize(
  userQuery, phoneNumber, clientName,
);

// 2. Usar el texto tokenizado para la búsqueda RAG
const ragResult = await this.searchAndGenerate(pseudonymizedText);

// 3. Re-hidratar la respuesta antes de enviar al usuario
const finalAnswer = await this.pseudonymService.rehydrate(ragResult.answer, mappingKey);

// 4. Invalidar la tabla una vez usada (opcional, el TTL lo hace automáticamente)
await this.pseudonymService.invalidate(mappingKey);
```

Si la re-hidratación falla por `PseudonymExpiredError`, responder al usuario:
> "Hubo un problema procesando tu consulta. Por favor, envía tu pregunta de nuevo."

---

## Decisiones de diseño

**¿Por qué Redis y no memoria en proceso?**
El servicio puede escalar horizontalmente (múltiples instancias del bot).
Redis garantiza que la tabla de correspondencia sea accesible desde cualquier instancia,
incluso si el proceso que tokenizó es distinto del que re-hidrata.

**¿Por qué TTL de 5 minutos y no más largo?**
El tiempo entre `pseudonymize()` y `rehydrate()` en un flujo normal es < 15 segundos.
Un TTL de 5 minutos es conservador pero reduce la ventana de exposición si Redis
es comprometido. Configurable vía `PSEUDONYM_TTL_SECONDS`.

**¿Por qué los tokens son predecibles (CLIENTE_001) y no aleatorios?**
El LLM necesita referencias estables para construir respuestas coherentes.
Si el token fuera aleatorio (`a7f3c2`), Gemini no podría generar frases naturales
como "El CLIENTE_001 tiene una deuda de MONTO_001 pendiente desde hace 3 días."
La seguridad no depende de la impredecibilidad del token, sino del TTL corto y
del aislamiento de la tabla de correspondencia en Redis.

**¿Por qué FULL_NAME no tiene patrones regex?**
La detección de nombres propios con regex en español tiene alta tasa de falsos positivos.
Palabras como "Bolivia", "Hola", nombres de planes ("Plan Fibra") serían detectadas
incorrectamente. La detección se hace por valor exacto de sesión (clientName conocido).
Para detección NER real, implementar el modelo Spacy entrenado como en la tesis.
