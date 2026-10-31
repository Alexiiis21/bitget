/**
 * Alertas: lectura de los registros de Bitget y la regla de «¿lo hizo el panel?».
 *
 * Los registros son respuestas reales capturadas el 15/10/2026, una por cada
 * combinación observada (fixture `test/fixtures/alertas/bitget-registros.json`).
 * Lo que se prueba es lo que decide si llega o no una alerta: que lo
 * automático no avise, que lo del panel no avise y que lo demás sí.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  listaDe,
  movimientoV2AEvento,
  movimientoV3AEvento,
  ordenV2AEvento,
  ordenV3AEvento,
  planV2AEventos,
  planV3AEventos
} from '@main/alertas/fuentes';
import {
  ajustePropio,
  clasificar,
  esAutomatico,
  unirTpDeApertura
} from '@main/alertas/clasificador';
import type { EventoCuenta } from '@main/alertas/tipos';
import type { AccionPropia } from '@main/storage/bitacora-acciones';

type Registro = Record<string, unknown>;
const fixture = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'alertas', 'bitget-registros.json'), 'utf8')
) as Record<string, unknown>;
const de = (clave: string): Registro[] => listaDe(fixture[clave]);
const busca = (clave: string, f: (r: Registro) => boolean): Registro => {
  const r = de(clave).find(f);
  if (r === undefined) throw new Error(`no hay ${clave} que cumpla`);
  return r;
};

describe('órdenes V2 (capturadas)', () => {
  it('la apertura del panel lleva clientOid pcb y no es automática', () => {
    const e = ordenV2AEvento(
      busca('v2_orders_history', (o) => String(o['clientOid']).startsWith('pcb'))
    );
    expect(e).toMatchObject({ tipo: 'abrir', automatico: false, origen: 'api' });
    expect(e?.clientOid?.startsWith('pcb')).toBe(true);
  });

  it('un TP disparado es automático (orderSource pos_profit_market)', () => {
    const e = ordenV2AEvento(
      busca('v2_orders_history', (o) => o['orderSource'] === 'pos_profit_market')
    );
    expect(e).toMatchObject({ tipo: 'cerrar', automatico: true });
  });

  it('una liquidación es automática (tradeSide burst_close_long, origen sys)', () => {
    const e = ordenV2AEvento(
      busca('v2_orders_history', (o) => o['tradeSide'] === 'burst_close_long')
    );
    expect(e).toMatchObject({ tipo: 'cerrar', lado: 'long', automatico: true });
  });

  it('el cierre del panel llega sin pcb y sin marca de automático: lo decide la bitácora', () => {
    const e = ordenV2AEvento(
      busca('v2_orders_history', (o) => o['tradeSide'] === 'close' && o['orderSource'] === 'market')
    );
    expect(e).toMatchObject({ tipo: 'cerrar', automatico: false });
    expect(e?.clientOid?.startsWith('pcb')).toBe(false);
  });

  it('una orden sin ejecutar no es un evento', () => {
    expect(ordenV2AEvento({ orderId: '1', status: 'cancelled', baseVolume: '0' })).toBeNull();
  });
});

describe('planes y movimientos V2 (capturados)', () => {
  it('un TP ejecutado da un solo evento: cuando se puso', () => {
    const ev = planV2AEventos(busca('v2_plan_history', (p) => p['planStatus'] === 'executed'));
    expect(ev.map((e) => e.tipo)).toEqual(['tp-sl-puesto']);
    expect(ev[0]).toMatchObject({ detalle: 'TP' });
  });

  it('uno cancelado da dos, y el de «quitado» no hereda el clientOid', () => {
    const ev = planV2AEventos(busca('v2_plan_history', (p) => p['planStatus'] === 'cancelled'));
    expect(ev.map((e) => e.tipo)).toEqual(['tp-sl-puesto', 'tp-sl-quitado']);
    expect(ev[0]?.clientOid?.startsWith('pcb')).toBe(true);
    expect(ev[1]?.clientOid).toBeNull();
  });

  it('de los movimientos solo cuentan margen y traspasos', () => {
    const tipos = Object.fromEntries(
      de('v2_bill').map((b) => [b['businessType'], movimientoV2AEvento(b)?.tipo ?? null])
    );
    expect(tipos).toMatchObject({
      append_margin: 'margen-agregado',
      trans_from_contract: 'traspaso-entrada',
      trans_to_union: 'traspaso-salida',
      open_long: null,
      close_long: null,
      contract_settle_fee: null
    });
  });
});

describe('UTA (capturado)', () => {
  it('la orden V3 deduce abrir o cerrar del lado de la posición', () => {
    const e = ordenV3AEvento(
      busca('v3_history_orders', (o) => String(o['clientOid']).startsWith('pcb'))
    );
    expect(e?.tipo === 'abrir' || e?.tipo === 'cerrar').toBe(true);
    expect(e?.origen).toBeNull();
    expect(
      ordenV3AEvento({ orderId: '1', cumExecQty: '0.1', posSide: 'long', side: 'sell' })?.tipo
    ).toBe('cerrar');
    expect(
      ordenV3AEvento({ orderId: '1', cumExecQty: '0.1', posSide: 'short', side: 'sell' })?.tipo
    ).toBe('abrir');
  });

  it('un TP/SL cancelado en UTA da puesto y quitado', () => {
    const ev = planV3AEventos(de('v3_history_strategy_orders')[0] ?? {});
    expect(ev.map((e) => e.tipo)).toEqual(['tp-sl-puesto', 'tp-sl-quitado']);
  });

  it('INCREASE_MARGIN es agregar margen, con el importe en positivo', () => {
    const e = movimientoV3AEvento(
      busca('v3_financial_records', (r) => r['type'] === 'INCREASE_MARGIN')
    );
    expect(e).toMatchObject({ tipo: 'margen-agregado', importe: '0.1' });
    expect(
      movimientoV3AEvento(busca('v3_financial_records', (r) => r['type'] === 'MARGIN_OPEN_LONG'))
    ).toBeNull();
  });
});

describe('esAutomatico', () => {
  it('reconoce lo que genera Bitget solo, en cualquiera de sus campos', () => {
    expect(esAutomatico({ enterPointSource: 'sys' })).toBe(true);
    expect(esAutomatico({ tradeSide: 'burst_close_short' })).toBe(true);
    expect(esAutomatico({ orderSource: 'pos_loss_market' })).toBe(true);
    expect(esAutomatico({ delegateType: 'profit_market' })).toBe(true);
    expect(esAutomatico({ orderSource: 'market', enterPointSource: 'app' })).toBe(false);
    expect(esAutomatico({ orderSource: 'normal', enterPointSource: 'web' })).toBe(false);
  });
});

/* ---------------- clasificador ---------------- */

