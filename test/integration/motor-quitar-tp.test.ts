/**
 * Quitar el Take Profit, contra el exchange simulado.
 *
 * --------------------------------------------------------------------------
 * Lo propio de esta funcion
 * --------------------------------------------------------------------------
 * El cliente lo pidio asi: «debo poder modificarlo, pero incluso debo poder
 * quitarlo si quiero, porque hay escenarios donde voy sin Take Profit y cierro
 * a mano». Lo que aqui se prueba es lo que no aparece en ninguna otra funcion:
 *
 *  1. La verdad es lo que Bitget tiene puesto, no lo que el panel recuerde
 *     haber colocado: el operador tambien los pone desde la app.
 *  2. Un Stop Loss no se puede confundir con un Take Profit.
 *  3. `00000 success` con las listas vacias **no** es un exito: significa que
 *     ya no estaba puesto.
 *  4. La peticion siempre lleva `orderIdList`. Sin el, Bitget cancela todos los
 *     planes del simbolo, y eso no puede ocurrir ni por un descuido.
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

/** Un Take Profit puesto sobre la posicion entera. */
const takeProfit = (lado: 'long' | 'short', orderId = 'plan_1', disparo = '63220.5'): unknown => ({
  orderId,
  clientOid: `oid_${orderId}`,
  symbol: SIMBOLO,
  planType: 'pos_profit',
  triggerPrice: disparo,
  holdSide: lado,
  status: 'live'
});

