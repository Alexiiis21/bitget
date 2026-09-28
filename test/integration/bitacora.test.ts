/**
 * La bitácora: que anote lo que hace falta y **ni un secreto**.
 *
 * ==========================================================================
 * Por qué merece pruebas propias
 * ==========================================================================
 * Es código nuevo que se ejecuta en **todas** las peticiones a Bitget, y escribe
 * a disco. Eso le da dos formas de hacer daño que ninguna otra pieza del panel
 * tiene:
 *
 *  1. **Filtrar una credencial.** Por el mismo sitio pasan la API Key, la firma
 *     y la passphrase. Un log demasiado generoso las deja en un archivo de texto
 *     plano en el equipo del operador, para siempre.
 *  2. **Tumbar una orden.** Si un fallo de escritura —disco lleno, antivirus,
 *     carpeta sin permisos— subiera por la pila, se llevaría por delante la
 *     petición que estaba anotando.
 *
 * Las dos se prueban aquí, contra el exchange simulado y con peticiones firmadas
 * de verdad.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ClienteBitget } from '@main/bitget/rest/client';
import { detenerBitacora, iniciarBitacora, superficieDeRuta } from '@main/diagnostico/bitacora';
import { obtenerAjustesCuenta } from '@main/bitget/rest/endpoints/ajustes-v3';
import { obtenerInfoCuenta } from '@main/bitget/rest/endpoints/cuenta';
import { archivoLogDeHoy } from '@main/storage/paths';
import { olvidarSecretos, registrarSecreto } from '@main/security/redact';
import {
  iniciarExchangeSimulado,
  sobreError,
  sobreOk,
  type ExchangeSimulado
} from '../mock-exchange/servidor';

const SECRET_KEY = 'secreto-larguisimo-que-no-debe-aparecer-jamas';
const PASSPHRASE = 'passphrase-que-tampoco-debe-aparecer';
const API_KEY = 'bg_4053b8f72a2bb13251e07712c14c6076';

const CREDENCIAL = { apiKey: API_KEY, secretKey: SECRET_KEY, passphrase: PASSPHRASE };

let carpeta: string;
let exchange: ExchangeSimulado;
let cliente: ClienteBitget;

/** Las líneas del archivo del día, ya parseadas. */
const leerBitacora = async (): Promise<Record<string, unknown>[]> => {
  const texto = await readFile(join(carpeta, archivoLogDeHoy()), 'utf8');
  return texto
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
};

/** El archivo entero, tal cual está en disco. */
const crudoBitacora = (): Promise<string> => readFile(join(carpeta, archivoLogDeHoy()), 'utf8');

/**
 * Espera a que la bitácora haya escrito N líneas.
 *
 * Anotar no se espera a propósito —una petición no debe quedarse esperando a un
 * `appendFile`—, así que la prueba tiene que darle su turno al bucle de eventos.
 */
const esperarLineas = async (n: number): Promise<Record<string, unknown>[]> => {
  for (let i = 0; i < 50; i += 1) {
    try {
      const lineas = await leerBitacora();
      if (lineas.length >= n) return lineas;
    } catch {
      /* Todavía no existe el archivo. */
    }
    await new Promise((listo) => setTimeout(listo, 10));
  }
  return leerBitacora();
};

beforeEach(async () => {
  carpeta = await mkdtemp(join(tmpdir(), 'pcb-bitacora-'));
  await iniciarBitacora(carpeta);
  exchange = await iniciarExchangeSimulado();
  cliente = new ClienteBitget({ host: exchange.url });

  /* Como al abrir el vault: los secretos vivos se registran para el redactor. */
  registrarSecreto(SECRET_KEY);
  registrarSecreto(PASSPHRASE);
});

afterEach(async () => {
  detenerBitacora();
  olvidarSecretos();
  await cliente.cerrar();
  await exchange.cerrar();
  await rm(carpeta, { recursive: true, force: true });
});

