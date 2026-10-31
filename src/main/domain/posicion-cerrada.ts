/**
 * Una posición cerrada, tal como la usa el historial del panel.
 *
 * ==========================================================================
 * Una sola forma para dos superficies
 * ==========================================================================
 * Classic (V2) y UTA (V3) devuelven el historial por endpoints distintos y con
 * nombres de campo distintos —`holdSide`/`posSide`, `openAvgPrice`/
 * `openPriceAvg`, `utime`/`updatedTime`…—. Cada endpoint traduce la suya a esta
 * forma, y todo lo que viene después —almacén, filtro por periodo, suma— no
 * sabe ni le importa de qué superficie salió la posición.
 *
 * ==========================================================================
 * Qué es el «resultado»
 * ==========================================================================
 * `netProfit` de Bitget. Verificado sobre V3 el 12/10/2026 (ver
 * docs/00-historial-fase-1.md §3): es el PnL de precio **más** comisiones de
 * apertura y cierre **más** financiamiento, con signo. Es lo que de verdad entró
 * o salió de la cuenta y por eso es lo que se suma. El desglose se conserva
 * para que una suma que no cuadre con la web se pueda explicar.
 *
 * ==========================================================================
 * Lo que no viene: apalancamiento y porcentaje
 * ==========================================================================
 * Ninguna de las dos superficies los entrega en el historial. Viajan como
 * `null` —«Bitget no lo informa»—, nunca como un valor calculado aquí: la
 * cláusula «Valores mostrados» del presupuesto prohíbe estimar. Si el cliente
 * decide otra cosa en la Fase 1, se rellenan en un solo sitio.
 */
import Decimal from 'decimal.js';

export type SuperficieHistorial = 'v2' | 'v3';

export interface PosicionCerrada {
  /** Identificador de Bitget. Clave del almacén: una posición, una entrada. */
  positionId: string;
  symbol: string;
  lado: 'long' | 'short';
  modoMargen: 'isolated' | 'crossed' | null;
  apalancamiento: string | null;
  abiertaEnMs: number;
  /** Fecha de cierre. Es por la que se filtra el periodo. */
  cerradaEnMs: number;
  precioEntrada: string;
  precioSalida: string;
  cantidadCierre: string;
  /** `netProfit`: precio + comisiones + financiamiento. Lo que se suma. */
  resultado: string;
  porcentaje: string | null;
  /** Solo el movimiento de precio (`pnl` en V2, `cumRealisedPnl` en V3). */
  pnlPrecio: string;
  /** Apertura + cierre, con signo (negativo = coste). */
  comisiones: string;
  financiamiento: string;
  superficie: SuperficieHistorial;
  /**
   * El Take Profit que estaba puesto al cerrarse. No viene en el historial de
   * posiciones: lo enlaza `historial/take-profit.ts` con el de planes TP/SL.
   * `undefined`: aún no se buscó; `null`: se buscó y no tenía.
   */
  tp?: TakeProfitCerrada | null | undefined;
}

export interface TakeProfitCerrada {
  /** Precio de disparo. */
  precio: string;
  /** Cuándo se colocó el plan. */
  colocadoEnMs: number;
  /** Cuándo se disparó, o `null` si no llegó a dispararse (Bitget lo canceló al cerrar). */
  disparadoEnMs: number | null;
}

/**
 * Una página ya normalizada.
 *
 * Sin cursor a propósito: el paginador avanza por fecha de cierre, no con el
 * cursor de Bitget. Ver `historial/paginador.ts`.
 */
export interface PaginaHistorial {
  posiciones: PosicionCerrada[];
}

/** El historial no se pudo leer. El motivo distingue los casos para la pantalla. */
export class ErrorHistorial extends Error {
  readonly motivo:
    | 'cuenta-desconocida'
    | 'sin-credencial'
    | 'paginacion-estancada'
    | 'demasiadas-paginas'
    | 'respuesta-invalida';

  constructor(motivo: ErrorHistorial['motivo'], mensaje: string) {
    super(mensaje);
    this.name = 'ErrorHistorial';
    this.motivo = motivo;
  }
}

/* ---------- utilidades de normalización, compartidas por V2 y V3 ---------- */

/** Un número de Bitget a cadena decimal, o `'0'` si no viene. */
export const decimalOCero = (v: string | null | undefined): string =>
  v === null || v === undefined || v === '' ? '0' : new Decimal(v).toString();

/** Suma de importes de Bitget con signo, sin pasar por `number`. */
export const sumar = (...vs: (string | null | undefined)[]): string =>
  vs.reduce<Decimal>((acc, v) => acc.plus(decimalOCero(v)), new Decimal(0)).toString();

/** Marca de tiempo de Bitget (ms, en cadena o número) a número. */
export function msDe(v: string | number | null | undefined, campo: string): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ErrorHistorial(
      'respuesta-invalida',
      `Bitget devolvió una fecha no válida en «${campo}».`
    );
  }
  return n;
}

export function ladoDe(v: string): PosicionCerrada['lado'] {
  const l = v.toLowerCase();
  if (l === 'long' || l === 'short') return l;
  throw new ErrorHistorial('respuesta-invalida', `Lado de posición desconocido: «${v}».`);
}

export function modoMargenDe(v: string | null | undefined): PosicionCerrada['modoMargen'] {
  const m = (v ?? '').toLowerCase();
  if (m === 'isolated' || m === 'crossed') return m;
  /* V3 escribe `crossed`; algunas respuestas usan `cross`. */
  if (m === 'cross') return 'crossed';
  return null;
}
