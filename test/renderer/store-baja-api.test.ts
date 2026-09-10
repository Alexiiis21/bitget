/**
 * La baja de una API key, desde la pantalla.
 *
 * --------------------------------------------------------------------------
 * Que se prueba aqui y por que importa
 * --------------------------------------------------------------------------
 * Que el proceso principal no borre sin la contrasena de paso lo prueba
 * `test/integration/sesion.test.ts`, y ese es el freno que cuenta. Aqui se
 * prueba la otra mitad, la que el cliente ve: que pulsar «Eliminar» **no borra
 * nada** por si solo, que la clave viaja con la baja, y que tres intentos
 * fallidos la cancelan dejando la credencial donde estaba.
 *
 * Como en `store-plan.test.ts`, el servicio es de mentira y apunta cada llamada:
 * «no se borro nada» se comprueba contando bajas, no confiando en que no las
 * haya.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiKeyRow, DeleteOutcome } from '@shared/domain/panel-view';

/** Cada llamada a `deleteApiKey`, con la clave que llevaba. */
const bajas: { id: string; paso: string }[] = [];
/** La contrasena de paso del panel de mentira; `''` es «no hay ninguna fijada». */
let pasoActual = 'bg1';

const FILA: ApiKeyRow = {
  id: 'cta_1',
  subAccountLabel: 'Sub-01',
  accountName: 'A',
  maskedKey: 'bg••••abcd',
  uid: '5476143701',
  parentUid: '1513226215',
  status: 'ok',
  reason: null,
  accountMode: 'classic',
  inTransition: false
};

vi.mock('@/services/panel-service', () => ({
  panelService: {
    getSystemInfo: async () => ({ appVersion: '1.0.0', panelNumber: 1, portable: true, market: 'simulado' }),
    listAssetSlots: async () => [],
    subscribeAssetPrices: () => () => undefined,
    listApiKeys: async () => [],
    hasStepPassword: async () => pasoActual !== '',
    deleteApiKey: async (id: string, paso: string): Promise<DeleteOutcome> => {
      bajas.push({ id, paso });
      if (pasoActual === '' || paso !== pasoActual) return 'paso-incorrecto';
      return 'borrada';
    }
  }
}));

const almacen = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => almacen.get(k) ?? null,
    setItem: (k: string, v: string) => almacen.set(k, v),
    removeItem: (k: string) => almacen.delete(k)
  },
  configurable: true
});
Object.defineProperty(globalThis, 'window', {
  value: { matchMedia: () => ({ matches: false }) },
  configurable: true
});

const { usarPanel } = await import('@/store/panel');

beforeEach(() => {
  bajas.length = 0;
  pasoActual = 'bg1';
  usarPanel.setState({
    apiKeys: [FILA],
    bajaApi: null,
    pinBaja: '',
    errorBaja: '',
    intentosBaja: 0,
    ocupado: false,
    avisos: []
  });
});

describe('pedir la baja no la ejecuta', () => {
  it('abre la confirmacion sin llamar al servicio', async () => {
    await usarPanel.getState().pedirBajaApi('cta_1');

    expect(bajas).toHaveLength(0);
    expect(usarPanel.getState().bajaApi?.etiqueta).toBe('Sub-01');
    expect(usarPanel.getState().bajaApi?.cuenta).toBe('A');
  });

  it('cancelar no borra nada y cierra el diálogo', async () => {
    await usarPanel.getState().pedirBajaApi('cta_1');
    usarPanel.getState().cancelarBajaApi();

    expect(bajas).toHaveLength(0);
    expect(usarPanel.getState().bajaApi).toBeNull();
  });

  /* Cerrar la pantalla de API keys tambien cancela: el diálogo vive sobre ella. */
  it('cerrar la pantalla cancela la baja a medio confirmar', async () => {
    await usarPanel.getState().pedirBajaApi('cta_1');
    usarPanel.getState().cerrarApis();

    expect(bajas).toHaveLength(0);
    expect(usarPanel.getState().bajaApi).toBeNull();
  });
});

describe('la contrasena de paso', () => {
  it('viaja con la baja, y con ella la credencial se borra', async () => {
    await usarPanel.getState().pedirBajaApi('cta_1');
    usarPanel.getState().escribirPinBaja('bg1');
    await usarPanel.getState().confirmarBajaApi();

    expect(bajas).toEqual([{ id: 'cta_1', paso: 'bg1' }]);
    expect(usarPanel.getState().bajaApi).toBeNull();
    expect(usarPanel.getState().avisos.at(-1)?.titulo).toBe('API key eliminada');
  });

  /*
   * El campo vacio no llega a salir: el canal exige al menos un caracter, y sin
   * esto el operador veria un error de red donde lo que falta es escribir algo.
   */
  it('sin escribir nada no se llama al servicio', async () => {
    await usarPanel.getState().pedirBajaApi('cta_1');
    await usarPanel.getState().confirmarBajaApi();

    expect(bajas).toHaveLength(0);
    expect(usarPanel.getState().bajaApi).not.toBeNull();
    expect(usarPanel.getState().errorBaja).toContain('Escriba la contraseña de paso');
  });

  it('con la contrasena incorrecta la ficha sigue registrada', async () => {
    await usarPanel.getState().pedirBajaApi('cta_1');
    usarPanel.getState().escribirPinBaja('mal');
    await usarPanel.getState().confirmarBajaApi();

    /* El diálogo sigue abierto: se puede reintentar. */
    expect(usarPanel.getState().bajaApi).not.toBeNull();
    expect(usarPanel.getState().errorBaja).toContain('Intento 1');
    expect(usarPanel.getState().pinBaja).toBe('');
  });

  it('al tercer intento fallido se cancela la baja', async () => {
    await usarPanel.getState().pedirBajaApi('cta_1');

    for (let i = 0; i < 3; i += 1) {
      usarPanel.getState().escribirPinBaja('mal');
      await usarPanel.getState().confirmarBajaApi();
    }

    expect(bajas).toHaveLength(3);
    expect(usarPanel.getState().bajaApi).toBeNull();
    expect(usarPanel.getState().avisos.at(-1)?.titulo).toBe('Baja cancelada');
  });

  /*
   * Sin contrasena de paso configurada el proceso principal no dejaria borrar.
   * Se dice al abrir el diálogo en vez de gastar tres intentos contra una clave
   * que no existe.
   */
  it('sin contrasena de paso en el panel, no se intenta siquiera', async () => {
    pasoActual = '';

    await usarPanel.getState().pedirBajaApi('cta_1');
    expect(usarPanel.getState().bajaApi?.hayPaso).toBe(false);
    expect(usarPanel.getState().errorBaja).toContain('Seguridad');

    usarPanel.getState().escribirPinBaja('bg1');
    await usarPanel.getState().confirmarBajaApi();

    expect(bajas).toHaveLength(0);
  });
});
