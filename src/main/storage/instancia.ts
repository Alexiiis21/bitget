/**
 * Identidad de este panel (`instancia.json`).
 *
 * El numero que se ve arriba a la derecha -«#3»- sale de aqui. No se deduce ni
 * se genera al vuelo: se escribe la primera vez y no cambia, porque el operador
 * lo usa para saber en que juego de cien cuentas esta trabajando y un numero
 * que baila seria peor que no tenerlo. docs/03-modelo-de-datos.md seccion 3.
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
