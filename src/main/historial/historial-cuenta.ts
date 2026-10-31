/**
 * El historial guardado de una cuenta y cómo se le suman posiciones.
 *
 * Puro: sin disco ni red. Lo usan el almacén en memoria (Fase 2) y el de disco
 * (Fase 3), de modo que las reglas de fusión y de cobertura existen una vez.
 *
 * ==========================================================================
 * Fusionar es idempotente
 * ==========================================================================
 * Las posiciones se guardan por `positionId`. Una posición cerrada no cambia,
 * así que recibirla dos veces —una página repetida tras un reintento, el solape
 * de diez minutos entre sincronizaciones— deja el historial igual. Es lo que
 * permite reintentar y solapar sin miedo a contar una operación dos veces.
 *
 * ==========================================================================
 * Cobertura: el tramo que se sabe completo
 * ==========================================================================
 * Tener posiciones de una fecha no significa tenerlas **todas**. La cobertura
 * es el tramo `[desdeMs, hastaMs]` del que se trajeron todas las páginas sin
 * error, y es lo que permite decir «en este periodo no falta nada». Solo se
 * amplía al terminar una sincronización entera; una a medias guarda lo que
 * trajo pero no declara cubierto nada.
 */
import type { PosicionCerrada } from '../domain/posicion-cerrada';

export interface Cobertura {
  desdeMs: number;
  hastaMs: number;
}

export interface HistorialCuenta {
  cuentaId: string;
  /** UID de Bitget al que pertenece. Si la cuenta cambia de UID, no es su historial. */
  uid: string;
  cobertura: Cobertura | null;
  sincronizadoEn: number | null;
  posiciones: Record<string, PosicionCerrada>;
}

export const historialVacio = (cuentaId: string, uid: string): HistorialCuenta => ({
  cuentaId,
  uid,
  cobertura: null,
  sincronizadoEn: null,
  posiciones: {}
});

/** Cuántas de `posiciones` no estaban ya en el historial. */
export const contarNuevas = (h: HistorialCuenta, posiciones: readonly PosicionCerrada[]): number =>
  new Set(posiciones.filter((p) => !(p.positionId in h.posiciones)).map((p) => p.positionId)).size;

/** Añade posiciones por `positionId`. No modifica `actual`. */
export function fusionarPosiciones(
  actual: HistorialCuenta,
  posiciones: readonly PosicionCerrada[]
): HistorialCuenta {
  const siguientes = { ...actual.posiciones };
  for (const p of posiciones) siguientes[p.positionId] = p;
  return { ...actual, posiciones: siguientes };
}

/**
 * La cobertura después de completar el tramo `nuevo`.
 *
 * Si `nuevo` toca o pisa la anterior, se unen. Si queda un hueco entre las dos
 * —la cuenta pasó más de 90 días sin sincronizar y Bitget ya no entrega lo de
 * en medio—, la cobertura pasa a ser solo `nuevo`: lo anterior sigue guardado,
 * pero ya no se puede afirmar que el tramo entero esté completo.
 */
export function ampliarCobertura(actual: Cobertura | null, nuevo: Cobertura): Cobertura {
  if (actual === null) return nuevo;
  const seTocan = nuevo.desdeMs <= actual.hastaMs && nuevo.hastaMs >= actual.desdeMs;
  if (!seTocan) return nuevo;
  return {
    desdeMs: Math.min(actual.desdeMs, nuevo.desdeMs),
    hastaMs: Math.max(actual.hastaMs, nuevo.hastaMs)
  };
}
