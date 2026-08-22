/**
 * El flujo de dos fases de la pantalla.
 *
 * --------------------------------------------------------------------------
 * Que se prueba aqui y por que importa
 * --------------------------------------------------------------------------
 * El motor ya garantiza que no se duplica una posicion. Esta suite comprueba lo
 * otro: que **la pantalla no envie nada que el operador no haya aprobado**. Es
 * la mitad de la promesa del contrato que vive en el renderer, y es la que se
 * rompe con un `await` mal puesto sin que ninguna prueba del backend se entere.
 *
 * Cuatro invariantes:
 *
 *   1. Planificar no envia.
 *   2. Cancelar no envia.
 *   3. Sin la contrasena de paso, la apertura no envia.
 *   4. Reintentar reenvia el **mismo plan** -mismos identificadores de orden- y
 *      deja fuera lo indeterminado.
 *
 * El servicio se sustituye por uno de mentira que apunta cada llamada, de modo
 * que «no envio nada» se comprueba contando envios, no confiando en que no los
 * haya.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BatchPlan, BatchResult, BatchTarget } from '@shared/domain/panel-view';

/* ---------- servicio de mentira, con contador de envios ---------- */

const enviados: { planId: string; only: BatchTarget[] | undefined }[] = [];
let planificaciones = 0;
let resultado: BatchResult;
let pasoValido = true;
let planDevuelto: BatchPlan;

const plan = (kind: BatchPlan['kind'], entradas: number): BatchPlan => ({
  kind,
  id: `plan_${kind}`,
  title: 'Prueba',
  summary: 'resumen',
  reference: '100',
  entries: Array.from({ length: entradas }, (_, i) => ({
    subAccountId: `sub_${i + 1}`,
    side: 'long' as const,
    label: `Sub-0${i + 1}`,
    detail: '0.01'
  })),
  discards: []
});

vi.mock('@/services/panel-service', () => ({
  panelService: {
    getSystemInfo: async () => ({ appVersion: '1.0.0', panelNumber: 1, portable: true }),
    listAssets: async () => [
      { id: 'BTC', symbol: 'BTCUSDT', label: 'BTC/USDT', priceDecimals: 1, maxLeverage: 150, minLeverage: 1, tradable: true },
      { id: 'PEPE', symbol: 'PEPEUSDT', label: 'PEPE/USDT', priceDecimals: 8, maxLeverage: 75, minLeverage: 1, tradable: true }
    ],
    subscribeAssetPrices: () => () => undefined,
    planOpen: async () => {
      planificaciones += 1;
      return planDevuelto;
    },
    planClose: async () => {
      planificaciones += 1;
      return planDevuelto;
    },
    planTakeProfit: async () => {
      planificaciones += 1;
      return planDevuelto;
    },
    planRemoveTakeProfit: async () => {
      planificaciones += 1;
      return planDevuelto;
    },
    planMargin: async () => {
      planificaciones += 1;
      return planDevuelto;
    },
    planLeverage: async () => {
      planificaciones += 1;
      return planDevuelto;
    },
    executePlan: async (p: BatchPlan, only?: BatchTarget[]) => {
      enviados.push({ planId: p.id, only });
      return resultado;
    },
    verifyStepPassword: async () => pasoValido
  }
}));

/*
 * El store lee el tema de `localStorage` al construirse. No hace falta un DOM
 * entero para probar la logica de planes: basta con las dos piezas que toca,
 * definidas antes de importarlo.
 */
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

const CUENTAS = [
  {
    id: 'cta_1',
    name: 'A',
    subAccounts: [1, 2, 3].map((n) => ({
      id: `sub_${n}`,
      accountId: 'cta_1',
      label: `Sub-0${n}`,
      slot: n,
      balance: '1000',
      status: 'ok' as const,
      statusReason: null
    }))
  }
];

