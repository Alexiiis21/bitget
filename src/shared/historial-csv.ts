/**
 * Filtros del historial y su exportación a CSV.
 *
 * Puro, y en `shared` por lo mismo que `resultado-periodo.ts`: lo usan el
 * proceso principal —que filtra la consulta y escribe el archivo— y el servicio
 * de demostración del renderer. Una sola regla para la tabla, el resumen y el
 * archivo: lo que se exporta es exactamente lo que se ve.
 *
 * ==========================================================================
 * El formato, pensado para Excel en México
 * ==========================================================================
 *   - Separador coma y punto decimal: es la configuración regional de es-MX.
 *     Los importes salen tal como los da Bitget, sin redondear ni separador de
 *     miles, para que Excel los lea como números.
 *   - UTF-8 con BOM: sin él, Excel abre «Operación» como «OperaciÃ³n».
 *   - Fechas `AAAA-MM-DD hh:mm:ss` en la hora del equipo, que Excel reconoce
 *     como fecha y ordena bien.
 *   - Fin de línea CRLF, el de Windows.
 *
 * Una celda de texto que empieza por `=`, `+`, `-` o `@` se precede de un
 * apóstrofo: Excel la ejecutaría como fórmula. Solo afecta a textos —nombres de
 * cuenta y de par—; los importes negativos no pasan por ahí.
 */

export interface FiltroHistorial {
  /** Par exacto (`BTCUSDT`), o `null` para todos. */
  simbolo: string | null;
  lado: 'long' | 'short' | null;
  resultado: 'todas' | 'ganadoras' | 'perdedoras';
}

export const SIN_FILTRO: FiltroHistorial = { simbolo: null, lado: null, resultado: 'todas' };

export const hayFiltro = (f: FiltroHistorial): boolean =>
  f.simbolo !== null || f.lado !== null || f.resultado !== 'todas';

/** Si una operación pasa el filtro. `resultado` es el neto de Bitget, con signo. */
export function cumpleFiltro(
  f: FiltroHistorial,
  o: { symbol: string; lado: 'long' | 'short'; resultado: string }
): boolean {
  if (f.simbolo !== null && o.symbol !== f.simbolo) return false;
  if (f.lado !== null && o.lado !== f.lado) return false;
  const n = Number.parseFloat(o.resultado);
  if (f.resultado === 'ganadoras' && !(n > 0)) return false;
  if (f.resultado === 'perdedoras' && !(n < 0)) return false;
  return true;
}

/** Lo que necesita cada fila del archivo. Es la forma de `PosicionCerradaIpc`. */
export interface FilaCsv {
  positionId: string;
  symbol: string;
  lado: 'long' | 'short';
  modoMargen: 'isolated' | 'crossed' | null;
  apalancamiento: string | null;
  abiertaEnMs: number;
  cerradaEnMs: number;
  precioEntrada: string;
  precioSalida: string;
  cantidadCierre: string;
  resultado: string;
  porcentaje: string | null;
  pnlPrecio: string;
  comisiones: string;
  financiamiento: string;
  takeProfit: { precio: string; colocadoEnMs: number; disparadoEnMs: number | null } | null;
}

/**
 * Zona de la Ciudad de México. Las fechas del TP se dan en UTC —la de Bitget—
 * y en CDMX, sea cual sea la zona del equipo, para cruzarlas con la web.
 */
export const ZONA_CDMX = 'America/Mexico_City';

/** Marca de orden de bytes de UTF-8: es lo que hace que Excel lea bien los acentos. */
const BOM = String.fromCharCode(0xfeff);

/**
 * Identificador interno de una subcuenta: `PCB-1-A-1` es el panel 1, la cuenta
 * madre A y la casilla 1.
 *
 * Existe para que una captura de pantalla o un archivo exportado digan sin
 * ambigüedad de qué subcuenta son, aunque se reenvíen sueltos. El nombre de la
 * subcuenta no basta: dos paneles pueden tener una «Sub-01» en su cuenta A.
 */
