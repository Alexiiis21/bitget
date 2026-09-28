/**
 * Formato de cifras del panel.
 *
 * Convención europea -punto para miles, coma para decimales- porque es la
 * que muestra la hoja de cálculo del cliente. Los decimales de precio se
 * ajustan al activo seleccionado: PEPE necesita fracciones de centavo, PAXG
 * se lee mejor con dos decimales fijos. Nunca se opera con `number` más allá
 * de esta capa de presentación — el dato que entra es siempre `Decimal`
 * (cadena), tal como lo define `shared/types.ts`.
 */
import type { Decimal } from '@shared/types';

const LOCALE = 'de-DE';

const aNumero = (v: Decimal | number | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/** Precio o cantidad con los decimales propios del activo. */
export function cifra(v: Decimal | number | null | undefined, decimales = 2): string {
  const n = aNumero(v);
  if (n === null) return '—';
  return n.toLocaleString(LOCALE, { minimumFractionDigits: decimales, maximumFractionDigits: decimales });
}

/** Igual que `cifra`, con signo explícito. Se usa en la distancia L/S y en el P&L. */
export function cifraConSigno(v: Decimal | number | null | undefined, decimales = 2): string {
  const n = aNumero(v);
  if (n === null) return '—';
  return (n > 0 ? '+' : '') + cifra(n, decimales);
}

/**
 * Decimales que trae la cadena tal como la manda el exchange: `"0.0000043575"`
 * → 10. Un número no trae ninguno que se pueda leer, y cae en 2.
 */
export function decimalesDe(v: Decimal | number | null | undefined): number {
  if (typeof v !== 'string') return 2;
  const punto = v.indexOf('.');
  return punto < 0 ? 0 : Math.min(v.length - punto - 1, 12);
}

/**
 * Un precio con los decimales del activo.
 *
 * `cifra` a secas redondea a dos, y con PEPE -diez decimales- eso convertía
 * entrada, liquidación y Take Profit en «0,00». Sin `decimales` -un activo que
 * no está en el selector y del que no se conoce `pricePlace`- se respetan los
 * que trae la cadena del exchange, que ya viene a la precisión del contrato.
 */
export function precio(v: Decimal | number | null | undefined, decimales?: number): string {
  return cifra(v, decimales ?? decimalesDe(v));
}

/** Igual que `precio`, con signo explícito. Se usa en la distancia L/S. */
export function precioConSigno(v: Decimal | number | null | undefined, decimales?: number): string {
  return cifraConSigno(v, decimales ?? decimalesDe(v));
}

/**
 * Un importe en USDT: dos decimales, y hasta cuatro por debajo de 1.
 *
 * Se usa en el margen. El P&L no pasa por aquí: sigue con `cifraConSigno`, que
 * es como lo validó el cliente.
 */
export function importe(v: Decimal | number | null | undefined): string {
  const n = aNumero(v);
  if (n === null) return '—';
  const max = Math.abs(n) >= 1 ? 2 : 4;
  return n.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: max });
}

/** Un porcentaje con signo explícito, para el ROE: «+35,00 %» / «−12,40 %». */
export function porcentajeConSigno(v: number | null | undefined, decimales = 2): string {
  const n = aNumero(v);
  if (n === null) return '—';
  return `${cifraConSigno(n, decimales)} %`;
}

/** «1 casilla» / «34 casillas». Evita el «1 casillas» que delata una plantilla. */
export function casillas(n: number): string {
  return `${n} ${n === 1 ? 'casilla' : 'casillas'}`;
}

/** Diferencia entre dos decimales como número, para restas antes de formatear. */
export function restar(a: Decimal | null, b: Decimal | null): number | null {
  const na = aNumero(a);
  const nb = aNumero(b);
  if (na === null || nb === null) return null;
  return na - nb;
}
