/**
 * El alcance y la seleccion de casillas.
 *
 * --------------------------------------------------------------------------
 * Que se prueba aqui y por que importa
 * --------------------------------------------------------------------------
 * Una sola invariante, y es la que el cliente pidio el 28/08/2026:
 *
 *   **lo que se ve marcado es exactamente lo que se va a enviar.**
 *
 * Antes no lo era, por los dos lados. Con el alcance en «Ambos» las dos puntas
 * de una columna se marcaban por separado, asi que un clic que fallaba la
 * segunda casilla abria media posicion donde se habia pedido el par. Y al reves:
 * «Todas» con el alcance en *Long* marcaba tambien las veinte short por dentro
 * -invisibles en el recuento- de modo que volver a «Ambos» convertia un lote de
 * veinte casillas en uno de cuarenta sin tocar la matriz.
 *
 * Las dos mitades se comprueban contando objetivos, que es lo que de verdad
 * viaja a Bitget, y no solo el rotulo del contador.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/* El store importa el servicio al cargarse; ninguna prueba de aqui lo llama. */
vi.mock('@/services/panel-service', () => ({
  panelService: {
    getSystemInfo: async () => ({ appVersion: '1.0.0', panelNumber: 1, portable: true }),
    listAssets: async () => [],
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

/** Dos cuentas principales de tres subcuentas: doce casillas en total. */
const CUENTAS = ['cta_1', 'cta_2'].map((id) => ({
  id,
  name: id === 'cta_1' ? 'A' : 'B',
  subAccounts: [1, 2, 3].map((n) => ({
    id: `${id}_sub_${n}`,
    accountId: id,
    label: `Sub-0${n}`,
    slot: n,
    balance: '1000',
    status: 'ok' as const,
    statusReason: null
  }))
}));

const objetivos = (): { subAccountId: string; side: string }[] => usarPanel.getState().objetivosSeleccionados();

beforeEach(() => {
  usarPanel.setState({ cuentas: CUENTAS, seleccion: {}, alcance: 'ambos' });
});

describe('«Ambos»: las dos casillas de una columna son una sola', () => {
  it('marcar la casilla LONG marca tambien la SHORT', () => {
    usarPanel.getState().alternarCasilla('cta_1', 'selLong', 0);

    expect(usarPanel.getState().seleccion['cta_1']?.selLong[0]).toBe(true);
    expect(usarPanel.getState().seleccion['cta_1']?.selShort[0]).toBe(true);
    expect(usarPanel.getState().contarSeleccion()).toBe(2);
    expect(objetivos()).toEqual([
      { subAccountId: 'cta_1_sub_1', side: 'long' },
      { subAccountId: 'cta_1_sub_1', side: 'short' }
    ]);
  });

  it('marcar la casilla SHORT marca tambien la LONG', () => {
    usarPanel.getState().alternarCasilla('cta_1', 'selShort', 2);

    expect(objetivos()).toEqual([
      { subAccountId: 'cta_1_sub_3', side: 'long' },
      { subAccountId: 'cta_1_sub_3', side: 'short' }
    ]);
  });

  /* Y el par se deshace entero, desde cualquiera de sus dos puntas. */
  it('desmarcar una de las dos quita la columna entera', () => {
    usarPanel.getState().alternarCasilla('cta_1', 'selLong', 0);
    usarPanel.getState().alternarCasilla('cta_1', 'selShort', 0);

    expect(usarPanel.getState().contarSeleccion()).toBe(0);
    expect(objetivos()).toHaveLength(0);
  });

  /*
   * El fallo original, dicho como se ve desde la pantalla: nunca puede quedar
   * media columna marcada, asi que nunca sale una punta sola donde se pidio el
   * par. Se comprueba sobre las seis columnas.
   */
  it('ninguna secuencia de clics deja media columna marcada', () => {
    for (const cuenta of CUENTAS) {
      cuenta.subAccounts.forEach((_, i) => {
        usarPanel.getState().alternarCasilla(cuenta.id, i % 2 === 0 ? 'selLong' : 'selShort', i);
      });
    }

    for (const cuenta of CUENTAS) {
      const sel = usarPanel.getState().seleccion[cuenta.id];
      expect(sel?.selLong).toEqual(sel?.selShort);
    }
    expect(usarPanel.getState().contarSeleccion() % 2).toBe(0);
  });
});

describe('«Long» y «Short»: el lado que no se opera no se puede marcar', () => {
  it('con el alcance en Long, la fila SHORT no responde', () => {
    usarPanel.getState().fijarAlcance('long');

    usarPanel.getState().alternarCasilla('cta_1', 'selShort', 0);

    expect(usarPanel.getState().seleccion['cta_1']?.selShort[0] ?? false).toBe(false);
    expect(usarPanel.getState().contarSeleccion()).toBe(0);
  });

  it('con el alcance en Short, la fila LONG no responde', () => {
    usarPanel.getState().fijarAlcance('short');

    usarPanel.getState().alternarCasilla('cta_1', 'selLong', 0);

    expect(usarPanel.getState().contarSeleccion()).toBe(0);
  });

  it('en Long, cada casilla marcada es una sola orden', () => {
    usarPanel.getState().fijarAlcance('long');

    usarPanel.getState().alternarCasilla('cta_1', 'selLong', 1);

    expect(objetivos()).toEqual([{ subAccountId: 'cta_1_sub_2', side: 'long' }]);
  });
});

describe('cambiar de alcance reconcilia lo ya marcado', () => {
  /*
   * La orden doble que aparecia sola. Con el alcance en Long se marcaban por
   * dentro las short, que el recuento no enseñaba; volver a «Ambos» las
   * despertaba. Ahora al pasar a Long se destildan, y lo que quede al volver
   * sale del par de las columnas que siguen marcadas -no de un residuo-.
   */
  it('pasar a Long destilda las short, y no reaparecen solas', () => {
    usarPanel.getState().seleccionarTodo();
    expect(usarPanel.getState().contarSeleccion()).toBe(12);

    usarPanel.getState().fijarAlcance('long');
    expect(usarPanel.getState().contarSeleccion()).toBe(6);
    for (const cuenta of CUENTAS) {
      expect(usarPanel.getState().seleccion[cuenta.id]?.selShort).toEqual([false, false, false]);
    }

    /* Se deja una sola columna y se vuelve a «Ambos». */
    usarPanel.getState().limpiarSeleccion();
    usarPanel.getState().alternarCasilla('cta_1', 'selLong', 0);
    usarPanel.getState().fijarAlcance('ambos');

    expect(objetivos()).toEqual([
      { subAccountId: 'cta_1_sub_1', side: 'long' },
      { subAccountId: 'cta_1_sub_1', side: 'short' }
    ]);
  });

  it('«Todas» marca solo el lado del alcance', () => {
    usarPanel.getState().fijarAlcance('short');
    usarPanel.getState().seleccionarTodo();

    expect(usarPanel.getState().contarSeleccion()).toBe(6);
    expect(objetivos().every((o) => o.side === 'short')).toBe(true);
    for (const cuenta of CUENTAS) {
      expect(usarPanel.getState().seleccion[cuenta.id]?.selLong).toEqual([false, false, false]);
    }
  });

  it('«Todas» de una cuenta, en Ambos, marca sus dos filas y se deshace entera', () => {
    usarPanel.getState().alternarCuenta('cta_1');
    expect(usarPanel.getState().contarSeleccion()).toBe(6);

    usarPanel.getState().alternarCuenta('cta_1');
    expect(usarPanel.getState().contarSeleccion()).toBe(0);
  });

  it('«Todas» de una cuenta, en Long, se da por cumplido sin mirar las short', () => {
    usarPanel.getState().fijarAlcance('long');

    usarPanel.getState().alternarCuenta('cta_1');
    expect(usarPanel.getState().contarSeleccion()).toBe(3);

    /* Segunda pulsacion: si mirara las short -vacias- volveria a marcarlo todo. */
    usarPanel.getState().alternarCuenta('cta_1');
    expect(usarPanel.getState().contarSeleccion()).toBe(0);
  });
});
