/**
 * Agregar margen y ajustar apalancamiento, contra el exchange simulado.
 *
 * --------------------------------------------------------------------------
 * Por que estas dos van juntas
 * --------------------------------------------------------------------------
 * Son las dos caras de la misma moneda y se comportan al reves la una de la
 * otra, asi que probarlas en el mismo archivo deja la diferencia a la vista:
 *
 *   agregar margen    no tiene identificador propio -> reenviar puede duplicar
 *                     el dinero comprometido, y por eso lo indeterminado se
 *                     resuelve releyendo el margen de la posicion.
 *   apalancamiento    fijar 150x dos veces deja 150x -> reenviar es inofensivo.
 *
 * El cliente marco el margen como lo mas critico de todo, y de ahi que su
 * planificacion compruebe tres cosas antes de enviar: posicion, modo aislado y
 * saldo.
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

const posicion = (lado: 'long' | 'short', margen = '100', modo = 'isolated'): unknown => ({
  symbol: SIMBOLO,
  holdSide: lado,
  total: '0.0157',
  available: '0.0157',
  marginCoin: 'SUSDT',
  marginMode: modo,
  openPriceAvg: '63000',
  liquidationPrice: '62370',
  leverage: '10',
  marginSize: margen
});

class Cuentas implements FuenteCuentas {
  private readonly mapa = new Map<string, CuentaEjecutable>();

  constructor(cuantas: number, saldo = '3000') {
    for (let i = 1; i <= cuantas; i += 1) {
      const id = `cta_${String(i).padStart(3, '0')}`;
      this.mapa.set(id, {
        cuentaId: id,
        etiqueta: `Sub-${String(i).padStart(2, '0')}`,
        credencial: { apiKey: `key_${id}`, secretKey: 'secreto', passphrase: 'frase' },
        saldoDisponible: saldo,
        modoMargen: 'isolated',
        apalancamiento: { long: 10, short: 10, cruzado: 10 }
      });
    }
  }

  cuentaEjecutable(cuentaId: string): CuentaEjecutable | null {
    return this.mapa.get(cuentaId) ?? null;
  }

  fijarSaldo(cuentaId: string, saldo: string): void {
    const c = this.mapa.get(cuentaId);
    if (c) c.saldoDisponible = saldo;
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

/** Respuesta valida de set-leverage: el esquema exige simbolo y moneda. */
const apalancamientoFijado = (cuerpo: Record<string, unknown>): Respuesta => ({
  cuerpo: sobreOk({
    symbol: SIMBOLO,
    marginCoin: 'SUSDT',
    longLeverage: String(cuerpo['leverage']),
    shortLeverage: String(cuerpo['leverage']),
    crossMarginLeverage: String(cuerpo['leverage']),
    marginMode: 'isolated'
  })
});

function enrutar(opciones: {
  posicionesDe?: (apiKey: string) => unknown[];
  alAjustar?: (cuerpo: Record<string, unknown>, apiKey: string) => Respuesta;
  alApalancar?: (cuerpo: Record<string, unknown>, apiKey: string) => Respuesta;
  cuentaDe?: () => unknown;
}): void {
  const posicionesDe = opciones.posicionesDe ?? (() => [posicion('long')]);
  const cuentaDe =
    opciones.cuentaDe ??
    (() => ({
      marginCoin: 'SUSDT',
      available: '3000',
      accountEquity: '3000',
      marginMode: 'isolated',
      posMode: 'hedge_mode',
      isolatedLongLever: 10,
      isolatedShortLever: 10,
      crossedMarginLeverage: 10
    }));
  const alAjustar = opciones.alAjustar ?? (() => ({ cuerpo: sobreOk({}) }));

  exchange.responderCon((p) => {
    const apiKey = String(p.cabeceras['access-key'] ?? '');
    if (p.url.startsWith('/api/v2/mix/market/contracts')) return { cuerpo: sobreOk([CONTRATO]) };
    if (p.url.startsWith('/api/v2/mix/position/all-position')) {
      return { cuerpo: sobreOk(posicionesDe(apiKey)) };
    }
    if (p.url.startsWith('/api/v2/mix/account/account')) return { cuerpo: sobreOk(cuentaDe()) };
    if (p.url.startsWith('/api/v2/mix/account/set-margin')) {
      return alAjustar(JSON.parse(p.cuerpo) as Record<string, unknown>, apiKey);
    }
    if (p.url.startsWith('/api/v2/mix/account/set-leverage')) {
      const cuerpo = JSON.parse(p.cuerpo) as Record<string, unknown>;
      return (opciones.alApalancar ?? apalancamientoFijado)(cuerpo, apiKey);
    }
    return null;
  });
}

