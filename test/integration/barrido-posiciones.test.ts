/**
 * El barrido REST de posiciones y saldos, contra el exchange simulado.
 *
 * Lo que se prueba aqui es lo que separa un monitor util de uno peligroso:
 *
 *  1. Que un fallo de red **no** borre las posiciones que sigue habiendo.
 *  2. Que el Take Profit se lea aparte y solo cuando hay algo que proteger.
 *  3. Que quitar el Take Profit desde la app de Bitget se note, aunque nadie
 *     avise: lo unico que pasa es que deja de venir en la lista.
 *  4. Que el reparto en el tiempo no deje ninguna cuenta atras ni permita que
 *     una cuenta lenta se solape consigo misma.
 *  5. Que el saldo se refresque solo, y que leerlo no pueda estropear nada de
 *     lo anterior.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MERCADO_SIMULADO } from '@main/bitget/mercado';
import { ClienteBitget } from '@main/bitget/rest/client';
import { AlmacenPosiciones } from '@main/domain/almacen-posiciones';
import { LimitadorPeticiones } from '@main/execution/rate-limiter';
import {
  BarridoPosiciones,
  type CuentaBarrible,
  type FuenteBarrido,
  type ResultadoLectura
} from '@main/execution/barrido-posiciones';
import { iniciarExchangeSimulado, sobreOk, type ExchangeSimulado } from '../mock-exchange/servidor';

const SIMBOLO = 'SBTCSUSDT';

const posicionCruda = (lado: 'long' | 'short', extra: Record<string, unknown> = {}): unknown => ({
  symbol: SIMBOLO,
  holdSide: lado,
  total: '0.0157',
  available: '0.0157',
  marginCoin: 'SUSDT',
  marginMode: 'isolated',
  openPriceAvg: '63200.5',
  liquidationPrice: '57000.1',
  leverage: '10',
  marginSize: '99.3',
  unrealizedPL: '2.5',
  ...extra
});

/** Respuesta de /api/v2/mix/account/accounts: una entrada por moneda de margen. */
const saldoCrudo = (monedas: Record<string, string>): unknown =>
  Object.entries(monedas).map(([marginCoin, available]) => ({
    marginCoin,
    available,
    accountEquity: available,
    usdtEquity: available,
    locked: '0'
  }));

/**
 * Responde a las tres peticiones que hace un barrido, cada una por su ruta.
 *
 * `saldo` a `null` hace fallar solo esa: es como se prueba que un saldo
 * ilegible no se lleva por delante las posiciones del mismo ciclo.
 */
const responderBarrido = (
  exchange: ExchangeSimulado,
  opciones: { posiciones?: unknown[]; planes?: unknown[]; saldo?: Record<string, string> | null }
): void => {
  exchange.responderCon((p) => {
    if (p.url.startsWith('/api/v2/mix/position/all-position')) {
      return { cuerpo: sobreOk(opciones.posiciones ?? []) };
    }
    if (p.url.startsWith('/api/v2/mix/account/accounts')) {
      const saldo = opciones.saldo;
      return saldo == null ? { estado: 500, cuerpo: 'boom' } : { cuerpo: sobreOk(saldoCrudo(saldo)) };
    }
    return { cuerpo: sobreOk({ entrustedList: opciones.planes ?? [] }) };
  });
};

const planTp = (precio = '66000'): unknown => ({
  orderId: 'plan_1',
  clientOid: 'oid_1',
  symbol: SIMBOLO,
  planType: 'pos_profit',
  triggerPrice: precio,
  posSide: 'long',
  status: 'live'
});

/** Fuente de prueba: tres cuentas, sin vault ni registro de por medio. */
class Fuente implements FuenteBarrido {
  readonly lecturas: { cuentaId: string; ok: boolean }[] = [];
  readonly saldos: { cuentaId: string; disponible: string }[] = [];
  private cuentas: CuentaBarrible[];
  private viva = true;

  constructor(cuantas: number) {
    this.cuentas = Array.from({ length: cuantas }, (_, i) => {
      const id = `cta_${String(i + 1).padStart(3, '0')}`;
      return { cuentaId: id, credencial: { apiKey: `key_${id}`, secretKey: 's', passphrase: 'f' } };
    });
  }

  cuentasBarribles(): CuentaBarrible[] {
    return this.viva ? this.cuentas : [];
  }

  operativa(): boolean {
    return this.viva;
  }

  bloquear(): void {
    this.viva = false;
  }

  registrarLectura(cuentaId: string, resultado: ResultadoLectura): void {
    this.lecturas.push({ cuentaId, ok: resultado.ok });
  }

  registrarSaldo(cuentaId: string, disponible: string): void {
    this.saldos.push({ cuentaId, disponible });
  }
}

