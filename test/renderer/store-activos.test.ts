/**
 * Las ocho casillas de activo, vistas desde la pantalla.
 *
 * --------------------------------------------------------------------------
 * Que se prueba aqui y por que importa
 * --------------------------------------------------------------------------
 * La validacion de fondo -que el simbolo exista, que no se repita, que no haya
 * novena casilla- vive en el proceso principal y la prueba
 * `test/integration/ranuras-sesion.test.ts`. Lo que se prueba aqui es la otra
 * mitad, la que solo se rompe en el renderer:
 *
 *   1. Quitar el activo que estaba seleccionado no deja `activoId` apuntando a
 *      algo que ya no esta en el selector. Con ese `activoId` se planifica: si
 *      sobreviviera, «Abrir» iria contra un activo que la pantalla ya no
 *      enseña.
 *   2. Un rechazo del proceso principal no cambia nada. Reflejar el cambio de
 *      todos modos dejaria la pantalla enseñando una configuracion que el disco
 *      no tiene.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset } from '@shared/domain/panel-view';

const CATALOGO: Asset[] = [
  { id: 'BTC', symbol: 'BTCUSDT', label: 'BTC/USDT', priceDecimals: 1, maxLeverage: 150, minLeverage: 1, tradable: true },
  { id: 'ETH', symbol: 'ETHUSDT', label: 'ETH/USDT', priceDecimals: 2, maxLeverage: 150, minLeverage: 1, tradable: true },
  { id: 'DOGE', symbol: 'DOGEUSDT', label: 'DOGE/USDT', priceDecimals: 5, maxLeverage: 75, minLeverage: 1, tradable: true }
];

/** Las casillas que devuelve el servicio de mentira. Las mueve `setAssetSlot`. */
let ranuras: (Asset | null)[] = [];
/** Si esta puesto, `setAssetSlot` falla con ese motivo y no toca nada. */
let rechazo: string | null = null;
let catalogosPedidos = 0;

