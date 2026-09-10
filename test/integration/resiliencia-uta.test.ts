/**
 * Fase E: qué hace el panel cuando algo sale mal en una cuenta UTA.
 *
 * ==========================================================================
 * Las dos cosas que se prueban, y por qué son las peligrosas
 * ==========================================================================
 * Las dos tienen la misma forma —«¿se puede reenviar esto?»— y las dos, mal
 * resueltas, abren la posición dos veces con dinero real. Es la regla dura nº 2.
 *
 *  1. **El tri-estado.** Una apertura que se queda sin respuesta. En V3 no hay
 *     endpoint para preguntar por el `clientOid`, así que la respuesta sale del
 *     socket. Lo que hay que demostrar no es que responda: es que **nunca
 *     responda «no entró»** cuando lo que pasa es que no lo sabe.
 *
 *  2. **La corrección de superficie.** Una cuenta que migró a UTA entre dos usos
 *     del panel. Corregir y reenviar es correcto solo si el fallo prueba que la
 *     orden no se ejecutó. Lo que hay que demostrar es dónde **no** se corrige:
 *     ante un error de esquema, ante un corte de conexión, ante un código que ya
 *     significa otra cosa.
 *
 * Los casos negativos son la mitad del archivo a propósito. Un mecanismo de
 * reintento se juzga por lo que se niega a reintentar.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MERCADO_SIMULADO } from '@main/bitget/mercado';
import { ClienteBitget } from '@main/bitget/rest/client';
import { consultarOrden } from '@main/bitget/rest/endpoints/ordenes';
import { RegistroOrdenesUta } from '@main/bitget/registro-ordenes-uta';
import { consultarOrdenV3 } from '@main/bitget/rest/endpoints/ordenes-v3';
import { ordenesDeEmpujon } from '@main/bitget/ws/empujones';
import { ErrorBitget } from '@main/bitget/errors';
import {
  MotorLotes,
  clientOidDe,
  type CuentaEjecutable,
  type FuenteCuentas,
  type ObjetivoApertura
} from '@main/execution/motor-lotes';
import {
  iniciarExchangeSimulado,
  sobreError,
  sobreOk,
  type ExchangeSimulado,
  type PeticionRecibida,
  type Respuesta
} from '../mock-exchange/servidor';

const SIMBOLO = 'SBTCSUSDT';

const vista = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  orderId: '1480000000000000001',
  clientOid: 'pcbplan0l',
  symbol: SIMBOLO,
  status: 'filled',
  qty: '0.0157',
  filledQty: '0.0157',
  avgPrice: '63200.5',
  ...extra
});

/* ========================================================================== */
/* 1. El registro de órdenes del socket                                       */
/* ========================================================================== */

describe('el registro de órdenes solo responde que sí', () => {
  let reloj = 1_000_000;
  let registro: RegistroOrdenesUta;

  beforeEach(() => {
    reloj = 1_000_000;
    registro = new RegistroOrdenesUta(() => reloj);
  });

  const anotar = (extra: Record<string, unknown> = {}): void => {
    for (const v of ordenesDeEmpujon([vista(extra)])) registro.registrar(v);
  };

  it('encuentra la orden que el socket anunció', () => {
    anotar();

    const encontrada = registro.buscar('pcbplan0l', SIMBOLO);
    expect(encontrada).toMatchObject({
      orderId: '1480000000000000001',
      clientOid: 'pcbplan0l',
      symbol: SIMBOLO,
      state: 'filled'
    });
  });

  it('un identificador que no consta devuelve null, que aquí es «no se sabe»', () => {
    anotar();
    expect(registro.buscar('pcbotroplan0l', SIMBOLO)).toBeNull();
  });

  it('no da por buena una orden de otro símbolo aunque coincida el identificador', () => {
    /*
     * Hoy `clientOidDe` no puede repetirse entre cuentas. La comparación de
     * símbolo existe para que un cambio futuro de ese generador no convierta un
     * choque de identificadores en una posición dada por abierta en la cuenta
     * equivocada.
     */
    anotar();
    expect(registro.buscar('pcbplan0l', 'SETHSUSDT')).toBeNull();
  });

  it('olvida lo que ya no ayuda a nadie', () => {
    anotar();
    expect(registro.buscar('pcbplan0l', SIMBOLO)).not.toBeNull();

    reloj += 600_001;
    expect(registro.buscar('pcbplan0l', SIMBOLO)).toBeNull();
  });

  it('conserva el último estado de una orden, no el primero', () => {
    anotar({ status: 'live' });
    anotar({ status: 'filled' });

    expect(registro.buscar('pcbplan0l', SIMBOLO)?.state).toBe('filled');
    expect(registro.tamano).toBe(1);
  });

  it('no crece sin límite por mucho que empuje el socket', () => {
    for (let i = 0; i < 1_200; i += 1) anotar({ clientOid: `pcbplan${i}l` });
    expect(registro.tamano).toBeLessThanOrEqual(1_000);
  });

  it('descarta lo que llega sin identificador propio', () => {
    /* Una orden puesta desde la app de Bitget. No es de ningún lote. */
    expect(ordenesDeEmpujon([{ orderId: '1', symbol: SIMBOLO, status: 'filled' }])).toEqual([]);
  });
});

