/**
 * El motor de lotes, contra el exchange simulado.
 *
 * --------------------------------------------------------------------------
 * Que se prueba aqui que no se pueda probar contra Bitget
 * --------------------------------------------------------------------------
 * Todo lo que sale mal. Bitget no rechaza una orden a peticion, no se cuelga
 * cuando conviene y no deja lanzar trescientas ordenes para ver que aguanta el
 * ritmo. Aqui si: el exchange simulado responde en funcion de la cuenta, y el
 * reloj y la espera del limitador se inyectan, asi que un lote de 300 cuentas
 * se ejecuta entero en milisegundos y de forma determinista.
 *
 * Las cuatro promesas que sostienen esta fase se comprueban una por una:
 * no duplicar, no arrastrar, no saturar y decir donde fallo.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClienteBitget } from '@main/bitget/rest/client';
import { LimitadorPeticiones } from '@main/execution/rate-limiter';
import { MERCADO_SIMULADO } from '@main/bitget/mercado';
import {
  MotorLotes,
  clientOidDe,
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

/** Contrato real de SBTCSUSDT, capturado de api.bitget.com el 12/08/2026. */
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

/** Fuente de cuentas de mentira: sin vault, sin disco y sin red. */
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
        modoMargen: 'crossed'
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

  olvidar(cuentaId: string): void {
    this.mapa.delete(cuentaId);
  }

  fijarApalancamiento(
    cuentaId: string,
    a: { long: number | null; short: number | null; cruzado: number | null }
  ): void {
    const c = this.mapa.get(cuentaId);
    if (c) c.apalancamiento = a;
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
let progreso: Lote[];

/**
 * Responde el catalogo y el ticker; delega las ordenes en `alOrdenar`.
 *
 * `alOrdenar` devuelve una **respuesta completa**, no solo el sobre: hace falta
 * poder simular tambien un 500 o un cuerpo que no es JSON, que es justo lo que
 * distingue un rechazo de Bitget de un corte de red.
 */
function enrutar(alOrdenar: (cuerpo: Record<string, unknown>) => Respuesta): void {
  exchange.responderCon((p) => {
    if (p.url.startsWith('/api/v2/mix/market/contracts')) return { cuerpo: sobreOk([CONTRATO]) };
    if (p.url.startsWith('/api/v2/mix/market/ticker')) return { cuerpo: sobreOk(TICKER) };
    if (p.url.startsWith('/api/v2/mix/order/place-order')) {
      return alOrdenar(JSON.parse(p.cuerpo) as Record<string, unknown>);
    }
    return null;
  });
}

const ordenAceptada = (cuerpo: Record<string, unknown>): Respuesta => ({
  cuerpo: sobreOk({ orderId: `ord_${String(cuerpo['clientOid'])}`, clientOid: cuerpo['clientOid'] })
});

/** Rechazo de Bitget: HTTP 200 con codigo de error dentro. El caso traicionero. */
const rechazoBitget = (code: string, msg: string): Respuesta => ({
  cuerpo: { code, msg, requestTime: 1, data: null }
});

beforeEach(async () => {
  exchange = await iniciarExchangeSimulado();
  /* Limitador con espera instantanea: el ritmo se prueba en rate-limiter.test.ts. */
  cliente = new ClienteBitget({
    host: exchange.url,
    limitador: new LimitadorPeticiones({ dormir: async () => undefined })
  });
  cuentas = new Cuentas(20);
  progreso = [];
  motor = new MotorLotes(cliente, cuentas, {
    dormir: async () => undefined,
    alProgresar: (l) => progreso.push(structuredClone(l))
  });
});

afterEach(async () => {
  await cliente.cerrar();
  await exchange.cerrar();
});

describe('planificacion: nada sale sin haberse calculado antes', () => {
  it('calcula cantidad y precio de referencia sin enviar ninguna orden', async () => {
    enrutar(ordenAceptada);

    const plan = await motor.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: cuentas.objetivos(5),
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null
    });

    expect(plan.entradas).toHaveLength(5);
    expect(plan.precioReferencia).toBe('63381.3');
    expect(plan.entradas[0]?.size).toBe('0.0157');
    /* Ni una peticion de orden: solo catalogo y ticker. */
    expect(exchange.peticiones.filter((p) => p.url.includes('place-order'))).toHaveLength(0);
  });

  /*
   * Si el problema esta en los parametros de la operacion, no debe salir ni una
   * sola orden. Es el primero de los dos frenos del pliego.
   */
  it('un activo inexistente aborta el lote entero', async () => {
    enrutar(ordenAceptada);

    await expect(
      motor.planificar({
        mercado: MERCADO_SIMULADO,
        simbolo: 'NOEXISTEUSDT',
        objetivos: cuentas.objetivos(5),
        margenInicial: '100',
        apalancamiento: 10,
        precioLimite: null
      })
    ).rejects.toThrow(/no existe/);
  });

  it('sin objetivos no hay plan', async () => {
    enrutar(ordenAceptada);
    await expect(
      motor.planificar({
        mercado: MERCADO_SIMULADO,
        simbolo: SIMBOLO,
        objetivos: [],
        margenInicial: '100',
        apalancamiento: 10,
        precioLimite: null
      })
    ).rejects.toThrow(/casilla/);
  });

  /* Lo que depende de cada cuenta no aborta el lote: se descarta esa cuenta. */
  it('separa las cuentas que no pueden de las que si, con el motivo', async () => {
    enrutar(ordenAceptada);
    cuentas.fijarSaldo('cta_003', '10');
    cuentas.olvidar('cta_007');

    const plan = await motor.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: cuentas.objetivos(10),
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null
    });

    expect(plan.entradas).toHaveLength(8);
    expect(plan.descartes).toHaveLength(2);
    expect(plan.descartes.find((d) => d.cuentaId === 'cta_003')?.motivo).toBe('margen-insuficiente');
    expect(plan.descartes.find((d) => d.cuentaId === 'cta_007')?.motivo).toBe('cuenta-desconocida');
  });

  it('el catalogo se pide una vez, no una por lote', async () => {
    enrutar(ordenAceptada);
    const peticion = {
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: cuentas.objetivos(2),
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null
    };

    await motor.planificar(peticion);
    await motor.planificar(peticion);

    expect(exchange.peticiones.filter((p) => p.url.includes('contracts'))).toHaveLength(1);
  });
});