let exchange: ExchangeSimulado;
let cliente: ClienteBitget;
let almacen: AlmacenPosiciones;

const cuenta = (n: number): CuentaBarrible => ({
  cuentaId: `cta_${String(n).padStart(3, '0')}`,
  credencial: { apiKey: `key_cta_${String(n).padStart(3, '0')}`, secretKey: 's', passphrase: 'f' }
});

function crearBarrido(fuente: FuenteBarrido, opciones = {}): BarridoPosiciones {
  return new BarridoPosiciones(cliente, MERCADO_SIMULADO, almacen, fuente, opciones);
}

beforeEach(async () => {
  exchange = await iniciarExchangeSimulado();
  cliente = new ClienteBitget({
    host: exchange.url,
    limitador: new LimitadorPeticiones({ dormir: async () => undefined })
  });
  almacen = new AlmacenPosiciones();
});

afterEach(async () => {
  await cliente.cerrar();
  await exchange.cerrar();
});

describe('lectura de una cuenta', () => {
  it('trae las posiciones y las deja en el almacen', async () => {
    exchange.responderCon((p) =>
      p.url.startsWith('/api/v2/mix/position/all-position')
        ? { cuerpo: sobreOk([posicionCruda('long'), posicionCruda('short')]) }
        : { cuerpo: sobreOk({ entrustedList: [] }) }
    );

    await crearBarrido(new Fuente(1)).barrerCuenta(cuenta(1));

    const vivas = almacen.deCuenta('cta_001');
    expect(vivas).toHaveLength(2);
    expect(vivas[0]?.precioEntrada).toBe('63200.5');
    expect(vivas[0]?.precioLiquidacion).toBe('57000.1');
    expect(vivas[0]?.pnl).toBe('2.5');
    expect(vivas[0]?.origen).toBe('rest');
  });

  it('un campo que Bitget no manda sale vacio, no en cero', async () => {
    /* Un cero en la liquidacion se leeria como «liquida en 0»; el vacio, como «no se sabe». */
    exchange.responderCon((p) =>
      p.url.startsWith('/api/v2/mix/position/all-position')
        ? { cuerpo: sobreOk([posicionCruda('long', { liquidationPrice: null })]) }
        : { cuerpo: sobreOk({ entrustedList: [] }) }
    );

    await crearBarrido(new Fuente(1)).barrerCuenta(cuenta(1));

    expect(almacen.deCuenta('cta_001')[0]?.precioLiquidacion).toBe('');
  });

  it('no consulta el Take Profit de una cuenta sin posiciones', async () => {
    exchange.responderCon((p) =>
      p.url.startsWith('/api/v2/mix/position/all-position')
        ? { cuerpo: sobreOk([]) }
        : { cuerpo: sobreOk({ entrustedList: [] }) }
    );

    await crearBarrido(new Fuente(1)).barrerCuenta(cuenta(1));

    expect(exchange.peticiones.filter((p) => p.url.includes('orders-plan-pending'))).toHaveLength(0);
  });

  it('una sola peticion de planes cubre todas las puntas de la cuenta', async () => {
    exchange.responderCon((p) =>
      p.url.startsWith('/api/v2/mix/position/all-position')
        ? { cuerpo: sobreOk([posicionCruda('long'), posicionCruda('short')]) }
        : { cuerpo: sobreOk({ entrustedList: [planTp()] }) }
    );

    await crearBarrido(new Fuente(1)).barrerCuenta(cuenta(1));

    expect(exchange.peticiones.filter((p) => p.url.includes('orders-plan-pending'))).toHaveLength(1);
    expect(almacen.deCuenta('cta_001').find((v) => v.lado === 'long')?.takeProfit?.precio).toBe('66000');
    /* El plan era del long: el short no puede heredarlo. */
    expect(almacen.deCuenta('cta_001').find((v) => v.lado === 'short')?.takeProfit).toBeNull();
  });

  it('un Take Profit que deja de aparecer se quita del monitor', async () => {
    let hayPlan = true;
    exchange.responderCon((p) =>
      p.url.startsWith('/api/v2/mix/position/all-position')
        ? { cuerpo: sobreOk([posicionCruda('long')]) }
        : { cuerpo: sobreOk({ entrustedList: hayPlan ? [planTp()] : [] }) }
    );

    const barrido = crearBarrido(new Fuente(1));
    await barrido.barrerCuenta(cuenta(1));
    expect(almacen.deCuenta('cta_001')[0]?.takeProfit?.precio).toBe('66000');

    /* El operador lo quita desde la app de Bitget: nadie avisa, solo deja de venir. */
    hayPlan = false;
    await barrido.barrerCuenta(cuenta(1));

    expect(almacen.deCuenta('cta_001')[0]?.takeProfit).toBeNull();
  });

  it('conserva el porcentaje que puso el panel si el precio no cambia', async () => {
    exchange.responderCon((p) =>
      p.url.startsWith('/api/v2/mix/position/all-position')
        ? { cuerpo: sobreOk([posicionCruda('long')]) }
        : { cuerpo: sobreOk({ entrustedList: [planTp()] }) }
    );

    const barrido = crearBarrido(new Fuente(1));
    await barrido.barrerCuenta(cuenta(1));
    /* Como si lo hubiera puesto la apertura: el porcentaje solo lo sabe el panel. */
    almacen.fijarTakeProfit('cta_001', SIMBOLO, 'long', {
      precio: '66000',
      porcentaje: 30,
      planId: 'plan_1'
    });

    await barrido.barrerCuenta(cuenta(1));

    expect(almacen.deCuenta('cta_001')[0]?.takeProfit?.porcentaje).toBe(30);
  });
});