/* ========================================================================== */
/* 2. El tri-estado en UTA                                                    */
/* ========================================================================== */

describe('resolver una apertura interrumpida en una cuenta UTA', () => {
  let registro: RegistroOrdenesUta;

  beforeEach(() => {
    registro = new RegistroOrdenesUta();
  });

  it('responde que la orden entró cuando el socket la anunció', async () => {
    for (const v of ordenesDeEmpujon([vista()])) registro.registrar(v);

    const detalle = await consultarOrdenV3(SIMBOLO, 'pcbplan0l', registro);

    /* La forma de V2, porque quien pregunta no sabe de superficies. */
    expect(detalle).toMatchObject({
      orderId: '1480000000000000001',
      clientOid: 'pcbplan0l',
      symbol: SIMBOLO,
      state: 'filled',
      size: '0.0157',
      baseVolume: '0.0157',
      priceAvg: '63200.5'
    });
  });

  it('LANZA en vez de devolver null cuando no consta', async () => {
    /*
     * ======================================================================
     * Esta es la prueba que impide duplicar una posición
     * ======================================================================
     * `null` significa, en el contrato de `consultarOrden`, «la orden NO entró»,
     * y quien lo recibe da la casilla por fallida y la ofrece para reintentar.
     * Que el socket no haya anunciado la orden no prueba eso en absoluto: pudo
     * estar caído, o la cuenta fría, o el empujón venir un instante después.
     */
    const error = await consultarOrdenV3(SIMBOLO, 'pcbdesconocido0l', registro).then(
      () => null,
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(ErrorBitget);
    expect((error as ErrorBitget).clase).toBe('indeterminada');
    expect((error as ErrorBitget).codigo).toBe('V3_SIN_CONSULTA_POR_CLIENTOID');
  });

  it('una cuenta Classic sigue preguntando por REST, sin tocar el registro', async () => {
    const exchange = await iniciarExchangeSimulado();
    const cliente = new ClienteBitget({ host: exchange.url });

    try {
      exchange.responderSiempre({
        cuerpo: sobreOk({
          orderId: '9',
          clientOid: 'pcbplan0l',
          symbol: SIMBOLO,
          size: '0.01',
          state: 'filled'
        })
      });

      const detalle = await consultarOrden(
        cliente,
        { apiKey: 'k', secretKey: 's', passphrase: 'f' },
        MERCADO_SIMULADO,
        SIMBOLO,
        'pcbplan0l'
      );

      expect(detalle?.orderId).toBe('9');
      expect(exchange.peticiones[0]?.url).toContain('/api/v2/mix/order/detail');
    } finally {
      await cliente.cerrar();
      await exchange.cerrar();
    }
  });
});

/* ========================================================================== */
/* 3. La corrección de superficie                                             */
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

const CUENTA_SIMBOLO = {
  marginCoin: 'SUSDT',
  available: '3000',
  accountEquity: '3000',
  marginMode: 'isolated',
  posMode: 'hedge_mode',
  isolatedLongLever: 10,
  isolatedShortLever: 10,
  crossedMarginLeverage: 10
};

const AJUSTES_UTA = {
  uid: '1111111111',
  accountMode: 'unified',
  holdMode: 'hedge_mode',
  symbolConfigList: [
    { category: 'SUSDT-FUTURES', symbol: SIMBOLO, marginMode: 'isolated', leverage: '10' }
  ]
};

/** Una cuenta guardada como Classic, que es la situación de partida. */
class UnaCuenta implements FuenteCuentas {
  readonly correcciones: { cuentaId: string; modo: string }[] = [];
  readonly cuenta: CuentaEjecutable = {
    cuentaId: 'cta_001',
    etiqueta: 'Sub-01',
    credencial: { apiKey: 'key_cta_001', secretKey: 'secreto', passphrase: 'frase' },
    saldoDisponible: '3000',
    modoMargen: 'isolated'
  };

  cuentaEjecutable(cuentaId: string): CuentaEjecutable | null {
    return cuentaId === this.cuenta.cuentaId ? this.cuenta : null;
  }

  alCorregirModo(cuentaId: string, modo: string): void {
    this.correcciones.push({ cuentaId, modo });
  }
}

describe('una cuenta que migró a UTA entre dos usos del panel', () => {
  let exchange: ExchangeSimulado;
  let cliente: ClienteBitget;
  let cuentas: UnaCuenta;
  let motor: MotorLotes;

  const objetivos: ObjetivoApertura[] = [{ cuentaId: 'cta_001', lado: 'long' }];

  /** Lo que toda apertura necesita leer antes de enviar nada. */
  const comunes = (p: PeticionRecibida): Respuesta | null => {
    if (p.url.startsWith('/api/v2/mix/market/contracts')) return { cuerpo: sobreOk([CONTRATO]) };
    if (p.url.startsWith('/api/v2/mix/market/ticker')) return { cuerpo: sobreOk(TICKER) };
    if (p.url.startsWith('/api/v2/mix/account/account')) return { cuerpo: sobreOk(CUENTA_SIMBOLO) };
    return null;
  };

  const planificar = async (): ReturnType<MotorLotes['planificar']> =>
    motor.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos,
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null,
      modoMargen: 'isolated'
    });

  /** Las rutas que llegaron, sin la cadena de consulta. */
  const rutas = (): string[] => exchange.peticiones.map((p) => (p.url.split('?')[0] ?? ''));

  beforeEach(async () => {
    exchange = await iniciarExchangeSimulado();
    cliente = new ClienteBitget({ host: exchange.url });
    cuentas = new UnaCuenta();
    motor = new MotorLotes(cliente, cuentas, { dormir: async () => undefined });
  });

  afterEach(async () => {
    await cliente.cerrar();
    await exchange.cerrar();
  });

  it('la detecta, corrige, reenvía por V3 y conserva el mismo clientOid', async () => {
    exchange.simularUta(AJUSTES_UTA);
    exchange.responderCon((p) => {
      const comun = comunes(p);
      if (comun !== null) return comun;

      /*
       * Bitget rechaza la apertura por V2 con un código que **no está en el
       * catálogo**. Ese es el disparador: ninguno de los 22 códigos conocidos
       * significa «esta clave no habla esta API», así que el candidato a serlo
       * es justamente uno que nadie ha catalogado.
       */
      if (p.url.startsWith('/api/v2/mix/order/place-order')) {
        return { cuerpo: sobreError('40404', 'Request URL NOT FOUND') };
      }
      if (p.url.startsWith('/api/v3/trade/place-order')) {
        const cuerpo = JSON.parse(p.cuerpo) as { clientOid?: string };
        return { cuerpo: sobreOk({ orderId: '77', clientOid: cuerpo.clientOid ?? '' }) };
      }
      return null;
    });

    const plan = await planificar();
    const lote = await motor.ejecutar(plan);

    expect(lote.jobs[0]?.estado).toBe('exito');
    expect(lote.jobs[0]?.ordenId).toBe('77');

    /* El orden importa: falla en V2, pregunta al oráculo, reenvía por V3. */
    expect(rutas()).toContain('/api/v2/mix/order/place-order');
    expect(rutas()).toContain('/api/v3/account/settings');
    expect(rutas()).toContain('/api/v3/trade/place-order');

    /*
     * ======================================================================
     * El mismo identificador en los dos envíos
     * ======================================================================
     * Es lo que hace seguro el reenvío: si por lo que fuera la primera orden
     * hubiera entrado, Bitget rechaza el `clientOid` repetido en vez de abrir
     * una segunda posición. Regenerarlo aquí destruiría esa red.
     */
    const esperado = clientOidDe(plan.id, 0, 'long');
    const enviados = exchange.peticiones
      .filter((p) => p.url.includes('place-order'))
      .map((p) => (JSON.parse(p.cuerpo) as { clientOid?: string }).clientOid);

    expect(enviados).toHaveLength(2);
    expect(enviados[0]).toBe(esperado);
    expect(enviados[1]).toBe(esperado);
  });

  it('avisa del modo corregido para que el resto del lote no tropiece igual', async () => {
    exchange.simularUta(AJUSTES_UTA);
    exchange.responderCon((p) => {
      const comun = comunes(p);
      if (comun !== null) return comun;
      if (p.url.startsWith('/api/v2/')) return { cuerpo: sobreError('40404', 'NOT FOUND') };
      if (p.url.startsWith('/api/v3/trade/place-order')) {
        return { cuerpo: sobreOk({ orderId: '77', clientOid: 'x' }) };
      }
      return null;
    });

    await motor.ejecutar(await planificar());

    expect(cuentas.correcciones).toEqual([{ cuentaId: 'cta_001', modo: 'uta' }]);
    /* Y la credencial de esta ejecución ya va sellada, no solo la persistida. */
    expect(cuentas.cuenta.credencial.superficie).toBe('v3');
    expect(cuentas.cuenta.credencial.holdMode).toBe('hedge_mode');
  });

  it('no corrige nada si el modo guardado ya era el correcto', async () => {
    /* Cuenta clásica de verdad: el oráculo rechaza V3, así que no hay nada que corregir. */
    exchange.responderCon((p) => {
      const comun = comunes(p);
      if (comun !== null) return comun;
      if (p.url.startsWith('/api/v2/mix/order/place-order')) {
        return { cuerpo: sobreError('49001', 'algo que nadie ha catalogado') };
      }
      return null;
    });

    const lote = await motor.ejecutar(await planificar());

    expect(lote.jobs[0]?.estado).toBe('fallo');
    /* Preguntó al oráculo una vez, y al ver que coincidía no reenvió. */
    expect(rutas().filter((r) => r === '/api/v2/mix/order/place-order')).toHaveLength(1);
    expect(cuentas.correcciones).toEqual([]);
  });
});

