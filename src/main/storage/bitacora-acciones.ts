/**
 * Bitácora de lo que el panel le pide a Bitget: `acciones/propias.jsonl`.
 *
 * ==========================================================================
 * Para qué existe
 * ==========================================================================
 * Las alertas de Telegram avisan de lo que se hizo **fuera** del panel. Para
 * eso hay que saber qué hizo el panel, y Bitget solo lo dice a medias: las
 * órdenes y el Take Profit llevan nuestro `clientOid` (`pcb…`), pero cerrar con
 * `close-positions`, agregar margen o cambiar el apalancamiento no aceptan
 * `clientOid`, y en UTA el historial de órdenes ni siquiera dice el origen
 * (verificado el 15/10/2026, docs/00-alertas-fase-1.md). Esta bitácora es la
 * otra mitad: cada escritura del panel, con su hora, para poder reconocerla
 * después en lo que devuelva Bitget.
 *
 * ==========================================================================
 * Se escribe en un solo sitio: el cliente REST
 * ==========================================================================
 * `ClienteBitget.peticionFirmada` llama al observador antes de firmar cada
 * petición que no es GET. Ninguna orden, cierre o ajuste puede salir sin pasar
 * por ahí, así que ninguno puede quedar sin anotar y aparecer luego como «hecho
 * por el cliente». Ver `observarEscrituras` en `bitget/rest/client.ts`.
 *
 * ==========================================================================
 * Qué guarda y qué no
 * ==========================================================================
 * La ruta y el cuerpo de la petición —símbolo, lado, importe, apalancamiento—,
 * que no llevan secretos: la firma va en las cabeceras. De la cuenta guarda una
 * **huella** de la API Key, no la clave: basta para reconocerla y no sirve para
 * nada más.
 *
 * Append-only, una línea por escritura, en cola para que dos órdenes
 * simultáneas no mezclen sus líneas. Una línea ilegible se descarta al leer sin
 * invalidar el resto. Lo de más de `BITACORA_RETENCION_MS` se purga: Bitget no
 * entrega historial más viejo, así que ya no hay nada con qué compararlo.
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { escribirAtomico, existe } from './atomic-write';

/** 120 días: más que los 90 que Bitget conserva de órdenes y planes. */
export const BITACORA_RETENCION_MS = 120 * 24 * 60 * 60 * 1000;

/** La huella de una API Key: identifica la cuenta sin guardar la clave. */
export const huellaCuenta = (apiKey: string): string =>
  createHash('sha256').update(apiKey, 'utf8').digest('hex').slice(0, 16);

const esquemaAccion = z.object({
  ts: z.number(),
  cuenta: z.string(),
  metodo: z.string(),
  ruta: z.string(),
  cuerpo: z.unknown()
});

export type AccionPropia = z.infer<typeof esquemaAccion>;

/** Fin de línea del archivo: una acción por línea. */
const SALTO = String.fromCharCode(10);

export class BitacoraAcciones {
  private readonly ruta: string;
  /** Una operación detrás de otra: líneas enteras aunque lleguen a la vez. */
  private cola: Promise<void> = Promise.resolve();
  /**
   * Copia en memoria del archivo, cargada la primera vez que hace falta.
   *
   * Las alertas leen la bitácora una vez por subcuenta y por revisión —cientos
   * de veces con el panel abierto—, así que no se va al disco cada vez. Solo
   * este proceso escribe el archivo —el panel no admite dos instancias—, de
   * modo que la copia nunca se queda atrás.
   */
  private memoria: AccionPropia[] | null = null;

  constructor(ruta: string) {
    this.ruta = ruta;
  }

  private enCola<T>(tarea: () => Promise<T>): Promise<T> {
    const esta = this.cola.then(tarea, tarea);
    this.cola = esta.then(
      () => undefined,
      () => undefined
    );
    return esta;
  }

  private async cargar(): Promise<AccionPropia[]> {
    if (this.memoria !== null) return this.memoria;
    const leidas: AccionPropia[] = [];
    if (await existe(this.ruta)) {
      for (const linea of (await readFile(this.ruta, 'utf8')).split(SALTO)) {
        const texto = linea.trim();
        if (texto === '') continue;
        try {
          leidas.push(esquemaAccion.parse(JSON.parse(texto)));
        } catch {
          /* Una línea cortada a mitad por un apagón: se descarta y se sigue. */
        }
      }
    }
    this.memoria = leidas;
    return leidas;
  }

  /**
   * Anota una escritura. Primero en memoria y luego en disco: si el disco
   * fallara, al menos esta sesión no la avisaría como externa.
   */
  anotar(accion: AccionPropia): Promise<void> {
    return this.enCola(async () => {
      (await this.cargar()).push(accion);
      await mkdir(dirname(this.ruta), { recursive: true });
      await appendFile(this.ruta, JSON.stringify(accion) + SALTO, 'utf8');
    });
  }

  /** Lo anotado desde `desdeMs`, en orden de llegada. */
  leerDesde(desdeMs: number): Promise<AccionPropia[]> {
    return this.enCola(async () => (await this.cargar()).filter((a) => a.ts >= desdeMs));
  }

  /** Reescribe el archivo sin lo anterior a `antesDeMs`. */
  purgar(antesDeMs: number): Promise<void> {
    return this.enCola(async () => {
      const quedan = (await this.cargar()).filter((a) => a.ts >= antesDeMs);
      this.memoria = quedan;
      if (!(await existe(this.ruta)) && quedan.length === 0) return;
      await escribirAtomico(
        this.ruta,
        quedan.length === 0 ? '' : quedan.map((a) => JSON.stringify(a)).join(SALTO) + SALTO
      );
    });
  }
}
