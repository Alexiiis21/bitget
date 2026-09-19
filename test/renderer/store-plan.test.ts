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
 *   3. Sin la contrasena de paso, ni la apertura ni el cierre envian.
 *   4. Reintentar reenvia el **mismo plan** -mismos identificadores de orden- y
 *      deja fuera lo indeterminado.
 *
 * El servicio se sustituye por uno de mentira que apunta cada llamada, de modo
 * que «no envio nada» se comprueba contando envios, no confiando en que no los
 * haya.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BatchPlan,
  BatchResult,
  BatchTarget,
  MarginRequest,
  OpenRequest,
  TpRequest
} from '@shared/domain/panel-view';

/* ---------- servicio de mentira, con contador de envios ---------- */

const enviados: { planId: string; only: BatchTarget[] | undefined }[] = [];
let planificaciones = 0;
/** La ultima peticion de apertura, para comprobar que viaja lo que se eligio. */
let ultimaApertura: OpenRequest | null = null;
/** Lo mismo para los dos ajustes sobre una posicion ya abierta. */
let ultimoTp: TpRequest | null = null;
let ultimoMargen: MarginRequest | null = null;
let resultado: BatchResult;
let pasoValido = true;
let planDevuelto: BatchPlan;
/** Cuando no es `null`, `executePlan` revienta en vez de devolver informe. */
let falloAlEnviar: Error | null = null;

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
  discards: [],
  blocker: null
});

/*
 * El sonido se espia en vez de sonar.
 *
 * En `environment: 'node'` no existe `Audio` y el modulo real es un no-op, asi
 * que sin este doble no habria forma de comprobar **cuando** se dispara, que es
 * lo unico que puede romperse sin que nadie se entere: el operador que no lo
 * oye no sabe si es el panel o su equipo.
 */
const sonidos = vi.fn();
vi.mock('@/lib/sonido', () => ({
  reproducirCajaRegistradora: () => sonidos()
}));

