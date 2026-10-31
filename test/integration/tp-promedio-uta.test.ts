/**
 * ELITE QLC, 28/10/2026: el Take Profit de lo agregado, en perdida.
 *
 * ==========================================================================
 * Lo que paso
 * ==========================================================================
 * Un short UTA de 6.156.000 PEPE con su Take Profit. Se agregaron 4.856.000 a
 * 0,000005148 y la orden llevo dentro `takeProfit: 0.0000051223`, calculado
 * desde el precio de **esa** orden. Bitget lo creo como un Take Profit aparte,
 * solo para lo agregado, y la entrada promedio de la posicion quedo en
 * 0,0000048531: ese Take Profit cerraba en perdida. Se disparo al minuto.
 *
 * Lo que se prueba:
 *   - agregar a una posicion con Take Profit no lo embebe: modifica el que hay,
 *     con la entrada promedio real y la cantidad de la posicion entera
 *   - un Take Profit sobrante del mismo lado se quita
 *   - agregar a una posicion sin Take Profit lo embebe calculado desde la
 *     entrada promedio estimada, y luego lo extiende a toda la posicion
 *   - ningun Take Profit sale si cierra en negativo tras comisiones
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Decimal from 'decimal.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClienteBitget } from '@main/bitget/rest/client';
import { detenerBitacora, iniciarBitacora } from '@main/diagnostico/bitacora';
import { precioTakeProfit } from '@main/domain/precio-take-profit';
import { LimitadorPeticiones } from '@main/execution/rate-limiter';
import { MotorLotes, type CuentaEjecutable, type FuenteCuentas } from '@main/execution/motor-lotes';
import { Sesion } from '@main/ipc/sesion';
import {
  iniciarExchangeSimulado,
  sobreOk,
  type ExchangeSimulado,
  type PeticionRecibida,
  type Respuesta
} from '../mock-exchange/servidor';

const KDF_PRUEBAS = { N: 16, r: 1, p: 1 };
const SIMBOLO = 'SBTCSUSDT';

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

/* La orden se agrega muy por encima de la entrada del short, como en ELITE QLC. */
const TICKER = [{ symbol: SIMBOLO, lastPr: '63378', markPrice: '63381.3' }];
const ENTRADA_PREVIA = '60000';
const TOTAL_PREVIO = '0.0157';
/* 100 de margen a 10x sobre 63381,3: 0,0157. */
const AGREGADO = '0.0157';
const TOTAL_DESPUES = '0.0314';
/* (0,0157 x 60000 + 0,0157 x 63381,3) / 0,0314 */
const ENTRADA_DESPUES = '61690.6';

const AJUSTES = {
  uid: '6915261611',
  accountMode: 'unified',
  holdMode: 'hedge_mode',
  symbolConfigList: [
    { category: 'SUSDT-FUTURES', symbol: SIMBOLO, marginMode: 'crossed', leverage: '10' }
  ]
};

class CuentaQlc implements FuenteCuentas {
  readonly cuenta: CuentaEjecutable = {
    cuentaId: 'cta_qlc',
    etiqueta: 'ELITE QLC',
    credencial: {
      apiKey: 'bg_qlc_00001395',
      secretKey: 's',
      passphrase: 'f',
      superficie: 'v3',
      holdMode: 'hedge_mode'
    },
    saldoDisponible: '3000',
    modoMargen: 'crossed'
  };

  cuentaEjecutable(cuentaId: string): CuentaEjecutable | null {
    return cuentaId === this.cuenta.cuentaId ? this.cuenta : null;
  }
}

interface Estrategia {
  orderId: string;
  clientOid: string;
  symbol: string;
  posSide: string;
  status: string;
  takeProfit: string;
  qty: string;
}

let carpeta: string;
let exchange: ExchangeSimulado;
let cliente: ClienteBitget;
let sesion: Sesion;

beforeEach(async () => {
  carpeta = await mkdtemp(join(tmpdir(), 'pcb-tp-promedio-'));
  await iniciarBitacora(join(carpeta, 'logs'));
  exchange = await iniciarExchangeSimulado();
  cliente = new ClienteBitget({
    host: exchange.url,
    limitador: new LimitadorPeticiones({ dormir: async () => undefined })
  });
  exchange.simularUta(AJUSTES);

  const fuente = new CuentaQlc();
  const motor = new MotorLotes(cliente, fuente, { dormir: async () => undefined });
  sesion = new Sesion(
    {
      vault: join(carpeta, 'vault.enc'),
      cuentas: join(carpeta, 'cuentas.json'),
      activos: join(carpeta, 'activos.json')
    },
    cliente,
    { parametrosKdf: KDF_PRUEBAS, mercado: 'simulado', motor, dormir: async () => undefined }
  );
  await sesion.crear('contrasena-de-prueba');
  vi.spyOn(sesion, 'cuentaEjecutable').mockImplementation((id) => fuente.cuentaEjecutable(id));
});

