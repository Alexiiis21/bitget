/**
 * Los puntos del checklist §9 de `INTEGRACION_V3_UTA.md` que no tenían prueba.
 *
 * ==========================================================================
 * Por qué existe este archivo aparte
 * ==========================================================================
 * Las Fases B a E se probaron cada una contra su propio criterio de cierre, y
 * al auditar el conjunto contra el checklist del documento quedaron cinco
 * puntos sin cubrir. Ninguno era código sin escribir: eran comportamientos
 * implementados que **nadie estaba comprobando**, que es una forma distinta de
 * riesgo y merece decirse por separado en vez de disolverse en los archivos de
 * cada fase.
 *
 * Dos de los cinco son de seguridad y son la razón de que esto se hiciera antes
 * de dar por buena la migración para probar a mano:
 *
 *   §9.11  una cuenta en transición **no debe operar**. Estaba implementado y
 *          sin probar: si `cuentaEjecutable` dejara de devolver `null`, ninguna
 *          prueba se habría enterado.
 *   §9.10  una apertura interrumpida en UTA no debe duplicarse. El registro del
 *          socket y `consultarOrdenV3` se probaron por piezas en la Fase E; lo
 *          que faltaba era el camino entero, que es donde vive la regla dura
 *          nº 2.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MERCADO_SIMULADO } from '@main/bitget/mercado';
import { ClienteBitget } from '@main/bitget/rest/client';
import { registroOrdenesUta } from '@main/bitget/registro-ordenes-uta';
import { PoolSockets, type CuentaSocket, type FuentePool } from '@main/bitget/ws/pool';
import { AlmacenPosiciones } from '@main/domain/almacen-posiciones';
import { Sesion } from '@main/ipc/sesion';
import {
  MotorLotes,
  clientOidDe,
  type CuentaEjecutable,
  type FuenteCuentas,
  type ObjetivoApertura
} from '@main/execution/motor-lotes';
import {
  iniciarExchangeSimulado,
  sobreOk,
  type ExchangeSimulado,
  type PeticionRecibida,
  type Respuesta
} from '../mock-exchange/servidor';
import { empujonUta, iniciarWsSimulado, type WsSimulado } from '../mock-exchange/ws-servidor';

const SIMBOLO = 'SBTCSUSDT';

/* ========================================================================== */
/* §9.9 · El clientOid que emite el panel es válido en V3                     */
/* ========================================================================== */

describe('§9.9 · el clientOid pasa la validación de caracteres de V3', () => {
  /**
   * V3 exige 1–32 caracteres de `[A-Za-z0-9.:/_-]`.
   *
   * Se comprobó por lectura de código en la Fase A y nunca se ató con una
   * prueba. Merece una porque el generador es un literal de plantilla: cualquiera
   * puede meter ahí un separador «para que se lea mejor» y el fallo aparecería
   * como un rechazo de Bitget en la primera apertura sobre una cuenta UTA, no
   * aquí.
   */
  const VALIDO = /^[A-Za-z0-9.:/_-]{1,32}$/;

  it('con los índices reales de un lote de 300 cuentas', () => {
    /* `randomUUID` sin guiones, recortado a 12: el id de plan real. */
    const planId = 'a1b2c3d4e5f6';

    for (const indice of [0, 9, 99, 299]) {
      for (const lado of ['long', 'short'] as const) {
        const oid = clientOidDe(planId, indice, lado);
        expect(oid).toMatch(VALIDO);
        /* Holgura amplia sobre el techo de 32: hoy son 19 como mucho. */
        expect(oid.length).toBeLessThanOrEqual(32);
      }
    }
  });

  it('long y short de la misma casilla no colisionan', () => {
    /*
     * En cobertura las dos puntas conviven, así que un identificador compartido
     * haría que Bitget rechazara la segunda por repetida y el panel lo leyera
     * como un fallo de la casilla.
     */
    expect(clientOidDe('a1b2c3d4e5f6', 7, 'long')).not.toBe(
      clientOidDe('a1b2c3d4e5f6', 7, 'short')
    );
  });
});