/** Deja el store con tres casillas long marcadas y un activo elegido. */
function prepararSeleccion(): void {
  usarPanel.setState({
    cuentas: CUENTAS,
    activoId: 'BTC',
    activos: [
      { id: 'BTC', symbol: 'BTCUSDT', label: 'BTC/USDT', priceDecimals: 1, maxLeverage: 150, minLeverage: 1, tradable: true }
    ],
    alcance: 'long',
    seleccion: {
      cta_1: {
        selLong: [true, true, true],
        selShort: [false, false, false]
      }
    },
    valores: { tp: '35', mgi: '100', mga: '50', ap: '10' }
  });
}

beforeEach(() => {
  enviados.length = 0;
  planificaciones = 0;
  pasoValido = true;
  planDevuelto = plan('open', 3);
  resultado = { label: 'Prueba', ok: 3, skipped: 0, failures: [], undetermined: [] };
  usarPanel.setState({ plan: null, batch: null, cola: [], pinPaso: '', errorPaso: '', intentosPaso: 0, avisos: [] });
  prepararSeleccion();
});

describe('planificar no envía', () => {
  it('deja el plan en pantalla sin mandar nada a Bitget', async () => {
    await usarPanel.getState().planear('open');

    expect(planificaciones).toBe(1);
    expect(enviados).toHaveLength(0);
    expect(usarPanel.getState().plan?.id).toBe('plan_open');
  });

  it('cancelar el plan no envía nada y lo borra', async () => {
    await usarPanel.getState().planear('open');
    usarPanel.getState().cancelarPlan();

    expect(enviados).toHaveLength(0);
    expect(usarPanel.getState().plan).toBeNull();
  });

  /* Sin casillas marcadas no se gasta ni una consulta de precios. */
  it('sin selección no se planifica siquiera', async () => {
    usarPanel.setState({ seleccion: {} });

    await usarPanel.getState().planear('open');

    expect(planificaciones).toBe(0);
    expect(enviados).toHaveLength(0);
  });

  /*
   * Un plan donde ninguna casilla es viable no se enseña como plan: seria un
   * diálogo vacio con un boton que no haria nada. Se dice el motivo.
   */
  it('un plan sin casillas viables no abre el diálogo', async () => {
    planDevuelto = {
      ...plan('close', 0),
      discards: [{ subAccountId: 'sub_1', side: 'long', label: 'Sub-01', reason: 'No hay posición.' }]
    };

    await usarPanel.getState().planear('close');

    expect(usarPanel.getState().plan).toBeNull();
    expect(usarPanel.getState().avisos.at(-1)?.cuerpo).toContain('No hay posición');
  });
});

describe('la contraseña de paso, en la apertura', () => {
  it('con la contraseña correcta se envía el plan aprobado', async () => {
    await usarPanel.getState().planear('open');
    usarPanel.getState().escribirPin('bg1');
    await usarPanel.getState().confirmarPlan();

    expect(enviados).toEqual([{ planId: 'plan_open', only: undefined }]);
  });

  it('con la contraseña incorrecta no sale ninguna orden', async () => {
    pasoValido = false;

    await usarPanel.getState().planear('open');
    usarPanel.getState().escribirPin('mal');
    await usarPanel.getState().confirmarPlan();

    expect(enviados).toHaveLength(0);
    expect(usarPanel.getState().plan).not.toBeNull();
    expect(usarPanel.getState().errorPaso).toContain('Intento 1');
  });

  /* Tres intentos cancelan la operación entera, sin haber enviado nada. */
  it('al tercer intento fallido se cancela sin enviar', async () => {
    pasoValido = false;
    await usarPanel.getState().planear('open');

    for (let i = 0; i < 3; i += 1) {
      usarPanel.getState().escribirPin('mal');
      await usarPanel.getState().confirmarPlan();
    }

    expect(enviados).toHaveLength(0);
    expect(usarPanel.getState().plan).toBeNull();
  });

  /*
   * Las otras cinco operaciones se aprueban con el plan a la vista y no piden
   * contraseña: solo la apertura compromete dinero nuevo (docs/04 W-09).
   */
  it('cerrar no pide contraseña de paso', async () => {
    pasoValido = false;
    planDevuelto = plan('close', 2);

    await usarPanel.getState().planear('close');
    await usarPanel.getState().confirmarPlan();

    expect(enviados).toEqual([{ planId: 'plan_close', only: undefined }]);
  });
});

