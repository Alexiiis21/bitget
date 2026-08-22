/**
 * El Take Profit, contra el exchange simulado.
 *
 * --------------------------------------------------------------------------
 * Lo propio de esta funcion
 * --------------------------------------------------------------------------
 * Bloques, idempotencia e informe ya se prueban en `motor-apertura.test.ts`.
 * Aqui esta lo que solo pasa con el Take Profit:
 *
 *  1. El porcentaje no define un precio por si solo: hacen falta la entrada de
 *     esa posicion y su apalancamiento, asi que hay que leer las posiciones.
 *  2. El apalancamiento se toma **de la posicion**, que es el que de verdad se
 *     aplico al abrirla.
 *  3. Lo indeterminado se resuelve mirando los planes que Bitget tiene puestos,
 *     no la orden.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClienteBitget } from '@main/bitget/rest/client';
import { LimitadorPeticiones } from '@main/execution/rate-limiter';
import { MERCADO_SIMULADO } from '@main/bitget/mercado';
import {
  MotorLotes,
  resumirLote,
  type CuentaEjecutable,
  type FuenteCuentas,
  type ObjetivoApertura
} from '@main/execution/motor-lotes';
import {
  iniciarExchangeSimulado,
  sobreOk,
  type ExchangeSimulado,
  type Respuesta
} from '../mock-exchange/servidor';

const SIMBOLO = 'SBTCSUSDT';

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

/** Posicion abierta, con su apalancamiento y su precio de entrada. */
const posicion = (lado: 'long' | 'short', entrada = '63000', apalancamiento = '100'): unknown => ({
  symbol: SIMBOLO,
  holdSide: lado,
  total: '0.0157',
  available: '0.0157',
  marginCoin: 'SUSDT',
  marginMode: 'isolated',
  openPriceAvg: entrada,
  liquidationPrice: '62370',
  leverage: apalancamiento,
  marginSize: '9.9'
});

class Cuentas implements FuenteCuentas {
  private readonly mapa = new Map<string, CuentaEjecutable>();

  constructor(cuantas: number) {
    for (let i = 1; i <= cuantas; i += 1) {
      const id = `cta_${String(i).padStart(3, '0')}`;
      this.mapa.set(id, {
        cuentaId: id,
        etiqueta: `Sub-${String(i).padStart(2, '0')}`,
        credencial: { apiKey: `key_${id}`, secretKey: 'secreto', passphrase: 'frase' },
        saldoDisponible: '3000',
        modoMargen: 'isolated'
      });
    }
  }

  cuentaEjecutable(cuentaId: string): CuentaEjecutable | null {
    return this.mapa.get(cuentaId) ?? null;
  }

  fijarApalancamiento(cuentaId: string, long: number): void {
    const c = this.mapa.get(cuentaId);
    if (c) c.apalancamiento = { long, short: long, cruzado: long };
  }

  objetivos(cuantas: number, lado: 'long' | 'short' = 'long'): ObjetivoApertura[] {
    return Array.from({ length: cuantas }, (_, i) => ({
      cuentaId: `cta_${String(i + 1).padStart(3, '0')}`,
      lado
    }));
  }
}

let exchange: ExchangeSimulado;
let cliente: ClienteBitget;
let cuentas: Cuentas;
let motor: MotorLotes;

function enrutar(opciones: {
  posicionesDe?: (apiKey: string) => unknown[];
  alColocar?: (cuerpo: Record<string, unknown>, apiKey: string) => Respuesta;
  planesDe?: (apiKey: string) => unknown[];
}): void {
  const posicionesDe = opciones.posicionesDe ?? (() => [posicion('long')]);
  const planesDe = opciones.planesDe ?? (() => []);
  const alColocar =
    opciones.alColocar ??
    ((c) => ({
      cuerpo: sobreOk({ orderId: `plan_${String(c['clientOid'])}`, clientOid: c['clientOid'] })
    }));

  exchange.responderCon((p) => {
    const apiKey = String(p.cabeceras['access-key'] ?? '');
    if (p.url.startsWith('/api/v2/mix/market/contracts')) return { cuerpo: sobreOk([CONTRATO]) };
    if (p.url.startsWith('/api/v2/mix/position/all-position')) {
      return { cuerpo: sobreOk(posicionesDe(apiKey)) };
    }
    if (p.url.startsWith('/api/v2/mix/order/orders-plan-pending')) {
      return { cuerpo: sobreOk({ entrustedList: planesDe(apiKey) }) };
    }
    if (p.url.startsWith('/api/v2/mix/order/place-tpsl-order')) {
      return alColocar(JSON.parse(p.cuerpo) as Record<string, unknown>, apiKey);
    }
    return null;
  });
}

const peticion = (cuantas: number, porcentaje = '35', lado: 'long' | 'short' = 'long') => ({
  mercado: MERCADO_SIMULADO,
  simbolo: SIMBOLO,
  objetivos: cuentas.objetivos(cuantas, lado),
  porcentaje
});

