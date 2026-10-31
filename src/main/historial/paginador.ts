/**
 * Recorre el historial de una cuenta página a página, tramo a tramo.
 *
 * No sabe de credenciales ni de superficies: recibe una `fuente` que trae una
 * página, y de eso se encarga `obtenerHistorialPosiciones`. Así se prueba sin
 * red y sirve igual para Classic y para UTA.
 *
 * ==========================================================================
 * Tramos
 * ==========================================================================
 * Bitget no admite rangos de más de 90 días. Un rango mayor se parte en tramos
 * de `HISTORIAL_VENTANA_MS`, del más reciente al más antiguo, y cada tramo se
 * pagina entero antes de pasar al siguiente. Hoy la sesión nunca pide más de 90
 * días —Bitget no guarda más—, pero el paginador no debe depender de eso.
 *
 * ==========================================================================
 * Se avanza por fecha de cierre, no con el cursor de Bitget
 * ==========================================================================
 * Verificado el 13/10/2026: paginar con el cursor de Bitget (`idLessThan =
 * endId` en V2) **pierde posiciones**. De 29 llegaron 28; la que faltaba cerró
 * 1 ms antes que la última de la página anterior, y el id interno que usa el
 * cursor no sigue el mismo orden que la lista.
 *
 * Lo que sí se verificó en las dos superficies es que `startTime`/`endTime`
 * filtran por **fecha de cierre** y son **inclusivos**, y que la lista llega de
 * la más reciente a la más antigua. Con eso se pagina sin cursor:
 *
 *   1. Se piden las `limite` más recientes de `[desde, fin]`.
 *   2. Si llegan menos de `limite`, el tramo está completo.
 *   3. Si no, todas las que cerraron **después** de la más antigua recibida ya
 *      están; se vuelve a pedir con `fin` = esa fecha, inclusiva. Las que
 *      comparten justo ese milisegundo se repiten y se descartan por
 *      `positionId`.
 *
 * El único caso que esto no resuelve son más de `limite` posiciones cerradas en
 * el mismo milisegundo: la página siguiente no traería nada nuevo. Se corta con
 * `paginacion-estancada` en vez de saltar ese milisegundo, porque saltarlo
 * podría dejar fuera posiciones sin avisar. Con 100 por página no ocurre en una
 * sola subcuenta.
 *
 * ==========================================================================
 * Reintentos: aquí sí, y es seguro
 * ==========================================================================
 * El cliente no reintenta, y el motor de lotes solo reintenta lo que puede
 * resolver sin duplicar. Una lectura no tiene ese problema: pedir dos veces la
 * misma página no cambia nada en Bitget. Se reintenta **la misma página, con
 * el mismo rango,** ante un fallo transitorio (`retryable`) o sin respuesta
 * (`indeterminada`), con la espera del motor. Lo demás —credencial rechazada,
 * IP no autorizada— se propaga: reintentarlo solo gastaría cupo.
 *
 * ==========================================================================
 * Contra los bucles
 * ==========================================================================
 * Una página sin nada nuevo corta con `paginacion-estancada`, y un total de
 * páginas absurdo, con `demasiadas-paginas`. Las dos cosas significan que el
 * comportamiento de Bitget ha cambiado; seguir pidiendo vaciaría el cupo de la
 * cuenta sin terminar nunca.
 */
import type { ConsultaPaginaHistorial } from '../bitget/rest/endpoints/historial-v3';
import {
  ErrorHistorial,
  type PaginaHistorial,
  type PosicionCerrada
} from '../domain/posicion-cerrada';
import {
  HISTORIAL_LIMITE_PAGINA,
  HISTORIAL_MAX_PAGINAS,
  HISTORIAL_REINTENTOS,
  HISTORIAL_VENTANA_MS
} from '@shared/constants';
import { dormirReal, leerConReintentos } from './reintento';

export type FuentePaginas = (consulta: ConsultaPaginaHistorial) => Promise<PaginaHistorial>;

export interface OpcionesRecorrido {
  desdeMs: number;
  hastaMs: number;
  dormir?: (ms: number) => Promise<void>;
  /** Por defecto los de `constants.ts`; las pruebas los reducen. */
  ventanaMs?: number;
  limitePagina?: number;
  maxPaginas?: number;
  reintentos?: number;
}

/** Los tramos de `[desde, hasta]`, del más reciente al más antiguo. */
export function tramosDe(desdeMs: number, hastaMs: number, ventanaMs: number): [number, number][] {
  const tramos: [number, number][] = [];
  let fin = hastaMs;
  while (fin > desdeMs) {
    const inicio = Math.max(desdeMs, fin - ventanaMs);
    tramos.push([inicio, fin]);
    fin = inicio;
  }
  return tramos;
}

/**
 * Las posiciones de `[desdeMs, hastaMs]`, una página cada vez.
 *
 * Se entrega por páginas y no la lista entera al final para que quien llama
 * pueda guardar el progreso: si la página 7 falla, las 6 primeras ya están en
 * disco y la siguiente sincronización no las vuelve a necesitar.
 */
export async function* recorrerHistorial(
  fuente: FuentePaginas,
  opciones: OpcionesRecorrido
): AsyncGenerator<PosicionCerrada[], void, undefined> {
  const dormir = opciones.dormir ?? dormirReal;
  const ventana = opciones.ventanaMs ?? HISTORIAL_VENTANA_MS;
  const limite = opciones.limitePagina ?? HISTORIAL_LIMITE_PAGINA;
  const maxPaginas = opciones.maxPaginas ?? HISTORIAL_MAX_PAGINAS;
  const reintentos = opciones.reintentos ?? HISTORIAL_REINTENTOS;

  let paginas = 0;

  const pedir = (consulta: ConsultaPaginaHistorial): Promise<PaginaHistorial> =>
    leerConReintentos(() => fuente(consulta), { dormir, reintentos });

  /* Entre tramos también: los extremos son inclusivos y un tramo pisa al otro en su borde. */
  const vistos = new Set<string>();

  for (const [desdeMs, hastaMs] of tramosDe(opciones.desdeMs, opciones.hastaMs, ventana)) {
    let fin = hastaMs;

    for (;;) {
      if (paginas >= maxPaginas) {
        throw new ErrorHistorial(
          'demasiadas-paginas',
          `El historial pasó de ${maxPaginas} páginas sin terminar. Se detuvo la consulta.`
        );
      }
      paginas++;

      const { posiciones } = await pedir({ desdeMs, hastaMs: fin, limite });

      const nuevas = posiciones.filter((p) => !vistos.has(p.positionId));
      for (const p of nuevas) vistos.add(p.positionId);
      if (nuevas.length > 0) yield nuevas;

      if (posiciones.length < limite) break;

      if (nuevas.length === 0) {
        throw new ErrorHistorial(
          'paginacion-estancada',
          'Bitget devolvió una página del historial sin posiciones nuevas. Se detuvo la consulta ' +
            'para no dar por completo un periodo al que podrían faltarle operaciones.'
        );
      }
      fin = Math.min(...posiciones.map((p) => p.cerradaEnMs));
    }
  }
}
