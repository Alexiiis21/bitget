/**
 * Identidad de este panel (`instancia.json`).
 *
 * El numero que se ve arriba -«#3»- sale de aqui. No se deduce ni se genera al
 * vuelo: se escribe una vez y se queda, porque el operador lo usa para saber en
 * que juego de cuentas esta trabajando y un numero que baila seria peor que no
 * tenerlo. docs/03-modelo-de-datos.md seccion 3.
 *
 * --------------------------------------------------------------------------
 * Fijo no era lo mismo que inmutable
 * --------------------------------------------------------------------------
 * Hasta el 28/08/2026 el numero se escribia en el primer arranque y no habia
 * forma de cambiarlo: el campo de la cabecera aceptaba teclearlo, el cambio se
 * veia en pantalla y al reiniciar volvia el 1, porque no existia canal que lo
 * guardara. Un campo que se deja escribir y no recuerda es peor que uno que no
 * se deja: el operador cree que este panel es el #3 y no lo es.
 *
 * Ahora `fijarNumeroPanel` lo persiste. Lo que no cambia es el resto de la
 * identidad -`id` y `creadoEn`-, que son de la instalacion y no del operador.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { escribirAtomico, existe } from './atomic-write';

const esquemaInstancia = z.object({
  id: z.string(),
  numero: z.number().int().positive(),
  nombre: z.string(),
  creadoEn: z.string()
});

export type Instancia = z.infer<typeof esquemaInstancia>;

const nueva = (): Instancia => ({
  id: `inst_${randomUUID().slice(0, 8)}`,
  numero: 1,
  nombre: 'Sistema 1',
  creadoEn: new Date().toISOString()
});

/**
 * Lee la identidad, creandola la primera vez.
 *
 * Un archivo ilegible no se sobrescribe: se devuelve una identidad de
 * emergencia en memoria. Machacarlo perderia el numero que el operador ya tiene
 * asociado a esta maquina, y el panel arranca igual sin escribir nada.
 */
export async function cargarInstancia(ruta: string): Promise<Instancia> {
  if (!(await existe(ruta))) {
    const identidad = nueva();
    await escribirAtomico(ruta, JSON.stringify(identidad, null, 2));
    return identidad;
  }

  try {
    return esquemaInstancia.parse(JSON.parse(await readFile(ruta, 'utf8')));
  } catch {
    return nueva();
  }
}

/**
 * Cambia el numero visible de este panel y lo deja escrito.
 *
 * Muta el objeto que ya circula por el proceso principal **y** escribe el
 * archivo, en ese orden y en el mismo sitio, a proposito: la identidad se carga
 * una vez al arrancar y `sistema:info` responde desde esa copia en memoria.
 * Actualizar solo el disco haria que el panel seguiera diciendo el numero
 * viejo hasta reiniciar; actualizar solo la memoria es justo el fallo que esto
 * viene a corregir.
 *
 * `id` y `creadoEn` no se tocan: identifican la instalacion, no al operador.
 */
export async function fijarNumeroPanel(
  ruta: string,
  instancia: Instancia,
  numero: number
): Promise<void> {
  instancia.numero = numero;
  await escribirAtomico(ruta, JSON.stringify(instancia, null, 2));
}
