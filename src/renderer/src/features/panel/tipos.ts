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

/** Acción en espera de la contraseña de paso. Solo la apertura pasa por aquí. */
export interface ValoresHerramientas {
  tp: string;
  mgi: string;
  mga: string;
  ap: string;
}

export interface FormularioApiKey {
  subcuenta: string;
  cuenta: string;
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
