/**
 * Configuracion del panel (`config.json`).
 *
 * --------------------------------------------------------------------------
 * Contra que mercado opera este panel, y por que no lo decide la pantalla
 * --------------------------------------------------------------------------
 * Bitget tiene dos mercados de futuros: el real y el simulado. La eleccion no
 * puede venir del renderer -seria un dato que viaja por IPC y que un fallo de
 * la pagina podria cambiar- ni deducirse del entorno de compilacion: `staging`
 * habla con la API real de Bitget, y aun asi debe poder operar contra el
 * mercado simulado mientras se prueba.
 *
 * Asi que vive en disco, junto al vault, y **arranca en `simulado`**. Pasar a
 * dinero real es una accion deliberada de quien administra el equipo, no un
 * descuido posible: docs/01 seccion 11 exige que la primera operacion real se
 * haga a mano y con el monto minimo antes de habilitar la ejecucion masiva.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { escribirAtomico, existe } from './atomic-write';

const VERSION_ACTUAL = 1;

const esquemaConfiguracion = z.object({
  version: z.number().int().positive(),
  /** `simulado` o `real`. Ver bitget/mercado.ts. */
  mercado: z.enum(['simulado', 'real'])
});

export type Configuracion = z.infer<typeof esquemaConfiguracion>;

const POR_DEFECTO: Configuracion = { version: VERSION_ACTUAL, mercado: 'simulado' };

/**
 * Lee la configuracion, creandola la primera vez.
 *
 * Un archivo ilegible **no** se sobrescribe y devuelve los valores por defecto:
 * el peor error posible aqui seria interpretar un archivo corrupto como «opera
 * con dinero real», y arrancar en simulado nunca causa un dano.
 */
export async function cargarConfiguracion(ruta: string): Promise<Configuracion> {
  if (!(await existe(ruta))) {
    await escribirAtomico(ruta, JSON.stringify(POR_DEFECTO, null, 2));
    return { ...POR_DEFECTO };
  }

  try {
    return esquemaConfiguracion.parse(JSON.parse(await readFile(ruta, 'utf8')));
  } catch {
    return { ...POR_DEFECTO };
  }
}

export async function guardarConfiguracion(ruta: string, config: Configuracion): Promise<void> {
  await escribirAtomico(ruta, JSON.stringify({ ...config, version: VERSION_ACTUAL }, null, 2));
}
