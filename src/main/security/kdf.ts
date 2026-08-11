/**
 * Derivacion de la clave del almacen a partir de la contrasena maestra.
 *
 * scrypt con N=2^17, r=8, p=1: ~128 MB de memoria y del orden de medio segundo
 * por derivacion. Ese coste es irrelevante una vez al abrir la aplicacion y es
 * justo lo que hace inviable la fuerza bruta sobre un `vault.enc` robado.
 *
 * Los parametros viajan **dentro del archivo**, no fijados en el codigo: subir
 * el coste en una version futura no invalida los vaults existentes, porque cada
 * uno recuerda con que parametros fue creado. docs/03 seccion 5.
 */
/*
 * `scrypt` se envuelve a mano en lugar de con `promisify`: la version
 * promisificada toma la sobrecarga de tres argumentos y deja fuera las
 * opciones, que es justo donde va `maxmem`.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { KDF_LONGITUD_CLAVE, KDF_SCRYPT_N, KDF_SCRYPT_P, KDF_SCRYPT_R } from '@shared/constants';

export interface ParametrosKdf {
  algoritmo: 'scrypt';
  N: number;
  r: number;
  p: number;
  longitudClave: number;
  /** Sal en base64. Unica por vault. */
  salt: string;
}

/** Parametros nuevos, con sal aleatoria de 32 bytes. */
export function nuevosParametros(
  overrides: Partial<Omit<ParametrosKdf, 'algoritmo'>> = {}
): ParametrosKdf {
  return {
    algoritmo: 'scrypt',
    N: overrides.N ?? KDF_SCRYPT_N,
    r: overrides.r ?? KDF_SCRYPT_R,
    p: overrides.p ?? KDF_SCRYPT_P,
    longitudClave: overrides.longitudClave ?? KDF_LONGITUD_CLAVE,
    salt: overrides.salt ?? randomBytes(32).toString('base64')
  };
}

/**
 * Deriva la clave del vault.
 *
 * `maxmem` hay que subirlo a mano: el limite por defecto de Node son 32 MB y
 * N=2^17 necesita 128, asi que sin esto scrypt falla con un error de memoria
 * que no dice nada util.
 */
export async function derivarClave(contrasena: string, params: ParametrosKdf): Promise<Buffer> {
  if (params.algoritmo !== 'scrypt') {
    throw new Error(`Algoritmo de derivacion no soportado: ${String(params.algoritmo)}`);
  }

  const memoriaNecesaria = 256 * params.N * params.r;

  return new Promise<Buffer>((resolver, rechazar) => {
    scryptCallback(
      contrasena,
      Buffer.from(params.salt, 'base64'),
      params.longitudClave,
      {
        N: params.N,
        r: params.r,
        p: params.p,
        maxmem: Math.max(64 * 1024 * 1024, memoriaNecesaria * 2)
      },
      (error, clave) => {
        if (error !== null) rechazar(error);
        else resolver(clave);
      }
    );
  });
}

/**
 * Comparacion en tiempo constante.
 *
 * Comparar con `===` filtra por cuanto tarda en fallar cuantos bytes iniciales
 * coincidian. Aqui casi no importa -no hay atacante remoto midiendo-, pero
 * cuesta lo mismo hacerlo bien.
 */
export function igualesEnTiempoConstante(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Sobrescribe un buffer con ceros.
 *
 * No hay garantia de que el sistema no haya copiado la memoria antes, pero
 * reduce la ventana en que la clave sigue legible tras bloquear el panel.
 */
export function borrar(...buffers: (Buffer | null | undefined)[]): void {
  for (const b of buffers) b?.fill(0);
}
