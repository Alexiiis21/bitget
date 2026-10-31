/**
 * El sincronizador del historial: una sincronización por cuenta, incremental,
 * idempotente y que no recrea lo que se borró.
 *
 * La fuente de páginas es falsa y controlable: se puede detener a mitad para
 * provocar las carreras que importan —doble clic, baja de la cuenta durante la
 * consulta— en vez de esperar a que ocurran solas.
 */
import { describe, expect, it } from 'vitest';
import type { ConsultaPaginaHistorial } from '@main/bitget/rest/endpoints/historial-v3';
import type { PaginaHistorial, PosicionCerrada } from '@main/domain/posicion-cerrada';
import { ampliarCobertura } from '@main/historial/historial-cuenta';
import {
  AlmacenHistorialMemoria,
  SOLAPE_MS,
  SincronizadorHistorial,
  type CuentaHistorial
} from '@main/historial/sincronizador';
import { HISTORIAL_VENTANA_MS } from '@shared/constants';
import { posicionesSeguidas } from '../mock-exchange/historial-simulado';

const AHORA = Date.parse('2026-10-12T12:00:00.000Z');

const posicion = (id: string): PosicionCerrada => ({
  positionId: id,
  symbol: 'BTCUSDT',
  lado: 'long',
  modoMargen: 'isolated',
  apalancamiento: null,
  abiertaEnMs: AHORA - 2_000,
  cerradaEnMs: AHORA - 1_000,
  precioEntrada: '1',
  precioSalida: '1',
  cantidadCierre: '1',
  resultado: '1',
  porcentaje: null,
  pnlPrecio: '1',
  comisiones: '0',
  financiamiento: '0',
  superficie: 'v3'
});

/** Una página por llamada, en orden; registra las consultas. */
function fuenteDe(paginas: PaginaHistorial[]) {
  const consultas: ConsultaPaginaHistorial[] = [];
  let i = 0;
  const fuente = (c: ConsultaPaginaHistorial): Promise<PaginaHistorial> => {
    consultas.push(c);
    return Promise.resolve(paginas[i++] ?? { posiciones: [] });
  };
  return { fuente, consultas };
}

function montar(cuentas: Map<string, CuentaHistorial>, ahora = (): number => AHORA) {
  const almacen = new AlmacenHistorialMemoria();
  const sync = new SincronizadorHistorial({
    almacen,
    cuenta: (id) => cuentas.get(id) ?? null,
    ahoraMs: ahora,
    dormir: () => Promise.resolve()
  });
  return { almacen, sync };
}

describe('primera sincronización', () => {
  it('pide los 90 días que guarda Bitget y declara cubierto ese tramo', async () => {
    const { fuente, consultas } = fuenteDe([{ posiciones: [posicion('a'), posicion('b')] }]);
    const { sync, almacen } = montar(new Map([['c1', { uid: 'u1', fuente }]]));

    const r = await sync.sincronizar('c1');

    expect(consultas[0]).toMatchObject({ desdeMs: AHORA - HISTORIAL_VENTANA_MS, hastaMs: AHORA });
    expect(r).toMatchObject({
      nuevas: 2,
      total: 2,
      hueco: false,
      cobertura: { desdeMs: AHORA - HISTORIAL_VENTANA_MS, hastaMs: AHORA }
    });
    expect(Object.keys((await almacen.leer('c1', 'u1'))?.posiciones ?? {})).toEqual(['a', 'b']);
  });
});

describe('incremental e idempotente', () => {
  it('la segunda pide solo desde el final de la anterior menos el solape, y no duplica', async () => {
    let ahora = AHORA;
    const paginas: PaginaHistorial[] = [
      { posiciones: [posicion('a')] },
      /* La segunda vuelve a traer `a` por el solape, más una nueva. */
      { posiciones: [posicion('a'), posicion('b')] }
    ];
    const { fuente, consultas } = fuenteDe(paginas);
    const { sync } = montar(new Map([['c1', { uid: 'u1', fuente }]]), () => ahora);

    await sync.sincronizar('c1');
    ahora += 3_600_000;
    const r = await sync.sincronizar('c1');

    expect(consultas[1]).toMatchObject({ desdeMs: AHORA - SOLAPE_MS, hastaMs: ahora });
    expect(r).toMatchObject({ nuevas: 1, total: 2, hueco: false });
    expect(r.cobertura).toEqual({ desdeMs: AHORA - HISTORIAL_VENTANA_MS, hastaMs: ahora });
  });
});