/* ========================================================================== */
/* §9.11 · Una cuenta en transición no opera                                  */
/* ========================================================================== */

describe('§9.11 · una cuenta que Bitget está migrando queda bloqueada', () => {
  const KDF_PRUEBAS = { N: 16, r: 1, p: 1 };
  const MAESTRA = 'contrasena-de-prueba';
  const ALTA = {
    etiqueta: 'Sub-01',
    grupoNombre: 'A',
    apiKey: 'bg_7Kq82ab3cd4ef19c',
    secretKey: 'secreto',
    passphrase: 'frase'
  };

  let carpeta: string;
  let exchange: ExchangeSimulado;
  let cliente: ClienteBitget;
  let sesion: Sesion;

  const infoCuenta = (): unknown =>
    sobreOk({ userId: '5476143701', authorities: ['coow', 'cpow'], ips: '1.2.3.4', parentId: 1513226215 });

  const cuentaSimbolo = (): unknown =>
    sobreOk({
      marginCoin: 'USDT',
      available: '500',
      accountEquity: '500',
      marginMode: 'isolated',
      posMode: 'hedge_mode',
      isolatedLongLever: 10,
      isolatedShortLever: 10,
      crossedMarginLeverage: 10
    });

  beforeEach(async () => {
    carpeta = await mkdtemp(join(tmpdir(), 'pcb-transicion-'));
    exchange = await iniciarExchangeSimulado();
    cliente = new ClienteBitget({ host: exchange.url });
    sesion = new Sesion(
      {
        vault: join(carpeta, 'vault.enc'),
        cuentas: join(carpeta, 'cuentas.json'),
        activos: join(carpeta, 'activos.json')
      },
      cliente,
      { parametrosKdf: KDF_PRUEBAS }
    );
    await sesion.crear(MAESTRA);
  });

  afterEach(async () => {
    sesion.cerrar();
    await cliente.cerrar();
    await exchange.cerrar();
    await rm(carpeta, { recursive: true, force: true });
  });

  /**
   * Da de alta la cuenta como Classic, que es la situación de partida real.
   *
   * Una cuenta **en** transición no se puede ni registrar: `verificarCredencial`
   * la devuelve como `rechazada` con su motivo, que es más estricto todavía que
   * bloquearla. El caso que hay que probar es el otro: una cuenta ya dada de
   * alta y operando a la que Bitget empieza a migrar por debajo.
   */
  const altaClasica = async (): Promise<string> => {
    exchange.responderCon((p) => {
      if (p.url.startsWith('/api/v2/spot/account/info')) return { cuerpo: infoCuenta() };
      if (p.url.startsWith('/api/v2/mix/account/account')) return { cuerpo: cuentaSimbolo() };
      return null;
    });

    const alta = await sesion.agregar(ALTA);
    expect(alta.ok).toBe(true);
    return sesion.listar()[0]?.id ?? '';
  };

  it('no entra en los lotes y la pantalla la marca', async () => {
    const id = await altaClasica();
    expect(sesion.cuentaEjecutable(id)).not.toBeNull();

    /*
     * Bitget empieza a migrarla. `switching` es uno de los dos estados de
     * transición. La cuenta responde bien a todo lo demás: lo que la bloquea no
     * es un fallo, es que la superficie que contesta ahora puede dejar de
     * hacerlo a mitad de una orden.
     */
    exchange.simularUta({ accountMode: 'switching', holdMode: 'hedge_mode' });
    await sesion.verificar(id);

    const fila = sesion.listar()[0];
    expect(fila?.enTransicion).toBe(true);

    /*
     * ======================================================================
     * Esto es lo que impide operar a ciegas una cuenta a medio migrar
     * ======================================================================
     * `null` significa «esta subcuenta no está disponible ahora», que es como el
     * motor descarta un objetivo sin contarlo como fallo del lote. Si esto
     * devolviera la cuenta, se le mandarían órdenes por una superficie que
     * Bitget puede cerrar en cualquier momento.
     */
    expect(sesion.cuentaEjecutable(id)).toBeNull();
  });

  it('vuelve a operar sola cuando Bitget termina, sin tocar nada', async () => {
    const id = await altaClasica();

    exchange.simularUta({ accountMode: 'switching', holdMode: 'hedge_mode' });
    await sesion.verificar(id);
    expect(sesion.cuentaEjecutable(id)).toBeNull();

    /* Bitget termina la migración: ya es UTA de pleno derecho. */
    exchange.simularUta({ accountMode: 'unified', holdMode: 'hedge_mode' });
    await sesion.verificar(id);

    /*
     * El bloqueo se levanta en la siguiente verificación, que es la única
     * lectura fresca que hay: el cambio termina por su cuenta y nadie avisa.
     */
    expect(sesion.listar()[0]?.enTransicion).toBe(false);
    expect(sesion.cuentaEjecutable(id)).not.toBeNull();
    expect(sesion.cuentaEjecutable(id)?.credencial.superficie).toBe('v3');
  });
});