describe('el apalancamiento de la cuenta', () => {
  /*
   * El cliente confirmo que el apalancamiento se fija una vez en Bitget y queda
   * fijo: la apertura no lo cambia. Pero el margen comprometido depende de el,
   * asi que una cuenta en otro apalancamiento no es un fallo -la orden sale
   * igual- pero si algo que el operador tiene que leer antes de confirmar.
   */
  it('avisa cuando la cuenta esta en otro apalancamiento, con el margen real', async () => {
    enrutar(ordenAceptada);
    cuentas.fijarApalancamiento('cta_002', { long: 20, short: 20, cruzado: 20 });

    const plan = await motor.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: cuentas.objetivos(4),
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null
    });

    expect(plan.entradas).toHaveLength(4);
    expect(plan.avisos).toHaveLength(1);
    expect(plan.avisos[0]?.cuentaId).toBe('cta_002');
    expect(plan.avisos[0]?.codigo).toBe('apalancamiento-distinto');
    /* Dice el numero concreto: a 20x la misma cantidad compromete la mitad. */
    expect(plan.avisos[0]?.mensaje).toContain('20x');
    expect(plan.avisos[0]?.mensaje).toContain('49.75');
  });

  it('no avisa cuando coincide', async () => {
    enrutar(ordenAceptada);
    cuentas.fijarApalancamiento('cta_001', { long: 10, short: 10, cruzado: 10 });

    const plan = await motor.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: cuentas.objetivos(3),
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null
    });

    expect(plan.avisos).toEqual([]);
  });

  /* No saberlo no es lo mismo que saber que difiere: no se inventa un aviso. */
  it('no avisa de lo que no sabe', async () => {
    enrutar(ordenAceptada);

    const plan = await motor.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: cuentas.objetivos(3),
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null
    });

    expect(plan.avisos).toEqual([]);
  });

  it('en margen cruzado manda el apalancamiento cruzado, no el del lado', async () => {
    enrutar(ordenAceptada);
    /* La cuenta es `crossed`: los valores por lado no aplican. */
    cuentas.fijarApalancamiento('cta_001', { long: 10, short: 10, cruzado: 25 });

    const plan = await motor.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: cuentas.objetivos(1),
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null
    });

    expect(plan.avisos).toHaveLength(1);
    expect(plan.avisos[0]?.mensaje).toContain('25x');
  });
});

