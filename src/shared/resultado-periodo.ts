/**
 * El resultado de un periodo: qué posiciones caen dentro y cuánto suman.
 *
 * Puro: sin disco, sin red y sin reloj propio. Vive en `shared` porque lo usan
 * el proceso principal y el servicio simulado del renderer: una sola regla. La zona horaria y la hora se
 * reciben, así que los bordes de día se prueban sin depender del equipo.
 *
 * ==========================================================================
 * Qué es «del 1 al 7 de agosto»
 * ==========================================================================
 * Desde las 00:00 del día 1 hasta las 00:00 del día 8, **en la zona horaria del
 * equipo**: los dos días cuentan completos. El rango es semiabierto
 * `[inicio, fin)`, y una posición que cierra exactamente a las 00:00 del día 8
 * ya es del día 8.
 *
 * La posición entra por su **fecha de cierre**. Es la misma fecha por la que
 * Bitget filtra (verificado el 13/10/2026) y la que el operador ve en la última
 * columna: una operación abierta el 31 de julio y cerrada el 2 de agosto es del
 * periodo de agosto.
 *
 * ==========================================================================
 * La suma
 * ==========================================================================
 * Se suma `resultado` —el `netProfit` de Bitget, con comisiones y
 * financiamiento ya incluidos— con `Decimal`, nunca con `number`: mil
 * operaciones de céntimos sumadas en coma flotante no dan lo que da Bitget.
 * Sale sin redondear; redondear es cosa de la pantalla.
 *
 * Una operación con resultado exactamente cero no es ni ganadora ni perdedora:
 * se cuenta aparte (`enCero`), para que ganadoras + perdedoras + enCero sea
 * siempre el total y nadie tenga que adivinar dónde fue a parar la que falta.
 *
 * No hay porcentaje del periodo: el presupuesto lo excluye, porque los
 * porcentajes de cada operación no se pueden promediar.
 */
import Decimal from 'decimal.js';

/** `YYYY-MM-DD`, tal como llega de un selector de fecha. */
export type FechaDia = string;

export interface Periodo {
  desde: FechaDia;
  hasta: FechaDia;
}

export interface RangoMs {
  /** Inclusivo. */
  inicioMs: number;
  /** Exclusivo. */
  finMs: number;
}

export interface ResumenPeriodo {
  total: number;
  ganadoras: number;
  perdedoras: number;
  enCero: number;
  /** Suma exacta de `resultado`, con signo. */
  resultadoNeto: string;
}

export class ErrorPeriodo extends Error {
  readonly motivo: 'fecha-invalida' | 'orden-invertido';

  constructor(motivo: ErrorPeriodo['motivo'], mensaje: string) {
    super(mensaje);
    this.name = 'ErrorPeriodo';
    this.motivo = motivo;
  }
}

const FORMATO_DIA = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Año, mes y día de una fecha, comprobando que existe en el calendario. */
function partesDe(fecha: FechaDia): [number, number, number] {
  const m = FORMATO_DIA.exec(fecha);
  if (m === null) throw new ErrorPeriodo('fecha-invalida', `Fecha no válida: «${fecha}».`);
  const [a, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(a, mes - 1, dia));
  if (d.getUTCFullYear() !== a || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) {
    throw new ErrorPeriodo('fecha-invalida', `Fecha no válida: «${fecha}».`);
  }
  return [a, mes, dia];
}

/** Cuántos ms va la zona por delante de UTC en el instante `ms`. */
function desfaseZona(ms: number, zona: string): number {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: zona,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(new Date(ms));
  const v = (tipo: string): number => Number(partes.find((p) => p.type === tipo)?.value);
  const comoUtc = Date.UTC(
    v('year'),
    v('month') - 1,
    v('day'),
    v('hour'),
    v('minute'),
    v('second')
  );
  return comoUtc - (ms - (ms % 1000));
}