describe('reintentar solo las fallidas', () => {
  it('reenvía el mismo plan acotado a lo que falló', async () => {
    planDevuelto = plan('close', 3);
    resultado = {
      label: 'Prueba',
      ok: 2,
      skipped: 0,
      failures: [{ subAccountId: 'sub_3', side: 'long', reason: 'Bitget rechazó la orden.' }],
      undetermined: []
    };

    await usarPanel.getState().planear('close');
    await usarPanel.getState().confirmarPlan();
    await usarPanel.getState().reintentarFallidas?.();

    expect(enviados).toHaveLength(2);
    /* El mismo plan: mismos identificadores de orden, y por eso no duplica. */
    expect(enviados[1]?.planId).toBe('plan_close');
    expect(enviados[1]?.only).toEqual([{ subAccountId: 'sub_3', side: 'long' }]);
  });

  /*
   * Lo indeterminado es lo unico que puede duplicar si se reenvia a ciegas: se
   * envio, no llego respuesta y no se pudo averiguar que paso. No hay boton.
   */
  it('lo indeterminado no ofrece reintento', async () => {
    planDevuelto = plan('close', 2);
    resultado = {
      label: 'Prueba',
      ok: 1,
      skipped: 0,
      failures: [],
      undetermined: [{ subAccountId: 'sub_2', side: 'long', reason: 'Se cortó la conexión.' }]
    };

    await usarPanel.getState().planear('close');
    await usarPanel.getState().confirmarPlan();

    expect(usarPanel.getState().reintentarFallidas).toBeNull();
    expect(usarPanel.getState().avisos.at(-1)?.cuerpo).toContain('duplicarlas');
  });

  it('sin fallos no hay nada que reintentar', async () => {
    planDevuelto = plan('close', 3);

    await usarPanel.getState().planear('close');
    await usarPanel.getState().confirmarPlan();

    expect(usarPanel.getState().reintentarFallidas).toBeNull();
  });
});

describe('el apalancamiento por defecto', () => {
  /*
   * El cliente opera siempre al maximo de cada activo y son topes distintos.
   * El campo lo propone solo, leido del catalogo de Bitget.
   */
  it('cambiar de activo pone el máximo de ese activo', () => {
    usarPanel.setState({
      valoresFijos: false,
      activos: [
        { id: 'BTC', symbol: 'BTCUSDT', label: 'BTC/USDT', priceDecimals: 1, maxLeverage: 150, minLeverage: 1, tradable: true },
        { id: 'PEPE', symbol: 'PEPEUSDT', label: 'PEPE/USDT', priceDecimals: 8, maxLeverage: 75, minLeverage: 1, tradable: true }
      ]
    });

    usarPanel.getState().fijarActivo('PEPE');
    expect(usarPanel.getState().valores.ap).toBe('75');

    usarPanel.getState().fijarActivo('BTC');
    expect(usarPanel.getState().valores.ap).toBe('150');
  });

  /* «Valores fijos» significa «no me cambies lo que escribí». */
  it('con valores fijos no se toca lo que el operador escribió', () => {
    usarPanel.setState({
      valoresFijos: true,
      valores: { tp: '35', mgi: '100', mga: '50', ap: '12' },
      activos: [
        { id: 'PEPE', symbol: 'PEPEUSDT', label: 'PEPE/USDT', priceDecimals: 8, maxLeverage: 75, minLeverage: 1, tradable: true }
      ]
    });

    usarPanel.getState().fijarActivo('PEPE');

    expect(usarPanel.getState().valores.ap).toBe('12');
  });
});

describe('un activo suspendido', () => {
  it('no se planifica sobre un contrato que Bitget tiene parado', async () => {
    usarPanel.setState({
      activos: [
        { id: 'BTC', symbol: 'BTCUSDT', label: 'BTC/USDT', priceDecimals: 1, maxLeverage: 150, minLeverage: 1, tradable: false }
      ]
    });

    await usarPanel.getState().planear('open');

    expect(planificaciones).toBe(0);
    expect(enviados).toHaveLength(0);
  });
});