beforeEach(async () => {
  exchange = await iniciarExchangeSimulado();
  cliente = new ClienteBitget({
    host: exchange.url,
    limitador: new LimitadorPeticiones({ dormir: async () => undefined })
  });
  cuentas = new Cuentas(20);
  motor = new MotorLotes(cliente, cuentas, { dormir: async () => undefined });
});

afterEach(async () => {
  await cliente.cerrar();
  await exchange.cerrar();
});

describe('planificar: el porcentaje se convierte en un precio', () => {
  it('calcula el precio de cada posicion sin colocar nada', async () => {
    enrutar({});

    const plan = await motor.planificarTakeProfit(peticion(3));

    expect(plan.entradas).toHaveLength(3);
    /* 63.000 x (1 + 0,35/100) = 63.220,5 */
    expect(plan.entradas[0]?.precioDisparo).toBe('63220.5');
    expect(plan.entradas[0]?.apalancamiento).toBe(100);
    expect(exchange.peticiones.filter((p) => p.url.includes('place-tpsl'))).toHaveLength(0);
  });

  /*
   * El apalancamiento de la posicion es el que se aplico al abrirla. Usar el de
   * la cuenta seria usar el de ahora, que puede haber cambiado despues.
   */
  it('usa el apalancamiento de la posicion, no el de la cuenta', async () => {
    enrutar({ posicionesDe: () => [posicion('long', '63000', '50')] });
    cuentas.fijarApalancamiento('cta_001', 100);

    const plan = await motor.planificarTakeProfit(peticion(1));

    expect(plan.entradas[0]?.apalancamiento).toBe(50);
    /* A 50x hace falta el doble de recorrido: 63.000 x (1 + 0,35/50) = 63.441 */
    expect(plan.entradas[0]?.precioDisparo).toBe('63441');
  });

  it('si la posicion no trae apalancamiento, cae al de la cuenta', async () => {
    enrutar({ posicionesDe: () => [{ ...(posicion('long') as object), leverage: null }] });
    cuentas.fijarApalancamiento('cta_001', 25);

    const plan = await motor.planificarTakeProfit(peticion(1));

    expect(plan.entradas[0]?.apalancamiento).toBe(25);
  });

  it('sin apalancamiento por ningun lado no inventa un precio', async () => {
    enrutar({ posicionesDe: () => [{ ...(posicion('long') as object), leverage: null }] });

    const plan = await motor.planificarTakeProfit(peticion(1));

    expect(plan.entradas).toHaveLength(0);
    expect(plan.descartes[0]?.motivo).toBe('apalancamiento-invalido');
  });

  it('cada posicion tiene su precio: entradas distintas dan objetivos distintos', async () => {
    enrutar({
      posicionesDe: (k) => [posicion('long', k.endsWith('001') ? '63000' : '64000')]
    });

    const plan = await motor.planificarTakeProfit(peticion(2));

    expect(plan.entradas[0]?.precioDisparo).toBe('63220.5');
    expect(plan.entradas[1]?.precioDisparo).toBe('64224');
  });

  it('en short el objetivo queda por debajo de la entrada', async () => {
    enrutar({ posicionesDe: () => [posicion('short')] });

    const plan = await motor.planificarTakeProfit(peticion(1, '35', 'short'));

    expect(Number(plan.entradas[0]?.precioDisparo)).toBeLessThan(63000);
  });

  /* Sin posicion no hay a que ponerle Take Profit: se descarta, no falla. */
  it('una casilla sin posicion se descarta con su motivo', async () => {
    enrutar({ posicionesDe: (k) => (k.endsWith('002') ? [] : [posicion('long')]) });

    const plan = await motor.planificarTakeProfit(peticion(4));

    expect(plan.entradas).toHaveLength(3);
    expect(plan.descartes[0]?.motivo).toBe('sin-posicion');
  });

  it('un porcentaje que no llega a un paso de precio se descarta', async () => {
    enrutar({});

    const plan = await motor.planificarTakeProfit(peticion(2, '0.001'));

    expect(plan.entradas).toHaveLength(0);
    expect(plan.descartes[0]?.motivo).toBe('sin-recorrido');
  });
});

