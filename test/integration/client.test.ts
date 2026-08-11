import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ClienteBitget } from '@main/bitget/rest/client';
import { ErrorBitget } from '@main/bitget/errors';
import type { Credencial } from '@main/bitget/rest/signer';
import {
  iniciarExchangeSimulado,
  sobreError,
  sobreOk,
  type ExchangeSimulado
} from '../mock-exchange/servidor';

const CRED: Credencial = {
  apiKey: 'bg_apikey_de_prueba_0000',
  secretKey: 'secreto-de-prueba-no-usar-en-produccion',
  passphrase: 'passphrase-de-prueba'
};

const esquemaCuenta = z.object({ marginCoin: z.string(), available: z.string() });
const esquemaLibre = z.unknown();

let exchange: ExchangeSimulado;
let cliente: ClienteBitget;

beforeEach(async () => {
  exchange = await iniciarExchangeSimulado();
  cliente = new ClienteBitget({
    host: exchange.url,
    timeoutsMs: { conexion: 500, cabeceras: 300, cuerpo: 300 }
  });
});

afterEach(async () => {
  await cliente.cerrar();
  await exchange.cerrar();
});

describe('camino feliz', () => {
  it('valida la respuesta y devuelve los datos tipados', async () => {
    exchange.responder({ cuerpo: sobreOk({ marginCoin: 'USDT', available: '1250.5' }) });

    const { datos, codigo, duracionMs } = await cliente.peticionFirmada(
      CRED,
      { metodo: 'GET', ruta: '/api/v2/mix/account/account', idempotente: true },
      esquemaCuenta
    );

    expect(datos.available).toBe('1250.5');
    expect(codigo).toBe('00000');
    expect(duracionMs).toBeGreaterThanOrEqual(0);
  });

  it('envia las cabeceras firmadas y el cuerpo exacto que firmo', async () => {
    exchange.responder({ cuerpo: sobreOk({}) });

    await cliente.peticionFirmada(
      CRED,
      {
        metodo: 'POST',
        ruta: '/api/v2/mix/order/place-order',
        cuerpo: { symbol: 'BTCUSDT', size: '0.01' },
        idempotente: false
      },
      esquemaLibre
    );

    const recibida = exchange.peticiones[0];
    expect(recibida?.cabeceras['access-key']).toBe(CRED.apiKey);
    expect(recibida?.cabeceras['access-passphrase']).toBe(CRED.passphrase);
    expect(recibida?.cabeceras['access-sign']).toBeTruthy();
    expect(recibida?.cabeceras['access-timestamp']).toMatch(/^\d{13}$/);
    expect(recibida?.cuerpo).toBe('{"symbol":"BTCUSDT","size":"0.01"}');
  });

  it('no manda ninguna cabecera de autenticacion en un endpoint publico', async () => {
    exchange.responder({ cuerpo: sobreOk({ serverTime: '1700000000000' }) });

    await cliente.peticionPublica(
      { metodo: 'GET', ruta: '/api/v2/public/time', idempotente: true },
      z.object({ serverTime: z.string() })
    );

    const recibida = exchange.peticiones[0];
    expect(recibida?.cabeceras['access-key']).toBeUndefined();
    expect(recibida?.cabeceras['access-sign']).toBeUndefined();
  });

  it('ordena la consulta igual en la URL enviada y en la firma', async () => {
    exchange.responder({ cuerpo: sobreOk({}) });

    await cliente.peticionFirmada(
      CRED,
      {
        metodo: 'GET',
        ruta: '/api/v2/mix/position/all-position',
        consulta: { productType: 'USDT-FUTURES', marginCoin: 'USDT' },
        idempotente: true
      },
      esquemaLibre
    );

    expect(exchange.peticiones[0]?.url).toBe(
      '/api/v2/mix/position/all-position?marginCoin=USDT&productType=USDT-FUTURES'
    );
  });
});

