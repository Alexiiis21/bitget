/**
 * Abrir y poner el Take Profit con **una sola confirmacion**.
 *
 * --------------------------------------------------------------------------
 * El fallo que estas pruebas impiden que vuelva
 * --------------------------------------------------------------------------
 * Hasta el 25/08/2026 eran dos operaciones. La confirmacion de abrir enseñaba
 * el porcentaje escrito en el formulario rotulado «se pone aparte», y aun asi
 * el operador lo leia dentro del dialogo de abrir y daba por hecho que salia
 * con la orden. No salia: habia que pulsar ademas «Take Profit %» y aprobar un
 * segundo plan.
 *
 * El resultado se vio en la reunion con el cliente de ese dia: posiciones
 * abiertas **sin proteccion** que el operador creia protegidas. En la captura
 * de Bitget, `Entire TP/SL: --/--` sobre una posicion recien abierta con un
 * 35% escrito en el panel.
 *
 * Es el peor modo de fallo posible aqui, porque no da ninguna señal: la
 * apertura sale correcta, el informe dice «1 correcta», y lo que falta no
 * aparece por ningun lado.
 *
 * --------------------------------------------------------------------------
 * Por que el precio de disparo se calcula dos veces
 * --------------------------------------------------------------------------
 * El precio del Take Profit sale del **precio de entrada** de la posicion, y al
 * confirmar la posicion todavia no existe. Asi que:
 *
 *   al planificar   se estima con el precio de referencia, para poder enseñar
 *                   un precio concreto en la confirmacion
 *   al ejecutar     se calcula con el precio de entrada real que devuelve
 *                   Bitget, y **ese** es el que se envia
 *
 * La ultima prueba de este archivo es la que fija esa diferencia: si alguien
 * "simplificara" mandando el precio estimado, el Take Profit quedaria en un
 * precio que no corresponde al porcentaje aprobado.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClienteBitget } from '@main/bitget/rest/client';
import { MERCADO_SIMULADO } from '@main/bitget/mercado';
import { Sesion } from '@main/ipc/sesion';
import { LimitadorPeticiones } from '@main/execution/rate-limiter';
import {
  MotorLotes,
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

/** Precio de marca con el que se dimensiona y se estima el Take Profit. */
const PRECIO_REFERENCIA = '63381.3';
const TICKER = [{ symbol: SIMBOLO, lastPr: '63378', markPrice: PRECIO_REFERENCIA }];

/**
 * Como esta el simbolo en Bitget: aislado, cobertura y 10x.
 *
 * Aislado porque es el modo con el que abren estas pruebas, y asi la apertura
 * no tiene nada que cambiar antes de enviar la orden. El caso contrario -abrir
 * en un modo distinto del que tiene el activo- se prueba en
 * `motor-apertura.test.ts`, que es donde vive esa maniobra.
 */
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

/**
 * Precio de entrada **real**, distinto del de referencia a proposito.
 *
 * Una orden a mercado no se llena exactamente al precio de marca. Separarlos
 * aqui es lo que permite distinguir cual de los dos se uso para calcular el
 * Take Profit que sale hacia Bitget.
 */