describe('una sola sincronización por cuenta', () => {
  it('dos llamadas simultáneas comparten el recorrido y su resultado', async () => {
    let soltar: () => void = () => undefined;
    const freno = new Promise<void>((r) => {
      soltar = r;
    });
    let llamadas = 0;
    const fuente = async (): Promise<PaginaHistorial> => {
      llamadas++;
      await freno;
      return { posiciones: [posicion('a')] };
    };
    const { sync } = montar(new Map([['c1', { uid: 'u1', fuente }]]));

    const p1 = sync.sincronizar('c1');
    const p2 = sync.sincronizar('c1');
    expect(p2).toBe(p1);
    soltar();
    await Promise.all([p1, p2]);

    expect(llamadas).toBe(1);
  });

  it('terminada una, la siguiente sí sale a la red', async () => {
    const { fuente, consultas } = fuenteDe([]);
    const { sync } = montar(new Map([['c1', { uid: 'u1', fuente }]]));

    await sync.sincronizar('c1');
    await sync.sincronizar('c1');
    expect(consultas).toHaveLength(2);
  });
});

describe('fallo a mitad', () => {
  it('guarda las páginas que llegaron pero no amplía la cobertura', async () => {
    let i = 0;
    const fuente = (): Promise<PaginaHistorial> => {
      i++;
      /* Una página llena: el paginador pide la siguiente, y esa falla. */
      if (i === 1)
        return Promise.resolve({ posiciones: posicionesSeguidas('p', 100, AHORA - 1_000) });
      return Promise.reject(new Error('red caída'));
    };
    const { sync, almacen } = montar(new Map([['c1', { uid: 'u1', fuente }]]));

    await expect(sync.sincronizar('c1')).rejects.toThrow('red caída');

    const h = await almacen.leer('c1', 'u1');
    expect(Object.keys(h?.posiciones ?? {})).toHaveLength(100);
    expect(h?.cobertura).toBeNull();
  });
});

describe('baja de la cuenta durante la sincronización', () => {
  it('no recrea el historial que la baja borró', async () => {
    let soltar: () => void = () => undefined;
    const freno = new Promise<void>((r) => {
      soltar = r;
    });
    let i = 0;
    const fuente = async (): Promise<PaginaHistorial> => {
      i++;
      if (i === 2) await freno;
      /* Páginas llenas para que el paginador pida la siguiente; la tercera, vacía, cierra. */
      return { posiciones: i < 3 ? posicionesSeguidas(`p${i}-`, 100, AHORA - i * 1_000_000) : [] };
    };
    const cuentas = new Map([['c1', { uid: 'u1', fuente }]]);
    const { sync, almacen } = montar(cuentas);

    const enCurso = sync.sincronizar('c1');
    await new Promise((r) => setTimeout(r, 0));

    /* La sesión quita la cuenta del registro y luego pide olvidar. */
    cuentas.delete('c1');
    const olvido = sync.olvidar('c1');
    soltar();

    await expect(enCurso).rejects.toMatchObject({ motivo: 'cuenta-desconocida' });
    await olvido;
    expect(await almacen.leer('c1', 'u1')).toBeNull();
  });

  it('una cuenta que cambió de UID no ve el historial de la anterior', async () => {
    const { fuente } = fuenteDe([{ posiciones: [posicion('a')] }]);
    const { sync, almacen } = montar(new Map([['c1', { uid: 'u1', fuente }]]));
    await sync.sincronizar('c1');

    expect(await almacen.leer('c1', 'u2')).toBeNull();
  });
});

describe('ampliarCobertura', () => {
  it('une tramos que se tocan', () => {
    expect(ampliarCobertura({ desdeMs: 0, hastaMs: 100 }, { desdeMs: 90, hastaMs: 200 })).toEqual({
      desdeMs: 0,
      hastaMs: 200
    });
  });

  it('con un hueco en medio, solo queda el tramo nuevo', () => {
    expect(ampliarCobertura({ desdeMs: 0, hastaMs: 100 }, { desdeMs: 150, hastaMs: 200 })).toEqual({
      desdeMs: 150,
      hastaMs: 200
    });
  });

  it('el resumen marca el hueco cuando la cuenta pasó más de 90 días sin sincronizar', async () => {
    let ahora = AHORA;
    const { fuente } = fuenteDe([]);
    const { sync } = montar(new Map([['c1', { uid: 'u1', fuente }]]), () => ahora);

    await sync.sincronizar('c1');
    ahora += 2 * HISTORIAL_VENTANA_MS;
    const r = await sync.sincronizar('c1');

    expect(r.hueco).toBe(true);
    expect(r.cobertura).toEqual({ desdeMs: ahora - HISTORIAL_VENTANA_MS, hastaMs: ahora });
  });
});
