/**
 * Contraste de la firma contra una implementacion independiente.
 *
 * `bitget-api` es un SDK comunitario que no usamos en produccion -docs/01
 * seccion 8 explica por que-, pero si sirve como oraculo: si nuestra firma y
 * la suya coinciden byte a byte sobre los mismos datos, el error tendria que
 * estar en las dos a la vez.
 *
 * Esta prueba no toca la red. Solo llama al firmador del SDK.
 */
import { RestClientV2 } from 'bitget-api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { firmarPeticion, type Credencial } from '@main/bitget/rest/signer';

const CRED: Credencial = {
  apiKey: 'bg_apikey_de_prueba_0000',
  secretKey: 'secreto-de-prueba-no-usar-en-produccion',
  passphrase: 'passphrase-de-prueba'
};

const TS = 1_700_000_000_000;

/** Superficie interna del SDK que usamos como oraculo. */
interface FirmanteSdk {
  signRequest(
    datos: Record<string, unknown>,
    endpoint: string,
    metodo: string,
    metodoFirma: 'bitget'
  ): Promise<{ sign: string; timestamp: number }>;
}

const oraculo = new RestClientV2({
  apiKey: CRED.apiKey,
  apiSecret: CRED.secretKey,
  apiPass: CRED.passphrase
}) as unknown as FirmanteSdk;

afterEach(() => vi.useRealTimers());

/** Congela el reloj para que el SDK use el mismo timestamp que nosotros. */
function congelarReloj(): void {
  vi.useFakeTimers();
  vi.setSystemTime(TS);
}

describe('firma contrastada con el SDK bitget-api', () => {
  it('coincide en una consulta GET con parametros', async () => {
    congelarReloj();
    const consulta = { productType: 'USDT-FUTURES', marginCoin: 'USDT' };
    const ruta = '/api/v2/mix/position/all-position';

    const suya = await oraculo.signRequest(consulta, ruta, 'GET', 'bitget');
    const nuestra = firmarPeticion(CRED, { metodo: 'GET', ruta, consulta, timestampMs: TS });

    expect(nuestra.cabeceras['ACCESS-SIGN']).toBe(suya.sign);
  });

  it('coincide en una consulta GET sin parametros', async () => {
    congelarReloj();
    const ruta = '/api/v2/mix/account/accounts';

    const suya = await oraculo.signRequest({}, ruta, 'GET', 'bitget');
    const nuestra = firmarPeticion(CRED, { metodo: 'GET', ruta, timestampMs: TS });

    expect(nuestra.cabeceras['ACCESS-SIGN']).toBe(suya.sign);
  });

  it('coincide en una orden POST con cuerpo', async () => {
    congelarReloj();
    const ruta = '/api/v2/mix/order/place-order';
    const cuerpo = {
      symbol: 'BTCUSDT',
      productType: 'USDT-FUTURES',
      marginMode: 'isolated',
      marginCoin: 'USDT',
      size: '0.01',
      side: 'buy',
      tradeSide: 'open',
      orderType: 'market',
      clientOid: 'pcb-lote1-acc1'
    };

    const suya = await oraculo.signRequest(cuerpo, ruta, 'POST', 'bitget');
    const nuestra = firmarPeticion(CRED, { metodo: 'POST', ruta, cuerpo, timestampMs: TS });

    expect(nuestra.cabeceras['ACCESS-SIGN']).toBe(suya.sign);
  });

  it('coincide al ajustar apalancamiento a x150', async () => {
    congelarReloj();
    const ruta = '/api/v2/mix/account/set-leverage';
    const cuerpo = {
      symbol: 'BTCUSDT',
      productType: 'USDT-FUTURES',
      marginCoin: 'USDT',
      leverage: '150',
      holdSide: 'long'
    };

    const suya = await oraculo.signRequest(cuerpo, ruta, 'POST', 'bitget');
    const nuestra = firmarPeticion(CRED, { metodo: 'POST', ruta, cuerpo, timestampMs: TS });

    expect(nuestra.cabeceras['ACCESS-SIGN']).toBe(suya.sign);
  });
});