describe('rechazo con HTTP 200', () => {
  /*
   * El fallo mas peligroso de todos: Bitget responde 200 y el rechazo viaja en
   * `code`. Un cliente que solo mire el estado HTTP da por abierta una posicion
   * que no existe.
   */
  it('trata un code distinto de 00000 como error, no como exito', async () => {
    exchange.responder({ estado: 200, cuerpo: sobreError('40009', 'sign signature error') });

    const fallo = await capturar(() =>
      cliente.peticionFirmada(
        CRED,
        { metodo: 'GET', ruta: '/api/v2/mix/account/account', idempotente: true },
        esquemaLibre
      )
    );

    expect(fallo).toBeInstanceOf(ErrorBitget);
    expect(fallo.codigo).toBe('40009');
    expect(fallo.clase).toBe('fatal-cuenta');
    expect(fallo.httpStatus).toBe(200);
    /* El texto del exchange se conserva para el log, sin llegar a la pantalla. */
    expect(fallo.mensajeOriginal).toBe('sign signature error');
  });

  it('clasifica saldo insuficiente como fallo de esa cuenta, no del lote', async () => {
    exchange.responder({ cuerpo: sobreError('43012', 'Insufficient balance') });

    const fallo = await capturar(() =>
      cliente.peticionFirmada(
        CRED,
        { metodo: 'POST', ruta: '/api/v2/mix/order/place-order', idempotente: false },
        esquemaLibre
      )
    );

    expect(fallo.clase).toBe('fatal-cuenta');
  });

  it('aborta el lote entero cuando el activo no existe', async () => {
    exchange.responder({ cuerpo: sobreError('40034', 'symbol does not exist') });

    const fallo = await capturar(() =>
      cliente.peticionFirmada(
        CRED,
        { metodo: 'POST', ruta: '/api/v2/mix/order/place-order', idempotente: false },
        esquemaLibre
      )
    );

    expect(fallo.clase).toBe('fatal-lote');
  });

  it('ante un codigo desconocido no reintenta: falla la cuenta', async () => {
    exchange.responder({ cuerpo: sobreError('99999', 'algo nuevo') });

    const fallo = await capturar(() =>
      cliente.peticionFirmada(
        CRED,
        { metodo: 'POST', ruta: '/api/v2/mix/order/place-order', idempotente: false },
        esquemaLibre
      )
    );

    expect(fallo.reintentable).toBe(false);
    expect(fallo.clase).toBe('fatal-cuenta');
    expect(fallo.message).toContain('99999');
  });
});

describe('errores de transporte y HTTP', () => {
  it('marca 429 como reintentable', async () => {
    exchange.responder({ estado: 429, cuerpo: 'Too Many Requests' });

    const fallo = await capturar(() =>
      cliente.peticionFirmada(
        CRED,
        { metodo: 'GET', ruta: '/api/v2/mix/account/account', idempotente: true },
        esquemaLibre
      )
    );

    expect(fallo.clase).toBe('retryable');
  });

  it('un 500 en una consulta se reintenta', async () => {
    exchange.responder({ estado: 500, cuerpo: 'Internal Server Error' });

    const fallo = await capturar(() =>
      cliente.peticionFirmada(
        CRED,
        { metodo: 'GET', ruta: '/api/v2/mix/position/all-position', idempotente: true },
        esquemaLibre
      )
    );

    expect(fallo.clase).toBe('retryable');
  });

  /*
   * La distincion que protege el dinero: el mismo 500, sobre una orden, no se
   * reintenta. Se resuelve preguntando por el clientOid.
   */
  it('un 500 en una orden queda indeterminado, no reintentable', async () => {
    exchange.responder({ estado: 500, cuerpo: 'Internal Server Error' });

    const fallo = await capturar(() =>
      cliente.peticionFirmada(
        CRED,
        { metodo: 'POST', ruta: '/api/v2/mix/order/place-order', idempotente: false },
        esquemaLibre
      )
    );

    expect(fallo.clase).toBe('indeterminada');
    expect(fallo.reintentable).toBe(false);
  });

  it('un timeout tras enviar una orden queda indeterminado', async () => {
    exchange.responder({ retrasoMs: 2_000, cuerpo: sobreOk({}) });

    const fallo = await capturar(() =>
      cliente.peticionFirmada(
        CRED,
        { metodo: 'POST', ruta: '/api/v2/mix/order/place-order', idempotente: false },
        esquemaLibre
      )
    );

    expect(fallo.clase).toBe('indeterminada');
  });

  it('el mismo timeout, en una consulta, si se reintenta', async () => {
    exchange.responder({ retrasoMs: 2_000, cuerpo: sobreOk({}) });

    const fallo = await capturar(() =>
      cliente.peticionFirmada(
        CRED,
        { metodo: 'GET', ruta: '/api/v2/mix/position/all-position', idempotente: true },
        esquemaLibre
      )
    );

    expect(fallo.clase).toBe('retryable');
  });

  it('una respuesta que no es JSON no revienta el panel', async () => {
    exchange.responder({ estado: 502, cuerpo: '<html>bad gateway</html>' });

    const fallo = await capturar(() =>
      cliente.peticionFirmada(
        CRED,
        { metodo: 'GET', ruta: '/api/v2/mix/account/account', idempotente: true },
        esquemaLibre
      )
    );

    expect(fallo).toBeInstanceOf(ErrorBitget);
    expect(fallo.httpStatus).toBe(502);
  });
});

