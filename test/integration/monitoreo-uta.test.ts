/**
 * Centro de Monitoreo sobre cuentas UTA: el socket V3 y su reconciliacion REST.
 *
 * ==========================================================================
 * Que se prueba, y por que precisamente esto
 * ==========================================================================
 * El monitor tiene dos fuentes —el socket, que baja la latencia, y el barrido
 * REST, que corrige— y la Fase D duplica las dos para UTA. Los riesgos no son
 * los mismos en cada una:
 *
 *  1. **La suscripcion.** Es el punto de fallo silencioso del socket V3: si el
 *     `instType` o el nombre del campo van mal, Bitget no confirma, la conexion
 *     no llega a viva y la cuenta se queda en REST **para siempre** sin que nada
 *     lo indique salvo el distintivo de «modo REST». Por eso se comprueba el
 *     cuerpo exacto del `subscribe`, no que la conexion se abra.
 *  2. **Los tres temas.** Con dos de tres confirmados la cuenta enseñaria
 *     posiciones al segundo y un saldo viejo, que es media verdad.
 *  3. **La convivencia.** Una Classic y una UTA en el mismo pool, cada una con
 *     su vocabulario, sin que el pool pregunte por el modo de ninguna.
 *  4. **La normalizacion.** Un empujon de V3 tiene que llegar al almacen como
 *     `Posicion`, con el lado en su sitio: `posSide` en la columna equivocada es
 *     el fallo caro de esta capa.
 *  5. **El saldo por REST.** Es el agujero que esta fase cierra: `leerSaldo` se
 *     traga su propio error, asi que una ruta equivocada ahi no falla, se
 *     congela.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MERCADO_REAL, MERCADO_SIMULADO } from '@main/bitget/mercado';
import { ClienteBitget } from '@main/bitget/rest/client';
import { obtenerCuentasFuturos } from '@main/bitget/rest/endpoints/cuenta';
import { obtenerPosicionesV3 } from '@main/bitget/rest/endpoints/posiciones-v3';
import {
  ConexionBitget,
  INST_TYPE_UTA,
  URL_WS_PRIVADO,
  URL_WS_PRIVADO_V3,
  type AvisosConexion
} from '@main/bitget/ws/conexion';
import { RegistroOrdenesUta } from '@main/bitget/registro-ordenes-uta';
import { saldoDeEmpujon } from '@main/bitget/ws/empujones';
import {
  PoolSockets,
  type CuentaSocket,
  type FuentePool,
  type OpcionesPool
} from '@main/bitget/ws/pool';
import { AlmacenPosiciones } from '@main/domain/almacen-posiciones';
import { BarridoPosiciones, type CuentaBarrible, type FuenteBarrido, type ResultadoLectura } from '@main/execution/barrido-posiciones';
import { iniciarExchangeSimulado, sobreOk, type ExchangeSimulado } from '../mock-exchange/servidor';
import { empujonPosiciones, empujonUta, iniciarWsSimulado, type WsSimulado } from '../mock-exchange/ws-servidor';

const CLASICA = { apiKey: 'bg_v2', secretKey: 'secreto', passphrase: 'frase' } as const;
const UTA = { apiKey: 'bg_v3', secretKey: 'secreto', passphrase: 'frase', superficie: 'v3' } as const;

const SIMBOLO = 'SBTCSUSDT';

/** Una posicion como la empuja el tema `position` de UTA. */
const posicionUta = (lado: 'long' | 'short', extra: Record<string, unknown> = {}): unknown => ({
  symbol: SIMBOLO,
  posSide: lado,
  total: '0.0157',
  marginMode: 'isolated',
  avgPrice: '63200.5',
  liquidationPrice: '57000.1',
  leverage: '10',
  marginSize: '99.3',
  unrealizedPL: '12.4',
  ...extra
});

/* ========================================================================== */
/* 1. La suscripcion                                                          */
/* ========================================================================== */