/* ========================================================================== */
/* §9.10 · Apertura interrumpida en UTA: se reconcilia, no se duplica         */
/* ========================================================================== */

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

const TICKER = [{ symbol: SIMBOLO, lastPr: '63378', markPrice: '63381.3' }];

const AJUSTES_UTA = {
  accountMode: 'unified',
  holdMode: 'hedge_mode',
  symbolConfigList: [
    { category: 'SUSDT-FUTURES', symbol: SIMBOLO, marginMode: 'isolated', leverage: '10' }
  ]
};

describe('§9.10 · una apertura UTA que se queda sin respuesta', () => {
  let exchange: ExchangeSimulado;
  let cliente: ClienteBitget;
  let motor: MotorLotes;

  const UTA_CREDENCIAL = {
    apiKey: 'key_uta',
    secretKey: 'secreto',
    passphrase: 'frase',
    superficie: 'v3' as const,
    holdMode: 'hedge_mode' as const
  };

  class UnaCuenta implements FuenteCuentas {
    cuentaEjecutable(cuentaId: string): CuentaEjecutable | null {
      if (cuentaId !== 'cta_uta') return null;
      return {
        cuentaId,
        etiqueta: 'UTA-01',
        credencial: UTA_CREDENCIAL,
        saldoDisponible: '3000',
        modoMargen: 'isolated'
      };
    }
  }

  const objetivos: ObjetivoApertura[] = [{ cuentaId: 'cta_uta', lado: 'long' }];

  /** Lo que la apertura lee antes de enviar. En UTA la config sale de `settings`. */
  const comunes = (p: PeticionRecibida): Respuesta | null => {
    if (p.url.startsWith('/api/v2/mix/market/contracts')) return { cuerpo: sobreOk([CONTRATO]) };
    if (p.url.startsWith('/api/v2/mix/market/ticker')) return { cuerpo: sobreOk(TICKER) };
    return null;
  };

  const planYEjecuta = async (): Promise<ReturnType<MotorLotes['ejecutar']>> => {
    const plan = await motor.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos,
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null,
      modoMargen: 'isolated'
    });
    return motor.ejecutar(plan);
  };

  /** Cuántas aperturas llegaron de verdad al exchange. */
  const aperturasEnviadas = (): number =>
    exchange.peticiones.filter((p) => p.url.includes('place-order')).length;

  beforeEach(async () => {
    exchange = await iniciarExchangeSimulado();
    exchange.simularUta(AJUSTES_UTA);
    /*
     * ======================================================================
     * Se usa el registro **del proceso**, no uno inyectado
     * ======================================================================
     * Y es deliberado. `consultarOrdenV3` lo alcanza por el singleton
     * `registroOrdenesUta` —entre quien escribe (el pool de sockets) y quien lee
     * (una función de endpoint) hay cinco capas que no tienen nada que ver con
     * esto—, así que una prueba que inyectara el suyo mediría un camino que en
     * producción no se recorre. La Fase E probó las piezas con un registro
     * propio; esto prueba el cableado real.
     */
    registroOrdenesUta.vaciar();
    /* Plazos de milisegundos: la petición se cuelga y no se espera de verdad. */
    cliente = new ClienteBitget({
      host: exchange.url,
      timeoutsMs: { conexion: 60, cabeceras: 60, cuerpo: 60 }
    });
    motor = new MotorLotes(cliente, new UnaCuenta(), { dormir: async () => undefined });
  });

  afterEach(async () => {
    await cliente.cerrar();
    await exchange.cerrar();
  });

  it('sale correcta si el socket había anunciado la orden, y NO se reenvía', async () => {
    exchange.responderCon((p) => {
      const comun = comunes(p);
      if (comun !== null) return comun;
      /* La apertura sale y la respuesta nunca vuelve. */
      if (p.url.includes('place-order')) return { retrasoMs: 3_000 };
      return null;
    });

    /*
     * El socket ya había contado esa orden. Se anota antes de ejecutar porque es
     * lo que pasa en la realidad: el empujón llega mientras la respuesta HTTP se
     * pierde.
     */
    const plan = await motor.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos,
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null,
      modoMargen: 'isolated'
    });
    const oid = clientOidDe(plan.id, 0, 'long');
    registroOrdenesUta.registrar({
      orderId: '1480000000000000009',
      clientOid: oid,
      symbol: SIMBOLO,
      state: 'filled',
      size: '0.0157',
      baseVolume: '0.0157',
      priceAvg: '63200.5'
    });

    const lote = await motor.ejecutar(plan);

    expect(lote.jobs[0]?.estado).toBe('exito');
    expect(lote.jobs[0]?.ordenId).toBe('1480000000000000009');

    /*
     * ======================================================================
     * La mitad que importa: una sola apertura llegó al exchange
     * ======================================================================
     * Resolver una casilla como correcta no vale de nada si por el camino se
     * mandó una segunda orden. Es la regla dura nº 2 medida donde ocurre.
     */
    expect(aperturasEnviadas()).toBe(1);
  });

  it('queda indeterminada si el socket no la anunció, y tampoco se reenvía', async () => {
    exchange.responderCon((p) => {
      const comun = comunes(p);
      if (comun !== null) return comun;
      if (p.url.includes('place-order')) return { retrasoMs: 3_000 };
      return null;
    });

    const lote = await planYEjecuta();

    /*
     * «No consta» no es «no entró». La casilla se marca y el operador la
     * comprueba en Bitget; lo que no se hace es darla por fallida y ofrecerla
     * para reintentar, que abriría la posición dos veces.
     */
    expect(lote.jobs[0]?.estado).toBe('indeterminada');
    expect(aperturasEnviadas()).toBe(1);
  });
});

