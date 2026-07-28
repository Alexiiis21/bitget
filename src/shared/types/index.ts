/**
 * Tipos del dominio, compartidos por los tres procesos.
 *
 * Regla: aqui solo hay tipos y constantes. Si algo con comportamiento aparece en
 * shared/, es senal de que se filtro logica hacia el renderer.
 * Ver docs/03-modelo-de-datos.md.
 */

/* ---------- primitivas ---------- */

/**
 * Cantidad monetaria como cadena decimal. Nunca `number`: 0.1 + 0.2 !== 0.3, y
 * un float en un precio de liquidacion es un error que se descubre con dinero
 * real. La aritmetica pasa por decimal.js. docs/03 seccion 14.
 */
export type Decimal = string;

export type Lado = 'long' | 'short';
export type ModoMargen = 'aislado' | 'cruzado';
export type ModoPosicion = 'cobertura' | 'unilateral';

/* ---------- cuentas ---------- */

export type EstadoConexion = 'conectada' | 'conectando' | 'desconectada' | 'modo-rest';

export interface Grupo {
  id: string;
  nombre: string;
  orden: number;
  colapsado: boolean;
}

/** Metadatos de cuenta. Nunca contiene secretos: viven cifrados en vault.enc. */
export interface Cuenta {
  id: string;
  grupoId: string;
  etiqueta: string;
  uid: string;
  credencialId: string;
  /** Solo los primeros 2 y ultimos 4 caracteres. El valor completo no cruza el IPC. */
  apiKeyEnmascarada: string;
  orden: number;
  activa: boolean;
  modoPosicion: ModoPosicion;
  modoMargen: ModoMargen;
  altaEn: string;
}

/* ---------- posiciones ---------- */

export interface TakeProfit {
  precio: Decimal;
  porcentaje: number;
  planId: string;
}

/**
 * Clave compuesta: cuentaId + simbolo + lado.
 *
 * El lado forma parte de la clave porque el panel opera en modo cobertura: una
 * cuenta puede tener LONG y SHORT vivos sobre el mismo simbolo al mismo tiempo.
 * Con la clave `(cuenta, simbolo)` se perderia una de las dos en silencio.
 * docs/03 seccion 1, Hallazgo 3.
 */
export interface Posicion {
  cuentaId: string;
  simbolo: string;
  lado: Lado;
  tamano: Decimal;
  precioEntrada: Decimal;
  precioLiquidacion: Decimal;
  apalancamiento: number;
  modoMargen: ModoMargen;
  margen: Decimal;
  /** Llega por el canal orders-algo, no por positions: puede faltar un instante. */
  takeProfit: TakeProfit | null;
  origen: 'ws' | 'rest';
  actualizadoEn: string;
  estado: 'viva' | 'indeterminada';
}

export const clavePosicion = (cuentaId: string, simbolo: string, lado: Lado): string =>
  `${cuentaId}|${simbolo}|${lado}`;

/* ---------- proyeccion del monitor ---------- */

export interface PuntaMonitor {
  liquidacion: Decimal;
  entrada: Decimal;
  takeProfit: Decimal | null;
}

export type EstadoFila = 'ok' | 'indeterminada' | 'sin-conexion' | 'modo-rest';

/** Una fila del Centro de Monitoreo. Corresponde 1:1 con docs/04 W-01. */
export interface FilaMonitor {
  cuentaId: string;
  etiqueta: string;
  grupoId: string;
  long: PuntaMonitor | null;
  short: PuntaMonitor | null;
  /** `null` cuando falta cualquiera de las dos puntas. Nunca cero. */
  distanciaLS: Decimal | null;
  estado: EstadoFila;
}

/* ---------- lotes de ejecucion ---------- */

export type AccionLote = 'abrir' | 'cerrar' | 'take-profit' | 'agregar-margen' | 'apalancamiento';

/**
 * Cuatro desenlaces, no dos. `indeterminado` no es un fallo: es la ausencia de
 * respuesta despues de enviar, y nunca se reintenta a ciegas.
 * docs/03 seccion 10.
 */
export type EstadoJob = 'pendiente' | 'enviando' | 'exito' | 'fallo' | 'omitida' | 'indeterminada';

export interface Job {
  cuentaId: string;
  clientOid: string;
  estado: EstadoJob;
  codigoBitget: string | null;
  mensaje: string | null;
  ordenId: string | null;
}

export interface Lote {
  id: string;
  accion: AccionLote;
  simbolo: string;
  iniciadoEn: string;
  terminadoEn: string | null;
  jobs: Job[];
}

/* ---------- catalogo de simbolos ---------- */

export interface Simbolo {
  simbolo: string;
  tickSize: Decimal;
  pricePlace: number;
  minTradeNum: Decimal;
  sizeMultiplier: Decimal;
  apalancamientoMax: number;
  estado: 'normal' | 'suspendido';
}