describe('ejecutar: colocar el Take Profit', () => {
  it('envia el precio calculado, el lado y su identificador', async () => {
    const cuerpos: Record<string, unknown>[] = [];
    enrutar({
      alColocar: (c) => {
        cuerpos.push(c);
        return { cuerpo: sobreOk({ orderId: 'plan_1', clientOid: c['clientOid'] }) };
      }
    });

    const plan = await motor.planificarTakeProfit(peticion(2));
    const lote = await motor.ejecutarTakeProfit(plan);

    expect(lote.accion).toBe('take-profit');
    expect(resumirLote(lote).exito).toBe(2);
    expect(cuerpos[0]).toMatchObject({
      symbol: SIMBOLO,
      productType: 'SUSDT-FUTURES',
      planType: 'pos_profit',
      triggerPrice: '63220.5',
      triggerType: 'fill_price',
      holdSide: 'long'
    });
    /* `pos_profit` cierra la posicion entera: no lleva cantidad. */
    expect(cuerpos[0]?.['size']).toBeUndefined();
    expect(String(cuerpos[0]?.['clientOid'])).toBe(plan.entradas[0]?.clientOid);
  });

  it('un fallo en una cuenta no impide poner el resto', async () => {
    enrutar({
      alColocar: (_c, apiKey) =>
        apiKey.endsWith('003')
          ? { cuerpo: { code: '40018', msg: 'Invalid IP', requestTime: 1, data: null } }
          : { cuerpo: sobreOk({ orderId: 'plan', clientOid: 'x' }) }
    });

    const plan = await motor.planificarTakeProfit(peticion(6));
    const lote = await motor.ejecutarTakeProfit(plan);

    expect(resumirLote(lote).exito).toBe(5);
    expect(resumirLote(lote).fallo).toBe(1);
  });

  it('reintentar solo las fallidas reutiliza sus identificadores', async () => {
    let fallar = true;
    enrutar({
      alColocar: (c, apiKey) =>
        fallar && apiKey.endsWith('002')
          ? { cuerpo: { code: '40018', msg: 'Invalid IP', requestTime: 1, data: null } }
          : { cuerpo: sobreOk({ orderId: 'plan', clientOid: c['clientOid'] }) }
    });

    const plan = await motor.planificarTakeProfit(peticion(4));
    const primera = await motor.ejecutarTakeProfit(plan);
    const fallido = primera.jobs.find((j) => j.estado === 'fallo');

    fallar = false;
    const reintento = await motor.ejecutarTakeProfit(plan, [fallido?.clientOid ?? '']);

    expect(reintento.jobs[0]?.clientOid).toBe(fallido?.clientOid);
    expect(reintento.jobs[0]?.estado).toBe('exito');
  });
});

describe('lo indeterminado se resuelve mirando los planes puestos', () => {
  it('si el Take Profit aparece en Bitget, se da por bueno', async () => {
    let oid = '';
    exchange.responderCon((p) => {
      if (p.url.startsWith('/api/v2/mix/market/contracts')) return { cuerpo: sobreOk([CONTRATO]) };
      if (p.url.startsWith('/api/v2/mix/position/all-position')) {
        return { cuerpo: sobreOk([posicion('long')]) };
      }
      if (p.url.startsWith('/api/v2/mix/order/place-tpsl-order')) {
        oid = String((JSON.parse(p.cuerpo) as Record<string, unknown>)['clientOid']);
        return { estado: 502, cuerpo: 'corte' };
      }
      if (p.url.startsWith('/api/v2/mix/order/orders-plan-pending')) {
        return { cuerpo: sobreOk({ entrustedList: [{ orderId: 'plan_rec', clientOid: oid }] }) };
      }
      return null;
    });

    const plan = await motor.planificarTakeProfit(peticion(1));
    const lote = await motor.ejecutarTakeProfit(plan);

    expect(lote.jobs[0]?.estado).toBe('exito');
    expect(lote.jobs[0]?.ordenId).toBe('plan_rec');
  });

  it('si no aparece, se marca fallo reintentable', async () => {
    exchange.responderCon((p) => {
      if (p.url.startsWith('/api/v2/mix/market/contracts')) return { cuerpo: sobreOk([CONTRATO]) };
      if (p.url.startsWith('/api/v2/mix/position/all-position')) {
        return { cuerpo: sobreOk([posicion('long')]) };
      }
      if (p.url.startsWith('/api/v2/mix/order/place-tpsl-order')) {
        return { estado: 502, cuerpo: 'corte' };
      }
      if (p.url.startsWith('/api/v2/mix/order/orders-plan-pending')) {
        return { cuerpo: sobreOk({ entrustedList: [] }) };
      }
      return null;
    });

    const plan = await motor.planificarTakeProfit(peticion(1));
    const lote = await motor.ejecutarTakeProfit(plan);

    expect(lote.jobs[0]?.estado).toBe('fallo');
    expect(lote.jobs[0]?.mensaje).toContain('sigue sin él');
  });
});

describe('escala', () => {
  it('trescientas posiciones: todas reciben su Take Profit', async () => {
    cuentas = new Cuentas(300);
    motor = new MotorLotes(cliente, cuentas, { tamanoBloque: 12, dormir: async () => undefined });
    enrutar({});

    const plan = await motor.planificarTakeProfit(peticion(300));
    const lote = await motor.ejecutarTakeProfit(plan);

    expect(plan.entradas).toHaveLength(300);
    expect(resumirLote(lote).exito).toBe(300);
    expect(new Set(lote.jobs.map((j) => j.clientOid)).size).toBe(300);
  }, 60_000);
});