vi.mock('@/services/panel-service', () => ({
  panelService: {
    getSystemInfo: async () => ({ appVersion: '1.0.0', panelNumber: 1, portable: true, market: 'simulado' }),
    listAssetSlots: async () => ranuras,
    listAssetCatalog: async () => {
      catalogosPedidos += 1;
      return CATALOGO;
    },
    setAssetSlot: async (indice: number, simbolo: string | null) => {
      if (rechazo !== null) throw new Error(rechazo);
      ranuras = ranuras.map((a, i) =>
        i === indice ? (simbolo === null ? null : (CATALOGO.find((c) => c.symbol === simbolo) ?? null)) : a
      );
      return ranuras;
    },
    subscribeAssetPrices: () => () => undefined
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

const idsDeRanuras = (): (string | null)[] =>
  usarPanel.getState().ranuras.map((a) => a?.id ?? null);

beforeEach(() => {
  ranuras = [CATALOGO[0] as Asset, CATALOGO[1] as Asset, null];
  rechazo = null;
  catalogosPedidos = 0;
  usarPanel.setState({
    ranuras,
    activos: [CATALOGO[0] as Asset, CATALOGO[1] as Asset],
    activoId: 'BTC',
    catalogo: [],
    cargaCatalogo: 'inicial',
    ranuraEditando: null,
    filtroCatalogo: '',
    fijandoRanura: false,
    valoresFijos: false,
    valores: { tp: '1.5', mgi: '100', mga: '50', ap: '150', tpAjuste: '', mgAjuste: '' },
    avisos: []
  });
});

describe('abrir el buscador', () => {
  it('trae el catalogo y recuerda que casilla se edita', async () => {
    await usarPanel.getState().abrirBuscadorActivos(2);

    expect(usarPanel.getState().ranuraEditando).toBe(2);
    expect(usarPanel.getState().catalogo).toHaveLength(3);
    expect(usarPanel.getState().cargaCatalogo).toBe('listo');
  });

  /* El catalogo del mercado no cambia mientras el panel esta abierto. */
  it('no vuelve a pedir el catalogo cada vez que se abre', async () => {
    await usarPanel.getState().abrirBuscadorActivos(0);
    usarPanel.getState().cerrarBuscadorActivos();
    await usarPanel.getState().abrirBuscadorActivos(1);

    expect(catalogosPedidos).toBe(1);
  });
});

describe('cambiar el activo de una casilla', () => {
  it('sustituye el de esa casilla y deja las demas donde estaban', async () => {
    await usarPanel.getState().abrirBuscadorActivos(0);
    await usarPanel.getState().fijarRanura('DOGEUSDT');

    expect(idsDeRanuras()).toEqual(['DOGE', 'ETH', null]);
    /* Y el buscador se cierra solo: elegir es el final del acto. */
    expect(usarPanel.getState().ranuraEditando).toBeNull();
  });

  /* Una casilla vacia no es un activo, asi que no entra en «activos». */
  it('vaciar una casilla la quita de los activos operables', async () => {
    await usarPanel.getState().abrirBuscadorActivos(1);
    await usarPanel.getState().fijarRanura(null);

    expect(idsDeRanuras()).toEqual(['BTC', null, null]);
    expect(usarPanel.getState().activos.map((a) => a.id)).toEqual(['BTC']);
  });
});

describe('el activo seleccionado cuando su casilla cambia', () => {
  /*
   * El fallo que esto impide: con `activoId` en BTC se vacia la casilla de BTC,
   * y `planear('open')` seguiria mandando `assetId: 'BTC'` -un activo que la
   * pantalla ya no enseña- porque el selector no tiene forma de decirlo.
   */
  it('quitar el activo seleccionado mueve la seleccion al primero que quede', async () => {
    await usarPanel.getState().abrirBuscadorActivos(0);
    await usarPanel.getState().fijarRanura(null);

    expect(usarPanel.getState().activoId).toBe('ETH');
    /* Y arrastra el tope del activo nuevo, como cualquier cambio de activo. */
    expect(usarPanel.getState().valores.ap).toBe('150');
  });

  it('cambiar otra casilla no toca el activo seleccionado', async () => {
    await usarPanel.getState().abrirBuscadorActivos(1);
    await usarPanel.getState().fijarRanura('DOGEUSDT');

    expect(usarPanel.getState().activoId).toBe('BTC');
  });

  /* «Valores fijos» significa «no me cambies lo que escribí», tambien aqui. */
  it('con valores fijos no se toca el apalancamiento escrito', async () => {
    usarPanel.setState({ valoresFijos: true, valores: { tp: '1.5', mgi: '100', mga: '50', ap: '12', tpAjuste: '', mgAjuste: '' } });

    await usarPanel.getState().abrirBuscadorActivos(0);
    await usarPanel.getState().fijarRanura(null);

    expect(usarPanel.getState().activoId).toBe('ETH');
    expect(usarPanel.getState().valores.ap).toBe('12');
  });
});

describe('cuando el proceso principal dice que no', () => {
  /*
   * Reflejar el cambio de todos modos dejaria la pantalla enseñando una
   * configuracion que el disco no tiene, y el operador creeria estar operando
   * un activo que no esta puesto.
   */
  it('un rechazo no cambia ninguna casilla y se avisa', async () => {
    rechazo = 'BTC/USDT ya está en la casilla 1. Vacíe esa casilla primero si quiere moverlo.';

    await usarPanel.getState().abrirBuscadorActivos(2);
    await usarPanel.getState().fijarRanura('BTCUSDT');

    expect(idsDeRanuras()).toEqual(['BTC', 'ETH', null]);
    expect(usarPanel.getState().avisos.at(-1)?.cuerpo).toContain('ya está en la casilla 1');
    /* El buscador se queda abierto: hay algo que corregir. */
    expect(usarPanel.getState().ranuraEditando).toBe(2);
  });
});
