import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { IntentDetectorService, Intent } from './intent-detector.service';
import { GeminiClientService } from '../ai/gemini-client.service';

// ══════════════════════════════════════════════════════════════
// TESTS UNITARIOS — IntentDetectorService
// Cobertura: detect(), isTransactional(), getTicketPriority(),
//            getTicketType()
// ══════════════════════════════════════════════════════════════

describe('IntentDetectorService', () => {
  let service: IntentDetectorService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IntentDetectorService,
        { provide: ConfigService,       useValue: { get: jest.fn(() => undefined) } },
        { provide: GeminiClientService, useValue: { isEnabled: jest.fn(() => false), isUsingOAuth: jest.fn(() => false) } },
      ],
    }).compile();

    service = module.get<IntentDetectorService>(IntentDetectorService);
    await service.onModuleInit();
  });

  // ─── detect() ─────────────────────────────────────────────

  describe('detect()', () => {
    // Entradas vacías / nulas
    it('devuelve NINGUNO para texto vacío', async () => {
      expect(await service.detect('')).toBe(Intent.NINGUNO);
      expect(await service.detect('   ')).toBe(Intent.NINGUNO);
    });

    it('devuelve NINGUNO para texto sin coincidencias', async () => {
      expect(await service.detect('lorem ipsum dolor sit amet')).toBe(Intent.NINGUNO);
    });

    // ── SALUDO ──────────────────────────────────────────────
    describe('SALUDO', () => {
      const cases = ['hola', 'Hola!', 'buenas', 'buenas tardes', 'buenos días', 'hey'];
      it.each(cases)('detecta SALUDO en "%s"', async (text) => {
        expect(await service.detect(text)).toBe(Intent.SALUDO);
      });
    });

    // ── CONSULTA_DEUDA ───────────────────────────────────────
    describe('CONSULTA_DEUDA', () => {
      const cases = [
        'cuánto debo',
        'tengo deuda',
        'cuál es mi saldo',
        'tengo facturas pendientes',
        'cuánto tengo pendiente',
        'ver mis cuotas',
        'tengo pago pendiente',
      ];
      it.each(cases)('detecta CONSULTA_DEUDA en "%s"', async (text) => {
        expect(await service.detect(text)).toBe(Intent.CONSULTA_DEUDA);
      });
    });

    // ── SOLICITAR_QR ─────────────────────────────────────────
    describe('SOLICITAR_QR', () => {
      const cases = [
        'necesito el QR',
        'quiero pagar',
        'cómo pago',
        'mándame el qr por favor',
        'realizar pago',
        'punto de pago',
      ];
      it.each(cases)('detecta SOLICITAR_QR en "%s"', async (text) => {
        expect(await service.detect(text)).toBe(Intent.SOLICITAR_QR);
      });
    });

    // ── SIN_CONEXION ─────────────────────────────────────────
    describe('SIN_CONEXION', () => {
      const cases = [
        'no tengo internet',
        'sin internet',
        'no funciona',
        'se cortó el internet',
        'sin señal',
        'no conecta',
        'sin conexión',
        'caída de la red',
      ];
      it.each(cases)('detecta SIN_CONEXION en "%s"', async (text) => {
        expect(await service.detect(text)).toBe(Intent.SIN_CONEXION);
      });
    });

    // ── VELOCIDAD_LENTA ──────────────────────────────────────
    describe('VELOCIDAD_LENTA', () => {
      const cases = [
        'el internet está lento',
        'muy lento',
        'no carga ninguna página',
        'tarde mucho',
        'poca velocidad',
        'baja velocidad',
        'buffering todo el tiempo',
        'lag en el juego',
      ];
      it.each(cases)('detecta VELOCIDAD_LENTA en "%s"', async (text) => {
        expect(await service.detect(text)).toBe(Intent.VELOCIDAD_LENTA);
      });
    });

    // ── PROBLEMA_ROUTER ──────────────────────────────────────
    describe('PROBLEMA_ROUTER', () => {
      const cases = [
        'el router tiene luz roja',
        'problema con el módem',
        'mi equipo parpadea',
        'se reinicia solo',
        'no enciende el router',
        'el aparato se apaga',
      ];
      it.each(cases)('detecta PROBLEMA_ROUTER en "%s"', async (text) => {
        expect(await service.detect(text)).toBe(Intent.PROBLEMA_ROUTER);
      });
    });

    // ── CERRAR_TICKET ────────────────────────────────────────
    describe('CERRAR_TICKET', () => {
      const cases = [
        'ya se solucionó el problema',
        'ya funciona',
        'cerrar el ticket',
        'ya está bien gracias',
        'solucionado',
        'ya está resuelto',
      ];
      it.each(cases)('detecta CERRAR_TICKET en "%s"', async (text) => {
        expect(await service.detect(text)).toBe(Intent.CERRAR_TICKET);
      });
    });

    // ── SOLICITAR_INSTALACION ────────────────────────────────
    describe('SOLICITAR_INSTALACION', () => {
      const cases = [
        'quiero instalar internet',
        'nueva instalación por favor',
        'quiero contratar el servicio',
        'quiero el servicio',
        'soy nuevo cliente',
        'me interesa el plan Oro',
        'plan plata disponible?',
      ];
      it.each(cases)('detecta SOLICITAR_INSTALACION en "%s"', async (text) => {
        expect(await service.detect(text)).toBe(Intent.SOLICITAR_INSTALACION);
      });
    });

    // ── CANCELAR_INSTALACION ─────────────────────────────────
    describe('CANCELAR_INSTALACION', () => {
      const cases = [
        'cancelar la instalación',
        'no puedo ese día',
        'cambiar la cita',
        'reagendar mi cita',
        'cambiar horario',
      ];
      it.each(cases)('detecta CANCELAR_INSTALACION en "%s"', async (text) => {
        expect(await service.detect(text)).toBe(Intent.CANCELAR_INSTALACION);
      });
    });

    // ── CONFIRMAR / CANCELAR ─────────────────────────────────
    describe('CONFIRMAR', () => {
      const cases = ['sí', 'si', 'confirmo', 'de acuerdo', 'perfecto', 'ok'];
      it.each(cases)('detecta CONFIRMAR en "%s"', async (text) => {
        expect(await service.detect(text)).toBe(Intent.CONFIRMAR);
      });
    });

    describe('CANCELAR', () => {
      const cases = ['no', 'cancelar', 'no quiero', 'dejar así'];
      it.each(cases)('detecta CANCELAR en "%s"', async (text) => {
        expect(await service.detect(text)).toBe(Intent.CANCELAR);
      });
    });

    // ── SOLICITAR_AGENTE ─────────────────────────────────────
    describe('SOLICITAR_AGENTE', () => {
      const cases = [
        'quiero hablar con un agente',
        'necesito un humano',
        'hablar con una persona',
        'quiero un operador',
        'asistente humano por favor',
      ];
      it.each(cases)('detecta SOLICITAR_AGENTE en "%s"', async (text) => {
        expect(await service.detect(text)).toBe(Intent.SOLICITAR_AGENTE);
      });
    });

    // ── MENU ─────────────────────────────────────────────────
    describe('MENU', () => {
      const cases = ['menú', 'menu', 'opciones disponibles', 'ayuda'];
      it.each(cases)('detecta MENU en "%s"', async (text) => {
        expect(await service.detect(text)).toBe(Intent.MENU);
      });
    });

    // ── CONSULTA_PERIODO ─────────────────────────────────────
    describe('CONSULTA_PERIODO', () => {
      const cases = [
        'cuándo tengo que pagar',
        'fecha de pago',
        'fecha límite',
        'cuándo vence mi pago',
        'cuándo debo pagar',
        'fecha de vencimiento',
        'periodo de pago',
        'plazo de pago',
      ];
      it.each(cases)('detecta CONSULTA_PERIODO en "%s"', async (text) => {
        expect(await service.detect(text)).toBe(Intent.CONSULTA_PERIODO);
      });
    });

    // ── Case insensitivity ───────────────────────────────────
    it('es case-insensitive', async () => {
      expect(await service.detect('CUÁNTO DEBO')).toBe(Intent.CONSULTA_DEUDA);
      expect(await service.detect('ROUTER')).toBe(Intent.PROBLEMA_ROUTER);
      expect(await service.detect('SIN INTERNET')).toBe(Intent.SIN_CONEXION);
    });

    // ── Prioridad SIN_CONEXION sobre VELOCIDAD_LENTA ─────────
    it('prioriza SIN_CONEXION sobre VELOCIDAD_LENTA cuando ambos aplican', async () => {
      expect(await service.detect('no tengo internet y está muy lento')).toBe(Intent.SIN_CONEXION);
    });
  });

  // ─── isTransactional() ────────────────────────────────────

  describe('isTransactional()', () => {
    it.each([
      Intent.CONSULTA_DEUDA,
      Intent.SOLICITAR_QR,
      Intent.SIN_CONEXION,
      Intent.VELOCIDAD_LENTA,
      Intent.PROBLEMA_ROUTER,
      Intent.CERRAR_TICKET,
      Intent.SOLICITAR_INSTALACION,
      Intent.CANCELAR_INSTALACION,
      Intent.CONFIRMAR,
      Intent.CANCELAR,
      Intent.SOLICITAR_AGENTE,
    ])('devuelve true para intent transaccional %s', (intent) => {
      expect(service.isTransactional(intent)).toBe(true);
    });

    it.each([Intent.NINGUNO, Intent.MENU, Intent.SALUDO])(
      'devuelve false para intent no transaccional %s',
      (intent) => {
        expect(service.isTransactional(intent)).toBe(false);
      },
    );
  });

  // ─── getTicketPriority() ───────────────────────────────────

  describe('getTicketPriority()', () => {
    it('asigna prioridad Alta a SIN_CONEXION', () => {
      expect(service.getTicketPriority(Intent.SIN_CONEXION)).toBe('Alta');
    });

    it('asigna prioridad Media a VELOCIDAD_LENTA', () => {
      expect(service.getTicketPriority(Intent.VELOCIDAD_LENTA)).toBe('Media');
    });

    it('asigna prioridad Media a PROBLEMA_ROUTER', () => {
      expect(service.getTicketPriority(Intent.PROBLEMA_ROUTER)).toBe('Media');
    });

    it('asigna prioridad Baja a intents no técnicos', () => {
      expect(service.getTicketPriority(Intent.SOLICITAR_INSTALACION)).toBe('Baja');
      expect(service.getTicketPriority(Intent.CONSULTA_DEUDA)).toBe('Baja');
      expect(service.getTicketPriority(Intent.NINGUNO)).toBe('Baja');
    });
  });

  // ─── getTicketType() ──────────────────────────────────────

  describe('getTicketType()', () => {
    it.each([
      [Intent.SIN_CONEXION, 'SoporteTecnico'],
      [Intent.VELOCIDAD_LENTA, 'SoporteTecnico'],
      [Intent.PROBLEMA_ROUTER, 'SoporteTecnico'],
    ])('tipo %s → %s', (intent, expected) => {
      expect(service.getTicketType(intent)).toBe(expected);
    });

    it('asigna InstalacionNueva a SOLICITAR_INSTALACION', () => {
      expect(service.getTicketType(Intent.SOLICITAR_INSTALACION)).toBe('InstalacionNueva');
    });

    it('asigna SoporteTecnico como fallback', () => {
      expect(service.getTicketType(Intent.NINGUNO)).toBe('SoporteTecnico');
    });
  });
});
