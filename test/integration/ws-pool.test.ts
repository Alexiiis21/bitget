/**
 * El pool de sockets, contra el servidor WebSocket local.
 *
 * Lo que se prueba es el reparto, que es lo que impide que el panel se bloquee
 * la IP:
 *
 *  1. Que no se abran mas sockets de los que caben, y que quien se queda fuera
 *     lo sepa -«modo REST» en pantalla, nunca degradar en silencio-.
 *  2. Que el presupuesto de conexiones se respete aunque haya huecos libres.
 *  3. Que una credencial rechazada no se reintente nunca: es la unica forma
 *     realista de agotar 240 conexiones en cinco minutos.
 *  4. Que enfriarse libere el hueco, y que el que quedo fuera lo ocupe.
 *  5. Que un `snapshot` y un `update` no se apliquen igual.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MERCADO_SIMULADO } from '@main/bitget/mercado';
import { PoolSockets, type CuentaSocket, type FuentePool } from '@main/bitget/ws/pool';
import { AlmacenPosiciones } from '@main/domain/almacen-posiciones';
import {
  empujonPlanes,
  empujonPosiciones,
  iniciarWsSimulado,
  type WsSimulado
} from '../mock-exchange/ws-servidor';

const SIMBOLO = 'SBTCSUSDT';

const posicionWs = (lado: 'long' | 'short', extra: Record<string, unknown> = {}): unknown => ({
  instId: SIMBOLO,
  holdSide: lado,
  total: '0.0157',
  marginCoin: 'SUSDT',
  marginMode: 'isolated',
  marginSize: '99.3',
  openPriceAvg: '63200.5',
  liquidationPrice: '57000.1',
  leverage: '10',
  ...extra
});

class Fuente implements FuentePool {
  readonly modoRest: { cuentaId: string; enModoRest: boolean }[] = [];
  readonly rechazos: string[] = [];
  calientes: string[] = [];
  viva = true;

  constructor(calientes: string[] = []) {
    this.calientes = calientes;
  }

  cuentasCalientes(): CuentaSocket[] {
    return this.calientes.map((cuentaId) => ({
      cuentaId,
      credencial: { apiKey: `key_${cuentaId}`, secretKey: 's', passphrase: 'f' }
    }));
  }

  operativa(): boolean {
    return this.viva;
  }

  marcarModoRest(cuentaId: string, enModoRest: boolean): void {
    this.modoRest.push({ cuentaId, enModoRest });
  }

  alRechazarCredencial(cuentaId: string): void {
    this.rechazos.push(cuentaId);
  }
}

let servidor: WsSimulado;
let almacen: AlmacenPosiciones;
const creados: PoolSockets[] = [];

function crearPool(fuente: FuentePool, opciones = {}): PoolSockets {
  const pool = new PoolSockets(MERCADO_SIMULADO, almacen, fuente, {
    /* Sin latido propio: cada prueba llama a `revisar()` cuando le toca. */
    programar: () => null,
    cancelar: () => undefined,
    azar: () => 0.5,
    conexion: { url: servidor.url, pingMs: 10_000, esperaLoginMs: 500 },
    ...opciones
  });
  creados.push(pool);
  return pool;
}

const cuentas = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `cta_${String(i + 1).padStart(3, '0')}`);

beforeEach(async () => {
  servidor = await iniciarWsSimulado();
  almacen = new AlmacenPosiciones();
});

afterEach(async () => {
  for (const p of creados) p.detener();
  creados.length = 0;
  await servidor.cerrar();
});