/** Un Stop Loss. Se parece en todo salvo en lo unico que importa. */
const stopLoss = (lado: 'long' | 'short', orderId = 'plan_sl'): unknown => ({
  orderId,
  clientOid: `oid_${orderId}`,
  symbol: SIMBOLO,
  planType: 'pos_loss',
  triggerPrice: '62000',
  holdSide: lado,
  status: 'live'
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

/** Respuesta por defecto: se quita lo que se pidio quitar. */
const quitado = (cuerpo: Record<string, unknown>): Respuesta => {
  const lista = cuerpo['orderIdList'] as { orderId?: string }[] | undefined;
  return { cuerpo: sobreOk({ successList: [{ orderId: lista?.[0]?.orderId }], failureList: [] }) };
};

function enrutar(opciones: {
  planesDe?: (apiKey: string) => unknown[];
  alCancelar?: (cuerpo: Record<string, unknown>, apiKey: string) => Respuesta;
}): void {
  const planesDe = opciones.planesDe ?? (() => [takeProfit('long')]);
  const alCancelar = opciones.alCancelar ?? quitado;

  exchange.responderCon((p) => {
    const apiKey = String(p.cabeceras['access-key'] ?? '');
    if (p.url.startsWith('/api/v2/mix/order/orders-plan-pending')) {
      return { cuerpo: sobreOk({ entrustedList: planesDe(apiKey) }) };
    }
    if (p.url.startsWith('/api/v2/mix/order/cancel-plan-order')) {
      return alCancelar(JSON.parse(p.cuerpo) as Record<string, unknown>, apiKey);
    }
    return null;
  });
}

const peticion = (cuantas: number, lado: 'long' | 'short' = 'long') => ({
  mercado: MERCADO_SIMULADO,
  simbolo: SIMBOLO,
  objetivos: cuentas.objetivos(cuantas, lado)
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

describe('planificar: se ensena lo que hay puesto', () => {
  it('lee el Take Profit de cada casilla sin quitar nada', async () => {
    enrutar({});

    const plan = await motor.planificarQuitarTakeProfit(peticion(3));

    expect(plan.entradas).toHaveLength(3);
    expect(plan.entradas[0]?.precioDisparo).toBe('63220.5');
    expect(plan.entradas[0]?.orderId).toBe('plan_1');
    expect(exchange.peticiones.filter((p) => p.url.includes('cancel-plan-order'))).toHaveLength(0);
  });

  /* Sin Take Profit no hay nada que quitar: es un descarte, no un fallo. */
  it('una casilla sin Take Profit se descarta con el motivo', async () => {
    enrutar({ planesDe: (k) => (k.endsWith('002') ? [] : [takeProfit('long')]) });

    const plan = await motor.planificarQuitarTakeProfit(peticion(4));

    expect(plan.entradas).toHaveLength(3);
    expect(plan.descartes[0]?.motivo).toBe('sin-take-profit');
  });

  /*
   * Quitar el Stop Loss creyendo que se quita el Take Profit dejaria la
   * posicion sin su unica proteccion. Es el peor error posible de esta funcion.
   */
  it('un Stop Loss no se confunde con un Take Profit', async () => {
    enrutar({ planesDe: () => [stopLoss('long')] });

    const plan = await motor.planificarQuitarTakeProfit(peticion(2));

    expect(plan.entradas).toHaveLength(0);
    expect(plan.descartes[0]?.motivo).toBe('sin-take-profit');
  });

  it('con los dos puestos, quita solo el Take Profit', async () => {
    enrutar({ planesDe: () => [stopLoss('long'), takeProfit('long', 'plan_tp')] });

    const plan = await motor.planificarQuitarTakeProfit(peticion(1));

    expect(plan.entradas[0]?.orderId).toBe('plan_tp');
  });

  it('el Take Profit del otro lado no se toca', async () => {
    enrutar({ planesDe: () => [takeProfit('short', 'plan_short')] });

    const plan = await motor.planificarQuitarTakeProfit(peticion(1, 'long'));

    expect(plan.entradas).toHaveLength(0);
    expect(plan.descartes[0]?.motivo).toBe('sin-take-profit');
  });

  it('una sola consulta por cuenta aunque se pidan los dos lados', async () => {
    enrutar({ planesDe: () => [takeProfit('long', 'plan_l'), takeProfit('short', 'plan_s')] });

    const plan = await motor.planificarQuitarTakeProfit({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: [
        { cuentaId: 'cta_001', lado: 'long' },
        { cuentaId: 'cta_001', lado: 'short' }
      ]
    });

    expect(plan.entradas).toHaveLength(2);
    expect(exchange.peticiones.filter((p) => p.url.includes('orders-plan-pending'))).toHaveLength(1);
  });

  it('sin ninguna casilla seleccionada no se planifica', async () => {
    enrutar({});

    await expect(
      motor.planificarQuitarTakeProfit({
        mercado: MERCADO_SIMULADO,
        simbolo: SIMBOLO,
        objetivos: []
      })
    ).rejects.toThrow(/casilla/);
  });
});

describe('ejecutar: quitar de verdad', () => {
  it('quita el Take Profit de cada casilla', async () => {
    enrutar({});

    const plan = await motor.planificarQuitarTakeProfit(peticion(5));
    const lote = await motor.ejecutarQuitarTakeProfit(plan);

    expect(resumirLote(lote).exito).toBe(5);
    expect(lote.jobs[0]?.mensaje).toBe('Take Profit quitado');
  });

  /*
   * El freno que impide el modo «cancelar todo» de Bitget: si `orderIdList`
   * faltara, el exchange quitaria los Take Profit de posiciones que el operador
   * no habia seleccionado, y respondiendo `success`.
   */
  it('cada peticion lleva exactamente un identificador, nunca ninguno', async () => {
    enrutar({});

    const plan = await motor.planificarQuitarTakeProfit(peticion(3));
    await motor.ejecutarQuitarTakeProfit(plan);

    const enviadas = exchange.peticiones.filter((p) => p.url.includes('cancel-plan-order'));
    expect(enviadas).toHaveLength(3);
    for (const p of enviadas) {
      const cuerpo = JSON.parse(p.cuerpo) as { orderIdList?: unknown[] };
      expect(cuerpo.orderIdList).toHaveLength(1);
    }
  });

  /*
   * Verificado contra Bitget el 18/08/2026: cancelar un plan que ya no existe
   * responde `00000 success` con las dos listas vacias. Darlo por exito diria
   * «quitado» sin haber quitado nada.
   */
  it('las listas vacias son «ya no estaba», no un exito', async () => {
    enrutar({ alCancelar: () => ({ cuerpo: sobreOk({ successList: [], failureList: [] }) }) });

    const plan = await motor.planificarQuitarTakeProfit(peticion(2));
    const lote = await motor.ejecutarQuitarTakeProfit(plan);

    expect(resumirLote(lote).exito).toBe(0);
    expect(lote.jobs.every((j) => j.estado === 'omitida')).toBe(true);
    expect(lote.jobs[0]?.mensaje).toContain('ya no estaba');
  });

  it('lo que Bitget rechaza sale como fallo, con su motivo', async () => {
    enrutar({
      alCancelar: (c, k) =>
        k.endsWith('002')
          ? {
              cuerpo: sobreOk({
                successList: [],
                failureList: [
                  { orderId: 'plan_1', errorCode: '43001', errorMsg: 'The order does not exist' }
                ]
              })
            }
          : quitado(c)
    });

    const plan = await motor.planificarQuitarTakeProfit(peticion(3));
    const lote = await motor.ejecutarQuitarTakeProfit(plan);

    const resumen = resumirLote(lote);
    expect(resumen.exito).toBe(2);
    expect(resumen.fallo).toBe(1);
    expect(lote.jobs.find((j) => j.cuentaId === 'cta_002')?.mensaje).toContain('does not exist');
  });

  it('un fallo en una cuenta no impide las demas', async () => {
    enrutar({
      alCancelar: (c, k) => (k.endsWith('003') ? { estado: 500, cuerpo: 'boom' } : quitado(c))
    });

    const plan = await motor.planificarQuitarTakeProfit(peticion(6));
    const lote = await motor.ejecutarQuitarTakeProfit(plan);

    expect(resumirLote(lote).exito).toBe(5);
  });
});

describe('corte de conexion: se mira si el plan sigue puesto', () => {
  it('si ya no aparece en Bitget, quedo quitado', async () => {
    let cancelaciones = 0;
    exchange.responderCon((p) => {
      if (p.url.startsWith('/api/v2/mix/order/cancel-plan-order')) {
        cancelaciones += 1;
        return { estado: 502, cuerpo: 'corte' };
      }
      if (p.url.startsWith('/api/v2/mix/order/orders-plan-pending')) {
        /* La primera consulta es la de planificar; la segunda, la de resolver. */
        return {
          cuerpo: sobreOk({ entrustedList: cancelaciones === 0 ? [takeProfit('long')] : [] })
        };
      }
      return null;
    });

    const plan = await motor.planificarQuitarTakeProfit(peticion(1));
    const lote = await motor.ejecutarQuitarTakeProfit(plan);

    expect(lote.jobs[0]?.estado).toBe('exito');
    expect(lote.jobs[0]?.mensaje).toContain('sí quedó quitado');
  });

  it('si sigue puesto, es un fallo reintentable', async () => {
    exchange.responderCon((p) => {
      if (p.url.startsWith('/api/v2/mix/order/cancel-plan-order')) {
        return { estado: 502, cuerpo: 'corte' };
      }
      if (p.url.startsWith('/api/v2/mix/order/orders-plan-pending')) {
        return { cuerpo: sobreOk({ entrustedList: [takeProfit('long')] }) };
      }
      return null;
    });

    const plan = await motor.planificarQuitarTakeProfit(peticion(1));
    const lote = await motor.ejecutarQuitarTakeProfit(plan);

    expect(lote.jobs[0]?.estado).toBe('fallo');
    expect(lote.jobs[0]?.mensaje).toContain('sigue puesto');
  });

  it('si no se pueden leer los planes, la casilla no se toca', async () => {
    exchange.responderCon((p) =>
      p.url.startsWith('/api/v2/mix/order/orders-plan-pending')
        ? { estado: 500, cuerpo: 'boom' }
        : null
    );

    const plan = await motor.planificarQuitarTakeProfit(peticion(2));

    expect(plan.entradas).toHaveLength(0);
    expect(plan.descartes[0]?.motivo).toBe('planes-ilegibles');
  });
});

describe('escala', () => {
  it('trescientas casillas se quedan sin Take Profit de una vez', async () => {
    cuentas = new Cuentas(300);
    motor = new MotorLotes(cliente, cuentas, { tamanoBloque: 12, dormir: async () => undefined });
    enrutar({});

    const plan = await motor.planificarQuitarTakeProfit(peticion(300));
    const lote = await motor.ejecutarQuitarTakeProfit(plan);

    expect(plan.entradas).toHaveLength(300);
    expect(resumirLote(lote).exito).toBe(300);
  }, 60_000);
});