describe('ejecucion: la orden que sale es la que se planifico', () => {
  it('envia lo acordado, con el lado y el modo correctos', async () => {
    const cuerpos: Record<string, unknown>[] = [];
    enrutar((c) => {
      cuerpos.push(c);
      return ordenAceptada(c);
    });

    const plan = await motor.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: [{ cuentaId: 'cta_001', lado: 'long' }, { cuentaId: 'cta_002', lado: 'short' }],
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null
    });
    const lote = await motor.ejecutar(plan);

    expect(resumirLote(lote).exito).toBe(2);
    expect(cuerpos[0]).toMatchObject({
      symbol: SIMBOLO,
      productType: 'SUSDT-FUTURES',
      marginCoin: 'SUSDT',
      side: 'buy',
      tradeSide: 'open',
      orderType: 'market',
      size: '0.0157'
    });
    /* En cobertura, abrir short es `sell` + `open`. Confundirlo cerraria un long. */
    expect(cuerpos[1]).toMatchObject({ side: 'sell', tradeSide: 'open' });
  });

  it('una orden limite lleva precio y vigencia; la de mercado no', async () => {
    const cuerpos: Record<string, unknown>[] = [];
    enrutar((c) => {
      cuerpos.push(c);
      return ordenAceptada(c);
    });

    const plan = await motor.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: cuentas.objetivos(1),
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: '60000'
    });
    await motor.ejecutar(plan);

    expect(cuerpos[0]).toMatchObject({ orderType: 'limit', price: '60000', force: 'gtc' });
  });
});

describe('un fallo no arrastra a los demas', () => {
  /*
   * El escenario del pliego: entra en 31 y falla en 3. Lo correcto queda hecho
   * y el informe dice cuenta por cuenta que paso.
   */
  it('las que fallan quedan senaladas y las demas terminan', async () => {
    enrutar((c) => {
      const oid = String(c['clientOid']);
      if (oid.endsWith('2l') || oid.endsWith('5l')) {
        return rechazoBitget('43012', 'Insufficient balance');
      }
      return ordenAceptada(c);
    });

    const plan = await motor.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: cuentas.objetivos(10),
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null
    });
    const lote = await motor.ejecutar(plan);

    const resumen = resumirLote(lote);
    expect(resumen.exito).toBe(8);
    expect(resumen.fallo).toBe(2);

    const fallidos = lote.jobs.filter((j) => j.estado === 'fallo');
    expect(fallidos.every((j) => j.codigoBitget === '43012')).toBe(true);
    /* El informe lo lee un operador: tiene que decir en que subcuenta fue. */
    expect(fallidos.every((j) => j.etiqueta.startsWith('Sub-'))).toBe(true);
  });

  it('un corte de red en una cuenta no tumba el bloque', async () => {
    enrutar((c) => {
      const oid = String(c['clientOid']);
      if (oid.endsWith('1l')) return { estado: 500, cuerpo: 'gateway' };
      return ordenAceptada(c);
    });

    const plan = await motor.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: cuentas.objetivos(6),
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null
    });
    const lote = await motor.ejecutar(plan);

    expect(resumirLote(lote).exito).toBe(5);
    expect(lote.jobs.filter((j) => j.estado !== 'exito')).toHaveLength(1);
  });

  it('los descartes aparecen en el informe como omitidos, no desaparecen', async () => {
    enrutar(ordenAceptada);
    cuentas.fijarSaldo('cta_004', '1');

    const plan = await motor.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: cuentas.objetivos(5),
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null
    });
    const lote = await motor.ejecutar(plan);

    const resumen = resumirLote(lote);
    expect(resumen.exito).toBe(4);
    expect(resumen.omitida).toBe(1);
    expect(lote.jobs).toHaveLength(5);
  });
});