/* ========================================================================== */
/* §9.5 y §9.13 · El monitor de una cuenta UTA: cierre y reconexión           */
/* ========================================================================== */

describe('§9.5 y §9.13 · el monitor de una subcuenta UTA', () => {
  let servidor: WsSimulado;
  let almacen: AlmacenPosiciones;
  const creados: PoolSockets[] = [];

  const UTA = {
    apiKey: 'key_uta',
    secretKey: 'secreto',
    passphrase: 'frase',
    superficie: 'v3' as const
  };

  class Fuente implements FuentePool {
    readonly modoRest: { cuentaId: string; enModoRest: boolean }[] = [];

    cuentasCalientes(): CuentaSocket[] {
      return [{ cuentaId: 'cta_uta', credencial: UTA }];
    }

    operativa(): boolean {
      return true;
    }

    marcarModoRest(cuentaId: string, enModoRest: boolean): void {
      this.modoRest.push({ cuentaId, enModoRest });
    }
  }

  const posicionUta = (extra: Record<string, unknown> = {}): unknown => ({
    symbol: SIMBOLO,
    posSide: 'long',
    total: '0.0157',
    marginMode: 'isolated',
    avgPrice: '63200.5',
    liquidationPrice: '57000.1',
    leverage: '10',
    ...extra
  });

  beforeEach(async () => {
    servidor = await iniciarWsSimulado();
    almacen = new AlmacenPosiciones();
  });

  afterEach(async () => {
    for (const p of creados) p.detener();
    creados.length = 0;
    await servidor.cerrar();
  });

  /**
   * Reloj del pool, controlable.
   *
   * Hace falta para el backoff: tras una caída, el pool no reabre hasta que
   * vence `proximoIntento`, y esperar de verdad esos segundos metería una espera
   * real en la suite. Se adelanta el reloj y se llama a `revisar()`, que es lo
   * mismo que hace el latido.
   */
  let reloj = 1_000_000;

  const crearPool = (fuente: FuentePool): PoolSockets => {
    const pool = new PoolSockets(MERCADO_SIMULADO, almacen, fuente, {
      programar: () => null,
      cancelar: () => undefined,
      azar: () => 0.5,
      ahora: () => reloj,
      conexion: { url: servidor.url, pingMs: 10_000, esperaLoginMs: 500 }
    });
    creados.push(pool);
    return pool;
  };

  it('§9.5 · un tamaño de cero borra la posición de la tabla', async () => {
    const pool = crearPool(new Fuente());
    pool.iniciar();
    await vi.waitFor(() => expect(pool.vivos).toHaveLength(1));

    servidor.empujar(empujonUta('position', 'snapshot', [posicionUta()]));
    await vi.waitFor(() => expect(almacen.tamano).toBe(1));

    /*
     * Bitget no manda un «cerrada»: manda la posición con tamaño cero. Leerlo
     * mal dejaría en el monitor una fila de una posición que ya no existe, que
     * es sobre lo que el operador decide si cierra o no.
     */
    servidor.empujar(empujonUta('position', 'update', [posicionUta({ total: '0' })]));
    await vi.waitFor(() => expect(almacen.tamano).toBe(0));
  });

  it('§9.13 · tras una caída del socket, la cuenta reconecta y su fila vuelve', async () => {
    const fuente = new Fuente();
    const pool = crearPool(fuente);
    pool.iniciar();
    await vi.waitFor(() => expect(pool.vivos).toHaveLength(1));

    servidor.empujar(empujonUta('position', 'snapshot', [posicionUta()]));
    await vi.waitFor(() => expect(almacen.tamano).toBe(1));

    /* Se corta sin avisar, como una caída de red. */
    servidor.cortar();
    await vi.waitFor(() => expect(pool.vivos).toHaveLength(0));

    /*
     * La cuenta cae a modo REST y **se marca**. Es lo que impide degradar en
     * silencio: el operador ve que esa casilla puede llevar hasta 45 s de
     * retraso, en vez de creerla al segundo.
     */
    expect(fuente.modoRest.some((m) => m.enModoRest)).toBe(true);

    /*
     * La posición sigue en el monitor mientras tanto: perder el socket es perder
     * inmediatez, no información. Vaciarla al caer haría desaparecer de la
     * pantalla posiciones abiertas con dinero dentro.
     */
    expect(almacen.tamano).toBe(1);

    /* Vence el backoff y el pool reabre en el siguiente ciclo. */
    reloj += 120_000;
    pool.revisar();
    await vi.waitFor(() => expect(pool.vivos).toHaveLength(1), { timeout: 3_000 });

    servidor.empujar(empujonUta('position', 'snapshot', [posicionUta({ total: '0.02' })]));
    await vi.waitFor(() => expect(almacen.deCuenta('cta_uta')[0]?.tamano).toBe('0.02'));

    /* Y vuelve a marcarse como en vivo. */
    expect(fuente.modoRest.at(-1)).toEqual({ cuentaId: 'cta_uta', enModoRest: false });
  });
});