vi.mock('@/services/panel-service', () => ({
  panelService: {
    getSystemInfo: async () => ({ appVersion: '1.0.0', panelNumber: 1, portable: true }),
    listAssetSlots: async () => [
      { id: 'BTC', symbol: 'BTCUSDT', label: 'BTC/USDT', priceDecimals: 1, maxLeverage: 150, minLeverage: 1, tradable: true },
      { id: 'PEPE', symbol: 'PEPEUSDT', label: 'PEPE/USDT', priceDecimals: 8, maxLeverage: 75, minLeverage: 1, tradable: true },
      null
    ],
    subscribeAssetPrices: () => () => undefined,
    planOpen: async (req: OpenRequest) => {
      planificaciones += 1;
      ultimaApertura = req;
      return planDevuelto;
    },
    planClose: async () => {
      planificaciones += 1;
      return planDevuelto;
    },
    planTakeProfit: async (req: TpRequest) => {
      planificaciones += 1;
      ultimoTp = req;
      return planDevuelto;
    },
    planRemoveTakeProfit: async () => {
      planificaciones += 1;
      return planDevuelto;
    },
    /*
     * Guarda la peticion entera porque lo que se comprueba de ella no es que se
     * llame, sino **con que**: la cantidad sin signo y la direccion que
     * corresponde al boton pulsado.
     */
    planMargin: async (req: MarginRequest) => {
      planificaciones += 1;
      ultimoMargen = req;
      return planDevuelto;
    },
    planLeverage: async () => {
      planificaciones += 1;
      return planDevuelto;
    },
    executePlan: async (p: BatchPlan, only?: BatchTarget[]) => {
      enviados.push({ planId: p.id, only });
      if (falloAlEnviar !== null) throw falloAlEnviar;
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
    valores: { tp: '35', mgi: '100', mga: '50', ap: '10', tpAjuste: '', mgAjuste: '' }
  });
}

beforeEach(() => {
  enviados.length = 0;
  planificaciones = 0;
  ultimaApertura = null;
  ultimoTp = null;
  ultimoMargen = null;
  usarPanel.setState({ modoMargen: 'isolated' });
  pasoValido = true;
  falloAlEnviar = null;
  planDevuelto = plan('open', 3);
  sonidos.mockClear();
  resultado = { label: 'Prueba', ok: 3, skipped: 0, failures: [], undetermined: [] };
  usarPanel.setState({ plan: null, batch: null, pinPaso: '', errorPaso: '', intentosPaso: 0, avisos: [] });
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

describe('la contraseña de paso, al abrir y al cerrar', () => {
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
   * Cerrar tambien la pide, desde el 26/08/2026. No compromete dinero nuevo,
   * pero realiza el resultado: convierte en definitiva una perdida abierta, y
   * un cierre equivocado no se deshace pulsando otra vez -se vuelve a abrir a
   * otro precio, y esa diferencia es el coste del error-.
   */
  it('sin la contraseña correcta, cerrar no envía ninguna orden', async () => {
    pasoValido = false;
    planDevuelto = plan('close', 2);

    await usarPanel.getState().planear('close');
    usarPanel.getState().escribirPin('mal');
    await usarPanel.getState().confirmarPlan();

    expect(enviados).toHaveLength(0);
    expect(usarPanel.getState().plan).not.toBeNull();
    expect(usarPanel.getState().errorPaso).toContain('Intento 1');
  });

  it('con la contraseña correcta, cerrar envía el plan aprobado', async () => {
    planDevuelto = plan('close', 2);

    await usarPanel.getState().planear('close');
    usarPanel.getState().escribirPin('bg1');
    await usarPanel.getState().confirmarPlan();

    expect(enviados).toEqual([{ planId: 'plan_close', only: undefined }]);
  });

  it('al tercer intento fallido, el cierre se cancela sin enviar', async () => {
    pasoValido = false;
    planDevuelto = plan('close', 2);
    await usarPanel.getState().planear('close');

    for (let i = 0; i < 3; i += 1) {
      usarPanel.getState().escribirPin('mal');
      await usarPanel.getState().confirmarPlan();
    }

    expect(enviados).toHaveLength(0);
    expect(usarPanel.getState().plan).toBeNull();
  });

  /*
   * Las otras dos no la piden: quitar el Take Profit y fijar el apalancamiento
   * no realizan ningun resultado, y pedirla en cada ajuste la convertiria en un
   * tramite que se teclea sin leer.
   */
  it('el apalancamiento no pide contraseña de paso', async () => {
    pasoValido = false;
    planDevuelto = plan('leverage', 2);

    await usarPanel.getState().planear('leverage');
    await usarPanel.getState().confirmarPlan();

    expect(enviados).toEqual([{ planId: 'plan_leverage', only: undefined }]);
  });
});

/*
 * ==========================================================================
 * Un plan impedido no llega a enviarse.
 * ==========================================================================
 * Lo pidió el cliente el 29/08/2026: si a alguna casilla no le cabe el margen
 * adicional, no se abre ninguna, y el motivo sale en la confirmación **antes**
 * de teclear la contraseña, para que el operador corrija los importes, añada
 * saldo o desmarque las casillas afectadas.
 *
 * El freno que de verdad cuenta está en el proceso principal —él rechaza el
 * plan al ejecutarlo—; lo que se prueba aquí es que la pantalla no llega
 * siquiera a pedirlo, que es lo que el cliente ve.
 */
describe('un plan impedido', () => {
  const impedido = (entradas: number) => ({
    ...plan('open', entradas),
    blocker: {
      code: 'saldo-margen-adicional',
      message: 'No se abre ninguna posición: a 2 casillas no les cabe el margen adicional.',
      boxes: 2
    }
  });

  it('no envía nada aunque se confirme', async () => {
    planDevuelto = impedido(3);

    await usarPanel.getState().planear('open');
    usarPanel.getState().escribirPin('bg1');
    await usarPanel.getState().confirmarPlan();

    expect(enviados).toHaveLength(0);
    /* El diálogo sigue abierto con el motivo: no se cierra dejando al operador sin saber. */
    expect(usarPanel.getState().plan).not.toBeNull();
    expect(usarPanel.getState().errorPaso).toContain('No se abre ninguna posición');
  });

  /*
   * Ni siquiera se comprueba la contraseña. Teclearla para que despues se
   * rechace el envio seria un tramite cuyo unico desenlace posible es un error.
   */
  it('no gasta un intento de contraseña de paso', async () => {
    planDevuelto = impedido(3);
    pasoValido = false;

    await usarPanel.getState().planear('open');
    usarPanel.getState().escribirPin('mal');
    await usarPanel.getState().confirmarPlan();

    expect(usarPanel.getState().intentosPaso).toBe(0);
  });

  /*
   * Con cero casillas viables el diálogo normalmente ni se abre —sería una
   * lista vacía—. Impedido sí se abre: es donde el cliente quiere leer el
   * motivo y ver, casilla a casilla, cuáles van cortas.
   */
  it('se enseña aunque no quede ninguna casilla viable', async () => {
    planDevuelto = impedido(0);

    await usarPanel.getState().planear('open');

    expect(usarPanel.getState().plan?.blocker?.code).toBe('saldo-margen-adicional');
  });

  /* Sin impedimento, cero casillas sigue sin abrir diálogo: no ha cambiado nada. */
  it('sin impedimento, cero casillas sigue sin abrir el diálogo', async () => {
    planDevuelto = { ...plan('open', 0), discards: [{ subAccountId: 'sub_1', side: 'long', label: 'Sub-01', reason: 'Saldo insuficiente.' }] };

    await usarPanel.getState().planear('open');

    expect(usarPanel.getState().plan).toBeNull();
    expect(usarPanel.getState().avisos.at(-1)?.cuerpo).toContain('Saldo insuficiente');
  });
});

/*
 * ==========================================================================
 * La selección se deshace sola tras abrir y tras cerrar.
 * ==========================================================================
 * Lo pidió el cliente -primero para abrir, y el 11/09/2026 para cerrar, que se
 * había quedado fuera-. Evita un error concreto, y es el mismo en espejo: tras
 * abrir esas casillas tienen posición y la siguiente acción caería sobre ellas;
 * tras cerrar están vacías, y la siguiente apertura abriría cuarenta posiciones
 * que nadie pidió. Destildar cuarenta a mano es justamente lo que nadie hace.
 *
 * Las otras cinco conservan la selección: encadenar dos ajustes sobre las
 * mismas casillas es un uso legítimo.
 */
describe('desmarcar tras abrir y tras cerrar', () => {
  it('tras abrir, no queda ninguna casilla marcada', async () => {
    expect(usarPanel.getState().contarSeleccion()).toBe(3);

    await usarPanel.getState().planear('open');
    usarPanel.getState().escribirPin('bg1');
    await usarPanel.getState().confirmarPlan();

    expect(enviados).toHaveLength(1);
    expect(usarPanel.getState().contarSeleccion()).toBe(0);
  });

  it('tras cerrar, no queda ninguna casilla marcada', async () => {
    planDevuelto = plan('close', 3);

    await usarPanel.getState().planear('close');
    usarPanel.getState().escribirPin('bg1');
    await usarPanel.getState().confirmarPlan();

    expect(enviados).toHaveLength(1);
    expect(usarPanel.getState().contarSeleccion()).toBe(0);
  });

  /*
   * Un lote a medias desmarca igual, y es una decisión, no un descuido.
   *
   * `BatchResult` no sabe cuáles salieron bien -`ok` y `skipped` son recuentos
   * sin identidad-, así que desmarcar solo esas sería adivinar. Las fallidas se
   * recuperan con «Reintentar solo las fallidas», que se alimenta del informe y
   * no de la selección: por eso se comprueba aquí que el botón existe.
   */
  it('un cierre a medias también desmarca del todo', async () => {
    planDevuelto = plan('close', 3);
    resultado = {
      label: 'Prueba',
      ok: 2,
      skipped: 0,
      failures: [
        { subAccountId: 'sub_3', side: 'long', reason: 'Bitget rechazó la orden.', retryable: true }
      ],
      undetermined: []
    };

    await usarPanel.getState().planear('close');
    usarPanel.getState().escribirPin('bg1');
    await usarPanel.getState().confirmarPlan();

    expect(usarPanel.getState().contarSeleccion()).toBe(0);
    expect(usarPanel.getState().reintentarFallidas).not.toBeNull();
  });

  /*
   * Con casillas sin confirmar, también. Se enviaron y no se sabe qué pasó: una
   * casilla que se quedara tildada es una invitación a actuar otra vez sobre una
   * posición de estado desconocido, que es justo lo que el aviso prohíbe.
   */
  it('un cierre con casillas sin confirmar también desmarca', async () => {
    planDevuelto = plan('close', 3);
    resultado = {
      label: 'Prueba',
      ok: 2,
      skipped: 0,
      failures: [],
      undetermined: [
        { subAccountId: 'sub_3', side: 'long', reason: 'Se cortó la conexión.', retryable: false }
      ]
    };

    await usarPanel.getState().planear('close');
    usarPanel.getState().escribirPin('bg1');
    await usarPanel.getState().confirmarPlan();

    expect(usarPanel.getState().contarSeleccion()).toBe(0);
    expect(usarPanel.getState().avisos.at(-1)?.titulo).toContain('sin confirmar');
  });

  /*
   * Las cinco que conservan. Es el guardarraíl de `DESMARCA_TRAS`: si alguien la
   * amplía sin querer, cae aquí y no en producción.
   */
  it.each<BatchPlan['kind']>(['tp', 'tp-remove', 'margin-add', 'margin-remove', 'leverage'])(
    'tras «%s» la selección se conserva',
    async (kind) => {
      planDevuelto = plan(kind, 3);
      /*
       * Los ajustes con campo propio no se planifican si está vacío -`CAMPO_DE`
       * en el store-, y el fixture los deja así. Sin esto el test pasaría sin
       * haber enviado nada, que es la peor forma de pasar.
       */
      usarPanel.setState((s) => ({ valores: { ...s.valores, tpAjuste: '20', mgAjuste: '5' } }));

      await usarPanel.getState().planear(kind);
      await usarPanel.getState().confirmarPlan();

      expect(enviados).toHaveLength(1);
      expect(usarPanel.getState().contarSeleccion()).toBe(3);
    }
  );

  /*
   * Si el envío revienta -el proceso principal no responde-, la selección se
   * queda. Es lo único con lo que el operador puede repetir: sin informe no hay
   * «Reintentar las fallidas» al que agarrarse.
   */
  it('si el envío falla, la selección no se toca', async () => {
    falloAlEnviar = new Error('el panel no responde');

    await usarPanel.getState().planear('open');
    usarPanel.getState().escribirPin('bg1');
    await usarPanel.getState().confirmarPlan();

    expect(usarPanel.getState().contarSeleccion()).toBe(3);
    expect(usarPanel.getState().avisos.at(-1)?.titulo).toContain('No se pudo enviar');
  });

  it('si el cierre no llega a enviarse, la selección tampoco se toca', async () => {
    planDevuelto = plan('close', 3);
    falloAlEnviar = new Error('el panel no responde');

    await usarPanel.getState().planear('close');
    usarPanel.getState().escribirPin('bg1');
    await usarPanel.getState().confirmarPlan();

    expect(usarPanel.getState().contarSeleccion()).toBe(3);
    expect(usarPanel.getState().avisos.at(-1)?.titulo).toContain('No se pudo enviar');
  });
});

describe('reintentar solo las fallidas', () => {
  it('reenvía el mismo plan acotado a lo que falló', async () => {
    planDevuelto = plan('close', 3);
    resultado = {
      label: 'Prueba',
      ok: 2,
      skipped: 0,
      failures: [{ subAccountId: 'sub_3', side: 'long', reason: 'Bitget rechazó la orden.', retryable: true }],
      undetermined: []
    };

    await usarPanel.getState().planear('close');
    await usarPanel.getState().confirmarPlan();

    /*
     * El cierre ya desmarcó. El reintento tiene que funcionar igual: se alimenta
     * de `failures`, no de las casillas tildadas. Si algún día dependiera de la
     * selección, este es el test que lo delata.
     */
    expect(usarPanel.getState().contarSeleccion()).toBe(0);

    await usarPanel.getState().reintentarFallidas?.();

    expect(enviados).toHaveLength(2);
    /* El mismo plan: mismos identificadores de orden, y por eso no duplica. */
    expect(enviados[1]?.planId).toBe('plan_close');
    expect(enviados[1]?.only).toEqual([{ subAccountId: 'sub_3', side: 'long' }]);
    expect(usarPanel.getState().contarSeleccion()).toBe(0);
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
      undetermined: [{ subAccountId: 'sub_2', side: 'long', reason: 'Se cortó la conexión.', retryable: false }]
    };

    await usarPanel.getState().planear('close');
    await usarPanel.getState().confirmarPlan();

    expect(usarPanel.getState().reintentarFallidas).toBeNull();
    expect(usarPanel.getState().avisos.at(-1)?.cuerpo).toContain('duplicarlas');
  });

  /*
   * El fallo del 26/08/2026, por el otro lado.
   *
   * El informe de una apertura trae hasta tres filas por casilla -la orden, su
   * Take Profit y su margen- y las tres llevan el mismo `subAccountId` y el
   * mismo `side`. Como el reintento se pide por cuenta y lado, un Take Profit
   * fallido metia **la apertura entera** en la lista: al reenviarla se volvia a
   * colocar el Take Profit con un plan nuevo y `clientOid` nuevos, de modo que
   * el identificador ya no protegia de nada y la posicion acababa con dos.
   *
   * Las filas derivadas se siguen enseñando -el operador tiene que saber que su
   * posicion quedo desprotegida- pero no se reenvian desde aqui.
   */
  it('una fila derivada de la apertura se enseña pero no se reintenta', async () => {
    planDevuelto = plan('open', 1);
    resultado = {
      label: 'Prueba',
      ok: 1,
      skipped: 0,
      failures: [
        {
          subAccountId: 'sub_1',
          side: 'long',
          reason: 'La posición quedó abierta SIN Take Profit.',
          retryable: false
        }
      ],
      undetermined: []
    };

    await usarPanel.getState().planear('open');
    usarPanel.getState().escribirPin('bg1');
    await usarPanel.getState().confirmarPlan();

    /* Se ve en el informe... */
    expect(usarPanel.getState().batch?.failures).toHaveLength(1);
    /* ...y no hay botón que la reenvíe. */
    expect(usarPanel.getState().reintentarFallidas).toBeNull();
  });

  /* Y la fila de la apertura en sí, que sí lleva su identificador, se reintenta. */
  it('la apertura fallida sí se reintenta, y sola', async () => {
    planDevuelto = plan('open', 2);
    resultado = {
      label: 'Prueba',
      ok: 1,
      skipped: 0,
      failures: [
        { subAccountId: 'sub_2', side: 'long', reason: 'Bitget rechazó la orden.', retryable: true },
        {
          subAccountId: 'sub_1',
          side: 'long',
          reason: 'La posición quedó abierta SIN el margen adicional.',
          retryable: false
        }
      ],
      undetermined: []
    };

    await usarPanel.getState().planear('open');
    usarPanel.getState().escribirPin('bg1');
    await usarPanel.getState().confirmarPlan();
    await usarPanel.getState().reintentarFallidas?.();

    expect(enviados).toHaveLength(2);
    /* Solo la casilla que falló de verdad: la derivada no arrastra a su apertura. */
    expect(enviados[1]?.only).toEqual([{ subAccountId: 'sub_2', side: 'long' }]);
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
      valores: { tp: '35', mgi: '100', mga: '50', ap: '12', tpAjuste: '', mgAjuste: '' },
      activos: [
        { id: 'PEPE', symbol: 'PEPEUSDT', label: 'PEPE/USDT', priceDecimals: 8, maxLeverage: 75, minLeverage: 1, tradable: true }
      ]
    });

    usarPanel.getState().fijarActivo('PEPE');

    expect(usarPanel.getState().valores.ap).toBe('12');
  });
});

/**
 * El modo de margen y el margen adicional, elegidos en la pantalla.
 *
 * El modo dejo de deducirse de la ficha de la cuenta el 26/08/2026: viaja
 * **dentro** de la orden, asi que abrir lo deja configurado en ese activo, y
 * deducirlo de un simbolo distinto del que se opera reconfiguraba activos en
 * silencio. Ahora lo dice el operador y sale con la peticion.
 */
describe('el modo de margen y el margen adicional', () => {
  it('viajan con la apertura tal como estan en la pantalla', async () => {
    usarPanel.setState({ modoMargen: 'isolated' });

    await usarPanel.getState().planear('open');

    expect(ultimaApertura?.marginMode).toBe('isolated');
    expect(ultimaApertura?.additionalMargin).toBe('50');
    expect(ultimaApertura?.takeProfitPercent).toBe('35');
  });

  it('sin margen adicional escrito, no viaja ninguno', async () => {
    usarPanel.setState({ valores: { tp: '35', mgi: '100', mga: '', ap: '10', tpAjuste: '', mgAjuste: '' } });

    await usarPanel.getState().planear('open');

    expect(ultimaApertura?.additionalMargin).toBeNull();
  });

  /*
   * Lo pidio el cliente el 25/08/2026: en cruzado Bitget no admite agregar
   * margen -lo toma del saldo total de la cuenta-, y abrir sin el margen que se
   * aprobo deja la posicion con menos colchon del que el operador cree. No se
   * planifica siquiera: ni una consulta de precios para llegar a esa respuesta.
   */
  it('en cruzado con margen adicional escrito, no se planifica nada', async () => {
    usarPanel.setState({ modoMargen: 'crossed' });

    await usarPanel.getState().planear('open');

    expect(planificaciones).toBe(0);
    expect(enviados).toHaveLength(0);
    expect(usarPanel.getState().plan).toBeNull();
    expect(usarPanel.getState().avisos.at(-1)?.cuerpo).toContain('cruzado');
  });

  it('en cruzado sin margen adicional, la apertura sigue su curso', async () => {
    usarPanel.setState({
      modoMargen: 'crossed',
      valores: { tp: '35', mgi: '100', mga: '', ap: '10', tpAjuste: '', mgAjuste: '' }
    });

    await usarPanel.getState().planear('open');

    expect(planificaciones).toBe(1);
    expect(ultimaApertura?.marginMode).toBe('crossed');
  });

  /*
   * Y no queda forma de reenviarlos por descuido.
   *
   * Tras abrir, los tres campos que salieron con la orden se vacian. Si se
   * quedaran escritos, la siguiente apertura sobre las mismas casillas
   * repetiria el Take Profit y volveria a comprometer el mismo margen.
   */
  it('tras abrir, los tres valores que salieron con la orden se vacían', async () => {
    usarPanel.setState({ valoresFijos: false });

    await usarPanel.getState().planear('open');
    usarPanel.getState().escribirPin('bg1');
    await usarPanel.getState().confirmarPlan();

    const { valores } = usarPanel.getState();
    expect(valores.tp).toBe('');
    expect(valores.mgi).toBe('');
    expect(valores.mga).toBe('');
    /* El apalancamiento no: el operador repite el mismo y no salió con la orden. */
    expect(valores.ap).toBe('10');
  });
});

/*
 * ---------------------------------------------------------------------------
 * Ajustar una posicion ya abierta
 * ---------------------------------------------------------------------------
 * Las tres operaciones volvieron el 01/09/2026, y lo que se prueba aqui es
 * justamente lo que faltaba la primera vez: que **no lean los campos de la
 * apertura**. Ese era el mecanismo de la incidencia del 26/08/2026 -el importe
 * salia con la orden, se quedaba escrito y el boton de al lado lo reenviaba-, y
 * es un fallo que solo se ve desde el store: mas abajo, las dos peticiones son
 * identicas.
 */
describe('los ajustes sobre lo ya abierto no tocan los campos de la apertura', () => {
  it('«Poner Take Profit» usa tpAjuste, no el tp que sale al abrir', async () => {
    planDevuelto = plan('tp', 3);
    usarPanel.setState((s) => ({ valores: { ...s.valores, tp: '35', tpAjuste: '12' } }));

    await usarPanel.getState().planear('tp');

    expect(ultimoTp?.percent).toBe('12');
  });

  it('«Agregar» y «Quitar» usan mgAjuste, y la dirección la pone el botón', async () => {
    planDevuelto = plan('margin-add', 3);
    usarPanel.setState((s) => ({ valores: { ...s.valores, mga: '50', mgAjuste: '7' } }));

    await usarPanel.getState().planear('margin-add');
    expect(ultimoMargen).toMatchObject({ amount: '7', direction: 'agregar' });

    planDevuelto = plan('margin-remove', 3);
    await usarPanel.getState().planear('margin-remove');
    expect(ultimoMargen).toMatchObject({ amount: '7', direction: 'quitar' });
  });

  /*
   * El signo no es un segundo mando.
   *
   * Con `-7` escrito y «Agregar» pulsado hay dos ordenes contradictorias, y la
   * unica respuesta segura es no planificar ninguna: el canal lo rechaza
   * igualmente, pero aqui se dice en castellano y sin gastar la consulta.
   */
  it('un importe con signo no se planifica', async () => {
    usarPanel.setState((s) => ({ valores: { ...s.valores, mgAjuste: '-7' } }));

    await usarPanel.getState().planear('margin-add');

    expect(planificaciones).toBe(0);
    expect(enviados).toHaveLength(0);
    expect(usarPanel.getState().avisos.at(-1)?.cuerpo).toContain('sin signo');
  });

  /* Tras aplicar un ajuste, su campo se vacia: no se hereda a la siguiente pulsacion. */
  it('tras mover margen, el campo del ajuste se vacía y el de la apertura no', async () => {
    planDevuelto = plan('margin-add', 3);
    usarPanel.setState({ valoresFijos: false });
    usarPanel.setState((s) => ({ valores: { ...s.valores, mga: '50', mgAjuste: '7' } }));

    await usarPanel.getState().planear('margin-add');
    await usarPanel.getState().confirmarPlan();

    const { valores } = usarPanel.getState();
    expect(valores.mgAjuste).toBe('');
    expect(valores.mga).toBe('50');
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

/*
 * ==========================================================================
 * El informe del lote anterior no sobrevive al siguiente.
 * ==========================================================================
 * La banda del resultado no es un modal: no bloquea nada, así que se puede
 * lanzar otro lote con ella en pantalla. Si el envío nuevo revienta, el `catch`
 * solo reponía `enviando` y `mensaje`, de modo que quedaban a la vez el aviso
 * «No se pudo enviar» y la banda del lote **anterior** con su botón de
 * reintentar activo, ligado por closure a aquel plan. Pulsarlo reenviaba el lote
 * de antes, sobre una casilla que el operador ya no estaba mirando.
 */
describe('el informe no sobrevive al lote siguiente', () => {
  /** Deja un informe con una fallida reintentable en pantalla. */
  async function dejarInformeConFallida(): Promise<void> {
    planDevuelto = plan('close', 3);
    resultado = {
      label: 'Lote A',
      ok: 2,
      skipped: 0,
      failures: [
        { subAccountId: 'sub_3', side: 'long', reason: 'Bitget rechazó la orden.', retryable: true }
      ],
      undetermined: []
    };

    await usarPanel.getState().planear('close');
    usarPanel.getState().escribirPin('bg1');
    await usarPanel.getState().confirmarPlan();
  }

  it('un lote nuevo que revienta no deja en pie el informe del anterior', async () => {
    await dejarInformeConFallida();
    expect(usarPanel.getState().batch?.label).toBe('Lote A');
    expect(usarPanel.getState().reintentarFallidas).not.toBeNull();

    /* Lote B, que no llega a salir. */
    prepararSeleccion();
    planDevuelto = plan('close', 3);
    falloAlEnviar = new Error('el panel no responde');

    await usarPanel.getState().planear('close');
    usarPanel.getState().escribirPin('bg1');
    await usarPanel.getState().confirmarPlan();

    expect(usarPanel.getState().batch).toBeNull();
    expect(usarPanel.getState().reintentarFallidas).toBeNull();
    expect(usarPanel.getState().avisos.at(-1)?.titulo).toContain('No se pudo enviar');
  });

  /*
   * El reintento es la excepción: tiene que conservar la lista de fallidas
   * visible hasta que salga bien. Si también la borrara, un reintento que
   * revienta dejaría al operador sin la lista de lo que le falta por cerrar.
   */
  it('un reintento que revienta sí conserva el informe', async () => {
    await dejarInformeConFallida();

    falloAlEnviar = new Error('el panel no responde');
    await usarPanel.getState().reintentarFallidas?.();

    expect(usarPanel.getState().batch?.label).toBe('Lote A');
    expect(usarPanel.getState().reintentarFallidas).not.toBeNull();
  });
});

/*
 * ==========================================================================
 * La caja registradora
 * ==========================================================================
 * Suena en el renderer y nadie puede verla en una captura, asi que la regla se
 * fija aqui: que lote suena y cual no. El cierre se anadio el 17/09/2026 a
 * peticion del cliente; hasta entonces solo sonaba la apertura.
 */
describe('el sonido de caja registradora', () => {
  /** Planifica, aprueba con la contrasena de paso y deja el informe puesto. */
  async function enviar(kind: BatchPlan['kind']): Promise<void> {
    planDevuelto = plan(kind, 2);
    await usarPanel.getState().planear(kind);
    usarPanel.getState().escribirPin('bg1');
    await usarPanel.getState().confirmarPlan();
  }

  it('suena cuando entra un lote de apertura', async () => {
    await enviar('open');

    expect(sonidos).toHaveBeenCalledTimes(1);
  });

  it('suena cuando entra un lote de cierre', async () => {
    await enviar('close');

    expect(sonidos).toHaveBeenCalledTimes(1);
  });

  /*
   * Un lote a medias movio dinero igual: diecisiete casillas dentro y tres
   * fuera siguen siendo diecisiete posiciones que no existian.
   */
  it('suena aunque el lote entre a medias', async () => {
    resultado = {
      label: 'Prueba',
      ok: 1,
      skipped: 0,
      failures: [
        {
          subAccountId: 'sub_2',
          side: 'long',
          reason: 'Saldo insuficiente',
          retryable: true
        }
      ],
      undetermined: []
    };

    await enviar('close');

    expect(sonidos).toHaveBeenCalledTimes(1);
  });

  /*
   * Cerrar una casilla que no tenia posicion vuelve como omitida, no como
   * correcta. Sonar ahi confirmaria un cierre que no ocurrio.
   */
  it('no suena si el cierre no cerro nada', async () => {
    resultado = { label: 'Prueba', ok: 0, skipped: 2, failures: [], undetermined: [] };

    await enviar('close');

    expect(sonidos).not.toHaveBeenCalled();
  });

  it('no suena al ajustar el Take Profit ni el apalancamiento', async () => {
    await enviar('tp');
    await enviar('leverage');

    expect(sonidos).not.toHaveBeenCalled();
  });
});
