/**
 * Un movimiento de una subcuenta, venga de donde venga en Bitget.
 *
 * Órdenes, planes TP/SL, movimientos de margen y traspasos llegan por
 * endpoints distintos, con nombres distintos en V2 y en V3. Cada lector de
 * `fuentes.ts` los traduce a esta forma, y todo lo demás —clasificar, guardar,
 * escribir el mensaje— trabaja solo con ella.
 */

export type TipoEvento =
  | 'abrir'
  | 'cerrar'
  /** Orden ejecutada de la que no se sabe si abrió o cerró (modo de una vía). */
  | 'orden'
  | 'tp-sl-puesto'
  | 'tp-sl-quitado'
  | 'margen-agregado'
  | 'margen-quitado'
  | 'traspaso-entrada'
  | 'traspaso-salida'
  | 'apalancamiento'
  | 'modo-margen'
  /** Aviso del propio panel, no un movimiento: «pueden faltar operaciones…». */
  | 'nota';

export interface EventoCuenta {
  /** Único y estable entre revisiones: `orden:<id>`, `plan:<id>:quitado`… */
  clave: string;
  tipo: TipoEvento;
  cuandoMs: number;
  simbolo: string | null;
  lado: 'long' | 'short' | null;
  cantidad: string | null;
  precio: string | null;
  importe: string | null;
  /** Lo que Bitget dice del origen (`api`, `web`, `app`…), crudo. `null` en UTA. */
  origen: string | null;
  clientOid: string | null;
  orderId: string | null;
  /**
   * Lo hizo Bitget solo: un TP/SL que se disparó, una liquidación. No es una
   * acción del cliente y no se avisa (decisión del 15/10/2026).
   */
  automatico: boolean;
  /** Texto extra para el mensaje: «TP», «SL», «10x → 20x»… */
  detalle: string | null;
  /**
   * Solo en lo que Bitget no fecha —apalancamiento, modo—: pasó en algún
   * momento entre esto y `cuandoMs`, que es cuando se notó.
   */
  desdeMs?: number;
  /**
   * Claves de otros eventos que esta línea ya cuenta: el TP que Bitget crea
   * junto con una apertura va dentro de ella. Se recuerdan como vistos para
   * que no lleguen después por separado.
   */
  incluye?: string[];
}

/** Un evento externo esperando a enviarse, con lo que hace falta para nombrar su subcuenta. */
export interface EventoPendiente extends EventoCuenta {
  cuentaId: string;
  /** `PCB-1-A-1`. */
  identificador: string;
  /** Nombre de la subcuenta: `Sub-01`. */
  etiqueta: string;
  /** Cuenta madre: `A`. */
  grupo: string;
}

/** Apalancamiento y modo de un símbolo, para notar si cambian entre revisiones. */
export interface AjustesSimbolo {
  modo: string | null;
  largo: string | null;
  corto: string | null;
  cruzado: string | null;
}
