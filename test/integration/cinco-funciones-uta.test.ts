/**
 * Las cinco funciones del panel sobre cuentas Classic y UTA a la vez.
 *
 * ==========================================================================
 * Lo que aqui se demuestra
 * ==========================================================================
 * Que el operador puede seleccionar casillas de los dos tipos, aprobar una sola
 * confirmacion y recibir **un solo informe con el resultado por cuenta** — que
 * es literalmente lo que pide la fase—. Y que el motor de lotes no sabe cual es
 * cual: no hay ni un `if` de superficie en `motor-lotes.ts`, la eleccion la hace
 * la capa de endpoints a partir de la credencial.
 *
 * Se prueba con un lote **mixto** en cada caso, no con dos lotes separados. Dos
 * lotes por separado pasarian aunque el enrutamiento estuviera roto en el lote
 * mixto, que es justo el escenario real.
 *
 * ==========================================================================
 * Advertencia sobre lo que estas pruebas NO demuestran
 * ==========================================================================
 * Que el panel habla con V3 como aqui se supone. Los nombres de parametro y las
 * rutas salen de la documentacion de Bitget, no de respuestas capturadas: el
 * exchange simulado contesta lo que le decimos que conteste. Estas pruebas fijan
 * la **traduccion** y el **enrutamiento**, que es lo que puede romperse por
 * dentro; que Bitget acepte esos cuerpos hay que comprobarlo contra una
 * subcuenta UTA real antes de operar con dinero.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MERCADO_SIMULADO } from '@main/bitget/mercado';
import { ClienteBitget } from '@main/bitget/rest/client';
import { abrirPosicion } from '@main/bitget/rest/endpoints/ordenes';
import { obtenerPosicionesV3 } from '@main/bitget/rest/endpoints/posiciones-v3';
import { colocarTakeProfitV3 } from '@main/bitget/rest/endpoints/tpsl-v3';
import { LimitadorPeticiones } from '@main/execution/rate-limiter';
import {
  MotorLotes,
  type CuentaEjecutable,
  type FuenteCuentas,
  type ObjetivoApertura
} from '@main/execution/motor-lotes';
import {
  iniciarExchangeSimulado,
  sobreError,
  sobreOk,
  type ExchangeSimulado,
  type PeticionRecibida,
  type Respuesta
} from '../mock-exchange/servidor';

const SIMBOLO = 'SBTCSUSDT';
const CLASICA = 'cta_v2';
const UTA = 'cta_v3';

const CONTRATO = {
  symbol: SIMBOLO,
  baseCoin: 'SBTC',
  quoteCoin: 'SUSDT',
  minTradeNum: '0.0001',
  volumePlace: '4',
  pricePlace: '1',
  priceEndStep: '1',
  sizeMultiplier: '0.0001',
  minTradeUSDT: '5',
  minLever: '1',
  maxLever: '125',
  maxMarketOrderQty: '220',
  maxOrderQty: '1200',
  symbolStatus: 'normal'
};

const TICKER = [{ symbol: SIMBOLO, lastPr: '63378', markPrice: '63381.3' }];

const CUENTA_SIMBOLO_V2 = {
  marginCoin: 'SUSDT',
  available: '3000',
  accountEquity: '3000',
  marginMode: 'isolated',
  posMode: 'hedge_mode',
  isolatedLongLever: 10,
  isolatedShortLever: 10,
  crossedMarginLeverage: 10
};

/** Ajustes de la cuenta UTA. `hedge_mode` es como opera el panel. */
const AJUSTES_UTA = {
  uid: '1111111111',
  accountMode: 'unified',
  accountLevel: 'advanced',
  holdMode: 'hedge_mode',
  symbolConfigList: [
    { category: 'SUSDT-FUTURES', symbol: SIMBOLO, marginMode: 'isolated', leverage: '10' }
  ]
};

/**
 * Dos cuentas: una Classic y una UTA, indistinguibles para el motor.
 *
 * La unica diferencia esta en la credencial —`superficie` y `holdMode`—, que es
 * exactamente donde el diseño dice que debe estar. `Sesion.credencialSellada`
 * las rellena en produccion a partir del registro.
 */