const PRECIO_ENTRADA_REAL = '63500.0';

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
        modoMargen: 'isolated'
      });
    }
  }

  cuentaEjecutable(cuentaId: string): CuentaEjecutable | null {
    return this.mapa.get(cuentaId) ?? null;
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
let sesion: Sesion;
let carpeta: string;

/** El cuerpo JSON de cada peticion a una ruta, en orden. */
const cuerposDe = (ruta: string): Record<string, unknown>[] =>
  exchange.peticiones
    .filter((p: PeticionRecibida) => p.url.startsWith(ruta))
    .map((p) => JSON.parse(p.cuerpo) as Record<string, unknown>);

/**
 * Exchange completo: catalogo, precio, apertura, posiciones y Take Profit.
 *
 * `posicionesTrasAbrir` decide que devuelve `all-position`. Por defecto, la
 * posicion que la apertura acaba de abrir, con su precio de entrada real.
 */
function enrutar(
  opciones: {
    alOrdenar?: (cuerpo: Record<string, unknown>) => Respuesta;
    alPonerTp?: (cuerpo: Record<string, unknown>) => Respuesta;
    alAjustarMargen?: (cuerpo: Record<string, unknown>) => Respuesta;
    posiciones?: () => unknown[];
  } = {}
): void {
  const alOrdenar =
    opciones.alOrdenar ??
    ((cuerpo): Respuesta => ({
      cuerpo: sobreOk({ orderId: `ord_${String(cuerpo['clientOid'])}`, clientOid: cuerpo['clientOid'] })
    }));

  const alPonerTp =
    opciones.alPonerTp ??
    ((cuerpo): Respuesta => ({
      cuerpo: sobreOk({ orderId: `plan_${String(cuerpo['clientOid'])}`, clientOid: cuerpo['clientOid'] })
    }));

  const alAjustarMargen =
    opciones.alAjustarMargen ?? ((): Respuesta => ({ cuerpo: sobreOk({}) }));

  const posiciones =
    opciones.posiciones ??
    ((): unknown[] => [
      {
        symbol: SIMBOLO,
        holdSide: 'long',
        total: '0.1578',
        available: '0.1578',
        marginCoin: 'SUSDT',
        marginMode: 'isolated',
        openPriceAvg: PRECIO_ENTRADA_REAL,
        leverage: '10',
        marginSize: '100'
      }
    ]);

  exchange.responderCon((p) => {
    if (p.url.startsWith('/api/v2/mix/market/contracts')) return { cuerpo: sobreOk([CONTRATO]) };
    if (p.url.startsWith('/api/v2/mix/market/ticker')) return { cuerpo: sobreOk(TICKER) };
    /*
     * Como esta configurado el simbolo. La apertura lo lee para saber si tiene
     * que cambiar el modo de margen antes de abrir; sin esta ruta descartaria
     * cada casilla con `modo-margen-ilegible` -no se abre a ciegas- y ninguna
     * de estas pruebas llegaria a colocar un Take Profit.
     */
    if (p.url.startsWith('/api/v2/mix/account/account')) {
      return { cuerpo: sobreOk(CUENTA_SIMBOLO) };
    }
    /* `set-margin-mode` primero: `set-margin` es prefijo suyo. */
    if (p.url.startsWith('/api/v2/mix/account/set-margin-mode')) {
      return { cuerpo: sobreOk({ symbol: SIMBOLO, marginCoin: 'SUSDT' }) };
    }
    if (p.url.startsWith('/api/v2/mix/account/set-margin')) {
      return alAjustarMargen(JSON.parse(p.cuerpo) as Record<string, unknown>);
    }
    if (p.url.startsWith('/api/v2/mix/position/all-position')) {
      return { cuerpo: sobreOk(posiciones()) };
    }
    if (p.url.startsWith('/api/v2/mix/order/place-order')) {
      return alOrdenar(JSON.parse(p.cuerpo) as Record<string, unknown>);
    }
    if (p.url.startsWith('/api/v2/mix/order/place-tpsl-order')) {
      return alPonerTp(JSON.parse(p.cuerpo) as Record<string, unknown>);
    }
    return null;
  });
}

beforeEach(async () => {
  carpeta = await mkdtemp(join(tmpdir(), 'pcb-apertura-tp-'));
  exchange = await iniciarExchangeSimulado();
  cliente = new ClienteBitget({
    host: exchange.url,
    limitador: new LimitadorPeticiones({ dormir: async () => undefined })
  });
  cuentas = new Cuentas(3);
  motor = new MotorLotes(cliente, cuentas, { dormir: async () => undefined });
  sesion = new Sesion(
    {
      vault: join(carpeta, 'vault.enc'),
      cuentas: join(carpeta, 'cuentas.json'),
      activos: join(carpeta, 'activos.json')
    },
    cliente,
    { mercado: 'simulado', motor, dormir: async () => undefined }
  );

  /*
   * El almacen tiene que estar abierto para que la sesion deje planificar. Las
   * credenciales de verdad no hacen falta: el motor lleva inyectada su propia
   * fuente de cuentas, que es la que resuelve cada subcuenta.
   */
  await sesion.crear('contrasena-de-prueba');
});

afterEach(async () => {
  sesion.cerrar();
  await cliente.cerrar();
  await exchange.cerrar();
  await rm(carpeta, { recursive: true, force: true });
});

describe('planificacion: el Take Profit se ve antes de abrir', () => {
  it('estima el precio de disparo con el precio de referencia', async () => {
    enrutar();

    const plan = await motor.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: cuentas.objetivos(1),
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null,
      modoMargen: 'isolated',
      takeProfitPorcentaje: '35'
    });

    /*
     * 63381,3 x (1 + 0,35/10) = 65599,6455, y el paso de precio de SBTCSUSDT es
     * 0,1: truncado hacia la entrada queda en 65599,6.
     */
    expect(plan.takeProfitPorcentaje).toBe('35');
    expect(plan.entradas[0]?.precioDisparoTp).toBe('65599.6');
    /* Planificar no envia nada: ni orden, ni Take Profit. */
    expect(cuerposDe('/api/v2/mix/order/place-order')).toHaveLength(0);
    expect(cuerposDe('/api/v2/mix/order/place-tpsl-order')).toHaveLength(0);
  });

  it('sin porcentaje, el plan no lleva Take Profit', async () => {
    enrutar();

    const plan = await motor.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: cuentas.objetivos(1),
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null,
      modoMargen: 'isolated',
    });

    expect(plan.takeProfitPorcentaje).toBeNull();
    expect(plan.entradas[0]?.precioDisparoTp).toBeNull();
  });

  /*
   * La casilla se descarta entera en vez de abrirse sin proteccion. Entre los
   * dos errores posibles, el inofensivo es no abrir: la posicion que no existe
   * no se puede liquidar.
   */
  it('no abre la posicion si su Take Profit no se puede colocar', async () => {
    enrutar();

    const plan = await motor.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: cuentas.objetivos(1),
      margenInicial: '100',
      apalancamiento: 125,
      precioLimite: null,
      modoMargen: 'isolated',
      /* Un 0,01% a 125x no llega ni a un paso de precio: no hay donde ponerlo. */
      takeProfitPorcentaje: '0.01'
    });

    expect(plan.entradas).toHaveLength(0);
    expect(plan.descartes[0]?.motivo).toBe('sin-recorrido');
    expect(plan.descartes[0]?.mensaje).toContain('No se abre la posición');
  });
});