/*
 * ==========================================================================
 * El saldo, que es el punto 10 del cliente.
 * ==========================================================================
 * Hasta el 29/08/2026 el saldo solo se refrescaba al verificar la credencial
 * -al reconectar o al pulsar «Probar»-, asi que mover dinero entre cuentas
 * desde la web de Bitget no se veia en el panel. Estas pruebas fijan que el
 * barrido lo trae solo, y sobre todo que traerlo **no puede** estropear lo que
 * ya funcionaba.
 */
describe('saldo', () => {
  it('lo lee en el mismo ciclo y lo entrega a la fuente', async () => {
    responderBarrido(exchange, { posiciones: [posicionCruda('long')], saldo: { SUSDT: '1250.75' } });

    const fuente = new Fuente(1);
    await crearBarrido(fuente).barrerCuenta(cuenta(1));

    expect(fuente.saldos).toEqual([{ cuentaId: 'cta_001', disponible: '1250.75' }]);
  });

  /*
   * En el mercado simulado el margen es SUSDT. Coger la primera entrada de la
   * lista guardaria el saldo de otra moneda como si fuera el de este mercado, y
   * el operador veria un disponible que no puede usar para abrir.
   */
  it('coge la moneda de margen del mercado, no la primera de la lista', async () => {
    responderBarrido(exchange, { saldo: { USDT: '9999', SUSDT: '42' } });

    const fuente = new Fuente(1);
    await crearBarrido(fuente).barrerCuenta(cuenta(1));

    expect(fuente.saldos).toEqual([{ cuentaId: 'cta_001', disponible: '42' }]);
  });

  it('si la moneda del mercado no viene, no inventa un cero', async () => {
    responderBarrido(exchange, { saldo: { USDT: '9999' } });

    const fuente = new Fuente(1);
    await crearBarrido(fuente).barrerCuenta(cuenta(1));

    expect(fuente.saldos).toEqual([]);
  });

  /*
   * La razon de que `leerSaldo` se trague su propio error. Si saliera al catch
   * de `barrerCuenta` haria dos daños: la foto de posiciones ya leida no se
   * aplicaria, y el fallo contaria hacia `FALLOS_PARA_DESCONECTAR`, pintando en
   * rojo una cuenta que responde perfectamente.
   */
  it('un saldo ilegible no tumba las posiciones ni marca la cuenta como caida', async () => {
    responderBarrido(exchange, { posiciones: [posicionCruda('long')], saldo: null });

    const fuente = new Fuente(1);
    await crearBarrido(fuente).barrerCuenta(cuenta(1));

    expect(almacen.deCuenta('cta_001')).toHaveLength(1);
    expect(fuente.saldos).toEqual([]);
    expect(fuente.lecturas.at(-1)).toEqual({ cuentaId: 'cta_001', ok: true });
  });
});

describe('un fallo no puede vaciar el monitor', () => {
  it('conserva las posiciones cuando la lectura falla', async () => {
    exchange.responderCon((p) =>
      p.url.startsWith('/api/v2/mix/position/all-position')
        ? { cuerpo: sobreOk([posicionCruda('long')]) }
        : { cuerpo: sobreOk({ entrustedList: [] }) }
    );

    const fuente = new Fuente(1);
    const barrido = crearBarrido(fuente);
    await barrido.barrerCuenta(cuenta(1));
    expect(almacen.tamano).toBe(1);

    /* Ahora el exchange se cae. La posicion sigue abierta ahi fuera. */
    exchange.responderCon(() => ({ estado: 500, cuerpo: 'gateway' }));
    await barrido.barrerCuenta(cuenta(1));

    expect(almacen.tamano).toBe(1);
    expect(fuente.lecturas.at(-1)).toEqual({ cuentaId: 'cta_001', ok: false });
  });

  it('un fallo al leer el Take Profit no tumba las posiciones ya aplicadas', async () => {
    exchange.responderCon((p) =>
      p.url.startsWith('/api/v2/mix/position/all-position')
        ? { cuerpo: sobreOk([posicionCruda('long')]) }
        : { estado: 500, cuerpo: 'gateway' }
    );

    const fuente = new Fuente(1);
    await crearBarrido(fuente).barrerCuenta(cuenta(1));

    expect(almacen.tamano).toBe(1);
    expect(fuente.lecturas.at(-1)?.ok).toBe(false);
  });
});

