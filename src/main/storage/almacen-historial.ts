/**
 * Historial de posiciones cerradas en disco: `historial/<cuentaId>.json`.
 *
 * Cumple lo contratado en la Fase 3 del presupuesto de historial: *"resguardo
 * de los registros consultados en el equipo, de modo que la información se
 * muestre de forma inmediata"*. Y algo que la Fase 1 convirtió en esencial:
 * Bitget solo entrega 90 días, así que lo anterior **solo existe aquí**.
 *
 * ==========================================================================
 * Un JSON por cuenta, no un JSONL
 * ==========================================================================
 * `registro-traspasos.ts` es append-only porque guarda *eventos*: un intento y
 * su desenlace. Aquí no hay eventos sino un conjunto: posiciones cerradas que
 * no cambian, identificadas por `positionId`. Lo natural es reemplazar el
 * archivo entero con la fusión por clave, y para eso `escribirAtomico`
 * —temporal, fsync, renombrado— es exactamente lo que hace falta. Un corte de
 * luz deja el archivo anterior o el nuevo, nunca uno a medias.
 *
 * Un archivo por cuenta y no uno común: dos cuentas se sincronizan en paralelo,
 * y con un archivo cada una no compiten por la misma escritura. La baja borra
 * un archivo en vez de reescribir el de todas.
 *
 * ==========================================================================
 * Lo que no se puede leer se trata como vacío
 * ==========================================================================
 * Un archivo corrupto, de otra versión o de otro UID no rompe el panel: se lee
 * como «no hay historial» y la siguiente sincronización lo reescribe con lo que
 * Bitget conserve. Lo que hubiera de más de 90 días en un archivo corrupto ya
 * estaba perdido; negarse a seguir no lo recuperaría.
 */
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { HistorialCuenta } from '../historial/historial-cuenta';
import type { AlmacenHistorial } from '../historial/sincronizador';
import { escribirAtomico } from './atomic-write';

const VERSION_ACTUAL = 1;

const esquemaPosicion = z.object({
  positionId: z.string(),
  symbol: z.string(),
  lado: z.enum(['long', 'short']),
  modoMargen: z.enum(['isolated', 'crossed']).nullable(),
  apalancamiento: z.string().nullable(),
  abiertaEnMs: z.number(),
  cerradaEnMs: z.number(),
  precioEntrada: z.string(),
  precioSalida: z.string(),
  cantidadCierre: z.string(),
  resultado: z.string(),
  porcentaje: z.string().nullable(),
  pnlPrecio: z.string(),
  comisiones: z.string(),
  financiamiento: z.string(),
  superficie: z.enum(['v2', 'v3']),
  /* Opcional: los archivos de antes no lo traen y se completa al sincronizar. */
  tp: z
    .object({
      precio: z.string(),
      colocadoEnMs: z.number(),
      disparadoEnMs: z.number().nullable()
    })
    .nullable()
    .optional()
});

const esquemaArchivo = z.object({
  version: z.literal(VERSION_ACTUAL),
  cuentaId: z.string(),
  uid: z.string(),
  cobertura: z.object({ desdeMs: z.number(), hastaMs: z.number() }).nullable(),
  sincronizadoEn: z.number().nullable(),
  posiciones: z.record(z.string(), esquemaPosicion)
});

/**
 * Los ids de cuenta los genera el panel (`cta_xxxxxxxx`), pero el nombre del
 * archivo sale de ellos: se exige una forma sin separadores para que un id
 * raro nunca pueda escribir fuera de la carpeta.
 */
const ID_SEGURO = /^[A-Za-z0-9_-]{1,64}$/;

export class AlmacenHistorialDisco implements AlmacenHistorial {
  private readonly carpeta: string;

  constructor(carpeta: string) {
    this.carpeta = carpeta;
  }

  private ruta(cuentaId: string): string {
    if (!ID_SEGURO.test(cuentaId))
      throw new Error(`Identificador de cuenta no válido: «${cuentaId}».`);
    return join(this.carpeta, `${cuentaId}.json`);
  }

  async leer(cuentaId: string, uid: string): Promise<HistorialCuenta | null> {
    let crudo: string;
    try {
      crudo = await readFile(this.ruta(cuentaId), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }

    let datos: z.infer<typeof esquemaArchivo>;
    try {
      datos = esquemaArchivo.parse(JSON.parse(crudo));
    } catch {
      return null;
    }

    /*
     * Mismo id, otro UID: la subcuenta se sustituyó por otra con el mismo hueco
     * en el panel. Su historial no es el de esta, y enseñarlo sería mezclar las
     * operaciones de dos titulares.
     */
    if (datos.cuentaId !== cuentaId || datos.uid !== uid) return null;

    return {
      cuentaId: datos.cuentaId,
      uid: datos.uid,
      cobertura: datos.cobertura,
      sincronizadoEn: datos.sincronizadoEn,
      posiciones: datos.posiciones
    };
  }

  async guardar(historial: HistorialCuenta): Promise<void> {
    const archivo: z.infer<typeof esquemaArchivo> = { version: VERSION_ACTUAL, ...historial };
    await escribirAtomico(this.ruta(historial.cuentaId), JSON.stringify(archivo));
  }

  async borrar(cuentaId: string): Promise<void> {
    try {
      await unlink(this.ruta(cuentaId));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
}