describe('la suscripcion de cada superficie', () => {
  let servidor: WsSimulado;
  const abiertas: ConexionBitget[] = [];

  const avisosMudos = (): AvisosConexion => ({
    alEmpujar: () => undefined,
    alCaer: () => undefined
  });

  const conectar = (credencial: typeof CLASICA | typeof UTA): ConexionBitget => {
    const conexion = new ConexionBitget('cta_001', credencial, MERCADO_SIMULADO, avisosMudos(), {
      url: servidor.url,
      pingMs: 10_000,
      esperaLoginMs: 500
    });
    abiertas.push(conexion);
    conexion.conectar();
    return conexion;
  };

  /** Los argumentos del `subscribe` que llego al servidor. */
  const argumentosSubscribe = (): Record<string, string>[] => {
    const crudo = servidor.recibidos.find((t) => t.includes('"subscribe"'));
    if (crudo === undefined) return [];
    return (JSON.parse(crudo) as { args: Record<string, string>[] }).args;
  };

  beforeEach(async () => {
    servidor = await iniciarWsSimulado();
  });

  afterEach(async () => {
    for (const c of abiertas) c.cerrar();
    abiertas.length = 0;
    await servidor.cerrar();
  });

  it('una UTA se suscribe a los tres temas con `topic` e `instType: UTA`', async () => {
    const conexion = conectar(UTA);
    await vi.waitFor(() => expect(conexion.estaViva).toBe(true));

    expect(argumentosSubscribe()).toEqual([
      { instType: 'UTA', topic: 'position' },
      { instType: 'UTA', topic: 'order' },
      { instType: 'UTA', topic: 'account' }
    ]);
  });

  it('una Classic sigue suscribiendose con `channel` y el instType del producto', async () => {
    const conexion = conectar(CLASICA);
    await vi.waitFor(() => expect(conexion.estaViva).toBe(true));

    /*
     * La regla dura numero 1: cero cambios observables en Classic. El cuerpo
     * tiene que ser identico al de antes de la Fase D, comodines incluidos.
     */
    expect(argumentosSubscribe()).toEqual([
      { instType: MERCADO_SIMULADO.productType, channel: 'positions', coin: 'default' },
      { instType: MERCADO_SIMULADO.productType, channel: 'orders-algo', instId: 'default' }
    ]);
  });

  it('no queda viva si Bitget no confirma uno de los tres temas', async () => {
    servidor.configurar({ canalesQueFallan: ['account'] });
    const conexion = conectar(UTA);

    /*
     * Media suscripcion no es media conexion: es una cuenta que enseñaria
     * posiciones frescas con un saldo de hace 45 s. Se prefiere caer y volver a
     * REST entero, que es lo que el operador ve marcado.
     */
    await vi.waitFor(() => expect(conexion.estado).not.toBe('suscribiendo'));
    expect(conexion.estaViva).toBe(false);
  });

  it('cada superficie abre su URL cuando nadie se la impone', () => {
    /*
     * En las demas pruebas la URL la fija el servidor local, asi que esta es la
     * unica que comprueba la eleccion real. Se intercepta la creacion del socket
     * en vez de conectar: el objetivo es leer la URL, no hablar con nadie.
     */
    const urls: string[] = [];
    const espia = (url: string): never => {
      urls.push(url);
      throw new Error('no se conecta');
    };

    for (const credencial of [CLASICA, UTA]) {
      const conexion = new ConexionBitget('cta_001', credencial, MERCADO_SIMULADO, avisosMudos(), {
        crearSocket: espia as unknown as (url: string) => never
      });
      expect(() => conexion.conectar()).toThrow();
    }

    expect(urls).toEqual([URL_WS_PRIVADO, URL_WS_PRIVADO_V3]);
    expect(INST_TYPE_UTA).toBe('UTA');
  });
});

/* ========================================================================== */
/* 2. El pool: las dos superficies a la vez                                   */
/* ========================================================================== */

