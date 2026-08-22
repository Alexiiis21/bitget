/**
 * El cierre de operaciones, contra el exchange simulado.
 *
 * --------------------------------------------------------------------------
 * Que se prueba aqui que la apertura no cubra
 * --------------------------------------------------------------------------
 * El cierre comparte con la apertura los bloques, la idempotencia y el informe
 * -eso ya se prueba en `motor-apertura.test.ts`-, pero tiene tres reglas
 * propias, y las tres protegen al operador de creer que cerro algo que sigue
 * abierto:
 *
 *  1. Se consulta que hay abierto antes de cerrar; una casilla vacia no es un
 *     fallo, es que no habia nada.
 *  2. `close-positions` responde con dos listas, y la peticion puede traer
 *     codigo de exito con la posicion dentro de la lista de fallos.
 *  3. Lo indeterminado se resuelve **mirando la posicion**, no la orden: si ya
 *     no esta, el cierre ocurrio.
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
import type { Lote } from '@shared/types';
import {
  iniciarExchangeSimulado,
  sobreOk,
  type ExchangeSimulado,
  type Respuesta
} from '../mock-exchange/servidor';

const SIMBOLO = 'SBTCSUSDT';

/** Una posicion abierta tal como la devuelve `all-position`. */
const posicion = (lado: 'long' | 'short', total = '0.0157'): unknown => ({
  symbol: SIMBOLO,
  holdSide: lado,
  total,
  available: total,
  marginCoin: 'SUSDT',
  marginMode: 'crossed',
  openPriceAvg: '63200.5',
  liquidationPrice: '57000.1',
  leverage: '10',
  marginSize: '99.3',
  unrealizedPL: '2.5'
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
        modoMargen: 'crossed'
      });
    }
  }

  cuentaEjecutable(cuentaId: string): CuentaEjecutable | null {
    return this.mapa.get(cuentaId) ?? null;
  }

  olvidar(cuentaId: string): void {
    this.mapa.delete(cuentaId);
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

/**
 * Enruta las tres llamadas del cierre.
 *
 * `posicionesDe` decide que tiene abierta cada cuenta; se distingue por la
 * API Key, que es lo unico que identifica a la cuenta en la peticion.
 */
function enrutar(opciones: {
  posicionesDe?: (apiKey: string) => unknown[];
  alCerrar?: (cuerpo: Record<string, unknown>, apiKey: string) => Respuesta;
}): void {
  const posicionesDe = opciones.posicionesDe ?? (() => [posicion('long')]);
  const alCerrar =
    opciones.alCerrar ??
    ((c) => ({
      cuerpo: sobreOk({
        successList: [{ orderId: `ord_${String(c['clientOid'])}`, clientOid: c['clientOid'] }],
        failureList: []
      })
    }));

  exchange.responderCon((p) => {
    const apiKey = String(p.cabeceras['access-key'] ?? '');
    if (p.url.startsWith('/api/v2/mix/position/all-position')) {
      return { cuerpo: sobreOk(posicionesDe(apiKey)) };
    }
    if (p.url.startsWith('/api/v2/mix/order/close-positions')) {
      return alCerrar(JSON.parse(p.cuerpo) as Record<string, unknown>, apiKey);
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

describe('planificar: se mira antes de cerrar', () => {
  it('consulta las posiciones y no cierra nada', async () => {
    enrutar({});

    const plan = await motor.planificarCierre(peticion(5));

    expect(plan.entradas).toHaveLength(5);
    expect(plan.entradas[0]?.size).toBe('0.0157');
    expect(plan.entradas[0]?.precioEntrada).toBe('63200.5');
    expect(plan.entradas[0]?.margenLiberado).toBe('99.3');
    expect(exchange.peticiones.filter((p) => p.url.includes('close-positions'))).toHaveLength(0);
  });

  /*
   * Cerrar una casilla que ya estaba cerrada no es un error del operador ni del
   * panel. Contarlo como fallo le haria buscar un problema que no existe.
   */
  it('una casilla sin posicion se descarta, no falla', async () => {
    enrutar({ posicionesDe: (k) => (k.endsWith('003') ? [] : [posicion('long')]) });

    const plan = await motor.planificarCierre(peticion(5));

    expect(plan.entradas).toHaveLength(4);
    expect(plan.descartes).toHaveLength(1);
    expect(plan.descartes[0]?.motivo).toBe('sin-posicion');
  });

  it('distingue el lado: no cierra un long cuando lo abierto es un short', async () => {
    enrutar({ posicionesDe: () => [posicion('short')] });

    const plan = await motor.planificarCierre(peticion(3, 'long'));

    expect(plan.entradas).toHaveLength(0);
    expect(plan.descartes.every((d) => d.motivo === 'sin-posicion')).toBe(true);
  });

  /*
   * Si no se puede saber que hay abierto, no se cierra a ciegas. Cerrar sin
   * mirar es justo lo que esta funcion no debe hacer.
   */
  it('si no se pueden leer las posiciones, esa cuenta no se toca', async () => {
    exchange.responderCon((p) => {
      const apiKey = String(p.cabeceras['access-key'] ?? '');
      if (p.url.startsWith('/api/v2/mix/position/all-position')) {
        if (apiKey.endsWith('002')) return { estado: 500, cuerpo: 'caido' };
        return { cuerpo: sobreOk([posicion('long')]) };
      }
      return { cuerpo: sobreOk({ successList: [{ orderId: 'x' }], failureList: [] }) };
    });

    const plan = await motor.planificarCierre(peticion(4));

    expect(plan.entradas).toHaveLength(3);
    expect(plan.descartes[0]?.motivo).toBe('posiciones-ilegibles');
  });

  /* Long y short de la misma subcuenta salen de una sola consulta. */
  it('no consulta dos veces la misma cuenta para dos lados', async () => {
    enrutar({ posicionesDe: () => [posicion('long'), posicion('short')] });

    const plan = await motor.planificarCierre({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: [
        { cuentaId: 'cta_001', lado: 'long' },
        { cuentaId: 'cta_001', lado: 'short' }
      ]
    });

    expect(plan.entradas).toHaveLength(2);
    expect(exchange.peticiones.filter((p) => p.url.includes('all-position'))).toHaveLength(1);
  });

  it('una cuenta que ya no esta registrada se descarta con su motivo', async () => {
    enrutar({});
    cuentas.olvidar('cta_002');

    const plan = await motor.planificarCierre(peticion(3));

    expect(plan.descartes[0]?.motivo).toBe('cuenta-desconocida');
  });
});

describe('ejecutar: cerrar lo que haya', () => {
  it('envia el cierre con el lado y el identificador correctos', async () => {
    const cuerpos: Record<string, unknown>[] = [];
    enrutar({
      alCerrar: (c) => {
        cuerpos.push(c);
        return { cuerpo: sobreOk({ successList: [{ orderId: 'ord_1' }], failureList: [] }) };
      }
    });

    const plan = await motor.planificarCierre(peticion(2));
    const lote = await motor.ejecutarCierre(plan);

    expect(resumirLote(lote).exito).toBe(2);
    expect(lote.accion).toBe('cerrar');
    expect(cuerpos[0]).toMatchObject({
      symbol: SIMBOLO,
      productType: 'SUSDT-FUTURES',
      holdSide: 'long'
    });
    /* Sin cantidad: se cierra lo que haya en ese momento, no lo que se vio al planificar. */
    expect(cuerpos[0]?.['size']).toBeUndefined();
    expect(String(cuerpos[0]?.['clientOid'])).toBe(plan.entradas[0]?.clientOid);
  });

  /*
   * El caso mas traicionero de este endpoint: la peticion responde 00000 y la
   * posicion viene dentro de `failureList`. Darlo por bueno dejaria al operador
   * creyendo que ya no tiene riesgo abierto.
   */
  it('un rechazo dentro de la respuesta de exito cuenta como fallo', async () => {
    enrutar({
      alCerrar: (c, apiKey) =>
        apiKey.endsWith('002')
          ? {
              cuerpo: sobreOk({
                successList: [],
                failureList: [
                  { clientOid: c['clientOid'], errorCode: '22002', errorMsg: 'No position to close' }
                ]
              })
            }
          : { cuerpo: sobreOk({ successList: [{ orderId: 'ord' }], failureList: [] }) }
    });

    const plan = await motor.planificarCierre(peticion(4));
    const lote = await motor.ejecutarCierre(plan);

    const resumen = resumirLote(lote);
    expect(resumen.exito).toBe(3);
    expect(resumen.fallo).toBe(1);
    expect(lote.jobs.find((j) => j.estado === 'fallo')?.codigoBitget).toBe('22002');
  });

  /*
   * Cerrar algo que ya estaba cerrado no es un fallo. Bitget responde 22002 y
   * el panel lo cuenta como omitido: no hay nada que arreglar.
   */
  it('cerrar una posicion ya cerrada se cuenta como omitida', async () => {
    enrutar({
      alCerrar: () => ({
        cuerpo: { code: '22002', msg: 'No position to close', requestTime: 1, data: null }
      })
    });

    const plan = await motor.planificarCierre(peticion(3));
    const lote = await motor.ejecutarCierre(plan);

    const resumen = resumirLote(lote);
    expect(resumen.omitida).toBe(3);
    expect(resumen.fallo).toBe(0);
  });

  it('un fallo en una cuenta no impide cerrar las demas', async () => {
    enrutar({
      alCerrar: (_c, apiKey) =>
        apiKey.endsWith('003')
          ? { cuerpo: { code: '40018', msg: 'Invalid IP', requestTime: 1, data: null } }
          : { cuerpo: sobreOk({ successList: [{ orderId: 'ord' }], failureList: [] }) }
    });

    const plan = await motor.planificarCierre(peticion(8));
    const lote = await motor.ejecutarCierre(plan);

    expect(resumirLote(lote).exito).toBe(7);
    expect(resumirLote(lote).fallo).toBe(1);
  });

  it('los descartes viajan al informe: nadie queda sin aparecer', async () => {
    enrutar({ posicionesDe: (k) => (k.endsWith('002') ? [] : [posicion('long')]) });

    const plan = await motor.planificarCierre(peticion(5));
    const lote = await motor.ejecutarCierre(plan);

    expect(lote.jobs).toHaveLength(5);
    expect(resumirLote(lote).omitida).toBe(1);
  });
});

describe('lo indeterminado se resuelve mirando la posicion', () => {
  /*
   * Es la diferencia de fondo con la apertura: la verdad de un cierre no es que
   * numero de orden devolvio el exchange, sino si la posicion sigue ahi.
   */
  it('si la posicion ya no esta, el cierre se dio por hecho', async () => {
    let cerrada = false;
    exchange.responderCon((p) => {
      if (p.url.startsWith('/api/v2/mix/position/all-position')) {
        return { cuerpo: sobreOk(cerrada ? [] : [posicion('long')]) };
      }
      if (p.url.startsWith('/api/v2/mix/order/close-positions')) {
        cerrada = true;
        return { estado: 502, cuerpo: 'corte' };
      }
      return null;
    });

    const plan = await motor.planificarCierre(peticion(1));
    const lote = await motor.ejecutarCierre(plan);

    expect(lote.jobs[0]?.estado).toBe('exito');
    expect(lote.jobs[0]?.mensaje).toContain('quedó cerrada');
  });

  it('si la posicion sigue abierta, se marca fallo reintentable', async () => {
    exchange.responderCon((p) => {
      if (p.url.startsWith('/api/v2/mix/position/all-position')) {
        return { cuerpo: sobreOk([posicion('long')]) };
      }
      if (p.url.startsWith('/api/v2/mix/order/close-positions')) {
        return { estado: 502, cuerpo: 'corte' };
      }
      return null;
    });

    const plan = await motor.planificarCierre(peticion(1));
    const lote = await motor.ejecutarCierre(plan);

    expect(lote.jobs[0]?.estado).toBe('fallo');
    expect(lote.jobs[0]?.mensaje).toContain('sigue abierta');
  });

  it('si tampoco se puede comprobar, queda indeterminada', async () => {
    let planificado = false;
    exchange.responderCon((p) => {
      if (p.url.startsWith('/api/v2/mix/position/all-position')) {
        if (!planificado) return { cuerpo: sobreOk([posicion('long')]) };
        return { estado: 502, cuerpo: 'corte' };
      }
      if (p.url.startsWith('/api/v2/mix/order/close-positions')) {
        planificado = true;
        return { estado: 502, cuerpo: 'corte' };
      }
      return null;
    });

    const plan = await motor.planificarCierre(peticion(1));
    const lote = await motor.ejecutarCierre(plan);

    expect(lote.jobs[0]?.estado).toBe('indeterminada');
  });
});

describe('escala y reintento', () => {
  it('trescientas cuentas: todas se cierran y ninguna se repite', async () => {
    cuentas = new Cuentas(300);
    motor = new MotorLotes(cliente, cuentas, { tamanoBloque: 12, dormir: async () => undefined });
    enrutar({});

    const plan = await motor.planificarCierre(peticion(300));
    const lote = await motor.ejecutarCierre(plan);

    expect(plan.entradas).toHaveLength(300);
    expect(resumirLote(lote).exito).toBe(300);
    expect(new Set(lote.jobs.map((j) => j.clientOid)).size).toBe(300);
  }, 60_000);

  it('reintentar solo las fallidas reutiliza sus identificadores', async () => {
    let fallar = true;
    enrutar({
      alCerrar: (_c, apiKey) =>
        fallar && apiKey.endsWith('002')
          ? { cuerpo: { code: '40018', msg: 'Invalid IP', requestTime: 1, data: null } }
          : { cuerpo: sobreOk({ successList: [{ orderId: 'ord' }], failureList: [] }) }
    });

    const plan = await motor.planificarCierre(peticion(4));
    const primera = await motor.ejecutarCierre(plan);
    const fallido = primera.jobs.find((j) => j.estado === 'fallo');
    expect(fallido).toBeDefined();

    fallar = false;
    const reintento = await motor.ejecutarCierre(plan, [fallido?.clientOid ?? '']);

    expect(reintento.jobs.filter((j) => j.clientOid !== '')).toHaveLength(1);
    expect(reintento.jobs[0]?.clientOid).toBe(fallido?.clientOid);
    expect(reintento.jobs[0]?.estado).toBe('exito');
  });

  it('el doble clic no lanza dos cierres', async () => {
    enrutar({
      alCerrar: () => ({
        retrasoMs: 40,
        cuerpo: sobreOk({ successList: [{ orderId: 'ord' }], failureList: [] })
      })
    });

    const plan = await motor.planificarCierre(peticion(4));
    const primera = motor.ejecutarCierre(plan);
    await expect(motor.ejecutarCierre(plan)).rejects.toThrow(/ya se está enviando/);
    await primera;

    expect(exchange.peticiones.filter((p) => p.url.includes('close-positions'))).toHaveLength(4);
  });

  it('avisa del avance mientras cierra', async () => {
    const progreso: Lote[] = [];
    motor = new MotorLotes(cliente, cuentas, {
      dormir: async () => undefined,
      alProgresar: (l) => progreso.push(structuredClone(l))
    });
    enrutar({});

    const plan = await motor.planificarCierre(peticion(6));
    await motor.ejecutarCierre(plan);

    expect(progreso.length).toBeGreaterThan(1);
    expect(progreso[progreso.length - 1]?.terminadoEn).not.toBeNull();
  });
});
