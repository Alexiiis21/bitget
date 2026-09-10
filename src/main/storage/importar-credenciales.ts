/**
 * Traer las credenciales de una carpeta de datos anterior.
 *
 * ==========================================================================
 * El problema que resuelve
 * ==========================================================================
 * El binario es portable y guarda sus datos **junto al `.exe`**. Es lo que hace
 * que copiar la carpeta copie el sistema entero y que dos entornos en la misma
 * maquina no se pisen, pero tiene una consecuencia que se cobro el 05/09/2026:
 * al recibir una version nueva y abrirla desde otra carpeta -Descargas, el
 * escritorio-, el panel no encuentra la carpeta de datos y arranca en blanco.
 * Las credenciales no se pierden, siguen donde estaban; lo que se pierde es
 * saber donde estaban.
 *
 * Esto es la salida: el operador señala su carpeta anterior y se copian.
 *
 * ==========================================================================
 * Tres reglas de las que no se puede salir
 * ==========================================================================
 *  1. **Nunca se pisa un almacen existente.** Si en destino ya hay `vault.enc`,
 *     se rechaza sin tocar nada. Sobrescribirlo seria irreversible: dentro
 *     estan las unicas copias de las API keys, y un `.bak` no salva de haber
 *     escrito encima el archivo bueno.
 *  2. **Se copia, no se mueve.** La carpeta de origen queda intacta. Si algo
 *     sale mal, el sistema anterior sigue funcionando exactamente igual.
 *  3. **La contrasena no viaja ni cambia.** Lo que se copia es el archivo
 *     cifrado tal cual; se abre con la contrasena maestra que tenia *ese*
 *     almacen, no con otra. Aqui no se descifra nada.
 *
 * El orden de copia tampoco es casual: `vault.enc` va **el ultimo**. Si algo
 * falla a mitad, el destino se queda sin vault y el panel sigue viendose como
 * recien instalado -que es la verdad- en lugar de con credenciales a medias.
 */
import { copyFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { existe } from './atomic-write';

/** Por que no se pudo importar. Cada uno se explica distinto. */
export type MotivoImportacion =
  | 'misma-carpeta'
  | 'ya-hay-vault'
  | 'sin-vault'
  | 'vault-ilegible';

export interface ResultadoImportacion {
  ok: boolean;
  motivo: MotivoImportacion | null;
  /** En castellano y con lo que hay que hacer, no con lo que falló por dentro. */
  mensaje: string;
  /** Cuantas subcuentas traia el registro copiado. `null` si no venia. */
  cuentas: number | null;
}

/** Las rutas del sistema de destino: las del panel que esta arrancando. */
export interface DestinoImportacion {
  base: string;
  vault: string;
  vaultBak: string;
  cuentas: string;
  activos: string;
}

/**
 * Comprobacion de que eso es un vault, **sin la contrasena**.
 *
 * No se descifra: solo se mira el sobre. Basta para distinguir una carpeta de
 * datos del panel de una carpeta cualquiera con un archivo que se llama igual,
 * que es el error que se quiere atrapar antes de copiar nada.
 */
const esquemaSobre = z.object({
  formato: z.literal('pcb-vault'),
  version: z.number().int().positive()
});

const fallo = (motivo: MotivoImportacion, mensaje: string): ResultadoImportacion => ({
  ok: false,
  motivo,
  mensaje,
  cuentas: null
});

/** Cuantas subcuentas trae un `cuentas.json`, o `null` si no se puede saber. */
async function contarCuentas(ruta: string): Promise<number | null> {
  try {
    const archivo: unknown = JSON.parse(await readFile(ruta, 'utf8'));
    const lista = (archivo as { cuentas?: unknown }).cuentas;
    return Array.isArray(lista) ? lista.length : null;
  } catch {
    return null;
  }
}

/**
 * Copia las credenciales de `origen` al sistema de destino.
 *
 * No abre dialogos ni conoce Electron: recibe la carpeta ya elegida. Asi se
 * puede probar entera sin levantar la aplicacion.
 */
export async function importarCredenciales(
  origen: string,
  destino: DestinoImportacion
): Promise<ResultadoImportacion> {
  if (resolve(origen) === resolve(destino.base)) {
    return fallo(
      'misma-carpeta',
      'Esa es la carpeta que el panel ya está usando. Elija la carpeta de datos de la versión anterior.'
    );
  }

  /* Regla 1, y va la primera: con un almacen en destino no se toca nada. */
  if (await existe(destino.vault)) {
    return fallo(
      'ya-hay-vault',
      'Este panel ya tiene credenciales guardadas y no se sobrescriben: sería irreversible. ' +
        'Si quiere reemplazarlas, saque antes la carpeta de datos actual de donde está.'
    );
  }

  const origenVault = resolve(origen, 'vault.enc');
  if (!(await existe(origenVault))) {
    return fallo(
      'sin-vault',
      'En esa carpeta no hay ningún archivo «vault.enc». Elija la carpeta que está junto al ' +
        'panel anterior y que se llama «datos-staging» —o «datos»—, no el acceso directo ni el .exe.'
    );
  }

  try {
    esquemaSobre.parse(JSON.parse(await readFile(origenVault, 'utf8')));
  } catch {
    return fallo(
      'vault-ilegible',
      'El archivo «vault.enc» de esa carpeta no tiene el formato del panel. No se ha copiado nada.'
    );
  }

  const origenCuentas = resolve(origen, 'cuentas.json');
  const origenActivos = resolve(origen, 'activos.json');
  const origenBak = resolve(origen, 'vault.enc.bak');

  /*
   * Primero lo accesorio y el vault al final. Ver la cabecera: un fallo a mitad
   * deja el panel como recien instalado, no con credenciales sin registro.
   *
   * `instancia.json` no se copia a proposito: lleva el numero de panel y la
   * identidad de *esa* instalacion, y dos paneles con el mismo numero es
   * exactamente la confusion que ese numero existe para evitar.
   */
  if (await existe(origenCuentas)) await copyFile(origenCuentas, destino.cuentas);
  if (await existe(origenActivos)) await copyFile(origenActivos, destino.activos);
  if (await existe(origenBak)) await copyFile(origenBak, destino.vaultBak);
  await copyFile(origenVault, destino.vault);

  const cuentas = (await existe(destino.cuentas)) ? await contarCuentas(destino.cuentas) : null;

  return {
    ok: true,
    motivo: null,
    mensaje:
      'Credenciales importadas. Desbloquee con la contraseña maestra que usaba en esa instalación: ' +
      'el archivo viene cifrado tal cual y esa contraseña no ha cambiado.',
    cuentas
  };
}