describe('ejecucion: una confirmacion, las dos cosas', () => {
  it('coloca el Take Profit tras abrir, sin una segunda confirmacion', async () => {
    enrutar();

    const plan = await sesion.planificarApertura({
      simbolo: SIMBOLO,
      objetivos: cuentas.objetivos(1),
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null,
      modoMargen: 'isolated',
      takeProfitPorcentaje: '35'
    });

    const lote = await sesion.ejecutarApertura(plan.id);

    /* La orden salio... */
    const ordenes = cuerposDe('/api/v2/mix/order/place-order');
    expect(ordenes).toHaveLength(1);
    expect(ordenes[0]?.['tradeSide']).toBe('open');

    /* ...y el Take Profit tambien, en la misma ejecucion. */
    const tps = cuerposDe('/api/v2/mix/order/place-tpsl-order');
    expect(tps).toHaveLength(1);
    expect(tps[0]?.['planType']).toBe('pos_profit');
    expect(tps[0]?.['holdSide']).toBe('long');

    /* El informe enseña las dos filas: la apertura y su Take Profit. */
    const apertura = lote.jobs.find((j) => j.etiqueta === 'Sub-01');
    const tp = lote.jobs.find((j) => j.etiqueta === 'Sub-01 · TP');
    expect(apertura?.estado).toBe('exito');
    expect(tp?.estado).toBe('exito');
  });

  /*
   * La razon de que el precio se calcule dos veces. El estimado sale de 63381,3
   * y el que se envia, de la entrada real de 63500: son precios distintos, y
   * solo el segundo hace que «35%» signifique el 35% que el operador aprobo.
   */
  it('envia el precio calculado con la entrada real, no el estimado', async () => {
    enrutar();

    const plan = await sesion.planificarApertura({
      simbolo: SIMBOLO,
      objetivos: cuentas.objetivos(1),
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null,
      modoMargen: 'isolated',
      takeProfitPorcentaje: '35'
    });

    expect(plan.entradas[0]?.precioDisparoTp).toBe('65599.6');

    await sesion.ejecutarApertura(plan.id);

    /* 63500 x (1 + 0,35/10) = 65722,5, al paso de 0,1. */
    const tps = cuerposDe('/api/v2/mix/order/place-tpsl-order');
    expect(tps[0]?.['triggerPrice']).toBe('65722.5');
    expect(tps[0]?.['triggerPrice']).not.toBe('65599.6');
  });

  /*
   * Una posicion abierta a la que no se le pudo poner el Take Profit tiene que
   * VERSE. El informe descarta los mensajes de los trabajos correctos, asi que
   * doblarlo en el mensaje de la apertura lo dejaria invisible: por eso es una
   * fila propia y en estado de fallo.
   */
  it('si el Take Profit falla, la posicion queda abierta y el informe lo dice', async () => {
    enrutar({
      alPonerTp: () => ({ cuerpo: { code: '40808', msg: 'Parameter verification exception', data: null } })
    });

    const plan = await sesion.planificarApertura({
      simbolo: SIMBOLO,
      objetivos: cuentas.objetivos(1),
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null,
      modoMargen: 'isolated',
      takeProfitPorcentaje: '35'
    });

    const lote = await sesion.ejecutarApertura(plan.id);

    /* La apertura NO se convierte en fallida: la posicion si se abrio. */
    expect(lote.jobs.find((j) => j.etiqueta === 'Sub-01')?.estado).toBe('exito');

    const tp = lote.jobs.find((j) => j.etiqueta === 'Sub-01 · TP');
    expect(tp?.estado).toBe('fallo');
    expect(tp?.mensaje).toContain('SIN Take Profit');
  });

  /*
   * La posicion puede tardar un instante en aparecer despues de que la orden
   * entre. Descartarla a la primera lectura dejaria sin Take Profit una
   * posicion recien abierta, que es el fallo original con otra cara.
   */
  it('reintenta la lectura de la posicion antes de darla por ausente', async () => {
    let lecturas = 0;
    enrutar({
      posiciones: () => {
        lecturas += 1;
        /* La primera lectura llega antes de que Bitget la refleje. */
        return lecturas === 1
          ? []
          : [
              {
                symbol: SIMBOLO,
                holdSide: 'long',
                total: '0.1578',
                marginCoin: 'SUSDT',
                marginMode: 'isolated',
                openPriceAvg: PRECIO_ENTRADA_REAL,
                leverage: '10',
                marginSize: '100'
              }
            ];
      }
    });

    const plan = await sesion.planificarApertura({
      simbolo: SIMBOLO,
      objetivos: cuentas.objetivos(1),
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null,
      modoMargen: 'isolated',
      takeProfitPorcentaje: '35'
    });

    const lote = await sesion.ejecutarApertura(plan.id);

    expect(lecturas).toBeGreaterThan(1);
    expect(cuerposDe('/api/v2/mix/order/place-tpsl-order')).toHaveLength(1);
    expect(lote.jobs.find((j) => j.etiqueta === 'Sub-01 · TP')?.estado).toBe('exito');
  });

  /* Sin porcentaje no se toca `place-tpsl-order`: abrir a secas sigue igual. */
  it('sin Take Profit escrito, no se coloca ninguno', async () => {
    enrutar();

    const plan = await sesion.planificarApertura({
      simbolo: SIMBOLO,
      objetivos: cuentas.objetivos(1),
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null,
      modoMargen: 'isolated',
      takeProfitPorcentaje: null
    });

    await sesion.ejecutarApertura(plan.id);

    expect(cuerposDe('/api/v2/mix/order/place-order')).toHaveLength(1);
    expect(cuerposDe('/api/v2/mix/order/place-tpsl-order')).toHaveLength(0);
  });
});