const T = 1_790_000_000_000;

const ev = (parcial: Partial<EventoCuenta> & Pick<EventoCuenta, 'tipo'>): EventoCuenta => ({
  clave: `k${Math.random()}`,
  cuandoMs: T,
  simbolo: 'BTCUSDT',
  lado: 'long',
  cantidad: '0.01',
  precio: '100000',
  importe: null,
  origen: 'app',
  clientOid: '1234567890',
  orderId: '555',
  automatico: false,
  detalle: null,
  ...parcial
});

const accion = (ruta: string, cuerpo: Record<string, unknown>, ts = T - 3_000): AccionPropia => ({
  ts,
  cuenta: 'h',
  metodo: 'POST',
  ruta,
  cuerpo
});

const ctx = (bitacora: AccionPropia[] = []) => ({ bitacora, traspasos: [], uid: '111' });

describe('clasificar', () => {
  it('lo automático no se avisa nunca', () => {
    expect(clasificar([ev({ tipo: 'cerrar', automatico: true })], ctx())).toEqual([]);
  });

  it('lo que lleva clientOid pcb es del panel', () => {
    expect(clasificar([ev({ tipo: 'abrir', clientOid: 'pcbabc1230l' })], ctx())).toEqual([]);
  });

  it('una apertura del cliente desde la app se avisa', () => {
    expect(clasificar([ev({ tipo: 'abrir' })], ctx())).toHaveLength(1);
  });

  it('un cierre sin pcb es del panel si hay un close-positions del mismo símbolo justo antes', () => {
    const b = [
      accion('/api/v2/mix/order/close-positions', { symbol: 'BTCUSDT', holdSide: 'long' })
    ];
    expect(clasificar([ev({ tipo: 'cerrar' })], ctx(b))).toEqual([]);
  });

  it('…y es externo si el close-positions fue de otro símbolo, otro lado o hace demasiado', () => {
    const cierre = ev({ tipo: 'cerrar' });
    expect(
      clasificar(
        [cierre],
        ctx([accion('/api/v2/mix/order/close-positions', { symbol: 'ETHUSDT' })])
      )
    ).toHaveLength(1);
    expect(
      clasificar(
        [cierre],
        ctx([accion('/api/v2/mix/order/close-positions', { symbol: 'BTCUSDT', holdSide: 'short' })])
      )
    ).toHaveLength(1);
    expect(
      clasificar(
        [cierre],
        ctx([accion('/api/v2/mix/order/close-positions', { symbol: 'BTCUSDT' }, T - 10 * 60_000)])
      )
    ).toHaveLength(1);
  });

  it('el margen del panel reconoce un solo movimiento: el segundo aporte igual es del cliente', () => {
    const b = [accion('/api/v2/mix/account/set-margin', { symbol: 'BTCUSDT', amount: '0.1' })];
    const externos = clasificar(
      [
        ev({ tipo: 'margen-agregado', importe: '0.1', clave: 'm1' }),
        ev({ tipo: 'margen-agregado', importe: '0.1', clave: 'm2', cuandoMs: T + 1_000 })
      ],
      ctx(b)
    );
    expect(externos.map((e) => e.clave)).toEqual(['m2']);
  });

  it('set-margin-mode no se confunde con agregar margen', () => {
    const b = [accion('/api/v2/mix/account/set-margin-mode', { symbol: 'BTCUSDT', amount: '0.1' })];
    expect(clasificar([ev({ tipo: 'margen-agregado', importe: '0.1' })], ctx(b))).toHaveLength(1);
  });

  it('quitar un TP es del panel si la bitácora canceló ese orderId', () => {
    const b = [
      accion('/api/v2/mix/order/cancel-plan-order', {
        orderIdList: [{ orderId: '555' }],
        symbol: 'BTCUSDT'
      })
    ];
    expect(clasificar([ev({ tipo: 'tp-sl-quitado', clientOid: null })], ctx(b))).toEqual([]);
    expect(clasificar([ev({ tipo: 'tp-sl-quitado', clientOid: null })], ctx())).toHaveLength(1);
  });

  it('un TP que Bitget cancela al cerrarse la posición no es «quitar el TP»', () => {
    const cierre = ev({ tipo: 'cerrar', automatico: true, cuandoMs: T });
    const cancelado = ev({ tipo: 'tp-sl-quitado', clientOid: null, cuandoMs: T + 500 });
    expect(clasificar([cierre, cancelado], ctx())).toEqual([]);
  });

  it('un TP puesto desde la app se avisa; uno del panel en UTA (sin pcb) lo reconoce la bitácora', () => {
    expect(clasificar([ev({ tipo: 'tp-sl-puesto' })], ctx())).toHaveLength(1);
    const b = [accion('/api/v3/trade/place-strategy-order', { symbol: 'BTCUSDT' })];
    expect(clasificar([ev({ tipo: 'tp-sl-puesto' })], ctx(b))).toEqual([]);
  });

  it('un traspaso es del panel si está en su registro de traspasos', () => {
    const traspasos = [{ ts: T - 60_000, importe: '25', uidOrigen: '111', uidDestino: '222' }];
    const e = ev({ tipo: 'traspaso-salida', importe: '25', simbolo: null });
    expect(clasificar([e], { bitacora: [], traspasos, uid: '111' })).toEqual([]);
    expect(clasificar([e], { bitacora: [], traspasos, uid: '333' })).toHaveLength(1);
  });

  it('devuelve lo externo en orden cronológico', () => {
    const r = clasificar(
      [
        ev({ tipo: 'abrir', clave: 'b', cuandoMs: T + 5 }),
        ev({ tipo: 'abrir', clave: 'a', cuandoMs: T })
      ],
      ctx()
    );
    expect(r.map((e) => e.clave)).toEqual(['a', 'b']);
  });
});

