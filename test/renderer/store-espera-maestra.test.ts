/**
 * La espera creciente de la maestra, vista desde la pantalla.
 *
 * --------------------------------------------------------------------------
 * Que se prueba aqui y que no
 * --------------------------------------------------------------------------
 * Que la espera se **cumpla** es cosa del proceso principal, y lo prueban
 * `test/unit/freno-maestra.test.ts` y la suite de la sesion. Aqui se prueba lo
 * que el operador ve, que es lo unico que decide si la funcion sirve:
 *
 *   1. Al arrancar con una espera en curso, la pantalla ya la sabe -sin haber
 *      tecleado nada-. Es lo que distingue «el panel me dice que espere» de
 *      «el panel no me deja entrar y no dice por que».
 *   2. Tras un fallo, la cuenta atras empieza sola.
 *   3. Con la espera en curso, la pantalla de seguridad **no** acusa a la
 *      contraseña: dice que hay que esperar.
 *   4. Un acierto la borra.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnlockResult } from '@shared/domain/panel-view';

/** Lo que el proceso principal responderia ahora mismo. */
let esperaMs = 0;
let resultadoDesbloqueo: UnlockResult = { ok: true, reason: null };
let maestraValida = true;
/** Cada consulta de la espera, para comprobar que se pregunta cuando toca. */
let consultas = 0;

vi.mock('@/services/panel-service', () => ({
  panelService: {
    getSystemInfo: async () => ({
      appVersion: '1.0.0',
      panelNumber: 1,
      portable: true,
      market: 'simulado'
    }),
    listAssetSlots: async () => [],
    subscribeAssetPrices: () => () => undefined,
    listApiKeys: async () => [],
    hasStepPassword: async () => true,
    isFirstRun: async () => false,
    findBackup: async () => null,
    getAccounts: async () => [],
    subscribeAccounts: () => () => undefined,
    unlockVault: async (): Promise<UnlockResult> => resultadoDesbloqueo,
    verifyMasterPassword: async (): Promise<boolean> => maestraValida && esperaMs === 0,
    masterCooldownMs: async (): Promise<number> => {
      consultas += 1;
      return esperaMs;
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
  esperaMs = 0;
  consultas = 0;
  maestraValida = true;
  resultadoDesbloqueo = { ok: true, reason: null };
  usarPanel.setState({
    esperaMaestraMs: 0,
    contrasena: '',
    errorContrasena: '',
    maestraSeguridad: '',
    errorSeguridad: '',
    etapaSeguridad: 'maestra',
    ocupado: false,
    pantalla: 'login'
  });
});

describe('al arrancar', () => {
  it('sabe la espera que dejo la sesion anterior sin que nadie teclee', async () => {
    esperaMs = 3 * 60_000;

    await usarPanel.getState().refrescarEsperaMaestra();

    expect(usarPanel.getState().esperaMaestraMs).toBe(3 * 60_000);
    expect(consultas).toBe(1);
  });

  /*
   * Si el proceso principal no contesta no se inventa una espera: el freno de
   * verdad esta al otro lado, y una cuenta atras que nadie ha confirmado seria
   * peor que ninguna.
   */
  it('no inventa una espera cuando la consulta falla', async () => {
    usarPanel.setState({ esperaMaestraMs: 0 });
    esperaMs = 0;

    await usarPanel.getState().refrescarEsperaMaestra();

    expect(usarPanel.getState().esperaMaestraMs).toBe(0);
  });
});

describe('tras fallar el desbloqueo', () => {
  it('empieza la cuenta atras sin esperar a que el operador lo intente otra vez', async () => {
    resultadoDesbloqueo = { ok: false, reason: 'Demasiados intentos seguidos.' };
    esperaMs = 3 * 60_000;

    usarPanel.setState({ contrasena: 'una-clave-larga' });
    await usarPanel.getState().desbloquear();

    expect(usarPanel.getState().errorContrasena).toContain('Demasiados intentos');
    expect(usarPanel.getState().esperaMaestraMs).toBe(3 * 60_000);
  });

  it('un desbloqueo correcto borra la espera', async () => {
    usarPanel.setState({ esperaMaestraMs: 60_000, contrasena: 'una-clave-larga' });

    await usarPanel.getState().desbloquear();

    expect(usarPanel.getState().pantalla).toBe('panel');
    expect(usarPanel.getState().esperaMaestraMs).toBe(0);
  });
});

describe('la pantalla de seguridad', () => {
  /*
   * El caso que motivo separar los dos mensajes: quien teclea **bien** durante
   * la espera no puede leer «la contraseña maestra no es correcta». Es como se
   * empieza a dudar de una clave que estaba bien, y de ahi a borrar el almacen
   * y volver a darlo todo de alta hay un paso.
   */
  it('con la espera en curso dice que hay que esperar, no que la clave este mal', async () => {
    esperaMs = 6 * 60_000;
    usarPanel.setState({ maestraSeguridad: 'la-buena-de-verdad' });

    await usarPanel.getState().verificarMaestra();

    const error = usarPanel.getState().errorSeguridad;
    expect(error).toContain('6 minutos');
    expect(error).not.toContain('no es correcta');
    expect(usarPanel.getState().etapaSeguridad).toBe('maestra');
  });

  it('sin espera, una clave mala si se llama por su nombre', async () => {
    maestraValida = false;
    usarPanel.setState({ maestraSeguridad: 'la-mala' });

    await usarPanel.getState().verificarMaestra();

    expect(usarPanel.getState().errorSeguridad).toContain('no es correcta');
  });
});
