/**
 * El catalogo de activos que ve la pantalla.
 *
 * --------------------------------------------------------------------------
 * Por que esto merece pruebas propias
 * --------------------------------------------------------------------------
 * Es lo primero que hace el panel al arrancar y de lo que depende todo lo
 * demas: sin catalogo no hay selector de activo, y sin selector no se puede
 * planificar nada. Ademas trae el dato que decide que puede escribir el
 * operador -el tope de apalancamiento del activo, distinto en cada uno y
 * distinto en cada mercado-, asi que un error aqui no se ve como un fallo del
 * catalogo sino como una operacion rechazada por Bitget mas tarde.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClienteBitget } from '@main/bitget/rest/client';
import { LimitadorPeticiones } from '@main/execution/rate-limiter';
import { MERCADO_REAL, MERCADO_SIMULADO } from '@main/bitget/mercado';
import { catalogoActivos, preciosDe } from '@main/bitget/catalogo-activos';
import { iniciarExchangeSimulado, sobreOk, type ExchangeSimulado } from '../mock-exchange/servidor';

/** Un contrato con los campos que el catalogo mira. */
const contrato = (symbol: string, baseCoin: string, extra: Record<string, unknown> = {}): unknown => ({
  symbol,
  baseCoin,
  quoteCoin: symbol.endsWith('SUSDT') ? 'SUSDT' : 'USDT',
  minTradeNum: '0.0001',
  volumePlace: '4',
  pricePlace: '1',
  priceEndStep: '1',
  sizeMultiplier: '0.0001',
  minTradeUSDT: '5',
  minLever: '1',
  maxLever: '150',
  maxMarketOrderQty: '220',
  maxOrderQty: '1200',
  symbolStatus: 'normal',
  ...extra
});

let exchange: ExchangeSimulado;
let cliente: ClienteBitget;

/** Los cinco del mercado real, con sus topes verdaderos. */
const CONTRATOS_REALES = [
  contrato('BTCUSDT', 'BTC', { maxLever: '150', pricePlace: '1' }),
  contrato('ETHUSDT', 'ETH', { maxLever: '150', pricePlace: '2' }),
  contrato('SOLUSDT', 'SOL', { maxLever: '100', pricePlace: '3' }),
  contrato('PEPEUSDT', 'PEPE', { maxLever: '75', pricePlace: '8' }),
  contrato('PAXGUSDT', 'PAXG', { maxLever: '50', pricePlace: '2' }),
  /* Uno que el panel no opera: tiene que quedarse fuera. */
  contrato('DOGEUSDT', 'DOGE', { maxLever: '75' })
];

beforeEach(async () => {
  exchange = await iniciarExchangeSimulado();
  cliente = new ClienteBitget({
    host: exchange.url,
    limitador: new LimitadorPeticiones({ dormir: async () => undefined })
  });
});

afterEach(async () => {
  await cliente.cerrar();
  await exchange.cerrar();
});

describe('que activos se ofrecen', () => {
  it('solo los cinco del panel, y en su orden', async () => {
    exchange.responderCon(() => ({ cuerpo: sobreOk(CONTRATOS_REALES) }));

    const activos = await catalogoActivos(cliente, MERCADO_REAL);

    expect(activos.map((a) => a.id)).toEqual(['BTC', 'ETH', 'SOL', 'PEPE', 'PAXG']);
  });

  /*
   * El cliente lo dijo expresamente: opera cinco activos y solo cinco. Un
   * selector con los 754 contratos de Bitget convertiria una eleccion de un
   * vistazo en una busqueda, y abriria la puerta a operar por error otro activo.
   */
  it('un activo que Bitget ofrece pero el panel no opera no aparece', async () => {
    exchange.responderCon(() => ({ cuerpo: sobreOk(CONTRATOS_REALES) }));

    const activos = await catalogoActivos(cliente, MERCADO_REAL);

    expect(activos.some((a) => a.id === 'DOGE')).toBe(false);
  });

  /*
   * Preferible un selector con cuatro a uno con cinco donde el quinto falla al
   * planificar: lo segundo lo descubre el operador con la operacion empezada.
   */
  it('un simbolo que el exchange no devuelve se omite en vez de inventarse', async () => {
    exchange.responderCon(() => ({
      cuerpo: sobreOk(CONTRATOS_REALES.filter((c) => (c as { symbol: string }).symbol !== 'PEPEUSDT'))
    }));

    const activos = await catalogoActivos(cliente, MERCADO_REAL);

    expect(activos.map((a) => a.id)).toEqual(['BTC', 'ETH', 'SOL', 'PAXG']);
  });
});

