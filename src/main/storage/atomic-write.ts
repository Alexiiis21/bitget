/**
 * Escritura atomica en disco.
 *
 * Es lo unico que SQLite habria aportado a este proyecto, y se resuelve en
 * treinta lineas: escribir a un temporal, forzar el volcado a disco y renombrar
 * encima. El renombrado dentro del mismo volumen es atomico, asi que un corte
 * de luz deja el archivo anterior intacto y nunca uno a medias.
 *
 * Sin esto, un cierre abrupto mientras se guarda `vault.enc` dejaria las
 * credenciales de 100 cuentas irrecuperables. docs/adr/0004.
 */
import { constants } from 'node:fs';
import { access, copyFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

/** `true` si la ruta existe. */
export async function existe(ruta: string): Promise<boolean> {
  try {
    await access(ruta, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Escribe reemplazando el contenido anterior, sin estado intermedio visible.
 *
 * El `sync()` antes del renombrado no es opcional: sin el, el renombrado puede
 * llegar al disco antes que los datos y el archivo queda vacio tras un corte.
 */
export async function escribirAtomico(ruta: string, contenido: string | Buffer): Promise<void> {
  await mkdir(dirname(ruta), { recursive: true });

  const temporal = `${ruta}.tmp`;
  const manejador = await open(temporal, 'w');
  try {
    await manejador.writeFile(contenido);
    await manejador.sync();
  } finally {
    await manejador.close();
  }

  try {
    await rename(temporal, ruta);
  } catch (e) {
    await unlink(temporal).catch(() => undefined);
    throw e;
  }
}

/**
 * Copia el archivo actual a `.bak` antes de sobrescribirlo.
 *
 * Una sola generacion. Suficiente para revertir una escritura que salio mal, y
 * no tanta como para que el respaldo se convierta en otra cosa que mantener.
 * docs/03 seccion 16.
 */
export async function rotarRespaldo(ruta: string): Promise<void> {
  if (!(await existe(ruta))) return;
  await copyFile(ruta, `${ruta}.bak`);
}
