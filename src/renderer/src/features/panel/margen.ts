import { importe } from '@/lib/formato';
import type { Position } from '@shared/domain/panel-view';

/**
 * Lo que enseña la columna «M. inicial», y con qué rótulo.
 *
 * Lo usan `AccordeonMonitor` y `ModalDetalleSubcuenta`, calculado en un solo
 * sitio para que las dos pantallas no puedan enseñar cifras distintas de la
 * misma punta.
 *
 * La cifra es **siempre** la de Bitget (`marginSize` en clásicas,
 * `positionBalance` en UTA). Hasta la v0.16.5 se prefería el acumulado que
 * anotaba el panel y Bitget solo entraba de respaldo, y ese acumulado vive en
 * memoria: tras reiniciar el panel, un reposicionamiento de 0,20 sobre una
 * posición de 0,40 dejaba la columna en 0,20, porque la apertura la hizo otra
 * sesión. Reportado por el cliente el 28/10/2026. Un guion solo si Bitget no lo
 * mandó.
 */
export interface MargenPunta {
  /** Cifra formateada, o `—` si no se sabe. */
  valor: string;
  titulo: string;
}

const TITULO_MARGEN = 'Margen de la posición según Bitget: apertura + reposicionamientos.';

export function margenDe(posicion: Position | undefined): MargenPunta {
  return { valor: importe(posicion?.currentMargin ?? null), titulo: TITULO_MARGEN };
}