describe('el pool mezcla Classic y UTA', () => {
  let servidor: WsSimulado;
  let almacen: AlmacenPosiciones;
  const creados: PoolSockets[] = [];

  class Fuente implements FuentePool {
    readonly saldos: { cuentaId: string; disponible: string }[] = [];
    viva = true;
    private readonly cuentas: readonly CuentaSocket[];

    constructor(cuentas: readonly CuentaSocket[]) {
      this.cuentas = cuentas;
    }

    cuentasCalientes(): CuentaSocket[] {
      return [...this.cuentas];
    }

    operativa(): boolean {
      return this.viva;
    }

    marcarModoRest(): void {
      /* Irrelevante aqui: lo cubre `ws-pool.test.ts`. */
    }

    registrarSaldo(cuentaId: string, disponible: string): void {
      this.saldos.push({ cuentaId, disponible });
    }
  }

  const crearPool = (fuente: FuentePool, extra: OpcionesPool = {}): PoolSockets => {
    const pool = new PoolSockets(MERCADO_SIMULADO, almacen, fuente, {
      programar: () => null,
      cancelar: () => undefined,
      azar: () => 0.5,
      conexion: { url: servidor.url, pingMs: 10_000, esperaLoginMs: 500 },
      ...extra
    });
    creados.push(pool);
    return pool;
  };

  const soloUta = (): Fuente => new Fuente([{ cuentaId: 'cta_uta', credencial: UTA }]);

  beforeEach(async () => {
    servidor = await iniciarWsSimulado();
    almacen = new AlmacenPosiciones();
  });

  afterEach(async () => {
    for (const p of creados) p.detener();
    creados.length = 0;
    await servidor.cerrar();
  });

  it('abre socket para una Classic y una UTA a la vez', async () => {
    const fuente = new Fuente([
      { cuentaId: 'cta_v2', credencial: CLASICA },
      { cuentaId: 'cta_uta', credencial: UTA }
    ]);
    const pool = crearPool(fuente);

    pool.iniciar();
    await vi.waitFor(() => expect(pool.vivos).toHaveLength(2));

    /* Las dos vivas quiere decir que las dos vieron confirmados sus canales. */
    expect(pool.vivos.sort()).toEqual(['cta_uta', 'cta_v2']);
  });

  it('una foto del tema `position` llena el monitor con la posicion normalizada', async () => {
    const fuente = soloUta();
    const pool = crearPool(fuente);
    pool.iniciar();
    await vi.waitFor(() => expect(pool.vivos).toHaveLength(1));

    servidor.empujar(empujonUta('position', 'snapshot', [posicionUta('short')]));
    await vi.waitFor(() => expect(almacen.tamano).toBe(1));

    const fila = almacen.deCuenta('cta_uta')[0];
    expect(fila).toMatchObject({
      simbolo: SIMBOLO,
      /* `posSide`, no `holdSide`: leerlo mal pondria la fila en la otra columna. */
      lado: 'short',
      tamano: '0.0157',
      /* `avgPrice` es el `openPriceAvg` de V2. Es el unico renombre confirmado. */
      precioEntrada: '63200.5',
      precioLiquidacion: '57000.1',
      apalancamiento: 10,
      modoMargen: 'aislado',
      origen: 'ws'
    });
  });

  it('un cambio suelto no borra las demas posiciones de la cuenta UTA', async () => {
    const pool = crearPool(soloUta());
    pool.iniciar();
    await vi.waitFor(() => expect(pool.vivos).toHaveLength(1));

    servidor.empujar(
      empujonUta('position', 'snapshot', [posicionUta('long'), posicionUta('short')])
    );
    await vi.waitFor(() => expect(almacen.tamano).toBe(2));

    servidor.empujar(empujonUta('position', 'update', [posicionUta('long', { total: '0.02' })]));
    await vi.waitFor(() =>
      expect(almacen.deCuenta('cta_uta').find((p) => p.lado === 'long')?.tamano).toBe('0.02')
    );

    expect(almacen.tamano).toBe(2);
  });

  it('el tema `account` refresca el saldo', async () => {
    const fuente = soloUta();
    const pool = crearPool(fuente);
    pool.iniciar();
    await vi.waitFor(() => expect(pool.vivos).toHaveLength(1));

    servidor.empujar(
      empujonUta('account', 'snapshot', [
        { coin: 'OTRA', available: '1' },
        { coin: MERCADO_SIMULADO.marginCoin, available: '4321.5' }
      ])
    );

    await vi.waitFor(() => expect(fuente.saldos).toHaveLength(1));
    expect(fuente.saldos[0]).toEqual({ cuentaId: 'cta_uta', disponible: '4321.5' });
  });

  it('un empujon de `account` sin la moneda del mercado no escribe nada', async () => {
    const fuente = soloUta();
    const pool = crearPool(fuente);
    pool.iniciar();
    await vi.waitFor(() => expect(pool.vivos).toHaveLength(1));

    /*
     * Dos filas y ninguna es la del mercado: no se puede elegir. No escribir
     * conserva el ultimo saldo conocido; escribir la primera pondria en la
     * matriz el saldo de otra moneda como si fuera este.
     */
    servidor.empujar(
      empujonUta('account', 'snapshot', [
        { coin: 'BTC', available: '0.5' },
        { coin: 'ETH', available: '3' }
      ])
    );
    servidor.empujar(empujonUta('position', 'snapshot', [posicionUta('long')]));
    await vi.waitFor(() => expect(almacen.tamano).toBe(1));

    expect(fuente.saldos).toEqual([]);
  });

  it('un empujon de `order` se anota y no altera el monitor', async () => {
    const fuente = soloUta();
    const registroOrdenes = new RegistroOrdenesUta();
    const pool = crearPool(fuente, { registroOrdenes });
    pool.iniciar();
    await vi.waitFor(() => expect(pool.vivos).toHaveLength(1));

    servidor.empujar(empujonUta('position', 'snapshot', [posicionUta('long')]));
    await vi.waitFor(() => expect(almacen.tamano).toBe(1));

    servidor.empujar(
      empujonUta('order', 'update', [
        { orderId: 'o1', clientOid: 'pcbplan0l', symbol: SIMBOLO, status: 'filled' }
      ])
    );

    /*
     * Desde la Fase E el tema tiene destino: el registro que devuelve el
     * tri-estado a las cuentas UTA. Ver `test/integration/resiliencia-uta.test.ts`
     * para lo que se hace con la anotacion; aqui solo se comprueba que el
     * empujon llega y que no estropea el monitor de paso.
     */
    await vi.waitFor(() =>
      expect(registroOrdenes.buscar('pcbplan0l', SIMBOLO)?.orderId).toBe('o1')
    );

    servidor.empujar(empujonUta('position', 'update', [posicionUta('long', { total: '0.03' })]));
    await vi.waitFor(() => expect(almacen.deCuenta('cta_uta')[0]?.tamano).toBe('0.03'));
    expect(almacen.tamano).toBe(1);
  });

  it('los empujones de V2 siguen entrando por su canal con el pool mezclado', async () => {
    const fuente = new Fuente([
      { cuentaId: 'cta_v2', credencial: CLASICA },
      { cuentaId: 'cta_uta', credencial: UTA }
    ]);
    const pool = crearPool(fuente);
    pool.iniciar();
    await vi.waitFor(() => expect(pool.vivos).toHaveLength(2));

    /*
     * El servidor simulado empuja a todos los clientes, asi que las dos cuentas
     * reciben los dos empujones. Lo que se comprueba es que cada normalizador
     * lee el suyo: `instId`/`holdSide` en V2 y `symbol`/`posSide` en V3, sin que
     * el pool pregunte de que superficie viene.
     */
    servidor.empujar(
      empujonPosiciones('snapshot', [
        { instId: SIMBOLO, holdSide: 'long', total: '0.5', openPriceAvg: '100', marginMode: 'crossed' }
      ])
    );
    await vi.waitFor(() => expect(almacen.tamano).toBe(2));

    expect(almacen.deCuenta('cta_v2')[0]).toMatchObject({
      lado: 'long',
      tamano: '0.5',
      precioEntrada: '100',
      modoMargen: 'cruzado'
    });
  });
});

