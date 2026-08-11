import { afterEach, describe, expect, it } from 'vitest';
import { firmarPeticion, type Credencial } from '@main/bitget/rest/signer';
import {
  enmascararApiKey,
  MARCA_REDACTADO,
  olvidarSecretos,
  redactar,
  redactarTexto,
  registrarSecreto
} from '@main/security/redact';

const CRED: Credencial = {
  apiKey: 'bg_apikey_de_prueba_0000',
  secretKey: 'secreto-de-prueba-no-usar-en-produccion',
  passphrase: 'passphrase-de-prueba'
};

afterEach(() => olvidarSecretos());

describe('enmascarado de API key', () => {
  it('muestra los primeros 2 y los ultimos 4, nada mas', () => {
    const enmascarada = enmascararApiKey('bg1234567890abcdef');
    expect(enmascarada).toBe('bg••••••••cdef');
    expect(enmascarada).not.toContain('1234567890');
  });

  it('no filtra nada cuando la key es demasiado corta', () => {
    expect(enmascararApiKey('bg12')).toBe('••••');
  });
});

describe('redaccion por nombre de campo', () => {
  it('enmascara las cabeceras de autenticacion de una peticion firmada', () => {
    const firmada = firmarPeticion(CRED, {
      metodo: 'GET',
      ruta: '/api/v2/mix/account/accounts',
      timestampMs: 1_700_000_000_000
    });

    const salida = JSON.stringify(redactar(firmada));

    expect(salida).not.toContain(CRED.apiKey);
    expect(salida).not.toContain(CRED.passphrase);
    expect(salida).not.toContain(firmada.cabeceras['ACCESS-SIGN']);
    /* El timestamp y la ruta si deben sobrevivir: sirven para diagnosticar. */
    expect(salida).toContain('1700000000000');
    expect(salida).toContain('/api/v2/mix/account/accounts');
  });

  it('alcanza campos sensibles anidados', () => {
    const salida = redactar({ cuenta: { etiqueta: 'sub-04', credencial: { secretKey: 'abc' } } });
    expect(JSON.stringify(salida)).not.toContain('abc');
  });

  it('no muta el objeto original', () => {
    const original = { apiKey: CRED.apiKey };
    redactar(original);
    expect(original.apiKey).toBe(CRED.apiKey);
  });
});

describe('redaccion por valor', () => {
  /*
   * La defensa que importa: el secreto aparece en un mensaje de error de la
   * libreria HTTP, dentro de un campo que nadie declaro como sensible.
   * docs/01 seccion 7 pide explicitamente esta prueba.
   */
  it('elimina un secreto vivo aunque venga en un campo inocente', () => {
    registrarSecreto(CRED.secretKey);

    const error = new Error(`fallo al conectar usando ${CRED.secretKey}`);
    const salida = JSON.stringify(redactar({ detalle: error, url: `x?s=${CRED.secretKey}` }));

    expect(salida).not.toContain(CRED.secretKey);
    expect(salida).toContain(MARCA_REDACTADO);
  });

  it('deja de sustituir cuando el vault se bloquea', () => {
    registrarSecreto('secreto-larguisimo-1');
    expect(redactarTexto('vino secreto-larguisimo-1')).toContain(MARCA_REDACTADO);

    olvidarSecretos();
    expect(redactarTexto('vino secreto-larguisimo-1')).toBe('vino secreto-larguisimo-1');
  });

  it('ignora valores demasiado cortos, que destruirian texto legitimo', () => {
    registrarSecreto('abc');
    expect(redactarTexto('abcdefg')).toBe('abcdefg');
  });
});

describe('robustez', () => {
  it('sobrevive a una estructura ciclica', () => {
    const nodo: Record<string, unknown> = { nombre: 'a' };
    nodo['self'] = nodo;
    expect(() => redactar(nodo)).not.toThrow();
  });

  it('conserva numeros, booleanos y nulos', () => {
    expect(redactar({ n: 1, b: true, z: null })).toEqual({ n: 1, b: true, z: null });
  });
});
