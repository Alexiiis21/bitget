/**
 * El TP de cada posición cerrada: cómo se enlaza con el historial de planes y
 * cómo lo completa el sincronizador.
 */
import { describe, expect, it } from 'vitest';
import type { PosicionCerrada } from '@main/domain/posicion-cerrada';
import { planTpV2, planTpV3, takeProfitDe, type PlanTp } from '@main/historial/take-profit';
import {
  AlmacenHistorialMemoria,
  SOLAPE_MS,
  SincronizadorHistorial
} from '@main/historial/sincronizador';

const AHORA = Date.parse('2026-10-29T12:00:00.000Z');
const HORA = 3_600_000;

const posicion = (extra: Partial<PosicionCerrada> = {}): PosicionCerrada => ({
  positionId: 'p1',
  symbol: 'PEPEUSDT',
  lado: 'short',
  modoMargen: 'crossed',
  apalancamiento: null,
  abiertaEnMs: AHORA - 10 * HORA,
  cerradaEnMs: AHORA - 2 * HORA,
  precioEntrada: '0.0000048531',
  precioSalida: '0.0000049576',
  cantidadCierre: '11012000',
  resultado: '-1.2145',
  porcentaje: null,
  pnlPrecio: '-1.15',
  comisiones: '-0.06',
  financiamiento: '0',
  superficie: 'v2',
  ...extra
});

const plan = (extra: Partial<PlanTp> = {}): PlanTp => ({
  symbol: 'PEPEUSDT',
  lado: 'short',
  precio: '0.0000047',
  creadoEnMs: AHORA - 10 * HORA + 2_000,
  terminadoEnMs: AHORA - 2 * HORA + 500,
  ejecutado: false,
  ...extra
});

describe('lectura de planes', () => {
  it('V2: solo los TP, con su precio de disparo', () => {
    const base = {
      symbol: 'BTCUSDT',
      posSide: 'short',
      triggerPrice: '79037.5',
      planStatus: 'executed',
      cTime: '1787682572822',
      uTime: '1787684019792'
    };
    expect(planTpV2({ ...base, planType: 'pos_profit' })).toEqual({
      symbol: 'BTCUSDT',
      lado: 'short',
      precio: '79037.5',
      creadoEnMs: 1787682572822,
      terminadoEnMs: 1787684019792,
      ejecutado: true
    });
    expect(planTpV2({ ...base, planType: 'pos_loss' })).toBeNull();
  });

  it('V3: el campo takeProfit; un plan solo de SL no cuenta', () => {
    const base = {
      symbol: 'BTCUSDT',
      posSide: 'long',
      status: 'cancelled',
      createdTime: '1791087440939',
      updatedTime: '1791087458303'
    };
    expect(planTpV3({ ...base, takeProfit: '84783.6', stopLoss: '' })).toMatchObject({
      precio: '84783.6',
      lado: 'long',
      ejecutado: false
    });
    expect(planTpV3({ ...base, takeProfit: '', stopLoss: '80000' })).toBeNull();
  });
});

describe('takeProfitDe', () => {
  it('el TP que Bitget canceló al cerrar la posición', () => {
    expect(takeProfitDe(posicion(), [plan()])).toEqual({
      precio: '0.0000047',
      colocadoEnMs: AHORA - 10 * HORA + 2_000,
      disparadoEnMs: null
    });
  });

  it('no mezcla otro par ni el otro lado', () => {
    expect(takeProfitDe(posicion(), [plan({ symbol: 'BTCUSDT' }), plan({ lado: 'long' })])).toBe(
      null
    );
  });

  it('un TP quitado a mano antes del cierre no estaba colocado', () => {
    expect(takeProfitDe(posicion(), [plan({ terminadoEnMs: AHORA - 5 * HORA })])).toBeNull();
  });

  it('el de una posición anterior del mismo par y lado no cuenta', () => {
    expect(
      takeProfitDe(posicion(), [
        plan({ creadoEnMs: AHORA - 20 * HORA, terminadoEnMs: AHORA - 10 * HORA - 8_000 })
      ])
    ).toBeNull();
  });

  it('entre varios vivos al cerrar, gana el ejecutado y después el más reciente', () => {
    const viejo = plan({ precio: '1', creadoEnMs: AHORA - 9 * HORA });
    const nuevo = plan({ precio: '2', creadoEnMs: AHORA - 3 * HORA });
    expect(takeProfitDe(posicion(), [viejo, nuevo])?.precio).toBe('2');
    const disparado = takeProfitDe(posicion(), [{ ...viejo, ejecutado: true }, nuevo]);
    expect(disparado).toMatchObject({ precio: '1', disparadoEnMs: viejo.terminadoEnMs });
  });
});

describe('el sincronizador completa el TP', () => {
  const montar = (
    posiciones: PosicionCerrada[],
    planesTp: (d: number, h: number) => Promise<PlanTp[]>
  ) => {
    const almacen = new AlmacenHistorialMemoria();
    const sync = new SincronizadorHistorial({
      almacen,
      cuenta: () => ({
        uid: 'u1',
        fuente: () => Promise.resolve({ posiciones }),
        planesTp
      }),
      ahoraMs: () => AHORA,
      dormir: () => Promise.resolve()
    });
    return { almacen, sync };
  };

  it('pone el precio, marca «sin TP» lo cerrado hace rato y deja pendiente lo recién cerrado', async () => {
    const reciente = posicion({
      positionId: 'p3',
      abiertaEnMs: AHORA - HORA,
      cerradaEnMs: AHORA - SOLAPE_MS / 2
    });
    const { almacen, sync } = montar(
      [posicion(), posicion({ positionId: 'p2', lado: 'long' }), reciente],
      () => Promise.resolve([plan()])
    );

    await sync.sincronizar('c1');
    const h = await almacen.leer('c1', 'u1');

    expect(h?.posiciones['p1']?.tp?.precio).toBe('0.0000047');
    expect(h?.posiciones['p2']?.tp).toBeNull();
    expect(h?.posiciones['p3']?.tp).toBeUndefined();
  });

  it('si los planes no se pueden leer, el historial se guarda igual', async () => {
    const { almacen, sync } = montar([posicion()], () => Promise.reject(new Error('sin red')));

    await expect(sync.sincronizar('c1')).resolves.toMatchObject({ total: 1 });
    expect((await almacen.leer('c1', 'u1'))?.posiciones['p1']?.tp).toBeUndefined();
  });
});