describe('reparto del cupo', () => {
  it('abre un socket por cuenta caliente', async () => {
    const fuente = new Fuente(cuentas(3));
    const pool = crearPool(fuente);

    pool.iniciar();
    await vi.waitFor(() => expect(pool.vivos).toHaveLength(3));

    expect(servidor.conectados()).toBe(3);
  });

  it('no pasa del tope de sockets, y avisa a quien se queda fuera', async () => {
    const fuente = new Fuente(cuentas(5));
    const pool = crearPool(fuente, { maxConcurrentes: 3 });

    pool.iniciar();
    await vi.waitFor(() => expect(pool.vivos).toHaveLength(3));
    pool.revisar();

    expect(pool.ocupados).toBe(3);
    const fuera = fuente.modoRest.filter((m) => m.enModoRest).map((m) => m.cuentaId);
    expect(fuera).toEqual(['cta_004', 'cta_005']);
  });

  it('el orden de prioridad decide quien se queda fuera', async () => {
    /* La fuente pone primero a quien ya tiene posiciones; el pool lo respeta. */
    const fuente = new Fuente(['con-posicion-1', 'con-posicion-2', 'solo-objetivo']);
    const pool = crearPool(fuente, { maxConcurrentes: 2 });

    pool.iniciar();
    await vi.waitFor(() => expect(pool.vivos).toHaveLength(2));

    expect(pool.vivos.sort()).toEqual(['con-posicion-1', 'con-posicion-2']);
  });

  it('el presupuesto de conexiones limita aunque sobren huecos', async () => {
    const fuente = new Fuente(cuentas(6));
    /* Dos conexiones de presupuesto y sitio para diez: manda el presupuesto. */
    const pool = crearPool(fuente, { maxConcurrentes: 10, presupuestoConexiones: 2 });

    pool.iniciar();
    await vi.waitFor(() => expect(pool.vivos.length).toBeGreaterThan(0));
    pool.revisar();

    expect(pool.ocupados).toBe(2);
  });

  it('el arranque escalonado reparte las conexiones entre segundos', () => {
    const fuente = new Fuente(cuentas(10));
    let t = 1_000_000;
    const pool = crearPool(fuente, {
      maxConcurrentes: 10,
      arranquePorSegundo: 2,
      ahora: () => t
    });

    pool.iniciar();
    expect(pool.ocupados).toBe(2);

    /* Sin avanzar el reloj no hay mas cupo del segundo, por mucho que se revise. */
    pool.revisar();
    expect(pool.ocupados).toBe(2);

    t += 1_000;
    pool.revisar();
    expect(pool.ocupados).toBe(4);
  });
});

describe('caidas y credenciales', () => {
  it('una credencial rechazada no se reintenta nunca mas', async () => {
    servidor.configurar({ login: { ok: false, code: '30012', msg: 'invalid sign' } });
    const fuente = new Fuente(['cta_001']);
    const pool = crearPool(fuente);

    pool.iniciar();
    await vi.waitFor(() => expect(fuente.rechazos).toEqual(['cta_001']));

    /* Aunque siga caliente y aunque sobre cupo: no se vuelve a intentar. */
    const antes = servidor.conexionesTotales();
    pool.revisar();
    pool.revisar();
    await new Promise((r) => setTimeout(r, 30));

    expect(servidor.conexionesTotales()).toBe(antes);
    expect(fuente.modoRest.at(-1)).toEqual({ cuentaId: 'cta_001', enModoRest: true });
  });

  it('una caida transitoria espera su backoff antes de reconectar', async () => {
    const fuente = new Fuente(['cta_001']);
    let t = 1_000_000;
    const pool = crearPool(fuente, { ahora: () => t });

    pool.iniciar();
    await vi.waitFor(() => expect(pool.vivos).toHaveLength(1));

    servidor.cortar();
    await vi.waitFor(() => expect(pool.ocupados).toBe(0));

    const trasCaida = servidor.conexionesTotales();
    pool.revisar();
    expect(servidor.conexionesTotales()).toBe(trasCaida);

    /* Pasado el backoff -1 s en el primer intento- si vuelve. */
    t += 2_000;
    pool.revisar();
    await vi.waitFor(() => expect(servidor.conexionesTotales()).toBe(trasCaida + 1));
  });

  it('reconectar saca a la cuenta de modo REST', async () => {
    const fuente = new Fuente(['cta_001']);
    let t = 1_000_000;
    const pool = crearPool(fuente, { ahora: () => t });

    pool.iniciar();
    await vi.waitFor(() => expect(pool.vivos).toHaveLength(1));

    servidor.cortar();
    await vi.waitFor(() => expect(fuente.modoRest.at(-1)?.enModoRest).toBe(true));

    t += 2_000;
    pool.revisar();
    await vi.waitFor(() => expect(fuente.modoRest.at(-1)?.enModoRest).toBe(false));
  });
});

describe('frio y caliente', () => {
  it('enfriarse libera el hueco y lo ocupa quien estaba fuera', async () => {
    const fuente = new Fuente(['cta_001', 'cta_002']);
    const pool = crearPool(fuente, { maxConcurrentes: 1 });

    pool.iniciar();
    await vi.waitFor(() => expect(pool.vivos).toEqual(['cta_001']));

    /* La primera cierra su posicion: deja de estar caliente. */
    fuente.calientes = ['cta_002'];
    pool.revisar();
    await vi.waitFor(() => expect(pool.vivos).toEqual(['cta_002']));
  });

  it('bloquear el panel cierra todos los sockets', async () => {
    const fuente = new Fuente(cuentas(3));
    const pool = crearPool(fuente);

    pool.iniciar();
    await vi.waitFor(() => expect(pool.vivos).toHaveLength(3));

    fuente.viva = false;
    pool.revisar();

    expect(pool.ocupados).toBe(0);
    await vi.waitFor(() => expect(servidor.conectados()).toBe(0));
  });
});

