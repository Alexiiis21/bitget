/**
 * El distintivo de mercado, cuando algo falla.
 *
 * --------------------------------------------------------------------------
 * Por que esta prueba existe
 * --------------------------------------------------------------------------
 * El 03/09/2026, con la red caida, un panel arrancado con `--mode staging-real`
 * -mercado real, ordenes con dinero de verdad- enseñaba la insignia SIMULADO.
 *
 * La causa: `iniciar` pedia la informacion del sistema y el catalogo de activos
 * en un mismo `Promise.all`. La primera es local y no puede fallar por red; el
 * segundo sale a Bitget. Un `ENOTFOUND` en el catalogo rechazaba el conjunto, el
 * `set` no llegaba a ejecutarse y `mercado` se quedaba en su valor inicial, que
 * ademas era `simulado`.
 *
 * Es el peor fallo posible de ese distintivo: no es que deje de informar, es que
 * tranquiliza justo cuando no debe. Lo que se fija aqui es que ninguna de las
 * dos mitades del arreglo se pueda deshacer sin que salte una prueba:
 *
 *   1. Que el catalogo se caiga no cambia lo que dice la insignia.
 *   2. Mientras no se sepa, se avisa: el valor de partida es `real`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Lo que devolvera `getSystemInfo` en cada caso. La cambia cada prueba. */
let sistema: { fallar: boolean; market: 'real' | 'simulado' } = { fallar: false, market: 'real' };
/** Si el catalogo de activos se cae, como con la red caida. */
let catalogoFalla = false;

vi.mock('@/services/panel-service', () => ({
  panelService: {
    getSystemInfo: async () => {
      if (sistema.fallar) throw new Error('IPC caido');
      return { appVersion: '1.0.0', panelNumber: 7, portable: true, market: sistema.market };
    },
    listAssetSlots: async () => {
      if (catalogoFalla) throw new Error('getaddrinfo ENOTFOUND api.bitget.com');
      return [];
    },
    subscribeAssetPrices: () => () => undefined,
    listApiKeys: async () => []
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
  sistema = { fallar: false, market: 'real' };
  catalogoFalla = false;
  usarPanel.setState({ mercado: 'real', numeroPanel: 1 });
});

describe('mercado con la red caida', () => {
  /* El caso exacto del 03/09/2026. */
  it('sigue diciendo real aunque el catalogo de activos no responda', async () => {
    catalogoFalla = true;

    await usarPanel.getState().iniciar();

    expect(usarPanel.getState().mercado).toBe('real');
  });

  /*
   * Y al reves: que el catalogo se caiga tampoco puede hacer que un panel
   * simulado se anuncie como real. Lo que manda es lo que dice el proceso
   * principal, no si la red va.
   */
  it('dice simulado cuando el proceso principal lo dice, aunque el catalogo falle', async () => {
    sistema = { fallar: false, market: 'simulado' };
    catalogoFalla = true;

    await usarPanel.getState().iniciar();

    expect(usarPanel.getState().mercado).toBe('simulado');
  });

  /* El catalogo no arrastra al resto de la informacion del sistema. */
  it('lee el numero de panel aunque el catalogo falle', async () => {
    catalogoFalla = true;

    await usarPanel.getState().iniciar();

    expect(usarPanel.getState().numeroPanel).toBe(7);
  });
});

describe('mercado sin saberlo todavia', () => {
  /*
   * Con el IPC roto no hay respuesta que creer. Entre una falsa alarma y una
   * falsa tranquilidad, se elige la alarma: mirar dos veces no cuesta dinero.
   */
  it('avisa de mercado real mientras no se sepa', async () => {
    sistema = { fallar: true, market: 'simulado' };
    usarPanel.setState({ mercado: 'real' });

    await usarPanel.getState().iniciar();

    expect(usarPanel.getState().mercado).toBe('real');
  });

  it('el estado de partida del store es real, no simulado', async () => {
    /* Se reimporta limpio para leer el valor inicial, sin lo que dejen otras. */
    vi.resetModules();
    const { usarPanel: reciente } = await import('@/store/panel');

    expect(reciente.getState().mercado).toBe('real');
  });
});