describe('los limites que condicionan el formulario', () => {
  /* Es lo que permite que el campo venga con el maximo del activo elegido. */
  it('cada activo trae su propio tope de apalancamiento', async () => {
    exchange.responderCon(() => ({ cuerpo: sobreOk(CONTRATOS_REALES) }));

    const activos = await catalogoActivos(cliente, MERCADO_REAL);
    const topes = Object.fromEntries(activos.map((a) => [a.id, a.apalancamientoMax]));

    expect(topes).toEqual({ BTC: 150, ETH: 150, SOL: 100, PEPE: 75, PAXG: 50 });
  });

  it('los decimales del precio salen del contrato, no de una tabla', async () => {
    exchange.responderCon(() => ({ cuerpo: sobreOk(CONTRATOS_REALES) }));

    const activos = await catalogoActivos(cliente, MERCADO_REAL);

    expect(activos.find((a) => a.id === 'PEPE')?.decimalesPrecio).toBe(8);
    expect(activos.find((a) => a.id === 'BTC')?.decimalesPrecio).toBe(1);
  });

  /* Un contrato suspendido se enseña, pero marcado: no admite ordenes. */
  it('un contrato suspendido se marca como no operable', async () => {
    exchange.responderCon(() => ({
      cuerpo: sobreOk([contrato('BTCUSDT', 'BTC', { symbolStatus: 'maintain' })])
    }));

    const activos = await catalogoActivos(cliente, MERCADO_REAL);

    expect(activos[0]?.operable).toBe(false);
  });
});

describe('mercado simulado', () => {
  /*
   * En la demo la moneda base lleva la `S` del prefijo -`SBTC`- y el operador
   * no la reconoce: en su pantalla de Bitget ve BTC. Se retira para que una
   * prueba en simulado se parezca a la operacion real.
   */
  it('quita el prefijo del mercado de pruebas del nombre visible', async () => {
    exchange.responderCon(() => ({
      cuerpo: sobreOk([
        contrato('SBTCSUSDT', 'SBTC', { maxLever: '125' }),
        contrato('SETHSUSDT', 'SETH', { maxLever: '100' }),
        contrato('SXRPSUSDT', 'SXRP', { maxLever: '50' })
      ])
    }));

    const activos = await catalogoActivos(cliente, MERCADO_SIMULADO);

    expect(activos.map((a) => a.id)).toEqual(['BTC', 'ETH', 'XRP']);
    expect(activos[0]?.simbolo).toBe('SBTCSUSDT');
    expect(activos[0]?.etiqueta).toBe('BTC/SUSDT');
  });

  /* El mismo activo tiene topes distintos segun el mercado. */
  it('usa el tope del mercado de pruebas, no el del real', async () => {
    exchange.responderCon(() => ({
      cuerpo: sobreOk([contrato('SBTCSUSDT', 'SBTC', { maxLever: '125' })])
    }));

    const activos = await catalogoActivos(cliente, MERCADO_SIMULADO);

    expect(activos[0]?.apalancamientoMax).toBe(125);
  });
});

describe('precios', () => {
  /*
   * Se usa el precio de marca y no el ultimo negociado, que es el mismo con el
   * que se dimensiona una apertura. Enseñar uno y calcular con otro haria que
   * el operador creyera que el panel calcula mal.
   */
  it('devuelve el precio de marca de cada activo', async () => {
    exchange.responderCon((p) => {
      if (p.url.startsWith('/api/v2/mix/market/contracts')) {
        return { cuerpo: sobreOk([contrato('BTCUSDT', 'BTC'), contrato('ETHUSDT', 'ETH')]) };
      }
      const simbolo = new URL(p.url, 'http://x').searchParams.get('symbol') ?? '';
      return {
        cuerpo: sobreOk([
          { symbol: simbolo, lastPr: '1', markPrice: simbolo === 'BTCUSDT' ? '102450.5' : '3624.8' }
        ])
      };
    });

    const activos = await catalogoActivos(cliente, MERCADO_REAL);
    const precios = await preciosDe(cliente, MERCADO_REAL, activos);

    expect(precios).toEqual({ BTC: '102450.5', ETH: '3624.8' });
  });

  /*
   * Un activo sin precio deja un hueco, no tumba la consulta: la pantalla
   * enseña un guion, que es la verdad, y los demas precios siguen llegando.
   */
  it('un simbolo que falla no deja sin precio a los demas', async () => {
    exchange.responderCon((p) => {
      if (p.url.startsWith('/api/v2/mix/market/contracts')) {
        return { cuerpo: sobreOk([contrato('BTCUSDT', 'BTC'), contrato('ETHUSDT', 'ETH')]) };
      }
      const simbolo = new URL(p.url, 'http://x').searchParams.get('symbol') ?? '';
      if (simbolo === 'ETHUSDT') return { estado: 500, cuerpo: 'boom' };
      return { cuerpo: sobreOk([{ symbol: simbolo, lastPr: '1', markPrice: '102450.5' }]) };
    });

    const activos = await catalogoActivos(cliente, MERCADO_REAL);
    const precios = await preciosDe(cliente, MERCADO_REAL, activos);

    expect(precios['BTC']).toBe('102450.5');
    expect(precios['ETH']).toBeUndefined();
  });
});