describe('lo que llega por el socket', () => {
  const conPool = async (): Promise<Fuente> => {
    const fuente = new Fuente(['cta_001']);
    const pool = crearPool(fuente);
    pool.iniciar();
    await vi.waitFor(() => expect(pool.vivos).toHaveLength(1));
    return fuente;
  };

  it('una foto sustituye las posiciones de la cuenta', async () => {
    await conPool();

    servidor.empujar(empujonPosiciones('snapshot', [posicionWs('long'), posicionWs('short')]));
    await vi.waitFor(() => expect(almacen.tamano).toBe(2));

    servidor.empujar(empujonPosiciones('snapshot', [posicionWs('long')]));
    await vi.waitFor(() => expect(almacen.tamano).toBe(1));
  });

  it('un cambio suelto no borra las demas posiciones', async () => {
    await conPool();

    servidor.empujar(empujonPosiciones('snapshot', [posicionWs('long'), posicionWs('short')]));
    await vi.waitFor(() => expect(almacen.tamano).toBe(2));

    servidor.empujar(empujonPosiciones('update', [posicionWs('long', { total: '0.02' })]));
    await vi.waitFor(() =>
      expect(almacen.deCuenta('cta_001').find((p) => p.lado === 'long')?.tamano).toBe('0.02')
    );

    expect(almacen.tamano).toBe(2);
  });

  it('un tamano de cero cierra la posicion', async () => {
    await conPool();

    servidor.empujar(empujonPosiciones('snapshot', [posicionWs('long')]));
    await vi.waitFor(() => expect(almacen.tamano).toBe(1));

    servidor.empujar(empujonPosiciones('update', [posicionWs('long', { total: '0' })]));
    await vi.waitFor(() => expect(almacen.tamano).toBe(0));
  });

  it('el Take Profit llega por su canal y se pega a su punta', async () => {
    await conPool();

    servidor.empujar(empujonPosiciones('snapshot', [posicionWs('long')]));
    await vi.waitFor(() => expect(almacen.tamano).toBe(1));

    servidor.empujar(
      empujonPlanes('update', [
        {
          instId: SIMBOLO,
          orderId: 'plan_1',
          planType: 'pos_profit',
          triggerPrice: '66000',
          posSide: 'long',
          status: 'live'
        }
      ])
    );

    await vi.waitFor(() =>
      expect(almacen.deCuenta('cta_001')[0]?.takeProfit?.precio).toBe('66000')
    );
  });

  it('un Stop Loss no se confunde con un Take Profit', async () => {
    await conPool();

    servidor.empujar(empujonPosiciones('snapshot', [posicionWs('long')]));
    await vi.waitFor(() => expect(almacen.tamano).toBe(1));

    servidor.empujar(
      empujonPlanes('update', [
        {
          instId: SIMBOLO,
          orderId: 'plan_sl',
          planType: 'pos_loss',
          triggerPrice: '55000',
          posSide: 'long',
          status: 'live'
        }
      ])
    );
    await new Promise((r) => setTimeout(r, 40));

    /* El precio al que la posicion cierra en perdidas no puede salir en la columna del TP. */
    expect(almacen.deCuenta('cta_001')[0]?.takeProfit).toBeNull();
  });

  it('un plan cancelado quita el Take Profit del monitor', async () => {
    await conPool();

    servidor.empujar(empujonPosiciones('snapshot', [posicionWs('long')]));
    servidor.empujar(
      empujonPlanes('update', [
        { instId: SIMBOLO, orderId: 'plan_1', planType: 'pos_profit', triggerPrice: '66000', posSide: 'long', status: 'live' }
      ])
    );
    await vi.waitFor(() => expect(almacen.deCuenta('cta_001')[0]?.takeProfit).not.toBeNull());

    servidor.empujar(
      empujonPlanes('update', [
        { instId: SIMBOLO, orderId: 'plan_1', planType: 'pos_profit', triggerPrice: '66000', posSide: 'long', status: 'cancelled' }
      ])
    );

    await vi.waitFor(() => expect(almacen.deCuenta('cta_001')[0]?.takeProfit).toBeNull());
  });
});