describe('unirTpDeApertura', () => {
  it('el TP que Bitget crea con la orden va dentro de la apertura, sin «parcial»', () => {
    const r = unirTpDeApertura([
      ev({ tipo: 'abrir', clave: 'orden:1' }),
      ev({
        tipo: 'tp-sl-puesto',
        clave: 'plan:9:puesto',
        cuandoMs: T + 104,
        precio: '81227.7',
        detalle: 'TP parcial',
        origen: 'sys'
      })
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      tipo: 'abrir',
      detalle: 'TP 81227.7',
      incluye: ['plan:9:puesto']
    });
  });

  it('TP y SL de la misma orden van los dos', () => {
    const r = unirTpDeApertura([
      ev({ tipo: 'abrir', clave: 'a' }),
      ev({
        tipo: 'tp-sl-puesto',
        clave: 'tp',
        cuandoMs: T + 100,
        precio: '110',
        detalle: 'TP parcial'
      }),
      ev({
        tipo: 'tp-sl-puesto',
        clave: 'sl',
        cuandoMs: T + 120,
        precio: '90',
        detalle: 'SL parcial'
      })
    ]);
    expect(r.map((e) => e.detalle)).toEqual(['TP 110 y SL 90']);
  });

  it('un TP de otro símbolo, otro lado o puesto más tarde sale aparte', () => {
    const tp = (p: Partial<EventoCuenta>): EventoCuenta =>
      ev({ tipo: 'tp-sl-puesto', clave: 'tp', cuandoMs: T + 100, detalle: 'TP', ...p });
    const abrir = ev({ tipo: 'abrir', clave: 'a' });
    expect(unirTpDeApertura([abrir, tp({ simbolo: 'ETHUSDT' })])).toHaveLength(2);
    expect(unirTpDeApertura([abrir, tp({ lado: 'short' })])).toHaveLength(2);
    expect(unirTpDeApertura([abrir, tp({ cuandoMs: T + 60_000 })])).toHaveLength(2);
  });

  it('sin la apertura en la lista, el TP no se calla', () => {
    const r = unirTpDeApertura([ev({ tipo: 'tp-sl-puesto', clave: 'tp' })]);
    expect(r.map((e) => e.clave)).toEqual(['tp']);
  });
});

describe('ajustePropio', () => {
  it('un cambio de apalancamiento lo pudo hacer el panel si hubo set-leverage del símbolo desde la revisión', () => {
    const b = [
      accion('/api/v2/mix/account/set-leverage', { symbol: 'BTCUSDT', leverage: '20' }, T)
    ];
    expect(ajustePropio(b, 'BTCUSDT', T - 60_000)).toBe(true);
    expect(ajustePropio(b, 'ETHUSDT', T - 60_000)).toBe(false);
    expect(ajustePropio(b, 'BTCUSDT', T + 60_000)).toBe(false);
  });
});