describe('reparto en el tiempo', () => {
  const relojFalso = (inicio = 1_000_000) => {
    let t = inicio;
    return { ahora: () => t, avanzar: (ms: number) => (t += ms) };
  };

  beforeEach(() => {
    exchange.responderCon((p) =>
      p.url.startsWith('/api/v2/mix/position/all-position')
        ? { cuerpo: sobreOk([]) }
        : { cuerpo: sobreOk({ entrustedList: [] }) }
    );
  });

  it('barre todas las cuentas en la primera pasada, sin dejar ninguna atras', async () => {
    const fuente = new Fuente(6);
    const reloj = relojFalso();
    const barrido = crearBarrido(fuente, {
      ahora: reloj.ahora,
      azar: () => 0.5,
      concurrenciaMaxima: 2,
      programar: () => null,
      cancelar: () => undefined
    });

    barrido.iniciar();
    await vi.waitFor(() => expect(fuente.lecturas).toHaveLength(6));

    expect(new Set(fuente.lecturas.map((l) => l.cuentaId)).size).toBe(6);
  });

  it('no vuelve a barrer una cuenta antes de que venza su intervalo', async () => {
    const fuente = new Fuente(2);
    const reloj = relojFalso();
    const barrido = crearBarrido(fuente, {
      ahora: reloj.ahora,
      azar: () => 0.5,
      concurrenciaMaxima: 2,
      programar: () => null,
      cancelar: () => undefined
    });

    barrido.iniciar();
    await vi.waitFor(() => expect(fuente.lecturas).toHaveLength(2));

    /* Sin avanzar el reloj no vence nadie, por mucho que se bombee. */
    barrido.iniciar();
    await new Promise((r) => setTimeout(r, 20));
    expect(fuente.lecturas).toHaveLength(2);
  });

  /*
   * Lo que hace que el informe de un lote enseñe el saldo de despues de abrir.
   *
   * Sin `adelantar`, esas cuentas esperarian su turno normal -hasta 45
   * segundos- con el operador delante del informe comprobando que salio bien.
   */
  it('adelantar vuelve a leer una cuenta sin esperar su intervalo', async () => {
    const fuente = new Fuente(2);
    const reloj = relojFalso();
    const barrido = crearBarrido(fuente, {
      ahora: reloj.ahora,
      azar: () => 0.5,
      concurrenciaMaxima: 2,
      programar: () => null,
      cancelar: () => undefined
    });

    barrido.iniciar();
    await vi.waitFor(() => expect(fuente.lecturas).toHaveLength(2));

    /* El reloj no se mueve: sin adelantar, nadie vence. */
    barrido.adelantar(['cta_001']);
    await vi.waitFor(() => expect(fuente.lecturas).toHaveLength(3));

    expect(fuente.lecturas.at(-1)?.cuentaId).toBe('cta_001');
    /* La otra no se adelanto, y sigue esperando su turno. */
    expect(fuente.lecturas.filter((l) => l.cuentaId === 'cta_002')).toHaveLength(1);
  });

  it('adelantar una cuenta que no existe no rompe el ciclo', async () => {
    const fuente = new Fuente(1);
    const barrido = crearBarrido(fuente, { programar: () => null, cancelar: () => undefined });

    barrido.iniciar();
    await vi.waitFor(() => expect(fuente.lecturas).toHaveLength(1));

    barrido.adelantar(['cta_borrada']);
    await new Promise((r) => setTimeout(r, 20));

    expect(fuente.lecturas).toHaveLength(1);
  });

  it('con el panel bloqueado no lee nada', async () => {
    const fuente = new Fuente(3);
    fuente.bloquear();
    const barrido = crearBarrido(fuente, {
      programar: () => null,
      cancelar: () => undefined
    });

    barrido.iniciar();
    await new Promise((r) => setTimeout(r, 20));

    expect(fuente.lecturas).toHaveLength(0);
    expect(exchange.peticiones).toHaveLength(0);
  });
});
