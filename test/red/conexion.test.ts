/**
 * Pruebas de conexion contra api.bitget.com. Salen a la red de verdad.
 *
 * Cubren el capitulo 10.1 del pliego -«Pruebas de Conexion»- en la parte que
 * no necesita credenciales. La verificacion de una API Key real, y por tanto
 * la deteccion de errores de autenticacion, se anade en el punto 3 de esta
 * fase, cuando exista la cuenta demo.
 *
 * Se ejecutan con `npm run test:red`. No forman parte del ciclo normal: si
 * Bitget esta caido o no hay internet, el resto de la suite debe seguir
 * siendo verde.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ClienteBitget } from '@main/bitget/rest/client';
import { ErrorBitget } from '@main/bitget/errors';

const esquemaContratos = z.array(
  z.object({
    symbol: z.string(),
    pricePlace: z.string(),
    priceEndStep: z.string(),
    minTradeNum: z.string(),
    symbolStatus: z.string()
  })
);

let cliente: ClienteBitget;

beforeAll(() => {
  cliente = new ClienteBitget();
});

afterAll(async () => {
  await cliente.cerrar();
});

describe('conexion con la API oficial', () => {
  it('alcanza el endpoint publico de hora y mide el desfase de reloj', async () => {
    const desfase = await cliente.sincronizarReloj();

    console.log(`  desfase con el reloj de Bitget: ${desfase} ms`);

    expect(cliente.relojSincronizado).toBe(true);
    /* Un equipo con la hora de Windows sincronizada no deberia pasar de 30 s. */
    expect(Math.abs(desfase)).toBeLessThan(30_000);
  });

  it('descarga el catalogo de contratos de futuros USDT-M', async () => {
    const { datos, duracionMs } = await cliente.peticionPublica(
      {
        metodo: 'GET',
        ruta: '/api/v2/mix/market/contracts',
        consulta: { productType: 'USDT-FUTURES' },
        idempotente: true
      },
      esquemaContratos
    );

    console.log(`  ${datos.length} contratos en ${duracionMs} ms`);

    expect(datos.length).toBeGreaterThan(100);
    expect(datos.some((c) => c.symbol === 'BTCUSDT')).toBe(true);
  });

  it('rechaza credenciales invalidas con un error clasificado, no con una excepcion cruda', async () => {
    const fallo = await cliente
      .peticionFirmada(
        { apiKey: 'inexistente', secretKey: 'inexistente', passphrase: 'inexistente' },
        { metodo: 'GET', ruta: '/api/v2/mix/account/accounts', idempotente: true },
        z.unknown()
      )
      .then(
        () => null,
        (e: unknown) => e
      );

    console.log(
      `  Bitget respondio: codigo ${(fallo as ErrorBitget).codigo} — ` +
        `"${(fallo as ErrorBitget).mensajeOriginal}"`
    );

    expect(fallo).toBeInstanceOf(ErrorBitget);
    const error = fallo as ErrorBitget;
    /* Credenciales malas fallan la cuenta; jamas se reintentan. */
    expect(error.clase).toBe('fatal-cuenta');
    expect(error.reintentable).toBe(false);
  });
});