describe('lo que anota', () => {
  it('una petición correcta, con su ruta, superficie y duración', async () => {
    exchange.responderSiempre({ cuerpo: sobreOk({ userId: '1', authorities: ['coow'] }) });

    await obtenerInfoCuenta(cliente, CREDENCIAL);
    const lineas = await esperarLineas(2);

    /* La primera es el arranque; la última, la petición. */
    const peticion = lineas.at(-1);
    expect(peticion).toMatchObject({
      tipo: 'peticion',
      metodo: 'GET',
      superficie: 'v2',
      httpStatus: 200,
      codigo: '00000'
    });
    expect(String(peticion?.['ruta'])).toContain('/api/v2/spot/account/info');
    expect(typeof peticion?.['ms']).toBe('number');
  });

  it('un rechazo de negocio, con el código y el mensaje de Bitget', async () => {
    /*
     * Es el caso del 09/09/2026: un código que no está en el catálogo. Lo que la
     * bitácora tiene que dejar claro es **a qué ruta** se le preguntó, que es lo
     * que no se sabía.
     */
    exchange.responderSiempre({ cuerpo: sobreError('40085', 'Operation rejected') });

    await obtenerInfoCuenta(cliente, CREDENCIAL).catch(() => undefined);
    const lineas = await esperarLineas(2);

    expect(lineas.at(-1)).toMatchObject({
      tipo: 'peticion',
      superficie: 'v2',
      codigo: '40085',
      mensaje: 'Operation rejected'
    });
  });

  it('distingue a qué superficie se llamó de verdad', async () => {
    exchange.simularUta({ accountMode: 'unified', holdMode: 'hedge_mode' });

    await obtenerAjustesCuenta(cliente, { ...CREDENCIAL, superficie: 'v3' });
    const lineas = await esperarLineas(2);

    expect(lineas.at(-1)).toMatchObject({ superficie: 'v3', codigo: '00000' });
    expect(String(lineas.at(-1)?.['ruta'])).toContain('/api/v3/account/settings');
  });

  it('un POST anota el cuerpo enviado y lo que contestó Bitget', async () => {
    /*
     * Sin esto no se sabe qué tamaño, lado o apalancamiento salió de verdad
     * cuando el operador dice que algo que ya funcionaba ha dejado de hacerlo.
     */
    exchange.responderSiempre({ cuerpo: sobreOk({ orderId: '123', clientOid: 'pcb-1' }) });

    await cliente.peticionFirmada(
      CREDENCIAL,
      {
        metodo: 'POST',
        ruta: '/api/v2/mix/order/place-order',
        cuerpo: { symbol: 'BTCUSDT', side: 'buy', size: '0.001', passphrase: PASSPHRASE },
        idempotente: false
      },
      z.unknown()
    );
    const lineas = await esperarLineas(2);

    expect(lineas.at(-1)).toMatchObject({
      metodo: 'POST',
      cuerpo: { symbol: 'BTCUSDT', side: 'buy', size: '0.001', passphrase: '[REDACTADO]' },
      respuesta: { orderId: '123', clientOid: 'pcb-1' }
    });
    expect(await crudoBitacora()).not.toContain(PASSPHRASE);
  });

  it('un GET no anota la respuesta: el sondeo llenaría el archivo', async () => {
    exchange.responderSiempre({ cuerpo: sobreOk({ userId: '1', authorities: ['coow'] }) });

    await obtenerInfoCuenta(cliente, CREDENCIAL);
    const lineas = await esperarLineas(2);

    expect(lineas.at(-1)).not.toHaveProperty('respuesta');
    expect(lineas.at(-1)).not.toHaveProperty('cuerpo');
  });

  it('`superficieDeRuta` no se inventa una tercera', () => {
    expect(superficieDeRuta('/api/v2/mix/order/place-order')).toBe('v2');
    expect(superficieDeRuta('/api/v3/trade/place-order')).toBe('v3');
    expect(superficieDeRuta('/otra/cosa')).toBe('otra');
  });
});

describe('lo que NO puede aparecer nunca', () => {
  it('ni la secret key, ni la passphrase, ni la API key entera', async () => {
    exchange.responderSiempre({ cuerpo: sobreOk({ userId: '1', authorities: ['coow'] }) });

    await obtenerInfoCuenta(cliente, CREDENCIAL);
    await esperarLineas(2);

    const crudo = await crudoBitacora();

    /*
     * ======================================================================
     * Es la prueba que justifica que esta pieza exista
     * ======================================================================
     * Por el mismo punto pasan la firma y las tres cabeceras de autenticación.
     * Un log que las recogiera dejaría las credenciales en texto plano en el
     * equipo del operador, y el vault entero no habría servido de nada.
     */
    expect(crudo).not.toContain(SECRET_KEY);
    expect(crudo).not.toContain(PASSPHRASE);
    expect(crudo).not.toContain(API_KEY);
    /* Tampoco las cabeceras, aunque fueran con otro nombre. */
    expect(crudo.toLowerCase()).not.toContain('access-sign');
    expect(crudo.toLowerCase()).not.toContain('access-passphrase');
  });

  it('la cuenta va enmascarada, como en la pantalla', async () => {
    exchange.responderSiempre({ cuerpo: sobreOk({ userId: '1', authorities: ['coow'] }) });

    await obtenerInfoCuenta(cliente, CREDENCIAL);
    const lineas = await esperarLineas(2);

    /* Primeros 2 y últimos 4, que es el formato que ya cruza el IPC. */
    expect(lineas.at(-1)?.['cuenta']).toBe('bg••••••••6076');
  });

  it('un secreto que Bitget devolviera en su propio mensaje se redacta', async () => {
    /*
     * Improbable y barato de cubrir. El mensaje del exchange es el único texto
     * suyo que se copia al log, así que es la única vía por la que un valor
     * sensible podría entrar sin que el panel lo pusiera.
     */
    exchange.responderSiempre({ cuerpo: sobreError('40012', `clave ${SECRET_KEY} invalida`) });

    await obtenerInfoCuenta(cliente, CREDENCIAL).catch(() => undefined);
    await esperarLineas(2);

    const crudo = await crudoBitacora();
    expect(crudo).not.toContain(SECRET_KEY);
    expect(crudo).toContain('[REDACTADO]');
  });
});

describe('no puede tumbar una orden', () => {
  it('si la bitácora está apagada, la petición sigue su curso', async () => {
    detenerBitacora();
    exchange.responderSiempre({ cuerpo: sobreOk({ userId: '7', authorities: ['coow'] }) });

    const r = await obtenerInfoCuenta(cliente, CREDENCIAL);

    expect(r.datos.userId).toBe('7');
  });

  it('una carpeta imposible deja la bitácora apagada, sin lanzar', async () => {
    /*
     * Un archivo donde debería ir la carpeta: `mkdir` falla. El panel tiene que
     * arrancar igual, sin log, en vez de no arrancar.
     */
    const imposible = join(carpeta, 'archivo.txt', 'logs');
    await expect(iniciarBitacora(imposible)).resolves.toBeUndefined();

    exchange.responderSiempre({ cuerpo: sobreOk({ userId: '9', authorities: ['coow'] }) });
    const r = await obtenerInfoCuenta(cliente, CREDENCIAL);

    expect(r.datos.userId).toBe('9');
  });
});