class DosCuentas implements FuenteCuentas {
  private readonly mapa = new Map<string, CuentaEjecutable>([
    [
      CLASICA,
      {
        cuentaId: CLASICA,
        etiqueta: 'Sub-01',
        credencial: { apiKey: `key_${CLASICA}`, secretKey: 's', passphrase: 'f' },
        saldoDisponible: '3000',
        modoMargen: 'isolated'
      }
    ],
    [
      UTA,
      {
        cuentaId: UTA,
        etiqueta: 'Sub-02',
        credencial: {
          apiKey: `key_${UTA}`,
          secretKey: 's',
          passphrase: 'f',
          superficie: 'v3',
          holdMode: 'hedge_mode'
        },
        saldoDisponible: '3000',
        modoMargen: 'isolated'
      }
    ]
  ]);

  cuentaEjecutable(cuentaId: string): CuentaEjecutable | null {
    return this.mapa.get(cuentaId) ?? null;
  }
}

const AMBAS: ObjetivoApertura[] = [
  { cuentaId: CLASICA, lado: 'long' },
  { cuentaId: UTA, lado: 'long' }
];

let exchange: ExchangeSimulado;
let cliente: ClienteBitget;
let motor: MotorLotes;

/** Cuerpos recibidos por ruta, para comprobar la traduccion de parametros. */
const cuerpoDe = (fragmento: string): Record<string, unknown> => {
  const p = exchange.peticiones.find((x) => x.url.includes(fragmento));
  return p === undefined ? {} : (JSON.parse(p.cuerpo) as Record<string, unknown>);
};

/** Rutas de lectura que toda planificacion necesita, en las dos superficies. */
function comunes(p: PeticionRecibida): Respuesta | null {
  if (p.url.startsWith('/api/v2/mix/market/contracts')) return { cuerpo: sobreOk([CONTRATO]) };
  if (p.url.startsWith('/api/v2/mix/market/ticker')) return { cuerpo: sobreOk(TICKER) };
  if (p.url.startsWith('/api/v2/mix/account/account')) return { cuerpo: sobreOk(CUENTA_SIMBOLO_V2) };
  return null;
}

beforeEach(async () => {
  exchange = await iniciarExchangeSimulado();
  exchange.simularUta(AJUSTES_UTA);
  cliente = new ClienteBitget({
    host: exchange.url,
    limitador: new LimitadorPeticiones({ dormir: async () => undefined })
  });
  motor = new MotorLotes(cliente, new DosCuentas(), { dormir: async () => undefined });
});

afterEach(async () => {
  await cliente.cerrar();
  await exchange.cerrar();
});