afterEach(async () => {
  sesion.cerrar();
  detenerBitacora();
  await cliente.cerrar();
  await exchange.cerrar();
  await rm(carpeta, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/**
 * Bitget UTA con un short abierto. `puestos` son los Take Profit que tiene al
 * empezar. Como Bitget, cada `place-order` con `takeProfit` crea uno aparte
 * solo para su cantidad.
 */
function enrutar(puestos: Estrategia[]): Estrategia[] {
  const estrategias = [...puestos];
  let ordenada = false;

  exchange.responderCon((p: PeticionRecibida): Respuesta | null => {
    if (p.url.startsWith('/api/v2/public/time'))
      return { cuerpo: sobreOk({ serverTime: String(Date.now()) }) };
    if (p.url.startsWith('/api/v2/mix/market/contracts')) return { cuerpo: sobreOk([CONTRATO]) };
    if (p.url.startsWith('/api/v2/mix/market/ticker')) return { cuerpo: sobreOk(TICKER) };

    if (p.url.startsWith('/api/v3/trade/place-order')) {
      ordenada = true;
      const cuerpo = JSON.parse(p.cuerpo) as Record<string, string>;
      if (cuerpo['takeProfit'] !== undefined) {
        estrategias.push({
          orderId: `tp_${cuerpo['clientOid'] ?? ''}`,
          clientOid: `tp_${cuerpo['clientOid'] ?? ''}`,
          symbol: SIMBOLO,
          posSide: cuerpo['posSide'] ?? '',
          status: 'pending',
          takeProfit: cuerpo['takeProfit'],
          qty: cuerpo['qty'] ?? ''
        });
      }
      return {
        cuerpo: sobreOk({
          orderId: `ord_${cuerpo['clientOid'] ?? ''}`,
          clientOid: cuerpo['clientOid']
        })
      };
    }

    if (p.url.startsWith('/api/v3/trade/modify-strategy-order')) {
      const cuerpo = JSON.parse(p.cuerpo) as Record<string, string>;
      const e = estrategias.find((x) => x.orderId === cuerpo['orderId']);
      if (e !== undefined) {
        e.takeProfit = cuerpo['takeProfit'] ?? e.takeProfit;
        e.qty = cuerpo['qty'] ?? e.qty;
      }
      return { cuerpo: sobreOk({ orderId: cuerpo['orderId'], clientOid: cuerpo['orderId'] }) };
    }

    if (p.url.startsWith('/api/v3/trade/cancel-strategy-order')) {
      const cuerpo = JSON.parse(p.cuerpo) as Record<string, string>;
      const i = estrategias.findIndex((x) => x.orderId === cuerpo['orderId']);
      if (i >= 0) estrategias.splice(i, 1);
      return { cuerpo: sobreOk(null) };
    }

    if (p.url.startsWith('/api/v3/trade/unfilled-strategy-orders')) {
      return { cuerpo: sobreOk(estrategias) };
    }

    if (p.url.startsWith('/api/v3/position/current-position')) {
      return {
        cuerpo: sobreOk({
          list: [
            {
              symbol: SIMBOLO,
              posSide: 'short',
              total: ordenada ? TOTAL_DESPUES : TOTAL_PREVIO,
              marginMode: 'crossed',
              avgPrice: ordenada ? ENTRADA_DESPUES : ENTRADA_PREVIA,
              markPrice: '63381.3',
              liquidationPrice: '0',
              leverage: '10',
              marginSize: '100'
            }
          ]
        })
      };
    }
    return null;
  });

  return estrategias;
}

const tpPrincipal = (precio: string): Estrategia => ({
  orderId: 'tp_principal',
  clientOid: 'tp_principal',
  symbol: SIMBOLO,
  posSide: 'short',
  status: 'pending',
  takeProfit: precio,
  qty: TOTAL_PREVIO
});

const cuerpos = (ruta: string): Record<string, string>[] =>
  exchange.peticiones
    .filter((p) => p.url.startsWith(ruta))
    .map((p) => JSON.parse(p.cuerpo) as Record<string, string>);

/* 5 % a 10x: un 0,5 % de recorrido. Desde el precio de la orden queda por encima de la entrada promedio. */
const PORCENTAJE = '5';

const agregarShort = async (): Promise<Awaited<ReturnType<Sesion['ejecutarApertura']>>> => {
  /* El tope pide la hora a Bitget: va despues de enrutar. */
  await sesion.fijarTopeMargen('1000');
  const plan = await sesion.planificarApertura({
    simbolo: SIMBOLO,
    objetivos: [{ cuentaId: 'cta_qlc', lado: 'short' }],
    margenInicial: '100',
    apalancamiento: 10,
    precioLimite: null,
    modoMargen: 'crossed',
    takeProfitPorcentaje: PORCENTAJE
  });
  return sesion.ejecutarApertura(plan.id);
};

const tpDesde = (entrada: string): string => {
  const r = precioTakeProfit({
    contrato: CONTRATO,
    precioEntrada: entrada,
    lado: 'short',
    apalancamiento: 10,
    porcentaje: PORCENTAJE
  });
  if (!r.ok) throw new Error(r.mensaje);
  return r.disparo.precioDisparo;
};

describe('agregar a un short UTA que ya tiene Take Profit', () => {
  it('no lo embebe: modifica el que hay, con la entrada promedio y la posicion entera', async () => {
    const estrategias = enrutar([tpPrincipal('59700')]);

    const lote = await agregarShort();

    /* La orden sale sin Take Profit dentro. */
    const [orden] = cuerpos('/api/v3/trade/place-order');
    expect(orden?.['takeProfit']).toBeUndefined();
    expect(orden?.['qty']).toBe(AGREGADO);

    /* Lo que antes se habria embebido estaba en perdida respecto a la entrada nueva. */
    expect(Number(tpDesde('63381.3'))).toBeGreaterThan(Number(ENTRADA_DESPUES));

    /* Se modifica el que habia: precio desde la entrada real, cantidad de la posicion entera. */
    const [mod] = cuerpos('/api/v3/trade/modify-strategy-order');
    expect(mod?.['orderId']).toBe('tp_principal');
    expect(mod?.['qty']).toBe(TOTAL_DESPUES);
    expect(mod?.['takeProfit']).toBe(tpDesde(ENTRADA_DESPUES));
    expect(Number(mod?.['takeProfit'])).toBeLessThan(Number(ENTRADA_DESPUES));

    /* Uno solo, y comprobado. */
    expect(estrategias.filter((e) => e.posSide === 'short')).toHaveLength(1);
    const tp = lote.jobs.find((j) => j.etiqueta === 'ELITE QLC · TP');
    expect(tp?.estado).toBe('exito');
    expect(tp?.mensaje).toContain('Comprobado en Bitget');
  });

  it('quita el Take Profit sobrante del mismo lado antes de modificar el bueno', async () => {
    const sobrante: Estrategia = {
      ...tpPrincipal('63064'),
      orderId: 'tp_sobrante',
      clientOid: 'tp_sobrante',
      qty: '0.0050'
    };
    const estrategias = enrutar([tpPrincipal('59700'), sobrante]);

    const lote = await agregarShort();

    const cancelados = cuerpos('/api/v3/trade/cancel-strategy-order');
    expect(cancelados.map((c) => c['orderId'])).toEqual(['tp_sobrante']);
    const [mod] = cuerpos('/api/v3/trade/modify-strategy-order');
    expect(mod?.['orderId']).toBe('tp_principal');
    expect(estrategias.map((e) => e.orderId)).toEqual(['tp_principal']);
    expect(lote.jobs.find((j) => j.etiqueta === 'ELITE QLC · TP')?.estado).toBe('exito');
  });
});

describe('agregar a un short UTA sin Take Profit', () => {
  it('lo embebe calculado desde la entrada promedio estimada y lo extiende a toda la posicion', async () => {
    const estrategias = enrutar([]);

    const lote = await agregarShort();

    const [orden] = cuerpos('/api/v3/trade/place-order');
    const estimada = new Decimal(TOTAL_PREVIO)
      .times(ENTRADA_PREVIA)
      .plus(new Decimal(AGREGADO).times('63381.3'))
      .dividedBy(TOTAL_DESPUES)
      .toSignificantDigits(12)
      .toFixed();
    expect(orden?.['takeProfit']).toBe(tpDesde(estimada));

    const [mod] = cuerpos('/api/v3/trade/modify-strategy-order');
    expect(mod?.['qty']).toBe(TOTAL_DESPUES);
    expect(mod?.['takeProfit']).toBe(tpDesde(ENTRADA_DESPUES));
    expect(estrategias).toHaveLength(1);
    expect(estrategias[0]?.qty).toBe(TOTAL_DESPUES);
    expect(lote.jobs.find((j) => j.etiqueta === 'ELITE QLC · TP')?.estado).toBe('exito');
  });
});

describe('ningun Take Profit en perdida', () => {
  it('un ajuste a mano que no cubre las comisiones se descarta y no se envia', async () => {
    enrutar([tpPrincipal('59700')]);

    /* 0,5 % a 10x: un 0,05 % de recorrido, menos que las comisiones de abrir y cerrar. */
    const plan = await sesion.planificarTakeProfit({
      simbolo: SIMBOLO,
      objetivos: [{ cuentaId: 'cta_qlc', lado: 'short' }],
      porcentaje: '0.5'
    });

    expect(plan.entradas).toHaveLength(0);
    expect(plan.descartes[0]?.motivo).toBe('tp-con-perdida');
    expect(plan.descartes[0]?.mensaje).toContain('pérdida');
    expect(cuerpos('/api/v3/trade/modify-strategy-order')).toHaveLength(0);
  });

  it('agregar con un porcentaje que no cubre las comisiones no abre nada', async () => {
    enrutar([tpPrincipal('59700')]);
    await sesion.fijarTopeMargen('1000');

    const plan = await sesion.planificarApertura({
      simbolo: SIMBOLO,
      objetivos: [{ cuentaId: 'cta_qlc', lado: 'short' }],
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null,
      modoMargen: 'crossed',
      takeProfitPorcentaje: '0.5'
    });

    expect(plan.entradas).toHaveLength(0);
    expect(plan.descartes[0]?.motivo).toBe('tp-con-perdida');
  });
});