export const identificadorCuenta = (panel: number, cuenta: string, casilla: number): string =>
  `PCB-${panel}-${cuenta}-${casilla}`;

const CABECERA = [
  'Identificador',
  'Cuenta',
  'Subcuenta',
  'Par',
  'Lado',
  'Apalancamiento',
  'Modo de margen',
  'Apertura',
  'Precio de entrada promedio',
  'Precio de salida promedio',
  'Take Profit',
  'TP colocado (UTC)',
  'TP colocado (CDMX)',
  'TP disparado (UTC)',
  'TP disparado (CDMX)',
  'Cantidad de cierre',
  'Resultado USDT',
  'Porcentaje',
  'Cierre',
  'Resultado por precio',
  'Comisiones',
  'Financiamiento',
  'ID de posición'
];

/** Una celda de texto, entrecomillada si hace falta y desactivada como fórmula. */
function texto(v: string): string {
  const seguro = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(seguro) ? `"${seguro.replace(/"/g, '""')}"` : seguro;
}

/** Un importe tal como lo dio Bitget. Vacío si no se sabe. */
const numero = (v: string | null): string => (v === null ? '' : v);

export function fechaCsv(ms: number, zona: string): string {
  /* `sv-SE` da justo `AAAA-MM-DD hh:mm:ss`. */
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: zona,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).format(new Date(ms));
}

const fechaOVacio = (ms: number | null | undefined, zona: string): string =>
  ms === null || ms === undefined ? '' : fechaCsv(ms, zona);

export function construirCsv(
  filas: readonly FilaCsv[],
  contexto: { identificador: string; cuenta: string; subcuenta: string; zona: string }
): string {
  const lineas = [CABECERA.join(',')];
  for (const f of filas) {
    lineas.push(
      [
        texto(contexto.identificador),
        texto(contexto.cuenta),
        texto(contexto.subcuenta),
        texto(f.symbol),
        f.lado === 'long' ? 'Long' : 'Short',
        numero(f.apalancamiento),
        f.modoMargen === 'isolated' ? 'Aislado' : f.modoMargen === 'crossed' ? 'Cruzado' : '',
        fechaCsv(f.abiertaEnMs, contexto.zona),
        numero(f.precioEntrada),
        numero(f.precioSalida),
        numero(f.takeProfit?.precio ?? null),
        fechaOVacio(f.takeProfit?.colocadoEnMs, 'UTC'),
        fechaOVacio(f.takeProfit?.colocadoEnMs, ZONA_CDMX),
        fechaOVacio(f.takeProfit?.disparadoEnMs, 'UTC'),
        fechaOVacio(f.takeProfit?.disparadoEnMs, ZONA_CDMX),
        numero(f.cantidadCierre),
        numero(f.resultado),
        numero(f.porcentaje),
        fechaCsv(f.cerradaEnMs, contexto.zona),
        numero(f.pnlPrecio),
        numero(f.comisiones),
        numero(f.financiamiento),
        texto(f.positionId)
      ].join(',')
    );
  }
  return `${BOM}${lineas.join('\r\n')}\r\n`;
}

/**
 * `historial_PCB-1-A-1_2026-08-01_a_2026-08-07.csv`, sin caracteres que Windows
 * rechace. Lleva el identificador y no el nombre de la subcuenta: es lo que la
 * distingue entre paneles.
 */
export function nombreArchivoCsv(
  identificador: string,
  desde: string | null,
  hasta: string | null
): string {
  const limpio =
    [...identificador]
      .map((c) => (c.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(c) ? '_' : c))
      .join('')
      .trim() || 'subcuenta';
  const periodo = desde !== null && hasta !== null ? `_${desde}_a_${hasta}` : '_completo';
  return `historial_${limpio}${periodo}.csv`;
}
