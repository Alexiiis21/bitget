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
import { LimitadorPeticiones } from '@main/execution/rate-limiter';
import {
  MotorLotes,
  type CuentaEjecutable,
  type FuenteCuentas,
  type ObjetivoApertura
} from '@main/execution/motor-lotes';
import {
  iniciarExchangeSimulado,
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

    /* V2: productType + marginCoin + size + tradeSide. */
    expect(v2['productType']).toBe('SUSDT-FUTURES');
    expect(v2['marginCoin']).toBe('SUSDT');
    expect(v2['size']).toBe(v3['qty']);
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

describe('apalancamiento', () => {
  it('en V3 el lado es el nombre del campo, no un parametro aparte', async () => {
    exchange.responderCon((p) => {
      const c = comunes(p);
      if (c !== null) return c;
      if (p.url.includes('set-leverage')) {
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
      return null;
    });

    const plan = await motor.planificarApalancamiento({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: AMBAS,
      apalancamiento: 25
    });
    const lote = await motor.ejecutarApalancamiento(plan);

    expect(lote.jobs.filter((j) => j.estado === 'exito')).toHaveLength(2);

    const v2 = cuerpoDe('/api/v2/mix/account/set-leverage');
    const v3 = cuerpoDe('/api/v3/account/set-leverage');

    expect(v2['leverage']).toBe('25');
    expect(v2['holdSide']).toBe('long');

    expect(v3['longLeverage']).toBe('25');
    expect(v3).not.toHaveProperty('holdSide');
    expect(v3).not.toHaveProperty('marginCoin');
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

describe('Take Profit — el hueco, y por que falla en vez de aproximar', () => {
  it('poner Take Profit falla solo en la cuenta UTA; la Classic sigue adelante', async () => {
    exchange.responderCon((p) => {
      const c = comunes(p);
      if (c !== null) return c;
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
      if (p.url.includes('place-tpsl-order')) {
        return { cuerpo: sobreOk({ orderId: 'tp_1', clientOid: 'x' }) };
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

    /*
     * Es el comportamiento que se busca: un lote mixto no se cae entero. La
     * Classic hace su trabajo y la UTA queda marcada con un motivo accionable,
     * en vez de con un exito que no puso ninguna proteccion.
     */
    expect(porCuenta.get(CLASICA)?.estado).toBe('exito');
    expect(porCuenta.get(UTA)?.estado).toBe('fallo');
    expect(porCuenta.get(UTA)?.mensaje).toContain('UTA');

    /* Y no se envio nada a V3: no se adivina un endpoint. */
    expect(exchange.peticiones.some((p) => p.url.includes('/api/v3/trade/place-tpsl'))).toBe(false);
  });
});
