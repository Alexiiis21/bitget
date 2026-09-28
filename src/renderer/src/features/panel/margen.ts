import { importe } from '@/lib/formato';
import type { Position } from '@shared/domain/panel-view';

/**
 * Lo que enseña la columna «M. inicial», y con qué rótulo.
 *
 * Lo usan `AccordeonMonitor` y `ModalDetalleSubcuenta`, calculado en un solo
 * sitio para que las dos pantallas no puedan enseñar cifras distintas de la
 * misma punta.
 *
 * El margen inicial es del panel y solo existe si el panel anotó la apertura en
 * esta sesión. Cuando no -la posición ya estaba abierta al arrancar, o se abrió
 * fuera del panel- se enseña el margen que Bitget tiene ahora, que incluye el
 * adicional, y el rótulo lo dice: son dos cifras distintas y no se pueden leer
 * igual. Un guion solo si tampoco Bitget lo mandó.
 */
export interface MargenPunta {
  /** Cifra formateada, o `—` si no se sabe. */
  valor: string;
  titulo: string;
  /** `true` si la cifra es la de Bitget y no la que anotó el panel. */
  deBitget: boolean;
}

const TITULO_MARGEN = 'Margen inicial acumulado: apertura + reposicionamientos.';

const TITULO_MARGEN_BITGET =
  'Margen actual de la posición en Bitget, con el margen adicional incluido. ' +
  'El panel no anotó la apertura de esta posición: ya estaba abierta cuando arrancó, o se abrió fuera del panel.';

export function margenDe(posicion: Position | undefined): MargenPunta {
  if (posicion?.initialMarginAccum != null) {
    return { valor: importe(posicion.initialMarginAccum), titulo: TITULO_MARGEN, deBitget: false };
  }
  if (posicion?.currentMargin != null) {
    return { valor: importe(posicion.currentMargin), titulo: TITULO_MARGEN_BITGET, deBitget: true };
  }
  return { valor: importe(null), titulo: TITULO_MARGEN, deBitget: false };
}
