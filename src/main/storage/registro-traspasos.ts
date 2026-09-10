/**
 * Registro de traspasos (`traspasos/movimientos.jsonl`).
 *
 * Cumple lo contratado en la Fase 3: *"registro del movimiento con fecha,
 * importe y resultado"*. Y hace algo más que el contrato no pide con esas
 * palabras pero que es lo que de verdad protege el dinero.
 *
 * ==========================================================================
 * Se escribe ANTES de enviar, no después
 * ==========================================================================
 * Un registro que se escribe al recibir la respuesta solo sirve para consultar
 * el pasado. Este se escribe **antes** de la petición, de modo que si el proceso
 * muere entre el envío y la respuesta —corte de luz, cierre de la aplicación, un
 * fallo de red que deja la petición en el aire— la intención ya está en disco.
 *
 * Sin eso, la pregunta «¿llegó a salir ese dinero?» no tiene respuesta más que
 * mirando Bitget cuenta por cuenta. Con eso, al arrancar queda un `intento` sin
 * su `resuelta` y el panel puede señalarlo.
 *
 * Es el mismo razonamiento que docs/03-modelo-de-datos.md §10 describe para las
 * órdenes; aquí se aplica de verdad, porque un traspaso lo merece igual: mueve
 * dinero y no se puede deshacer.
 *
 * ==========================================================================
 * Lo que este archivo NO hace: reintentar
 * ==========================================================================
 * Un traspaso sin respuesta **no se reenvía nunca de forma automática**. El
 * `clientOid` protege del duplicado en el propio exchange, pero la respuesta
 * correcta a «no sé si salió» es consultar el saldo, no repetir el movimiento.
 * Lo mismo que el estado `unknown` de las órdenes: consultar es seguro,
 * reintentar no lo es.
 *
 * Append-only, una línea JSON por evento. Una línea corrupta —un corte a mitad
 * de escritura— se descarta al leer y no invalida el resto del archivo.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { existe } from './atomic-write';

const esquemaIntento = z.object({
  ts: z.string(),
  tipo: z.literal('intento'),
  clientOid: z.string(),
  uidMadre: z.string(),
  uidOrigen: z.string(),
  etiquetaOrigen: z.string(),
  uidDestino: z.string(),
  etiquetaDestino: z.string(),
  importe: z.string(),
  moneda: z.string()
});

const esquemaResuelta = z.object({
  ts: z.string(),
  tipo: z.literal('resuelta'),
  clientOid: z.string(),
  resultado: z.enum(['exito', 'fallo']),
  /** Identificador del movimiento en Bitget. Lo único con lo que reclamar. */
  transferId: z.string().nullish(),
  codigoBitget: z.string().nullish(),
  mensaje: z.string().nullish()
});

const esquemaLinea = z.union([esquemaIntento, esquemaResuelta]);

export type Intento = z.infer<typeof esquemaIntento>;
export type Resuelta = z.infer<typeof esquemaResuelta>;
export type LineaTraspaso = z.infer<typeof esquemaLinea>;

/** Un traspaso tal como se lee del registro, con su desenlace si lo tuvo. */
export interface MovimientoRegistrado {
  clientOid: string;
  ts: string;
  uidOrigen: string;
  etiquetaOrigen: string;
  uidDestino: string;
  etiquetaDestino: string;
  importe: string;
  moneda: string;
  /**
   * `pendiente` es el estado que justifica todo este archivo: se envió y no se
   * sabe qué pasó. No es un fallo —puede haber salido— y por eso no se cuenta
   * como tal ni se reintenta.
   */
  resultado: 'exito' | 'fallo' | 'pendiente';
  transferId: string | null;
  mensaje: string | null;
  resueltoEn: string | null;
}

export class RegistroTraspasos {
  private readonly ruta: string;

  constructor(ruta: string) {
    this.ruta = ruta;
  }

  private async anotar(linea: LineaTraspaso): Promise<void> {
    await mkdir(dirname(this.ruta), { recursive: true });
    await appendFile(this.ruta, `${JSON.stringify(linea)}\n`, 'utf8');
  }

  /**
   * Deja constancia de que se va a enviar. **Se llama antes de la petición.**
   *
   * Si esta escritura falla, el traspaso no debe enviarse: sin registro previo,
   * un envío que no responda queda sin rastro, que es exactamente el estado que
   * este archivo existe para evitar.
   */
  async anotarIntento(datos: Omit<Intento, 'ts' | 'tipo'>, ahora = new Date()): Promise<void> {
    await this.anotar({ ts: ahora.toISOString(), tipo: 'intento', ...datos });
  }

  /** Cierra un intento con lo que Bitget respondió. */
  async anotarResuelta(datos: Omit<Resuelta, 'ts' | 'tipo'>, ahora = new Date()): Promise<void> {
    await this.anotar({ ts: ahora.toISOString(), tipo: 'resuelta', ...datos });
  }

  /**
   * Todo lo registrado, lo más reciente primero.
   *
   * Une cada `intento` con su `resuelta`. Los que no tienen pareja salen como
   * `pendiente`, que es la señal de que hay que ir a mirar el saldo.
   */
  async listar(limite = 200): Promise<MovimientoRegistrado[]> {
    if (!(await existe(this.ruta))) return [];

    const crudo = await readFile(this.ruta, 'utf8');
    const intentos = new Map<string, Intento>();
    const resueltas = new Map<string, Resuelta>();

    for (const linea of crudo.split('\n')) {
      const texto = linea.trim();
      if (texto === '') continue;

      let dato: LineaTraspaso;
      try {
        dato = esquemaLinea.parse(JSON.parse(texto));
      } catch {
        /*
         * Línea ilegible: un corte de luz a mitad de escritura deja la última a
         * medias. Se descarta esa y se sigue; un archivo de eventos no se
         * invalida por su última línea.
         */
        continue;
      }

      if (dato.tipo === 'intento') intentos.set(dato.clientOid, dato);
      else resueltas.set(dato.clientOid, dato);
    }

    const movimientos: MovimientoRegistrado[] = [];
    for (const intento of intentos.values()) {
      const fin = resueltas.get(intento.clientOid);
      movimientos.push({
        clientOid: intento.clientOid,
        ts: intento.ts,
        uidOrigen: intento.uidOrigen,
        etiquetaOrigen: intento.etiquetaOrigen,
        uidDestino: intento.uidDestino,
        etiquetaDestino: intento.etiquetaDestino,
        importe: intento.importe,
        moneda: intento.moneda,
        resultado: fin?.resultado ?? 'pendiente',
        transferId: fin?.transferId ?? null,
        mensaje: fin?.mensaje ?? null,
        resueltoEn: fin?.ts ?? null
      });
    }

    movimientos.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    return movimientos.slice(0, limite);
  }

  /** Los que se enviaron y de los que no se sabe el desenlace. */
  async pendientes(): Promise<MovimientoRegistrado[]> {
    return (await this.listar(Number.MAX_SAFE_INTEGER)).filter((m) => m.resultado === 'pendiente');
  }
}