describe('apertura', () => {
  it('un lote mixto abre en las dos y da resultado por cuenta', async () => {
    exchange.responderCon((p) => {
      const c = comunes(p);
      if (c !== null) return c;
      if (p.url.includes('place-order')) {
        const cuerpo = JSON.parse(p.cuerpo) as Record<string, unknown>;
        return { cuerpo: sobreOk({ orderId: `ord_${String(cuerpo['clientOid'])}`, clientOid: cuerpo['clientOid'] }) };
      }
      return null;
    });

    const plan = await motor.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: AMBAS,
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null,
      modoMargen: 'isolated'
    });

    const lote = await motor.ejecutar(plan);

    expect(lote.jobs).toHaveLength(2);
    expect(lote.jobs.every((j) => j.estado === 'exito')).toBe(true);
    /* Cada casilla trae su propio identificador de orden en el informe. */
    expect(new Set(lote.jobs.map((j) => j.ordenId)).size).toBe(2);

    const rutas = exchange.peticiones.map((p) => p.url.split('?')[0] ?? '');
    expect(rutas).toContain('/api/v2/mix/order/place-order');
    expect(rutas).toContain('/api/v3/trade/place-order');
  });

  it('traduce los parametros de la orden y retira los que V3 no usa', async () => {
    exchange.responderCon((p) => {
      const c = comunes(p);
      if (c !== null) return c;
      if (p.url.includes('place-order')) {
        const cuerpo = JSON.parse(p.cuerpo) as Record<string, unknown>;
        return { cuerpo: sobreOk({ orderId: 'ord_1', clientOid: cuerpo['clientOid'] }) };
      }
      return null;
    });

    const plan = await motor.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: AMBAS,
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null,
      modoMargen: 'isolated'
    });
    await motor.ejecutar(plan);

    const v2 = cuerpoDe('/api/v2/mix/order/place-order');
    const v3 = cuerpoDe('/api/v3/trade/place-order');

    /*
     * Las dos usan el campo (10x) desde el 02/10/2026: 100 × 10 / 63381.3 = 0.0157.
     * Hasta entonces la UTA abria a 75x fijo.
     */
    expect(v2['size']).toBe('0.0157');
    expect(v3['qty']).toBe('0.0157');

    /* La UTA ya estaba a 10x: no hay cambio de los dos lados que avisar. */
    expect(plan.avisos.filter((a) => a.codigo === 'apalancamiento-uta-ambos-lados')).toHaveLength(0);

    /* V2: productType + marginCoin + size + tradeSide. */
    expect(v2['productType']).toBe('SUSDT-FUTURES');
    expect(v2['marginCoin']).toBe('SUSDT');
    expect(v2['tradeSide']).toBe('open');

    /* V3: category + qty + posSide, y ni marginCoin ni tradeSide. */
    expect(v3['category']).toBe('SUSDT-FUTURES');
    expect(v3['posSide']).toBe('long');
    expect(v3).not.toHaveProperty('marginCoin');
    expect(v3).not.toHaveProperty('tradeSide');
    expect(v3).not.toHaveProperty('size');

    /* El clientOid es el mismo generador en las dos: la idempotencia no cambia. */
    expect(String(v3['clientOid'])).toMatch(/^pcb[a-z0-9]+$/);
    expect(String(v3['clientOid']).length).toBeLessThanOrEqual(32);
  });

  it('en one-way mode omite posSide', async () => {
    /*
     * `posSide` es el campo que decide sobre que posicion se actua. Enviarlo en
     * una cuenta unilateral no aporta nada; omitirlo en una de cobertura deja
     * que Bitget elija el lado. La regla vive en `posSideDe`.
     */
    const soloUta = new MotorLotes(
      cliente,
      {
        cuentaEjecutable: () => ({
          cuentaId: UTA,
          etiqueta: 'Sub-02',
          credencial: {
            apiKey: `key_${UTA}`,
            secretKey: 's',
            passphrase: 'f',
            superficie: 'v3',
            holdMode: 'one_way_mode'
          },
          saldoDisponible: '3000',
          modoMargen: 'isolated'
        })
      },
      { dormir: async () => undefined }
    );

    exchange.responderCon((p) => {
      const c = comunes(p);
      if (c !== null) return c;
      if (p.url.includes('place-order')) return { cuerpo: sobreOk({ orderId: 'o', clientOid: 'c' }) };
      return null;
    });

    const plan = await soloUta.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: [{ cuentaId: UTA, lado: 'short' }],
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null,
      modoMargen: 'isolated'
    });
    await soloUta.ejecutar(plan);

    expect(cuerpoDe('/api/v3/trade/place-order')).not.toHaveProperty('posSide');
  });
});

describe('cierre', () => {
  it('cierra en las dos superficies y consume la lista de fallos parciales', async () => {
    const posicion = {
      symbol: SIMBOLO,
      holdSide: 'long',
      total: '0.5',
      marginMode: 'isolated',
      openPriceAvg: '63000',
      liquidationPrice: '58000',
      leverage: '10',
      marginSize: '3150'
    };

    exchange.responderCon((p) => {
      const c = comunes(p);
      if (c !== null) return c;
      if (p.url.startsWith('/api/v2/mix/position/all-position')) return { cuerpo: sobreOk([posicion]) };
      if (p.url.startsWith('/api/v3/position/current-position')) {
        return {
          cuerpo: sobreOk({
            list: [
              {
                symbol: SIMBOLO,
                posSide: 'long',
                total: '0.5',
                marginMode: 'isolated',
                avgPrice: '63000',
                liquidationPrice: '58000',
                leverage: '10',
                marginSize: '3150'
              }
            ]
          })
        };
      }
      if (p.url.includes('close-positions')) {
        const cuerpo = JSON.parse(p.cuerpo) as Record<string, unknown>;
        return { cuerpo: sobreOk({ successList: [{ orderId: 'cl_1', clientOid: cuerpo['clientOid'] }] }) };
      }
      return null;
    });

    const plan = await motor.planificarCierre({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: AMBAS
    });
    const lote = await motor.ejecutarCierre(plan);

    expect(lote.jobs.filter((j) => j.estado === 'exito')).toHaveLength(2);

    const v3 = cuerpoDe('/api/v3/trade/close-positions');
    expect(v3['category']).toBe('SUSDT-FUTURES');
    expect(v3['posSide']).toBe('long');
    expect(v3).not.toHaveProperty('holdSide');
  });
});