/* ========================================================================== */
/* 4. Dónde NO se corrige. La mitad que importa                               */
/* ========================================================================== */

describe('la corrección de superficie se niega a actuar', () => {
  let exchange: ExchangeSimulado;
  let cliente: ClienteBitget;
  let cuentas: UnaCuenta;
  let motor: MotorLotes;

  const objetivos: ObjetivoApertura[] = [{ cuentaId: 'cta_001', lado: 'long' }];

  const comunes = (p: PeticionRecibida): Respuesta | null => {
    if (p.url.startsWith('/api/v2/mix/market/contracts')) return { cuerpo: sobreOk([CONTRATO]) };
    if (p.url.startsWith('/api/v2/mix/market/ticker')) return { cuerpo: sobreOk(TICKER) };
    if (p.url.startsWith('/api/v2/mix/account/account')) return { cuerpo: sobreOk(CUENTA_SIMBOLO) };
    return null;
  };

  const ejecutar = async (): Promise<ReturnType<MotorLotes['ejecutar']>> => {
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

  const consultasAlOraculo = (): number =>
    exchange.peticiones.filter((p) => p.url.startsWith('/api/v3/account/settings')).length;

  beforeEach(async () => {
    exchange = await iniciarExchangeSimulado();
    cliente = new ClienteBitget({ host: exchange.url });
    cuentas = new UnaCuenta();
    motor = new MotorLotes(cliente, cuentas, { dormir: async () => undefined });
    /* La cuenta *sí* es UTA: si el mecanismo se disparara, corregiría. */
    exchange.simularUta(AJUSTES_UTA);
  });

  afterEach(async () => {
    await cliente.cerrar();
    await exchange.cerrar();
  });

  it('ante un código catalogado, porque ya se sabe qué significa', async () => {
    exchange.responderCon((p) => {
      const comun = comunes(p);
      if (comun !== null) return comun;
      if (p.url.startsWith('/api/v2/mix/order/place-order')) {
        return { cuerpo: sobreError('43012', 'insufficient balance') };
      }
      return null;
    });

    const lote = await ejecutar();

    /*
     * Saldo insuficiente es saldo insuficiente en las dos superficies. Preguntar
     * al oráculo por cada casilla de un lote de trescientas sería una tormenta de
     * peticiones para acabar sabiendo lo que el código ya decía.
     */
    expect(lote.jobs[0]?.estado).toBe('fallo');
    expect(consultasAlOraculo()).toBe(0);
  });

  it('ante una respuesta ilegible, porque la orden pudo haberse ejecutado', async () => {
    exchange.responderCon((p) => {
      const comun = comunes(p);
      if (comun !== null) return comun;
      if (p.url.startsWith('/api/v2/mix/order/place-order')) {
        /* `00000`, pero sin los campos que el esquema exige. */
        return { cuerpo: sobreOk({ nada: 'que ver' }) };
      }
      return null;
    });

    const lote = await ejecutar();

    /*
     * ======================================================================
     * Es el caso más peligroso de todo el archivo
     * ======================================================================
     * Bitget respondió éxito y el cuerpo no encajó. La orden **pudo entrar**.
     * Reenviarla —aunque fuera a la otra superficie— es exactamente cómo se
     * abren dos posiciones. Por eso `esRechazoDeNegocio` exige un código
     * numérico y `ESQUEMA` no lo es.
     */
    expect(lote.jobs[0]?.estado).toBe('fallo');
    expect(lote.jobs[0]?.codigoBitget).toBe('ESQUEMA');
    expect(consultasAlOraculo()).toBe(0);
  });

  it('ante un corte de conexión, porque el resultado es desconocido', async () => {
    exchange.responderCon((p) => {
      const comun = comunes(p);
      if (comun !== null) return comun;
      if (p.url.startsWith('/api/v2/mix/order/place-order')) {
        /* Se cuelga: la petición sale y no vuelve nada. */
        return { retrasoMs: 2_000 };
      }
      return null;
    });

    /* Plazos de milisegundos para no esperar de verdad a que expire. */
    await cliente.cerrar();
    cliente = new ClienteBitget({
      host: exchange.url,
      timeoutsMs: { conexion: 50, cabeceras: 50, cuerpo: 50 }
    });
    motor = new MotorLotes(cliente, cuentas, { dormir: async () => undefined });

    const lote = await ejecutar();

    /*
     * `indeterminada` no se reenvía nunca, ni corregida. Se consulta. Y la
     * consulta, en una cuenta guardada como Classic, va por REST a V2.
     */
    expect(['indeterminada', 'fallo']).toContain(lote.jobs[0]?.estado);
    expect(consultasAlOraculo()).toBe(0);
  });

  it('más de una vez por casilla', async () => {
    let intentos = 0;
    exchange.responderCon((p) => {
      const comun = comunes(p);
      if (comun !== null) return comun;
      if (p.url.includes('place-order')) {
        intentos += 1;
        return { cuerpo: sobreError('40404', 'NOT FOUND') };
      }
      return null;
    });

    const lote = await ejecutar();

    /*
     * Corrige a V3, reenvía, y V3 también rechaza. No se vuelve a preguntar: sin
     * el tope, una cuenta que rechaza en las dos superficies produciría una
     * consulta al oráculo por cada vuelta.
     */
    expect(lote.jobs[0]?.estado).toBe('fallo');
    expect(intentos).toBe(2);
    expect(consultasAlOraculo()).toBe(1);
  });
});