/**
 * El margen adicional, con la misma confirmacion y por la misma razon.
 *
 * El cliente lo escribe en el mismo formulario y en la misma pulsacion que el
 * Take Profit. Mientras fue una operacion aparte pasaba lo de siempre: la
 * confirmacion de abrir enseñaba el importe, el operador daba por hecho que
 * salia con ella, y la posicion quedaba con menos colchon del que creia.
 */
describe('el margen adicional sale con la misma confirmacion', () => {
  it('lo agrega tras abrir, y lo cuenta en su propia fila del informe', async () => {
    const margenes: Record<string, unknown>[] = [];
    enrutar({
      alAjustarMargen: (cuerpo) => {
        margenes.push(cuerpo);
        return { cuerpo: sobreOk({}) };
      }
    });

    const plan = await sesion.planificarApertura({
      simbolo: SIMBOLO,
      objetivos: cuentas.objetivos(1),
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null,
      modoMargen: 'isolated',
      margenAdicional: '50'
    });

    const lote = await sesion.ejecutarApertura(plan.id);

    expect(cuerposDe('/api/v2/mix/order/place-order')).toHaveLength(1);
    expect(margenes).toHaveLength(1);
    expect(margenes[0]?.['amount']).toBe('50');
    expect(margenes[0]?.['holdSide']).toBe('long');

    /*
     * En su propia fila y no dentro del mensaje de la apertura: el informe
     * descarta los mensajes de los trabajos correctos, asi que un margen
     * fallido escrito ahi seria invisible.
     */
    const fila = lote.jobs.find((j) => j.etiqueta === 'Sub-01 · MGA');
    expect(fila?.estado).toBe('exito');
    /* Y la apertura conserva el suyo: son dos desenlaces, no uno. */
    expect(lote.jobs.find((j) => j.etiqueta === 'Sub-01')?.estado).toBe('exito');
  });

  it('sin margen adicional escrito, no se toca `set-margin`', async () => {
    enrutar();

    const plan = await sesion.planificarApertura({
      simbolo: SIMBOLO,
      objetivos: cuentas.objetivos(1),
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null,
      modoMargen: 'isolated',
      margenAdicional: null
    });

    await sesion.ejecutarApertura(plan.id);

    expect(cuerposDe('/api/v2/mix/account/set-margin')).toHaveLength(0);
  });

  /*
   * Si el margen falla con la posicion ya abierta, la posicion existe y tiene
   * menos colchon del aprobado. Es un fallo y hay que decirlo, con la accion:
   * el motivo tecnico a secas no le dice al operador que le falta margen.
   */
  it('si el margen falla con la posicion abierta, lo cuenta como fallo', async () => {
    enrutar({
      alAjustarMargen: () => ({
        cuerpo: { code: '40808', msg: 'margin mode == FIXED', requestTime: 1, data: null }
      })
    });

    const plan = await sesion.planificarApertura({
      simbolo: SIMBOLO,
      objetivos: cuentas.objetivos(1),
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null,
      modoMargen: 'isolated',
      margenAdicional: '50'
    });

    const lote = await sesion.ejecutarApertura(plan.id);

    const fila = lote.jobs.find((j) => j.etiqueta === 'Sub-01 · MGA');
    expect(fila?.estado).toBe('fallo');
    expect(fila?.mensaje).toContain('SIN el margen adicional');
    /* La apertura sigue siendo correcta: que falle el margen no la deshace. */
    expect(lote.jobs.find((j) => j.etiqueta === 'Sub-01')?.estado).toBe('exito');
  });

  /* Las dos cosas en la misma pulsacion, cada una con su fila. */
  it('Take Profit y margen adicional salen juntos', async () => {
    enrutar();

    const plan = await sesion.planificarApertura({
      simbolo: SIMBOLO,
      objetivos: cuentas.objetivos(1),
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null,
      modoMargen: 'isolated',
      takeProfitPorcentaje: '35',
      margenAdicional: '50'
    });

    const lote = await sesion.ejecutarApertura(plan.id);

    expect(cuerposDe('/api/v2/mix/order/place-tpsl-order')).toHaveLength(1);
    expect(cuerposDe('/api/v2/mix/account/set-margin')).toHaveLength(1);
    expect(lote.jobs.find((j) => j.etiqueta === 'Sub-01 · TP')?.estado).toBe('exito');
    expect(lote.jobs.find((j) => j.etiqueta === 'Sub-01 · MGA')?.estado).toBe('exito');
  });
});
