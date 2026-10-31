/**
 * Reintento de una **lectura** ante un fallo transitorio.
 *
 * Solo para lecturas: pedir dos veces lo mismo no cambia nada en Bitget. Las
 * operaciones que mueven dinero no pasan por aquí; las resuelve el motor de
 * lotes consultando, nunca repitiendo.
 *
 * Se reintenta lo `retryable` (429, 5xx) y lo `indeterminada` (sin respuesta),
 * con la espera del motor —300 ms, 900 ms, 2,7 s— o la que pida Bitget. Lo demás
 * —credencial rechazada, IP no autorizada— se propaga a la primera: repetirlo
 * solo gastaría cupo para recibir el mismo rechazo.
 */
import { ErrorBitget } from '../bitget/errors';
import { HISTORIAL_REINTENTOS } from '@shared/constants';

const esperaReintento = (intento: number): number => 300 * 3 ** (intento - 1);

const esTransitorio = (e: unknown): e is ErrorBitget =>
  e instanceof ErrorBitget && (e.clase === 'retryable' || e.clase === 'indeterminada');

export const dormirReal = (ms: number): Promise<void> =>
  new Promise<void>((r) => {
    setTimeout(r, ms);
  });

export async function leerConReintentos<T>(
  tarea: () => Promise<T>,
  opciones: { dormir?: (ms: number) => Promise<void>; reintentos?: number } = {}
): Promise<T> {
  const dormir = opciones.dormir ?? dormirReal;
  const reintentos = opciones.reintentos ?? HISTORIAL_REINTENTOS;

  for (let intento = 0; ; intento++) {
    try {
      return await tarea();
    } catch (e) {
      if (!esTransitorio(e) || intento >= reintentos) throw e;
      await dormir(e.reintentarEnMs ?? esperaReintento(intento + 1));
    }
  }
}
