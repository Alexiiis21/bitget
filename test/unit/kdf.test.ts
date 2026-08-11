/**
 * Derivacion de la clave maestra.
 *
 * La mayor parte de la suite del vault usa parametros baratos para no tardar
 * medio segundo por apertura. Aqui se ejercita **una vez** con los parametros
 * reales, porque hay un fallo que solo aparece con ellos: si `maxmem` se queda
 * en el limite por defecto de Node (32 MB), N=2^17 necesita 128 y scrypt
 * revienta. Con parametros de prueba nunca se nota; en produccion, siempre.
 */
import { describe, expect, it } from 'vitest';
import {
  borrar,
  derivarClave,
  igualesEnTiempoConstante,
  nuevosParametros
} from '@main/security/kdf';
import { KDF_LONGITUD_CLAVE, KDF_SCRYPT_N } from '@shared/constants';

const BARATO = { N: 16, r: 1, p: 1 };

describe('parametros reales de produccion', () => {
  it('deriva con N=2^17 sin agotar maxmem, en un tiempo tolerable al abrir', async () => {
    const params = nuevosParametros();
    expect(params.N).toBe(KDF_SCRYPT_N);

    const t0 = Date.now();
    const clave = await derivarClave('contrasena-maestra-de-verdad', params);
    const ms = Date.now() - t0;

    expect(clave.length).toBe(KDF_LONGITUD_CLAVE);
    /* Medio segundo es el coste buscado: molesto para la fuerza bruta, no para el operador. */
    expect(ms).toBeLessThan(5_000);
  }, 30_000);
});

describe('determinismo', () => {
  it('misma contrasena y misma sal producen la misma clave', async () => {
    const params = nuevosParametros(BARATO);
    const a = await derivarClave('secreta', params);
    const b = await derivarClave('secreta', params);

    expect(igualesEnTiempoConstante(a, b)).toBe(true);
  });

  it('la sal cambia la clave aunque la contrasena sea la misma', async () => {
    const a = await derivarClave('secreta', nuevosParametros(BARATO));
    const b = await derivarClave('secreta', nuevosParametros(BARATO));

    expect(igualesEnTiempoConstante(a, b)).toBe(false);
  });

  it('cada juego de parametros trae una sal distinta', () => {
    const salts = new Set(Array.from({ length: 50 }, () => nuevosParametros(BARATO).salt));
    expect(salts.size).toBe(50);
  });
});

describe('borrado de memoria', () => {
  it('deja el buffer a ceros', async () => {
    const clave = await derivarClave('secreta', nuevosParametros(BARATO));
    expect(clave.some((b) => b !== 0)).toBe(true);

    borrar(clave);
    expect(clave.every((b) => b === 0)).toBe(true);
  });

  it('tolera nulos sin romperse', () => {
    expect(() => borrar(null, undefined)).not.toThrow();
  });
});

describe('comparacion', () => {
  it('distingue longitudes distintas sin lanzar', () => {
    expect(igualesEnTiempoConstante(Buffer.from('abc'), Buffer.from('abcd'))).toBe(false);
  });
});
