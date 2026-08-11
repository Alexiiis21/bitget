import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  cabecerasPublicas,
  cadenaConsulta,
  cadenaPrefirma,
  firmar,
  firmarPeticion,
  serializarCuerpo,
  type Credencial
} from '@main/bitget/rest/signer';

/*
 * Credencial ficticia. Los vectores de firma de este archivo se calcularon con
 * ella y estan fijados literalmente: si alguien cambia como se construye la
 * cadena de prefirma, estas pruebas se caen antes de que Bitget devuelva 40009
 * en cien cuentas a la vez.
 */
const CRED: Credencial = {
  apiKey: 'bg_apikey_de_prueba_0000',
  secretKey: 'secreto-de-prueba-no-usar-en-produccion',
  passphrase: 'passphrase-de-prueba'
};

const TS = 1_700_000_000_000;

describe('cadena de consulta', () => {
  it('no produce interrogante cuando no hay parametros', () => {
    expect(cadenaConsulta(undefined)).toBe('');
    expect(cadenaConsulta({})).toBe('');
  });

  it('omite undefined y null, pero conserva cero y cadena vacia', () => {
    expect(cadenaConsulta({ a: undefined, b: null, c: 0, d: '' })).toBe('?c=0&d=');
  });

  it('ordena alfabeticamente, para que la firma sea reproducible', () => {
    const uno = cadenaConsulta({ productType: 'USDT-FUTURES', marginCoin: 'USDT' });
    const otro = cadenaConsulta({ marginCoin: 'USDT', productType: 'USDT-FUTURES' });
    expect(uno).toBe(otro);
    expect(uno).toBe('?marginCoin=USDT&productType=USDT-FUTURES');
  });

  it('codifica los valores conflictivos', () => {
    expect(cadenaConsulta({ q: 'a b&c=d' })).toBe('?q=a%20b%26c%3Dd');
  });
});

describe('serializacion del cuerpo', () => {
  it('devuelve cadena vacia cuando no hay cuerpo, nunca "undefined"', () => {
    expect(serializarCuerpo(undefined)).toBe('');
  });

  it('serializa compacto, sin espacios', () => {
    expect(serializarCuerpo({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}');
  });
});

describe('cadena de prefirma', () => {
  it('concatena timestamp, metodo, ruta con consulta y cuerpo, sin separadores', () => {
    const prefirma = cadenaPrefirma({
      timestampMs: TS,
      metodo: 'GET',
      rutaCompleta: '/api/v2/mix/account/accounts?productType=USDT-FUTURES',
      cuerpo: ''
    });
    expect(prefirma).toBe('1700000000000GET/api/v2/mix/account/accounts?productType=USDT-FUTURES');
  });
});

describe('firma de peticiones', () => {
  it('reproduce el vector fijo de una consulta GET', () => {
    const firmada = firmarPeticion(CRED, {
      metodo: 'GET',
      ruta: '/api/v2/mix/position/all-position',
      consulta: { productType: 'USDT-FUTURES', marginCoin: 'USDT' },
      timestampMs: TS
    });

    expect(firmada.rutaCompleta).toBe(
      '/api/v2/mix/position/all-position?marginCoin=USDT&productType=USDT-FUTURES'
    );
    expect(firmada.cuerpo).toBe('');
    expect(firmada.cabeceras['ACCESS-SIGN']).toBe('teQsNlO9s++IHCDnK+MU2sLJrguX0nfoFyiMXkMatQk=');
  });

  it('reproduce el vector fijo de una orden POST', () => {
    const firmada = firmarPeticion(CRED, {
      metodo: 'POST',
      ruta: '/api/v2/mix/order/place-order',
      cuerpo: {
        symbol: 'BTCUSDT',
        productType: 'USDT-FUTURES',
        marginMode: 'isolated',
        marginCoin: 'USDT',
        size: '0.01',
        side: 'buy',
        tradeSide: 'open',
        orderType: 'market',
        clientOid: 'pcb-lote1-acc1'
      },
      timestampMs: TS
    });

    expect(firmada.cabeceras['ACCESS-SIGN']).toBe('aI3ZGsqte63tTWw1WvQZeOsj+g8wqBuzRincVuU0Qvs=');
  });

  it('emite las cuatro cabeceras de autenticacion mas locale', () => {
    const { cabeceras } = firmarPeticion(CRED, {
      metodo: 'GET',
      ruta: '/api/v2/mix/account/accounts',
      timestampMs: TS
    });

    expect(cabeceras['ACCESS-KEY']).toBe(CRED.apiKey);
    expect(cabeceras['ACCESS-PASSPHRASE']).toBe(CRED.passphrase);
    expect(cabeceras['ACCESS-TIMESTAMP']).toBe('1700000000000');
    expect(cabeceras['Content-Type']).toBe('application/json');
    expect(cabeceras['locale']).toBe('en-US');
  });

  it('firma en milisegundos: trece digitos, no diez', () => {
    const { cabeceras } = firmarPeticion(CRED, { metodo: 'GET', ruta: '/api/v2/public/time' });
    expect(cabeceras['ACCESS-TIMESTAMP']).toMatch(/^\d{13}$/);
  });

  it('acepta un reloj inyectado, para corregir el desfase con el servidor', () => {
    const { cabeceras } = firmarPeticion(
      CRED,
      { metodo: 'GET', ruta: '/api/v2/public/time' },
      () => 1_234_567_890_123
    );
    expect(cabeceras['ACCESS-TIMESTAMP']).toBe('1234567890123');
  });

  /*
   * La invariante que sostiene todo el modulo: se firma exactamente lo que se
   * envia. Si alguien vuelve a serializar el cuerpo o reordena la consulta
   * aguas abajo, la firma deja de corresponder y Bitget rechaza la peticion.
   */
  it('firma exactamente la ruta y el cuerpo que devuelve para enviar', () => {
    const firmada = firmarPeticion(CRED, {
      metodo: 'POST',
      ruta: '/api/v2/mix/account/set-leverage',
      consulta: { productType: 'USDT-FUTURES' },
      cuerpo: { symbol: 'BTCUSDT', marginCoin: 'USDT', leverage: '150' },
      timestampMs: TS
    });

    const recalculada = createHmac('sha256', CRED.secretKey)
      .update(`${TS}POST${firmada.rutaCompleta}${firmada.cuerpo}`, 'utf8')
      .digest('base64');

    expect(firmada.cabeceras['ACCESS-SIGN']).toBe(recalculada);
  });

  it('produce firmas distintas para secretos distintos', () => {
    const prefirma = '1700000000000GET/api/v2/public/time';
    expect(firmar('secreto-a', prefirma)).not.toBe(firmar('secreto-b', prefirma));
  });

  it('devuelve la firma en base64, no en hexadecimal', () => {
    expect(firmar(CRED.secretKey, 'x')).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(firmar(CRED.secretKey, 'x')).toHaveLength(44);
  });
});

describe('peticiones publicas', () => {
  it('no llevan ninguna cabecera de autenticacion', () => {
    const cabeceras = cabecerasPublicas();
    for (const clave of Object.keys(cabeceras)) {
      expect(clave.startsWith('ACCESS-')).toBe(false);
    }
  });
});