/* ========================================================================== */
/* 3. Reconciliacion REST contra V3                                           */
/* ========================================================================== */

describe('el barrido REST sobre una cuenta UTA', () => {
  let exchange: ExchangeSimulado;
  let cliente: ClienteBitget;
  let almacen: AlmacenPosiciones;

  class Fuente implements FuenteBarrido {
    readonly saldos: { cuentaId: string; disponible: string }[] = [];
    readonly lecturas: ResultadoLectura[] = [];
    private readonly cuentas: readonly CuentaBarrible[];

    constructor(cuentas: readonly CuentaBarrible[]) {
      this.cuentas = cuentas;
    }

    cuentasBarribles(): CuentaBarrible[] {
      return [...this.cuentas];
    }

    operativa(): boolean {
      return true;
    }

    registrarLectura(_cuentaId: string, resultado: ResultadoLectura): void {
      this.lecturas.push(resultado);
    }

    registrarSaldo(cuentaId: string, disponible: string): void {
      this.saldos.push({ cuentaId, disponible });
    }
  }

  /** Las rutas que llegaron al exchange, sin la cadena de consulta. */
  const rutas = (): string[] => exchange.peticiones.map((p) => (p.url.split('?')[0] ?? ''));

  beforeEach(async () => {
    exchange = await iniciarExchangeSimulado();
    cliente = new ClienteBitget({ host: exchange.url });
    almacen = new AlmacenPosiciones();
  });

  afterEach(async () => {
    await cliente.cerrar();
    await exchange.cerrar();
  });

  it('lee posiciones y saldo por V3, y no toca ninguna ruta de V2', async () => {
    exchange.simularUta({ accountMode: 'unified', holdMode: 'hedge_mode' });
    exchange.responderCon((p) => {
      if (p.url.startsWith('/api/v3/position/current-position')) {
        return {
          cuerpo: sobreOk({
            list: [
              {
                symbol: 'BTCUSDT',
                posSide: 'long',
                total: '0.01',
                avgPrice: '63000',
                liquidationPrice: '57000',
                leverage: '10',
                marginMode: 'isolated'
              }
            ]
          })
        };
      }
      if (p.url.startsWith('/api/v3/account/assets')) {
        return { cuerpo: sobreOk([{ coin: 'USDT', available: '5000.25', equity: '5100' }]) };
      }
      return null;
    });

    const fuente = new Fuente([{ cuentaId: 'cta_uta', credencial: UTA }]);
    const barrido = new BarridoPosiciones(cliente, MERCADO_REAL, almacen, fuente, {
      programar: () => null,
      cancelar: () => undefined
    });

    await barrido.barrerCuenta({ cuentaId: 'cta_uta', credencial: UTA });

    expect(fuente.lecturas).toEqual([{ ok: true, latenciaMs: expect.any(Number) }]);
    expect(almacen.deCuenta('cta_uta')[0]).toMatchObject({
      simbolo: 'BTCUSDT',
      lado: 'long',
      precioEntrada: '63000',
      origen: 'rest'
    });

    /*
     * El saldo es lo que esta fase arregla. Antes, esta misma lectura iba a
     * `/api/v2/mix/account/accounts`, Bitget la rechazaba, `leerSaldo` se tragaba
     * el error y la columna se quedaba con el valor de la verificacion para
     * siempre. La prueba de que esta arreglado no es que llegue el numero: es
     * que **ninguna** ruta de V2 aparezca.
     */
    expect(fuente.saldos).toEqual([{ cuentaId: 'cta_uta', disponible: '5000.25' }]);
    expect(rutas().every((r) => r.startsWith('/api/v3/'))).toBe(true);
  });

  it('`obtenerCuentasFuturos` devuelve la forma de V2 leyendo `account/assets`', async () => {
    exchange.simularUta({ accountMode: 'unified' });
    exchange.responderSiempre({
      cuerpo: sobreOk([
        { coin: 'USDT', availableBalance: '120.5', accountEquity: '130' },
        { coin: 'BTC', available: '0.01' }
      ])
    });

    const r = await obtenerCuentasFuturos(cliente, UTA, MERCADO_REAL.productType, 'USDT');

    /* La misma forma que devuelve V2, para que quien la consuma no distinga. */
    expect(r.datos).toEqual([
      { marginCoin: 'USDT', available: '120.5', accountEquity: '130', usdtEquity: '130', locked: '0' },
      { marginCoin: 'BTC', available: '0.01', accountEquity: '', usdtEquity: '', locked: '0' }
    ]);
    expect(rutas()).toEqual(['/api/v3/account/assets']);
  });

  it('lee el saldo con la forma documentada de `account/assets`: objeto con `assets`', async () => {
    exchange.simularUta({ accountMode: 'unified' });
    exchange.responderSiempre({
      cuerpo: sobreOk({
        accountEquity: '130',
        usdtEquity: '130',
        unrealisedPnl: '0',
        assets: [{ coin: 'USDT', equity: '130', balance: '130', available: '120.5', debt: '0', locked: '0' }]
      })
    });

    const r = await obtenerCuentasFuturos(cliente, UTA, MERCADO_REAL.productType, 'USDT');

    expect(r.datos.find((c) => c.marginCoin === 'USDT')?.available).toBe('120.5');
  });
});

