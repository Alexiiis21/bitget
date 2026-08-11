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