describe('no se duplica una posicion', () => {
  it('el identificador de cada orden es estable entre ejecuciones', async () => {
    enrutar(ordenAceptada);

    const plan = await motor.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: cuentas.objetivos(3),
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null
    });

    expect(plan.entradas[0]?.clientOid).toBe(clientOidDe(plan.id, 0, 'long'));

    const primera = await motor.ejecutar(plan);
    const segunda = await motor.ejecutar(plan);

    expect(primera.jobs.map((j) => j.clientOid)).toEqual(segunda.jobs.map((j) => j.clientOid));
  });

  /*
   * La carrera realista: el operador pulsa dos veces. Sin cerrojo, los dos
   * envios corren en paralelo y el limitador no distingue uno de otro.
   */
  it('dos ejecuciones simultaneas del mismo plan: la segunda se rechaza', async () => {
    enrutar((c) => ({ retrasoMs: 40, cuerpo: ordenAceptada(c) }));

    const plan = await motor.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: cuentas.objetivos(4),
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null
    });

    const primera = motor.ejecutar(plan);
    await expect(motor.ejecutar(plan)).rejects.toThrow(/ya se está enviando/);
    await primera;

    expect(exchange.peticiones.filter((p) => p.url.includes('place-order'))).toHaveLength(4);
  });

  it('reintentar solo las fallidas reutiliza sus identificadores', async () => {
    let fallar = true;
    enrutar((c) => {
      const oid = String(c['clientOid']);
      /* 40018 es fatal de cuenta: no se reintenta solo, queda para el operador. */
      if (fallar && oid.endsWith('1l')) return rechazoBitget('40018', 'Invalid IP');
      return ordenAceptada(c);
    });

    const plan = await motor.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: cuentas.objetivos(4),
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null
    });
    const primera = await motor.ejecutar(plan);
    const fallido = primera.jobs.find((j) => j.estado === 'fallo');
    expect(fallido).toBeDefined();

    fallar = false;
    const reintento = await motor.ejecutar(plan, [fallido?.clientOid ?? '']);

    expect(reintento.jobs.filter((j) => j.clientOid !== '')).toHaveLength(1);
    expect(reintento.jobs[0]?.clientOid).toBe(fallido?.clientOid);
    expect(reintento.jobs[0]?.estado).toBe('exito');
  });
});