describe('el saldo empujado por el tema `account` de V3', () => {
  it('lo lee aunque las monedas vengan anidadas en `coin`', () => {
    const datos = [
      {
        totalEquity: '130',
        unrealisedPnl: '0',
        coin: [{ coin: 'USDT', available: '120.5', equity: '130', balance: '130', locked: '0' }]
      }
    ];

    expect(saldoDeEmpujon(datos, 'USDT')).toBe('120.5');
  });

  it('sigue leyendo la forma plana', () => {
    expect(saldoDeEmpujon([{ coin: 'USDT', available: '7' }], 'USDT')).toBe('7');
  });
});

/* ========================================================================== */
/* 4. Paginacion: el sobre de V3                                              */
/* ========================================================================== */

describe('las listas de V3 llegan de dos formas', () => {
  let exchange: ExchangeSimulado;
  let cliente: ClienteBitget;

  beforeEach(async () => {
    exchange = await iniciarExchangeSimulado();
    cliente = new ClienteBitget({ host: exchange.url });
  });

  afterEach(async () => {
    await cliente.cerrar();
    await exchange.cerrar();
  });

  const UNA = {
    symbol: 'BTCUSDT',
    posSide: 'long',
    total: '0.01',
    avgPrice: '63000'
  };

  it('el array pelado y el sobre con cursor dan el mismo resultado', async () => {
    exchange.simularUta({ accountMode: 'unified' });

    exchange.responderV3({ cuerpo: sobreOk([UNA]) });
    const pelado = await obtenerPosicionesV3(cliente, UTA, MERCADO_REAL);

    exchange.responderV3({ cuerpo: sobreOk({ list: [UNA], cursor: '' }) });
    const envuelto = await obtenerPosicionesV3(cliente, UTA, MERCADO_REAL);

    /*
     * No se sabe cual de las dos formas usa cada endpoint de V3 —nada de esto
     * esta capturado—, y apostar por una dejaria la lista vacia con la otra: en
     * el barrido, una subcuenta UTA sin posiciones en el monitor.
     */
    expect(pelado.datos).toEqual(envuelto.datos);
    expect(pelado.datos[0]).toMatchObject({ symbol: 'BTCUSDT', holdSide: 'long' });
  });

  it('una lista vacia o ausente no inventa posiciones', async () => {
    exchange.simularUta({ accountMode: 'unified' });

    exchange.responderV3({ cuerpo: sobreOk({ cursor: null }) });
    const sinLista = await obtenerPosicionesV3(cliente, UTA, MERCADO_REAL);

    expect(sinLista.datos).toEqual([]);
  });
});