describe('apertura en UTA fija antes el apalancamiento del modo de la orden', () => {
  it('manda set-leverage en aislado con el lado y despues place-order', async () => {
    exchange.responderCon((p) => {
      const c = comunes(p);
      if (c !== null) return c;
      if (p.url.startsWith('/api/v3/account/set-leverage')) return { cuerpo: sobreOk('success') };
      if (p.url.includes('place-order')) {
        const cuerpo = JSON.parse(p.cuerpo) as Record<string, unknown>;
        return { cuerpo: sobreOk({ orderId: 'ord_1', clientOid: cuerpo['clientOid'] }) };
      }
      return null;
    });

    const plan = await motor.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: [{ cuentaId: UTA, lado: 'long' }],
      margenInicial: '100',
      apalancamiento: 25,
      precioLimite: null,
      modoMargen: 'isolated'
    });
    /* La cuenta estaba a 10x: se avisa de que long y short pasan a 25x juntos. */
    const ambos = plan.avisos.filter((a) => a.codigo === 'apalancamiento-uta-ambos-lados');
    expect(ambos).toHaveLength(1);
    expect(ambos[0]?.mensaje).toContain('10x a 25x');

    const lote = await motor.ejecutar(plan);
    expect(lote.jobs.every((j) => j.estado === 'exito')).toBe(true);

    const rutas = exchange.peticiones.map((p) => p.url);
    const iLev = rutas.findIndex((u) => u.startsWith('/api/v3/account/set-leverage'));
    const iOrden = rutas.findIndex((u) => u.includes('place-order'));
    expect(iLev).toBeGreaterThanOrEqual(0);
    expect(iLev).toBeLessThan(iOrden);

    const lev = cuerpoDe('/api/v3/account/set-leverage');
    expect(lev['marginMode']).toBe('isolated');
    expect(lev['posSide']).toBe('long');
    /* El del campo, y en aislado lleva los tres. */
    expect(lev['leverage']).toBe('25');
    expect(lev['longLeverage']).toBe('25');
    expect(lev['shortLeverage']).toBe('25');
  });
});