describe('reintento automatico de lo transitorio', () => {
  /*
   * Un «servicio ocupado» significa que la orden no entro. Reintentar es seguro
   * porque se reenvia el mismo `clientOid`: si por lo que fuera si hubiera
   * entrado, Bitget rechaza el repetido en vez de abrir una segunda posicion.
   */
  it('un fallo transitorio se reintenta solo y acaba entrando', async () => {
    const intentos = new Map<string, number>();
    enrutar((c) => {
      const oid = String(c['clientOid']);
      const n = (intentos.get(oid) ?? 0) + 1;
      intentos.set(oid, n);
      if (n === 1) return rechazoBitget('45001', 'servicio ocupado');
      return ordenAceptada(c);
    });

    const plan = await motor.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: cuentas.objetivos(3),
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null
    });
    const lote = await motor.ejecutar(plan);

    expect(resumirLote(lote).exito).toBe(3);
    /* Y el reintento reutiliza el identificador: por eso no puede duplicar. */
    expect([...intentos.values()].every((n) => n === 2)).toBe(true);
  });

  it('el reintento no es infinito: se rinde y lo dice', async () => {
    const intentos = new Map<string, number>();
    enrutar((c) => {
      const oid = String(c['clientOid']);
      intentos.set(oid, (intentos.get(oid) ?? 0) + 1);
      return rechazoBitget('45001', 'servicio ocupado');
    });

    const plan = await motor.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: cuentas.objetivos(1),
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null
    });
    const lote = await motor.ejecutar(plan);

    expect(lote.jobs[0]?.estado).toBe('fallo');
    /* Un envio y tres reintentos, no mas. */
    expect([...intentos.values()][0]).toBe(4);
  });

  it('un fallo de cuenta no se reintenta: reintentar no lo arreglaria', async () => {
    const intentos = new Map<string, number>();
    enrutar((c) => {
      const oid = String(c['clientOid']);
      intentos.set(oid, (intentos.get(oid) ?? 0) + 1);
      return rechazoBitget('43012', 'Insufficient balance');
    });

    const plan = await motor.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: cuentas.objetivos(1),
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null
    });
    await motor.ejecutar(plan);

    expect([...intentos.values()][0]).toBe(1);
  });
});

describe('lo enviado sin respuesta se consulta, no se reintenta', () => {
  it('si la orden si habia entrado, el lote la da por buena', async () => {
    exchange.responderCon((p) => {
      if (p.url.startsWith('/api/v2/mix/market/contracts')) return { cuerpo: sobreOk([CONTRATO]) };
      if (p.url.startsWith('/api/v2/mix/market/ticker')) return { cuerpo: sobreOk(TICKER) };
      if (p.url.startsWith('/api/v2/mix/order/place-order')) return { estado: 502, cuerpo: 'corte' };
      if (p.url.startsWith('/api/v2/mix/order/detail')) {
        return {
          cuerpo: sobreOk({
            orderId: 'ord_recuperada',
            clientOid: 'x',
            symbol: SIMBOLO,
            size: '0.0157',
            state: 'filled'
          })
        };
      }
      return null;
    });

    const plan = await motor.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: cuentas.objetivos(1),
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null
    });
    const lote = await motor.ejecutar(plan);

    expect(lote.jobs[0]?.estado).toBe('exito');
    expect(lote.jobs[0]?.ordenId).toBe('ord_recuperada');
    /* Se consulto, no se reenvio: una sola orden en todo el intercambio. */
    expect(exchange.peticiones.filter((p) => p.url.includes('place-order'))).toHaveLength(1);
  });

  it('si Bitget no la conoce, se marca fallo reintentable y no queda a medias', async () => {
    exchange.responderCon((p) => {
      if (p.url.startsWith('/api/v2/mix/market/contracts')) return { cuerpo: sobreOk([CONTRATO]) };
      if (p.url.startsWith('/api/v2/mix/market/ticker')) return { cuerpo: sobreOk(TICKER) };
      if (p.url.startsWith('/api/v2/mix/order/place-order')) return { estado: 502, cuerpo: 'corte' };
      if (p.url.startsWith('/api/v2/mix/order/detail')) {
        return { cuerpo: { code: '40109', msg: 'order not exist', requestTime: 1, data: null } };
      }
      return null;
    });

    const plan = await motor.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: cuentas.objetivos(1),
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null
    });
    const lote = await motor.ejecutar(plan);

    expect(lote.jobs[0]?.estado).toBe('fallo');
    expect(lote.jobs[0]?.mensaje).toContain('no se abrió nada');
  });

  /*
   * Si ni siquiera se puede preguntar, `indeterminada` es la unica etiqueta
   * honesta. Nunca se reintenta sola: el operador lo comprueba en Bitget.
   */
  it('si tampoco se puede consultar, queda indeterminada', async () => {
    exchange.responderCon((p) => {
      if (p.url.startsWith('/api/v2/mix/market/contracts')) return { cuerpo: sobreOk([CONTRATO]) };
      if (p.url.startsWith('/api/v2/mix/market/ticker')) return { cuerpo: sobreOk(TICKER) };
      return { estado: 502, cuerpo: 'corte' };
    });

    const plan = await motor.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: cuentas.objetivos(1),
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null
    });
    const lote = await motor.ejecutar(plan);

    expect(lote.jobs[0]?.estado).toBe('indeterminada');
  });
});

