/**
 * Tipos propios de la vista (diseño aprobado v2).
 *
 * Lo que no viene de `PanelService` porque es puramente de la pantalla:
 * selección de casillas, acordeones abiertos, avisos emergentes, la acción
 * en espera de contraseña de paso. Nunca contiene secretos ni datos de
 * mercado — esos vienen siempre tipados desde `@shared/domain/panel-view`.
 */
import type { ActionKey, BatchResult, Side } from '@shared/domain/panel-view';

export type AlcanceLado = Side | 'ambos';

/** Selección de casillas de una cuenta: 20 booleanos por lado, índice 0 = casilla 1. */
export interface SeleccionCuenta {
  selLong: boolean[];
  selShort: boolean[];
}

export type TipoAviso = 'ok' | 'aviso' | 'error';

export interface Aviso {
  id: string;
  tipo: TipoAviso;
  titulo: string;
  cuerpo: string;
  meta: string;
}

/**
 * Lo que el operador teclea en la barra lateral.
 *
 * --------------------------------------------------------------------------
 * Los importes de abrir y los de ajustar son campos distintos
 * --------------------------------------------------------------------------
 * `tp` y `mga` salen **con la orden** al pulsar «Abrir»; `tpAjuste` y
 * `mgAjuste` se aplican **después**, sobre una posición que ya está abierta.
 * Podrían haber sido dos campos en lugar de cuatro, y lo fueron: el 26/08/2026
 * una posición acabó con 2 USDT de margen donde el operador había escrito 1,
 * porque el importe salió con la apertura y el valor se quedó escrito en el
 * mismo campo desde el que se pulsaba el botón suelto.
 *
 * Separarlos es lo que hace que ese descuido ya no exista: el número que se
 * teclea para abrir no está en la casilla desde la que se ajusta lo abierto.
 * Ver `PlanKind`.
 */
export interface ValoresHerramientas {
  /** Take Profit que sale con la apertura, en %. */
  tp: string;
  mgi: string;
  /** Margen adicional que sale con la apertura. */
  mga: string;
  ap: string;
  /** Take Profit que se pone sobre posiciones ya abiertas, en %. */
  tpAjuste: string;
  /** Margen que se agrega o se retira de posiciones ya abiertas. Sin signo. */
  mgAjuste: string;
}

/**
 * El formulario de alta, tal como se teclea.
 *
 * `cuenta` y `casilla` son cadenas porque salen de un `<select>`, no porque sean
 * texto libre: la cuenta principal es una de las quince fijas —de la A a la O— y
 * la casilla, un número de 1 a 20. Los dos se convierten al enviarse.
 */
export interface FormularioApiKey {
  subcuenta: string;
  cuenta: string;
  casilla: string;
  apiKey: string;
  secretKey: string;
  passphrase: string;
}

export const CLAVES_ACCION: readonly { clave: ActionKey; etiqueta: string; nombre: string }[] = [
  { clave: 'tp', etiqueta: 'TP', nombre: 'Take Profit' },
  { clave: 'mg', etiqueta: 'MGA', nombre: 'Margen adicional' },
  { clave: 'ap', etiqueta: 'AP', nombre: 'Apalancamiento' },
  { clave: 'oe', etiqueta: 'OE', nombre: 'Orden ejecutada' }
];

export type ResultadoLote = BatchResult;