describe('apalancamiento', () => {
  it('en V3 aislado van leverage, longLeverage y shortLeverage con el valor del campo', async () => {
    exchange.responderCon((p) => {
      const c = comunes(p);
      if (c !== null) return c;
      if (p.url.startsWith('/api/v2/mix/account/set-leverage')) {
        return {
          cuerpo: sobreOk({
            symbol: SIMBOLO,
            marginCoin: 'SUSDT',
            marginMode: 'isolated',
            longLeverage: '25',
            shortLeverage: '25'
          })
        };
      }
      if (p.url.startsWith('/api/v3/account/set-leverage')) {
        /* V3 responde una cadena y el cambio se ve al releer los ajustes. */
        exchange.simularUta({
          ...AJUSTES_UTA,
          symbolConfigList: [
            { category: 'SUSDT-FUTURES', symbol: SIMBOLO, marginMode: 'isolated', leverage: '25' }
          ]
        });
        return { cuerpo: sobreOk('success') };
      }
      return null;
    });

    const plan = await motor.planificarApalancamiento({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: AMBAS,
      apalancamiento: 25
    });
    /* Lo que enseña la confirmacion: el que tiene ahora y el pedido. */
    const uta = plan.entradas.find((e) => e.cuentaId === UTA);
    expect(uta?.apalancamientoActual).toBe(10);
    expect(uta?.apalancamiento).toBe(25);
    const lote = await motor.ejecutarApalancamiento(plan);

    expect(lote.jobs.filter((j) => j.estado === 'exito')).toHaveLength(2);

    const v2 = cuerpoDe('/api/v2/mix/account/set-leverage');
    const v3 = cuerpoDe('/api/v3/account/set-leverage');

    expect(v2['leverage']).toBe('25');
    expect(v2['holdSide']).toBe('long');

    /*
     * Capturado el 30/09/2026: sin `leverage` o sin los dos lados, Bitget
     * responde 25200. Las dos superficies usan el valor del campo.
     */
    expect(v3['leverage']).toBe('25');
    expect(v3['longLeverage']).toBe('25');
    expect(v3['shortLeverage']).toBe('25');
    expect(v3['marginMode']).toBe('isolated');
    expect(v3['posSide']).toBe('long');
    expect(v3).not.toHaveProperty('holdSide');
    expect(v3).not.toHaveProperty('marginCoin');
  });

  it('por encima del maximo del simbolo no se planifica, tampoco en UTA', async () => {
    exchange.responderCon((p) => comunes(p));

    await expect(
      motor.planificarApalancamiento({
        mercado: MERCADO_SIMULADO,
        simbolo: SIMBOLO,
        objetivos: [{ cuentaId: UTA, lado: 'long' }],
        apalancamiento: 150
      })
    ).rejects.toThrow(/entre .*x y 125x/);
  });

  it('abrir en UTA por encima del maximo descarta la casilla', async () => {
    exchange.responderCon((p) => comunes(p));

    const plan = await motor.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: [{ cuentaId: UTA, lado: 'long' }],
      margenInicial: '100',
      apalancamiento: 150,
      precioLimite: null,
      modoMargen: 'isolated'
    });

    expect(plan.entradas).toHaveLength(0);
    expect(plan.descartes[0]?.motivo).toBe('apalancamiento-uta-fuera-de-rango');
  });

  it('en UTA un simbolo sin configurar se trata como cruzado y se puede fijar', async () => {
    /* Capturado el 30/09/2026: cuenta UTA nueva, `symbolConfigList` vacia. */
    exchange.simularUta({ ...AJUSTES_UTA, symbolConfigList: [] });
    exchange.responderCon((p) => {
      const c = comunes(p);
      if (c !== null) return c;
      if (p.url.startsWith('/api/v3/account/set-leverage')) {
        exchange.simularUta({
          ...AJUSTES_UTA,
          symbolConfigList: [
            { category: 'SUSDT-FUTURES', symbol: SIMBOLO, marginMode: 'crossed', leverage: '75' }
          ]
        });
        return { cuerpo: sobreOk('success') };
      }
      return null;
    });

    const plan = await motor.planificarApalancamiento({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: [{ cuentaId: UTA, lado: 'long' }],
      apalancamiento: 75
    });

    expect(plan.descartes).toHaveLength(0);
    expect(plan.entradas[0]?.modoMargen).toBe('crossed');

    const lote = await motor.ejecutarApalancamiento(plan);
    expect(lote.jobs.every((j) => j.estado === 'exito')).toBe(true);

    /* Cruzado: un solo apalancamiento, sin lado. */
    const v3 = cuerpoDe('/api/v3/account/set-leverage');
    expect(v3['leverage']).toBe('75');
    expect(v3).not.toHaveProperty('longLeverage');
  });
});