describe('escala: el lote de 300 cuentas', () => {
  /*
   * El tamano que el cliente quiere operar. Lo que se comprueba no es la
   * velocidad -el reloj esta inyectado- sino que ninguna se queda sin enviar,
   * que cada una lleva su identificador y que la presion sobre la API va por
   * bloques y no de golpe.
   */
  it('trescientas cuentas: todas salen, ninguna se repite', async () => {
    cuentas = new Cuentas(300);
    motor = new MotorLotes(cliente, cuentas, { tamanoBloque: 12 });
    enrutar(ordenAceptada);

    const plan = await motor.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: cuentas.objetivos(300),
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null
    });
    const lote = await motor.ejecutar(plan);

    expect(plan.entradas).toHaveLength(300);
    expect(resumirLote(lote).exito).toBe(300);

    const oids = lote.jobs.map((j) => j.clientOid);
    expect(new Set(oids).size).toBe(300);

    const ordenes = exchange.peticiones.filter((p) => p.url.includes('place-order'));
    expect(ordenes).toHaveLength(300);
  }, 30_000);

  it('nunca hay mas peticiones en vuelo que el tamano del bloque', async () => {
    cuentas = new Cuentas(120);
    motor = new MotorLotes(cliente, cuentas, { tamanoBloque: 10 });

    let enVuelo = 0;
    let maximo = 0;
    exchange.responderCon((p) => {
      if (p.url.startsWith('/api/v2/mix/market/contracts')) return { cuerpo: sobreOk([CONTRATO]) };
      if (p.url.startsWith('/api/v2/mix/market/ticker')) return { cuerpo: sobreOk(TICKER) };
      enVuelo += 1;
      maximo = Math.max(maximo, enVuelo);
      setTimeout(() => {
        enVuelo -= 1;
      }, 5);
      return { retrasoMs: 5, cuerpo: ordenAceptada(JSON.parse(p.cuerpo) as Record<string, unknown>) };
    });

    const plan = await motor.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: cuentas.objetivos(120),
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null
    });
    await motor.ejecutar(plan);

    expect(maximo).toBeLessThanOrEqual(10);
  }, 30_000);

  it('con saldos desiguales, cada cuenta recibe el veredicto que le toca', async () => {
    cuentas = new Cuentas(300);
    for (let i = 1; i <= 300; i += 3) cuentas.fijarSaldo(`cta_${String(i).padStart(3, '0')}`, '5');
    motor = new MotorLotes(cliente, cuentas, { tamanoBloque: 20 });
    enrutar(ordenAceptada);

    const plan = await motor.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: cuentas.objetivos(300),
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null
    });
    const lote = await motor.ejecutar(plan);

    const resumen = resumirLote(lote);
    expect(resumen.exito).toBe(200);
    expect(resumen.omitida).toBe(100);
    expect(lote.jobs).toHaveLength(300);
    expect(
      lote.jobs.filter((j) => j.estado === 'omitida').every((j) => (j.mensaje ?? '').includes('Saldo'))
    ).toBe(true);
  }, 30_000);
});

describe('informe de progreso', () => {
  it('avisa del avance sin esperar a que termine el lote', async () => {
    enrutar(ordenAceptada);

    const plan = await motor.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: cuentas.objetivos(6),
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null
    });
    await motor.ejecutar(plan);

    expect(progreso.length).toBeGreaterThan(1);
    /* El ultimo aviso trae el lote terminado y cuadrado. */
    const ultimo = progreso[progreso.length - 1];
    expect(ultimo?.terminadoEn).not.toBeNull();
    expect(resumirLote(ultimo as Lote).exito).toBe(6);
  });
});