/**
 * Las 00:00 de un día en una zona, en ms UTC.
 *
 * Se corrige dos veces con el desfase porque el desfase de la zona puede
 * cambiar justo ese día (horario de verano). México lo abolió en 2022, pero el
 * panel no debe depender de dónde esté el equipo.
 */
function medianoche(a: number, mes: number, dia: number, zona: string): number {
  const ingenua = Date.UTC(a, mes - 1, dia);
  let ms = ingenua - desfaseZona(ingenua, zona);
  ms = ingenua - desfaseZona(ms, zona);
  return ms;
}

/** `[00:00 de desde, 00:00 del día siguiente a hasta)` en la zona dada. */
export function rangoDePeriodo(periodo: Periodo, zona: string): RangoMs {
  const [a1, m1, d1] = partesDe(periodo.desde);
  const [a2, m2, d2] = partesDe(periodo.hasta);
  if (periodo.desde > periodo.hasta) {
    throw new ErrorPeriodo('orden-invertido', 'La fecha inicial es posterior a la final.');
  }
  const siguiente = new Date(Date.UTC(a2, m2 - 1, d2 + 1));
  return {
    inicioMs: medianoche(a1, m1, d1, zona),
    finMs: medianoche(
      siguiente.getUTCFullYear(),
      siguiente.getUTCMonth() + 1,
      siguiente.getUTCDate(),
      zona
    )
  };
}

/** Las que cerraron dentro del rango, de la más reciente a la más antigua. */
export function filtrarPorCierre<T extends { cerradaEnMs: number }>(
  posiciones: readonly T[],
  rango: RangoMs | null
): T[] {
  return posiciones
    .filter(
      (p) => rango === null || (p.cerradaEnMs >= rango.inicioMs && p.cerradaEnMs < rango.finMs)
    )
    .sort((a, b) => b.cerradaEnMs - a.cerradaEnMs);
}

export function resumir(posiciones: readonly { resultado: string }[]): ResumenPeriodo {
  let ganadoras = 0;
  let perdedoras = 0;
  let enCero = 0;
  let neto = new Decimal(0);

  for (const p of posiciones) {
    const r = new Decimal(p.resultado);
    neto = neto.plus(r);
    if (r.isZero()) enCero++;
    else if (r.isPositive()) ganadoras++;
    else perdedoras++;
  }

  return {
    total: posiciones.length,
    ganadoras,
    perdedoras,
    enCero,
    resultadoNeto: neto.toString()
  };
}

/**
 * Si lo guardado alcanza para dar el periodo por completo.
 *
 * `faltaAntes`: el periodo empieza antes de lo sincronizado. Si eso queda a más
 * de 90 días, no se puede recuperar: Bitget ya no lo entrega.
 *
 * `faltaDespues`: el periodo sigue después de la última sincronización —por
 * ejemplo, si incluye hoy—. Se arregla sincronizando.
 *
 * El final se recorta a `ahoraMs`: nadie puede tener las operaciones de
 * mañana, y un periodo que acaba el domingo que viene está completo si lo está
 * hasta ahora.
 */
export function completitud(
  rango: RangoMs | null,
  cobertura: { desdeMs: number; hastaMs: number } | null,
  ahoraMs: number
): { completo: boolean; faltaAntes: boolean; faltaDespues: boolean } {
  if (cobertura === null) return { completo: false, faltaAntes: true, faltaDespues: true };
  if (rango === null) {
    /* Sin periodo, «todo»: lo anterior a la cobertura nunca se sabe completo. */
    return { completo: false, faltaAntes: true, faltaDespues: cobertura.hastaMs < ahoraMs };
  }
  const finEfectivo = Math.min(rango.finMs, ahoraMs);
  const faltaAntes = rango.inicioMs < cobertura.desdeMs && rango.inicioMs < finEfectivo;
  const faltaDespues = finEfectivo > cobertura.hastaMs;
  return { completo: !faltaAntes && !faltaDespues, faltaAntes, faltaDespues };
}