describe('margen', () => {
  /** Las dos superficies devuelven la misma posicion, cada una con sus nombres. */
  const posiciones = (p: PeticionRecibida): Respuesta | null => {
    const comun = {
      total: '0.5',
      marginMode: 'isolated',
      liquidationPrice: '58000',
      leverage: '10',
      marginSize: '3150'
    };
    if (p.url.startsWith('/api/v2/mix/position/all-position')) {
      return {
        cuerpo: sobreOk([{ symbol: SIMBOLO, holdSide: 'long', openPriceAvg: '63000', ...comun }])
      };
    }
    if (p.url.startsWith('/api/v3/position/current-position')) {
      return {
        cuerpo: sobreOk({
          list: [{ symbol: SIMBOLO, posSide: 'long', avgPrice: '63000', ...comun }]
        })
      };
    }
    return null;
  };

  it('agrega margen en las dos y traduce el signo a `operation`', async () => {
    exchange.responderCon((p) => comunes(p) ?? posiciones(p) ?? (p.url.includes('set-margin') ? { cuerpo: sobreOk({}) } : null));

    const plan = await motor.planificarMargen({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: AMBAS,
      cantidad: '50',
      direccion: 'agregar'
    });
    const lote = await motor.ejecutarMargen(plan);

    expect(lote.jobs.filter((j) => j.estado === 'exito')).toHaveLength(2);

    const v2 = cuerpoDe('/api/v2/mix/account/set-margin');
    const v3 = cuerpoDe('/api/v3/account/set-margin');

    /* V2 codifica el sentido en el signo del importe. */
    expect(v2['amount']).toBe('50');
    expect(v2['holdSide']).toBe('long');

    /* V3 lo separa: importe siempre positivo, sentido en `operation`. */
    expect(v3['operation']).toBe('add');
    expect(v3['amount']).toBe('50');
    expect(v3['posSide']).toBe('long');
    expect(v3).not.toHaveProperty('marginCoin');
  });

  it('al quitar, el signo se convierte en `operation: reduce` y el importe queda positivo', async () => {
    /*
     * Es la traduccion que mas cuidado pide: un `-50` que llegara a V3 tal cual
     * seria un importe invalido, y un `50` con `operation: add` retiraria margen
     * donde el operador pidio agregarlo —o al reves—. Acercar la liquidacion por
     * un signo mal traducido es de los errores caros.
     */
    exchange.responderCon((p) => comunes(p) ?? posiciones(p) ?? (p.url.includes('set-margin') ? { cuerpo: sobreOk({}) } : null));

    const plan = await motor.planificarMargen({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: [{ cuentaId: UTA, lado: 'long' }],
      cantidad: '50',
      direccion: 'quitar'
    });
    await motor.ejecutarMargen(plan);

    const v3 = cuerpoDe('/api/v3/account/set-margin');
    expect(v3['operation']).toBe('reduce');
    expect(v3['amount']).toBe('50');
    expect(String(v3['amount']).startsWith('-')).toBe(false);
  });
});

