/**
 * El ROE de una posicion viva: retorno sobre el margen inicial, en porcentaje.
 *
 * ==========================================================================
 * Por que lo calcula el panel
 * ==========================================================================
 * Bitget **no manda este numero**. A diferencia del P&L -que viaja como
 * `unrealizedPL` en `all-position`, en `current-position` y en los dos canales
 * de socket-, no hay ningun campo `roe` en ninguna superficie. La columna del
 * Centro de Monitoreo es aritmetica de este proceso, y por eso vive aqui y no
 * en `ipc/sesion.ts`: es dominio, se prueba sin electron y sin red, igual que su
 * vecino `precio-take-profit.ts`.
 *
 * ==========================================================================
 * Sobre el margen INICIAL, no sobre el de ahora
 * ==========================================================================
 * Hasta el 10/09/2026 el divisor era `marginSize` —el margen que la posicion
 * tiene en este momento— y por eso el panel no coincidia con Bitget en cuanto se
 * agregaba margen a una punta. La medicion que lo fija es una captura del propio
 * cliente, ya escrita en `precio-take-profit.ts` seccion «Sobre que margen se
 * calcula el ROE»: una posicion con 1.008,71 USDT de margen tras un aporte
 * adicional seguia enseñando en la app el ROE sobre 8,71. Con el divisor viejo
 * el panel enseñaba ahi un ROE 115 veces menor que Bitget.
 *
 * Ademas el panel se contradecia consigo mismo: `precioTakeProfit` situa el
 * disparo del «Take Profit al 35 %» usando el margen inicial, asi que la columna
 * ROE no llegaba nunca al 35 con el que se habia aprobado esa misma posicion.
 *
 * ==========================================================================
 * Por que se deriva y no se lee del aporte del panel
 * ==========================================================================
 * `AporteDelPanel.margenInicial` es el margen que el operador aprobo, y sale
 * `null` en toda posicion abierta antes de este arranque —que son la mayoria de
 * las que el cliente mira—. El ROE tiene que poder leerse en cualquier posicion
 * viva, asi que se reconstruye de tres campos que el exchange manda siempre:
 *
 *   margen inicial = tamano x precio de entrada / apalancamiento
 *
 * Eso arregla de paso las cuentas UTA. `marginSize` no esta documentado en V3
 * -ver la cabecera de `bitget/rest/endpoints/posiciones-v3.ts`- y cuando no
 * llega, el margen salia cadena vacia y el ROE era `null` **siempre**: un guion
 * permanente en la columna. Los tres factores de arriba si los manda V3.
 */
import Decimal from 'decimal.js';
import type { Decimal as Cantidad } from '@shared/types';

/**
 * Cantidad valida, o `null` si eso no es un numero.
 *
 * El mismo ayudante que `precio-take-profit.ts`, y por la misma razon:
 * `new Decimal('.')` lanza. Aqui el argumento viene de una respuesta del
 * exchange y se lee dentro de `posicionesMonitor`, que proyecta la lista entera
 * de una tacada, asi que una excepcion no dejaria una fila mal calculada
 * -dejaria el Centro de Monitoreo entero en blanco-.
 */
function cantidad(v: string | null | undefined): Decimal | null {
  if (v == null || v.trim() === '') return null;
  try {
    const d = new Decimal(v);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/**
 * Margen con el que se abrio la punta: `tamano x entrada / apalancamiento`.
 *
 * `null` si algun factor falta o no es un numero, y tambien si el resultado no
 * sirve de divisor. Se devuelve `Decimal` y no cadena porque su unico consumidor
 * es la division de abajo: convertirlo a texto para volver a leerlo solo añadiria
 * una ocasion de perder precision.
 */
export function margenInicialDe(
  tamano: Cantidad,
  precioEntrada: Cantidad,
  apalancamiento: number
): Decimal | null {
  if (!Number.isFinite(apalancamiento) || apalancamiento <= 0) return null;

  const unidades = cantidad(tamano);
  const precio = cantidad(precioEntrada);
  if (unidades === null || precio === null) return null;

  const margen = unidades.times(precio).dividedBy(apalancamiento);
  return margen.lessThanOrEqualTo(0) ? null : margen;
}

/**
 * Retorno sobre el margen inicial, en porcentaje. Ver `PosicionMonitor.roe`.
 *
 * `null` sin P&L conocido -cadena vacia: Bitget no lo mando en esta lectura- o
 * cuando no se puede formar el divisor. Nunca un cero: «no se sabe» y «no gana
 * nada» son cosas distintas, y la pantalla enseña un guion para la primera.
 */
export function roeDe(
  pnl: Cantidad,
  tamano: Cantidad,
  precioEntrada: Cantidad,
  apalancamiento: number
): number | null {
  const ganancia = cantidad(pnl);
  if (ganancia === null) return null;

  const margenInicial = margenInicialDe(tamano, precioEntrada, apalancamiento);
  if (margenInicial === null) return null;

  return ganancia.dividedBy(margenInicial).times(100).toNumber();
}