const margen = (cuantas: number, cantidad = '50') => ({
  mercado: MERCADO_SIMULADO,
  simbolo: SIMBOLO,
  objetivos: cuentas.objetivos(cuantas),
  cantidad
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

describe('agregar margen · las tres puertas antes de enviar', () => {
  it('planifica y enseña el margen resultante sin enviar nada', async () => {
    enrutar({});

    const plan = await motor.planificarMargen(margen(3));

    expect(plan.entradas).toHaveLength(3);
    expect(plan.entradas[0]?.margenActual).toBe('100');
    expect(plan.entradas[0]?.margenResultante).toBe('150');
    expect(plan.totalComprometido).toBe('150');
    expect(exchange.peticiones.filter((p) => p.url.includes('set-margin'))).toHaveLength(0);
  });

  it('sin posicion no hay a que agregar margen', async () => {
    enrutar({ posicionesDe: (k) => (k.endsWith('002') ? [] : [posicion('long')]) });

    const plan = await motor.planificarMargen(margen(4));

    expect(plan.entradas).toHaveLength(3);
    expect(plan.descartes[0]?.motivo).toBe('sin-posicion');
  });

  /* Bitget responde 40808 en cruzado; decirlo aqui evita la peticion. */
  it('una posicion en margen cruzado se descarta con el motivo en castellano', async () => {
    enrutar({ posicionesDe: () => [posicion('long', '100', 'crossed')] });

    const plan = await motor.planificarMargen(margen(2));

    expect(plan.entradas).toHaveLength(0);
    expect(plan.descartes[0]?.motivo).toBe('margen-cruzado');
    expect(plan.descartes[0]?.mensaje).toContain('aislado');
  });

  /* Es dinero nuevo saliendo del saldo: enterarse a mitad del lote es tarde. */
  it('sin saldo suficiente se descarta antes de enviar', async () => {
    enrutar({});
    cuentas.fijarSaldo('cta_002', '10');

    const plan = await motor.planificarMargen(margen(3));

    expect(plan.entradas).toHaveLength(2);
    expect(plan.descartes[0]?.motivo).toBe('margen-insuficiente');
  });

  /*
   * Con long y short de la misma subcuenta el saldo tiene que dar para las dos.
   * Comprobar cada casilla contra el saldo entero dejaria pasar el doble.
   */
  it('el saldo se reparte entre las casillas de la misma cuenta', async () => {
    enrutar({ posicionesDe: () => [posicion('long'), posicion('short')] });
    cuentas.fijarSaldo('cta_001', '60');

    const plan = await motor.planificarMargen({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: [
        { cuentaId: 'cta_001', lado: 'long' },
        { cuentaId: 'cta_001', lado: 'short' }
      ],
      cantidad: '50'
    });

    expect(plan.entradas).toHaveLength(1);
    expect(plan.descartes[0]?.motivo).toBe('margen-insuficiente');
  });

  it('una cantidad invalida aborta el lote entero', async () => {
    enrutar({});
    await expect(motor.planificarMargen(margen(2, '0'))).rejects.toThrow(/mayor que cero/);
  });
});

describe('agregar margen · ejecucion', () => {
  it('envia la cantidad y el lado correctos', async () => {
    const cuerpos: Record<string, unknown>[] = [];
    enrutar({
      alAjustar: (c) => {
        cuerpos.push(c);
        return { cuerpo: sobreOk({}) };
      }
    });

    const plan = await motor.planificarMargen(margen(2));
    const lote = await motor.ejecutarMargen(plan);

    expect(lote.accion).toBe('agregar-margen');
    expect(resumirLote(lote).exito).toBe(2);
    expect(cuerpos[0]).toMatchObject({
      symbol: SIMBOLO,
      productType: 'SUSDT-FUTURES',
      marginCoin: 'SUSDT',
      amount: '50',
      holdSide: 'long'
    });
  });

  it('un fallo en una cuenta no impide las demas', async () => {
    enrutar({
      alAjustar: (_c, apiKey) =>
        apiKey.endsWith('003')
          ? { cuerpo: { code: '40808', msg: 'margin mode == FIXED', requestTime: 1, data: null } }
          : { cuerpo: sobreOk({}) }
    });

    const plan = await motor.planificarMargen(margen(5));
    const lote = await motor.ejecutarMargen(plan);

    expect(resumirLote(lote).exito).toBe(4);
    const fallo = lote.jobs.find((j) => j.estado === 'fallo');
    expect(fallo?.codigoBitget).toBe('40808');
    expect(fallo?.mensaje).toContain('aislado');
  });
});

describe('agregar margen · lo indeterminado se resuelve releyendo el margen', () => {
  /*
   * Aqui no hay `clientOid` que impida duplicar, asi que reintentar a ciegas
   * comprometeria el doble del dinero aprobado. La unica salida es comparar.
   */
  it('si el margen ya subio, se da por hecho', async () => {
    let aplicado = false;
    exchange.responderCon((p) => {
      if (p.url.startsWith('/api/v2/mix/position/all-position')) {
        return { cuerpo: sobreOk([posicion('long', aplicado ? '150' : '100')]) };
      }
      if (p.url.startsWith('/api/v2/mix/account/set-margin')) {
        aplicado = true;
        return { estado: 502, cuerpo: 'corte' };
      }
      return null;
    });

    const plan = await motor.planificarMargen(margen(1));
    const lote = await motor.ejecutarMargen(plan);

    expect(lote.jobs[0]?.estado).toBe('exito');
    expect(lote.jobs[0]?.mensaje).toContain('sí quedó agregado');
    /* Una sola llamada: no se reintento a ciegas. */
    expect(exchange.peticiones.filter((p) => p.url.includes('set-margin'))).toHaveLength(1);
  });

  it('si el margen sigue igual, se marca fallo reintentable', async () => {
    exchange.responderCon((p) => {
      if (p.url.startsWith('/api/v2/mix/position/all-position')) {
        return { cuerpo: sobreOk([posicion('long', '100')]) };
      }
      if (p.url.startsWith('/api/v2/mix/account/set-margin')) {
        return { estado: 502, cuerpo: 'corte' };
      }
      return null;
    });

    const plan = await motor.planificarMargen(margen(1));
    const lote = await motor.ejecutarMargen(plan);

    expect(lote.jobs[0]?.estado).toBe('fallo');
    expect(lote.jobs[0]?.mensaje).toContain('no se agregó');
  });
});

describe('apalancamiento', () => {
  const apalancar = (cuantas: number, valor = 125) => ({
    mercado: MERCADO_SIMULADO,
    simbolo: SIMBOLO,
    objetivos: cuentas.objetivos(cuantas),
    apalancamiento: valor
  });

  /* No necesita posicion: es configuracion de la cuenta. */
  it('planifica sin consultar posiciones', async () => {
    enrutar({});

    const plan = await motor.planificarApalancamiento(apalancar(5));

    expect(plan.entradas).toHaveLength(5);
    expect(plan.entradas[0]?.apalancamientoActual).toBe(10);
    expect(exchange.peticiones.filter((p) => p.url.includes('all-position'))).toHaveLength(0);
  });

  /* Fuera del rango del simbolo, Bitget respondería «Leverage ratio exceeded». */
  it('fuera del rango del simbolo aborta el lote sin gastar peticiones', async () => {
    enrutar({});

    await expect(motor.planificarApalancamiento(apalancar(3, 200))).rejects.toThrow(/125x/);
    expect(exchange.peticiones.filter((p) => p.url.includes('set-leverage'))).toHaveLength(0);
  });

  it('envia el valor y el lado, y cuenta el resultado', async () => {
    const cuerpos: Record<string, unknown>[] = [];
    enrutar({
      alApalancar: (c) => {
        cuerpos.push(c);
        return apalancamientoFijado(c);
      }
    });

    const plan = await motor.planificarApalancamiento(apalancar(3));
    const lote = await motor.ejecutarApalancamiento(plan);

    expect(lote.accion).toBe('apalancamiento');
    expect(resumirLote(lote).exito).toBe(3);
    expect(cuerpos[0]).toMatchObject({ leverage: '125', holdSide: 'long' });
    expect(lote.jobs[0]?.mensaje).toContain('125x');
  });

  /*
   * La propiedad que la hace la mas benigna: fijar el mismo valor dos veces
   * deja el mismo valor, asi que un corte de red se resuelve leyendo y ya.
   */
  it('lo indeterminado se resuelve leyendo como quedo la cuenta', async () => {
    exchange.responderCon((p) => {
      if (p.url.startsWith('/api/v2/mix/market/contracts')) return { cuerpo: sobreOk([CONTRATO]) };
      if (p.url.startsWith('/api/v2/mix/account/set-leverage')) {
        return { estado: 502, cuerpo: 'corte' };
      }
      if (p.url.startsWith('/api/v2/mix/account/account')) {
        return {
          cuerpo: sobreOk({
            marginCoin: 'SUSDT',
            available: '3000',
            accountEquity: '3000',
            marginMode: 'isolated',
            posMode: 'hedge_mode',
            isolatedLongLever: 125,
            isolatedShortLever: 125,
            crossedMarginLeverage: 10
          })
        };
      }
      return null;
    });

    const plan = await motor.planificarApalancamiento(apalancar(1));
    const lote = await motor.ejecutarApalancamiento(plan);

    expect(lote.jobs[0]?.estado).toBe('exito');
    expect(lote.jobs[0]?.mensaje).toContain('sí quedó fijado');
  });

  it('trescientas cuentas: todas quedan fijadas', async () => {
    cuentas = new Cuentas(300);
    motor = new MotorLotes(cliente, cuentas, { tamanoBloque: 12, dormir: async () => undefined });
    enrutar({});

    const plan = await motor.planificarApalancamiento({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: cuentas.objetivos(300),
      apalancamiento: 125
    });
    const lote = await motor.ejecutarApalancamiento(plan);

    expect(resumirLote(lote).exito).toBe(300);
  }, 60_000);
});