describe('validacion de forma', () => {
  it('rechaza una respuesta cuyo dato no cumple el esquema', async () => {
    /* `available` deberia ser cadena; llega como numero. */
    exchange.responder({ cuerpo: sobreOk({ marginCoin: 'USDT', available: 1250.5 }) });

    const fallo = await capturar(() =>
      cliente.peticionFirmada(
        CRED,
        { metodo: 'GET', ruta: '/api/v2/mix/account/account', idempotente: true },
        esquemaCuenta
      )
    );

    expect(fallo.codigo).toBe('ESQUEMA');
  });

  it('rechaza un sobre sin los campos obligatorios', async () => {
    exchange.responder({ cuerpo: { resultado: 'ok' } });

    const fallo = await capturar(() =>
      cliente.peticionFirmada(
        CRED,
        { metodo: 'GET', ruta: '/api/v2/mix/account/account', idempotente: true },
        esquemaLibre
      )
    );

    expect(fallo.codigo).toBe('ESQUEMA');
  });
});

describe('correccion de reloj', () => {
  it('mide el desfase contra el servidor y firma con el reloj corregido', async () => {
    const local = 1_700_000_000_000;
    /* El servidor va 8 segundos por delante del equipo del operador. */
    const servidor = local + 8_000;

    const clienteFijo = new ClienteBitget({
      host: exchange.url,
      ahora: () => local,
      timeoutsMs: { conexion: 500, cabeceras: 300, cuerpo: 300 }
    });

    exchange.responder({ cuerpo: sobreOk({ serverTime: String(servidor) }) });
    const desfase = await clienteFijo.sincronizarReloj();

    expect(desfase).toBeCloseTo(8_000, -2);
    expect(clienteFijo.relojSincronizado).toBe(true);
    expect(clienteFijo.relojDesviado).toBe(true);

    exchange.responder({ cuerpo: sobreOk({}) });
    await clienteFijo.peticionFirmada(
      CRED,
      { metodo: 'GET', ruta: '/api/v2/mix/account/account', idempotente: true },
      esquemaLibre
    );

    const enviada = Number(exchange.peticiones[1]?.cabeceras['access-timestamp']);
    expect(enviada).toBeGreaterThanOrEqual(servidor - 100);

    await clienteFijo.cerrar();
  });

  it('no se desvia cuando los relojes coinciden', async () => {
    const local = 1_700_000_000_000;
    const clienteFijo = new ClienteBitget({
      host: exchange.url,
      ahora: () => local,
      timeoutsMs: { conexion: 500, cabeceras: 300, cuerpo: 300 }
    });

    exchange.responder({ cuerpo: sobreOk({ serverTime: String(local) }) });
    await clienteFijo.sincronizarReloj();

    expect(clienteFijo.relojDesviado).toBe(false);
    await clienteFijo.cerrar();
  });

  it('detecta un serverTime que no es un numero', async () => {
    exchange.responder({ cuerpo: sobreOk({ serverTime: 'ayer' }) });

    const fallo = await capturar(() => cliente.sincronizarReloj());
    expect(fallo.codigo).toBe('ESQUEMA');
  });
});

/** Captura el `ErrorBitget` de una promesa que debe fallar. */
async function capturar(fn: () => Promise<unknown>): Promise<ErrorBitget> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ErrorBitget) return e;
    throw e;
  }
  throw new Error('se esperaba un ErrorBitget y la promesa se resolvio');
}
