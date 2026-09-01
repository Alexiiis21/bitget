/**
 * El formulario de alta de API keys: cuenta principal y casilla.
 *
 * --------------------------------------------------------------------------
 * Que se prueba aqui y por que importa
 * --------------------------------------------------------------------------
 * Que la casilla elegida llegue al backend y que la ocupada se rechace lo prueba
 * `test/integration/sesion.test.ts`. Aqui se prueba lo que solo existe en la
 * pantalla, y que es lo que evita un alta rechazada **despues** de teclear tres
 * claves de 64 caracteres:
 *
 *   1. La casilla que se propone es una libre de la cuenta principal elegida.
 *   2. Cambiar de cuenta principal cambia la propuesta: la casilla 3 de la A y
 *      la 3 de la B no tienen nada que ver.
 *   3. Tras un alta correcta, la cuenta principal se conserva y la casilla
 *      avanza. Dar de alta veinte subcuentas seguidas es el uso real de esta
 *      pantalla.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SUBCUENTAS_POR_GRUPO } from '@shared/constants';
import type { Account, ApiKeyInput } from '@shared/domain/panel-view';

/** Las altas que recibio el servicio, para comprobar que viaja la casilla. */
const altas: ApiKeyInput[] = [];

vi.mock('@/services/panel-service', () => ({
  panelService: {
    getSystemInfo: async () => ({ appVersion: '1.0.0', panelNumber: 1, portable: true, market: 'simulado' }),
    listAssetSlots: async () => [],
    subscribeAssetPrices: () => () => undefined,
    listApiKeys: async () => [],
    registerApiKey: async (input: ApiKeyInput) => {
      altas.push(input);
      return { ok: true, verdict: 'valida', reason: null, warnings: [], latencyMs: 10, uid: '547', parentUid: '151' };
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

/** Una cuenta principal con las casillas que se le indiquen ya ocupadas. */
const cuentaCon = (nombre: string, ocupadas: number[]): Account => ({
  id: `cta_${nombre}`,
  name: nombre,
  subAccounts: ocupadas.map((slot) => ({
    id: `${nombre}_s${slot}`,
    accountId: `cta_${nombre}`,
    label: `Sub-${String(slot).padStart(2, '0')}`,
    slot,
    balance: '1000',
    status: 'ok' as const,
    statusReason: null
  }))
});

/** El formulario con los tres secretos ya escritos: lo que falta es el destino. */
const conCredenciales = (): void => {
  usarPanel.setState((s) => ({
    formulario: {
      ...s.formulario,
      subcuenta: 'Sub-99',
      apiKey: 'bg_clavedeprueba0001',
      secretKey: 'secreto-de-prueba-largo',
      passphrase: 'frase'
    }
  }));
};

beforeEach(() => {
  altas.length = 0;
  usarPanel.setState({
    /* La A tiene ocupadas la 1, la 2 y la 3; la B, solo la 1. */
    cuentas: [cuentaCon('A', [1, 2, 3]), cuentaCon('B', [1])],
    formulario: { subcuenta: '', cuenta: 'A', casilla: '1', apiKey: '', secretKey: '', passphrase: '' },
    apiKeys: [],
    ocupado: false,
    avisos: []
  });
});

describe('la casilla que propone el formulario', () => {
  it('al abrir, la primera libre de la cuenta principal', () => {
    usarPanel.getState().abrirApis();

    expect(usarPanel.getState().formulario.casilla).toBe('4');
  });

  it('cambiar de cuenta principal propone la primera libre de esa', () => {
    usarPanel.getState().abrirApis();

    usarPanel.getState().escribirFormulario('cuenta', 'B');

    expect(usarPanel.getState().formulario.casilla).toBe('2');
  });

  /* Una cuenta principal sin subcuentas las tiene las veinte libres. */
  it('una cuenta principal vacia propone la casilla 1', () => {
    usarPanel.getState().abrirApis();

    usarPanel.getState().escribirFormulario('cuenta', 'C');

    expect(usarPanel.getState().formulario.casilla).toBe('1');
  });

  /*
   * Sin casillas libres no se propone ninguna: proponer una que va a chocar
   * seria enviar al operador a un rechazo con las tres claves ya tecleadas.
   */
  it('con la cuenta principal llena no propone nada', () => {
    const todas = Array.from({ length: SUBCUENTAS_POR_GRUPO }, (_, i) => i + 1);
    usarPanel.setState({ cuentas: [cuentaCon('A', todas)] });

    usarPanel.getState().abrirApis();

    expect(usarPanel.getState().formulario.casilla).toBe('');
  });

  /* Lo que el operador elige a mano se respeta. */
  it('escribir una casilla no la cambia sola', () => {
    usarPanel.getState().abrirApis();

    usarPanel.getState().escribirFormulario('casilla', '17');

    expect(usarPanel.getState().formulario.casilla).toBe('17');
  });
});

describe('guardar el alta', () => {
  it('la casilla elegida viaja con la credencial', async () => {
    usarPanel.getState().abrirApis();
    conCredenciales();
    usarPanel.getState().escribirFormulario('casilla', '12');

    await usarPanel.getState().guardarApi();

    expect(altas).toHaveLength(1);
    expect(altas[0]?.slot).toBe(12);
    expect(altas[0]?.accountName).toBe('A');
  });

  /*
   * Sin casilla no se sale a la red. Pasa con la cuenta principal llena, y el
   * aviso dice que hacer en vez de dejar que Bitget cobre la peticion.
   */
  it('sin casilla no se llama al servicio', async () => {
    const todas = Array.from({ length: SUBCUENTAS_POR_GRUPO }, (_, i) => i + 1);
    usarPanel.setState({ cuentas: [cuentaCon('A', todas)] });
    usarPanel.getState().abrirApis();
    conCredenciales();

    await usarPanel.getState().guardarApi();

    expect(altas).toHaveLength(0);
    expect(usarPanel.getState().avisos.at(-1)?.titulo).toBe('Elija una casilla');
  });

  /*
   * Dar de alta veinte subcuentas seguidas es el uso real de esta pantalla.
   * Volver a «A · casilla 1» tras cada una obligaba a reelegir las dos cosas
   * veinte veces; los tres secretos si se borran.
   */
  it('tras guardar, conserva la cuenta principal y avanza la casilla', async () => {
    usarPanel.getState().abrirApis();
    usarPanel.getState().escribirFormulario('cuenta', 'B');
    conCredenciales();

    await usarPanel.getState().guardarApi();

    const { formulario } = usarPanel.getState();
    expect(formulario.cuenta).toBe('B');
    /* La 1 estaba ocupada y la 2 se acaba de usar, aunque la matriz aun no lo sepa. */
    expect(formulario.casilla).toBe('3');
    expect(formulario.apiKey).toBe('');
    expect(formulario.secretKey).toBe('');
    expect(formulario.passphrase).toBe('');
  });
});