describe('Take Profit en UTA: ordenes de estrategia tpsl', () => {
  /** Una posicion long abierta en las dos superficies. */
  const conPosicion = (p: PeticionRecibida): Respuesta | null => {
    if (p.url.startsWith('/api/v2/mix/position/all-position')) {
      return {
        cuerpo: sobreOk([
          {
            symbol: SIMBOLO,
            holdSide: 'long',
            total: '0.5',
            marginMode: 'isolated',
            openPriceAvg: '63000',
            liquidationPrice: '58000',
            leverage: '10',
            marginSize: '3150'
          }
        ])
      };
    }
    if (p.url.startsWith('/api/v3/position/current-position')) {
      return {
        cuerpo: sobreOk({
          list: [
            {
              symbol: SIMBOLO,
              posSide: 'long',
              total: '0.5',
              marginMode: 'isolated',
              avgPrice: '63000',
              liquidationPrice: '58000',
              leverage: '10',
              marginSize: '3150'
            }
          ]
        })
      };
    }
    if (p.url.startsWith('/api/v2/mix/order/orders-plan-pending')) {
      return { cuerpo: sobreOk({ entrustedList: [] }) };
    }
    return null;
  };

  it('un lote mixto pone el Take Profit en las dos, y en V3 por place-strategy-order', async () => {
    exchange.responderCon((p) => {
      const c = comunes(p) ?? conPosicion(p);
      if (c !== null) return c;
      if (p.url.startsWith('/api/v3/trade/unfilled-strategy-orders')) return { cuerpo: sobreOk([]) };
      if (p.url.includes('place-tpsl-order')) return { cuerpo: sobreOk({ orderId: 'tp_v2', clientOid: 'x' }) };
      if (p.url.startsWith('/api/v3/trade/place-strategy-order')) {
        return { cuerpo: sobreOk({ orderId: 'tp_v3', clientOid: 'y' }) };
      }
      return null;
    });

    const plan = await motor.planificarTakeProfit({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: AMBAS,
      porcentaje: '10'
    });
    const lote = await motor.ejecutarTakeProfit(plan);

    const porCuenta = new Map(lote.jobs.map((j) => [j.cuentaId, j]));
    expect(porCuenta.get(CLASICA)?.estado).toBe('exito');
    expect(porCuenta.get(UTA)?.estado).toBe('exito');
    expect(porCuenta.get(UTA)?.ordenId).toBe('tp_v3');

    const v3 = cuerpoDe('/api/v3/trade/place-strategy-order');
    expect(v3['type']).toBe('tpsl');
    expect(v3['tpslMode']).toBe('full');
    expect(v3['posSide']).toBe('long');
    expect(v3['tpTriggerBy']).toBe('market');
    expect(v3['tpOrderType']).toBe('market');
    expect(v3['category']).toBe('SUSDT-FUTURES');
    /* El mismo precio de disparo que la Classic: misma posicion, mismo calculo. */
    expect(v3['takeProfit']).toBe(cuerpoDe('place-tpsl-order')['triggerPrice']);
    expect(v3).not.toHaveProperty('holdSide');
    expect(v3).not.toHaveProperty('planType');
  });

  /** Un Take Profit UTA ya puesto sobre el long, como lo deja la apertura. */
  const conTpViejo = (p: PeticionRecibida, qty: string | null = '0.5'): Respuesta | null => {
    if (!p.url.startsWith('/api/v3/trade/unfilled-strategy-orders')) return null;
    return {
      cuerpo: sobreOk([
        {
          orderId: 'tp_viejo',
          symbol: SIMBOLO,
          posSide: 'long',
          status: 'pending',
          takeProfit: '70000',
          ...(qty === null ? {} : { qty })
        }
      ])
    };
  };

  it('cambia un Take Profit puesto modificándolo, sin cancelarlo', async () => {
    exchange.responderCon((p) => {
      const c = comunes(p) ?? conPosicion(p) ?? conTpViejo(p);
      if (c !== null) return c;
      if (p.url.startsWith('/api/v3/trade/modify-strategy-order')) return { cuerpo: sobreOk(null) };
      return null;
    });

    const plan = await motor.planificarTakeProfit({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: [{ cuentaId: UTA, lado: 'long' }],
      porcentaje: '10'
    });
    const lote = await motor.ejecutarTakeProfit(plan);
    expect(lote.jobs.every((j) => j.estado === 'exito')).toBe(true);
    expect(lote.jobs[0]?.ordenId).toBe('tp_viejo');

    const rutas = exchange.peticiones.map((p) => p.url);
    expect(rutas.some((u) => u.startsWith('/api/v3/trade/cancel-strategy-order'))).toBe(false);
    expect(rutas.some((u) => u.startsWith('/api/v3/trade/place-strategy-order'))).toBe(false);

    const mod = cuerpoDe('/api/v3/trade/modify-strategy-order');
    expect(mod['orderId']).toBe('tp_viejo');
    expect(mod['qty']).toBe('0.5');
    expect(mod['takeProfit']).toBe(plan.entradas[0]?.precioDisparo);
    expect(mod['tpTriggerBy']).toBe('market');
    expect(mod['tpOrderType']).toBe('market');
  });

  it('sin qty en el listado usa el tamaño de la posición', async () => {
    exchange.responderCon((p) => {
      const c = comunes(p) ?? conPosicion(p) ?? conTpViejo(p, null);
      if (c !== null) return c;
      if (p.url.startsWith('/api/v3/trade/modify-strategy-order')) return { cuerpo: sobreOk(null) };
      return null;
    });

    const plan = await motor.planificarTakeProfit({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: [{ cuentaId: UTA, lado: 'long' }],
      porcentaje: '10'
    });
    await motor.ejecutarTakeProfit(plan);
    expect(cuerpoDe('/api/v3/trade/modify-strategy-order')['qty']).toBe('0.5');
  });

  it('si Bitget rechaza la modificación, el Take Profit anterior no se toca', async () => {
    exchange.responderCon((p) => {
      const c = comunes(p) ?? conPosicion(p) ?? conTpViejo(p);
      if (c !== null) return c;
      if (p.url.startsWith('/api/v3/trade/modify-strategy-order')) {
        return { estado: 400, cuerpo: sobreError('40034', 'rechazado') };
      }
      return null;
    });

    const plan = await motor.planificarTakeProfit({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: [{ cuentaId: UTA, lado: 'long' }],
      porcentaje: '10'
    });
    const lote = await motor.ejecutarTakeProfit(plan);
    expect(lote.jobs[0]?.estado).not.toBe('exito');
    expect(exchange.peticiones.some((p) => p.url.startsWith('/api/v3/trade/cancel-strategy-order'))).toBe(false);
  });

  it('el 31008 del Take Profit separado se dice claro y no se reintenta', async () => {
    /*
     * Capturado el 01/10/2026: con la posicion UTA abierta, `place-strategy-order`
     * responde 31008 a toda variante. Reintentarlo solo retrasaba el lote.
     */
    let intentos = 0;
    exchange.responderCon((p) => {
      if (!p.url.startsWith('/api/v3/trade/place-strategy-order')) return null;
      intentos += 1;
      return {
        estado: 400,
        cuerpo: sobreError('31008', 'There is no position in this position, no take profit or stop loss order can be made')
      };
    });

    const credencial = { apiKey: `key_${UTA}`, secretKey: 's', passphrase: 'f', superficie: 'v3' as const, holdMode: 'hedge_mode' as const };
    const envio = colocarTakeProfitV3(cliente, credencial, {
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      lado: 'short',
      precioDisparo: '60000',
      clientOid: 'pcb_tp'
    });

    await expect(envio).rejects.toThrow('solo se puede poner al abrirla');
    expect(intentos).toBe(1);
  });

  it('la apertura UTA lleva el Take Profit dentro de place-order', async () => {
    /* Capturado el 01/10/2026: asi si lo acepta Bitget, y aparece como tpsl pendiente. */
    exchange.responderCon((p) =>
      p.url.startsWith('/api/v3/trade/place-order')
        ? { cuerpo: sobreOk({ orderId: 'o_v3', clientOid: 'pcb_a' }) }
        : null
    );

    const credencial = { apiKey: `key_${UTA}`, secretKey: 's', passphrase: 'f', superficie: 'v3' as const, holdMode: 'hedge_mode' as const };
    await abrirPosicion(cliente, credencial, {
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      lado: 'short',
      modoMargen: 'isolated',
      size: '0.0002',
      precioLimite: null,
      clientOid: 'pcb_a',
      takeProfit: '84094.7'
    });

    const cuerpo = cuerpoDe('/api/v3/trade/place-order');
    expect(cuerpo['takeProfit']).toBe('84094.7');
    expect(cuerpo['tpOrderType']).toBe('market');
    expect(cuerpo['posSide']).toBe('short');
    expect(exchange.peticiones.some((p) => p.url.startsWith('/api/v3/trade/place-strategy-order'))).toBe(false);
  });

  it('lee margen y P&L de la posicion con los nombres reales de V3', async () => {
    /* Respuesta real de `current-position` capturada el 01/10/2026, recortada. */
    exchange.responderCon((p) =>
      p.url.startsWith('/api/v3/position/current-position')
        ? {
            cuerpo: sobreOk({
              list: [
                {
                  category: 'USDT-FUTURES',
                  symbol: 'BTCUSDT',
                  posSide: 'short',
                  marginMode: 'isolated',
                  positionBalance: '0.36074383',
                  total: '0.0002',
                  available: '0.0002',
                  leverage: '75',
                  avgPrice: '83979.7',
                  unrealisedPnl: '-0.17564',
                  liquidationPrice: '85393',
                  markPrice: '84857.9'
                }
              ]
            })
          }
        : null
    );

    const credencial = { apiKey: `key_${UTA}`, secretKey: 's', passphrase: 'f', superficie: 'v3' as const, holdMode: 'hedge_mode' as const };
    const r = await obtenerPosicionesV3(cliente, credencial, MERCADO_SIMULADO);

    expect(r.datos[0]?.marginSize).toBe('0.36074383');
    expect(r.datos[0]?.unrealizedPL).toBe('-0.17564');
    expect(r.datos[0]?.openPriceAvg).toBe('83979.7');
  });

  it('una orden con Take Profit y Stop Loss no se toma por Take Profit, para no llevarse el Stop Loss', async () => {
    exchange.responderCon((p) => {
      const c = comunes(p) ?? conPosicion(p);
      if (c !== null) return c;
      if (p.url.startsWith('/api/v3/trade/unfilled-strategy-orders')) {
        return {
          cuerpo: sobreOk([
            {
              orderId: 'tp_y_sl',
              symbol: SIMBOLO,
              posSide: 'long',
              status: 'pending',
              takeProfit: '70000',
              stopLoss: '60000'
            }
          ])
        };
      }
      return null;
    });

    const plan = await motor.planificarQuitarTakeProfit({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: [{ cuentaId: UTA, lado: 'long' }]
    });

    expect(plan.entradas).toHaveLength(0);
    expect(exchange.peticiones.some((p) => p.url.includes('cancel-strategy-order'))).toBe(false);
  });
});
