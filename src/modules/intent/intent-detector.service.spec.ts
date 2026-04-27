import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { IntentDetectorService, Intent } from './intent-detector.service';
import { PseudonymService }    from '../../common/security/pseudonym/pseudonym.service';
import { PiiGuardInterceptor } from '../../common/security/pseudonym/pii-guard.interceptor';

const mockPseudonymService = {
  pseudonymize: jest.fn().mockResolvedValue({
    pseudonymizedText: 'texto',
    mappingKey:        '',
    replacementsCount: 0,
  }),
};

const mockPiiGuard = {
  inspect: jest.fn().mockReturnValue({ hasLeak: false, detections: [], detectedTypes: [] }),
};

// ══════════════════════════════════════════════════════════════
// TESTS UNITARIOS — IntentDetectorService (versión Gemini)
// Modo fallback regex puro (sin API key).
// Casos de prueba verificados contra los patrones reales.
// ══════════════════════════════════════════════════════════════

const configServiceMock = {
  get: jest.fn((key: string) => {
    if (key === 'gemini.apiKey') return '';
    if (key === 'gemini.intentModel') return 'gemini-2.0-flash';
    return undefined;
  }),
};

describe('IntentDetectorService', () => {
  let service: IntentDetectorService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IntentDetectorService,
        { provide: ConfigService,       useValue: configServiceMock },
        { provide: PseudonymService,    useValue: mockPseudonymService },
        { provide: PiiGuardInterceptor, useValue: mockPiiGuard },
      ],
    }).compile();
    service = module.get<IntentDetectorService>(IntentDetectorService);
    await service.onModuleInit();
  });

  describe('detect()', () => {
    it('retorna NINGUNO para texto vacío', async () => {
      expect(await service.detect('')).toBe(Intent.NINGUNO);
      expect(await service.detect('   ')).toBe(Intent.NINGUNO);
    });

    it('retorna NINGUNO para texto sin coincidencias', async () => {
      expect(await service.detect('lorem ipsum dolor sit amet')).toBe(Intent.NINGUNO);
    });

    describe('SALUDO', () => {
      const cases = ['hola', 'Hola!', 'buenas', 'buenas tardes', 'buenos días', 'hey'];
      it.each(cases)('"%s"', async (text) => {
        expect(await service.detect(text)).toBe(Intent.SALUDO);
      });
    });

    describe('CONSULTA_DEUDA', () => {
      const cases = ['cuánto debo', 'tengo deuda', 'cuál es mi saldo', 'tengo facturas pendientes', 'ver mis cuotas'];
      it.each(cases)('"%s"', async (text) => {
        expect(await service.detect(text)).toBe(Intent.CONSULTA_DEUDA);
      });
    });

    describe('SOLICITAR_QR', () => {
      const cases = ['necesito el QR', 'quiero pagar', 'mándame el qr por favor'];
      it.each(cases)('"%s"', async (text) => {
        expect(await service.detect(text)).toBe(Intent.SOLICITAR_QR);
      });
    });

    describe('SIN_CONEXION', () => {
      const cases = ['no tengo internet', 'sin internet', 'no funciona', 'se cortó el internet', 'sin conexión'];
      it.each(cases)('"%s"', async (text) => {
        expect(await service.detect(text)).toBe(Intent.SIN_CONEXION);
      });
    });

    describe('VELOCIDAD_LENTA', () => {
      const cases = ['el internet está lento', 'muy lento', 'poca velocidad', 'baja velocidad', 'buffering todo el tiempo', 'lag en el juego'];
      it.each(cases)('"%s"', async (text) => {
        expect(await service.detect(text)).toBe(Intent.VELOCIDAD_LENTA);
      });
    });

    describe('PROBLEMA_ROUTER', () => {
      const cases = ['el router tiene luz roja', 'el modem parpadea', 'luz amarilla en el router'];
      it.each(cases)('"%s"', async (text) => {
        expect(await service.detect(text)).toBe(Intent.PROBLEMA_ROUTER);
      });
    });

    describe('CANCELAR_INSTALACION', () => {
      // Debe detectarse ANTES que CANCELAR (ordering en FALLBACK_RULES)
      const cases = ['cancelar la instalación', 'reagendar mi cita', 'cambiar horario de la visita', 'reprogramar la instalación'];
      it.each(cases)('"%s"', async (text) => {
        expect(await service.detect(text)).toBe(Intent.CANCELAR_INSTALACION);
      });
    });

    describe('SOLICITAR_INSTALACION', () => {
      const cases = ['quiero instalar internet', 'nueva instalación por favor', 'quiero contratar el servicio', 'me interesa el plan Oro'];
      it.each(cases)('"%s"', async (text) => {
        expect(await service.detect(text)).toBe(Intent.SOLICITAR_INSTALACION);
      });
    });

    describe('CERRAR_TICKET', () => {
      const cases = ['ya se solucionó el problema', 'ya funciona', 'cerrar el ticket', 'ya está resuelto'];
      it.each(cases)('"%s"', async (text) => {
        expect(await service.detect(text)).toBe(Intent.CERRAR_TICKET);
      });
    });

    describe('SOLICITAR_AGENTE', () => {
      const cases = ['quiero hablar con un agente', 'necesito un humano', 'hablar con una persona', 'quiero un operador'];
      it.each(cases)('"%s"', async (text) => {
        expect(await service.detect(text)).toBe(Intent.SOLICITAR_AGENTE);
      });
    });

    describe('CONSULTA_PERIODO', () => {
      // Patrones: /fecha.*pago/i, /vence/i, /cu.*ndo.*pagar/i, /plazo.*pago/i
      const cases = ['fecha de pago', 'cuándo vence', 'cuándo tengo que pagar', 'plazo de pago'];
      it.each(cases)('"%s"', async (text) => {
        expect(await service.detect(text)).toBe(Intent.CONSULTA_PERIODO);
      });
    });

    describe('CONFIRMAR', () => {
      // /^s[ií]/i — debe empezar con s seguido de i o í
      const cases = ['sí', 'si', 'confirmo', 'de acuerdo', 'perfecto', 'ok'];
      it.each(cases)('"%s"', async (text) => {
        expect(await service.detect(text)).toBe(Intent.CONFIRMAR);
      });
    });

    describe('CANCELAR', () => {
      const cases = ['no', 'no quiero'];
      it.each(cases)('"%s"', async (text) => {
        expect(await service.detect(text)).toBe(Intent.CANCELAR);
      });
    });

    describe('MENU', () => {
      // /men[uú]/i — funciona con y sin tilde
      const cases = ['ver el menu', 'opciones disponibles', 'ayuda por favor'];
      it.each(cases)('"%s"', async (text) => {
        expect(await service.detect(text)).toBe(Intent.MENU);
      });
      it('detecta MENU con tilde (menú)', async () => {
        expect(await service.detect('quiero ver el menú')).toBe(Intent.MENU);
      });
    });

    it('es case-insensitive', async () => {
      expect(await service.detect('CUÁNTO DEBO')).toBe(Intent.CONSULTA_DEUDA);
      expect(await service.detect('ROUTER')).toBe(Intent.PROBLEMA_ROUTER);
      expect(await service.detect('SIN INTERNET')).toBe(Intent.SIN_CONEXION);
    });

    it('prioriza SIN_CONEXION sobre VELOCIDAD_LENTA en texto mixto', async () => {
      expect(await service.detect('no tengo internet y está muy lento')).toBe(Intent.SIN_CONEXION);
    });

    it('prioriza CANCELAR_INSTALACION sobre CANCELAR', async () => {
      expect(await service.detect('cancelar la instalación')).toBe(Intent.CANCELAR_INSTALACION);
    });
  });

  describe('isTransactional()', () => {
    it.each([
      Intent.CONSULTA_DEUDA, Intent.SOLICITAR_QR, Intent.SIN_CONEXION,
      Intent.VELOCIDAD_LENTA, Intent.PROBLEMA_ROUTER, Intent.CERRAR_TICKET,
      Intent.SOLICITAR_INSTALACION, Intent.CANCELAR_INSTALACION,
      Intent.CONFIRMAR, Intent.CANCELAR, Intent.SOLICITAR_AGENTE,
    ])('true para %s', (intent) => {
      expect(service.isTransactional(intent)).toBe(true);
    });

    it.each([Intent.NINGUNO, Intent.MENU, Intent.SALUDO])(
      'false para %s', (intent) => {
        expect(service.isTransactional(intent)).toBe(false);
      },
    );
  });

  describe('getTicketPriority()', () => {
    it('Alta → SIN_CONEXION', () => expect(service.getTicketPriority(Intent.SIN_CONEXION)).toBe('Alta'));
    it('Media → VELOCIDAD_LENTA', () => expect(service.getTicketPriority(Intent.VELOCIDAD_LENTA)).toBe('Media'));
    it('Media → PROBLEMA_ROUTER', () => expect(service.getTicketPriority(Intent.PROBLEMA_ROUTER)).toBe('Media'));
    it('Baja → intents no técnicos', () => {
      expect(service.getTicketPriority(Intent.CONSULTA_DEUDA)).toBe('Baja');
      expect(service.getTicketPriority(Intent.NINGUNO)).toBe('Baja');
    });
  });

  describe('getTicketType()', () => {
    it.each([
      [Intent.SIN_CONEXION,    'SoporteTecnico'],
      [Intent.VELOCIDAD_LENTA, 'SoporteTecnico'],
      [Intent.PROBLEMA_ROUTER, 'SoporteTecnico'],
    ])('%s → %s', (intent, expected) => {
      expect(service.getTicketType(intent)).toBe(expected);
    });
    it('InstalacionNueva → SOLICITAR_INSTALACION', () => {
      expect(service.getTicketType(Intent.SOLICITAR_INSTALACION)).toBe('InstalacionNueva');
    });
    it('SoporteTecnico fallback', () => {
      expect(service.getTicketType(Intent.NINGUNO)).toBe('SoporteTecnico');
    });
  });
});
