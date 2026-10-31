/**
 * Un `history-position` falso que se comporta como el de verdad.
 *
 * Reproduce lo verificado contra Bitget el 13/10/2026 en V2 y V3 (ver
 * docs/00-historial-fase-1.md §4):
 *
 *   - filtra por **fecha de cierre**, con los dos extremos **inclusivos**;
 *   - devuelve de la más reciente a la más antigua;
 *   - corta en `limite`.
 *
 * Es lo que permite probar el paginador contra el caso que rompió el cursor
 * —dos posiciones cerradas con 1 ms de diferencia justo en la frontera de una
 * página— sin depender de que la cuenta real lo vuelva a tener.
 */
import type { ConsultaPaginaHistorial } from '@main/bitget/rest/endpoints/historial-v3';
import type { PaginaHistorial, PosicionCerrada } from '@main/domain/posicion-cerrada';

export function posicionCerrada(id: string, cerradaEnMs: number, resultado = '0'): PosicionCerrada {
  return {
    positionId: id,
    symbol: 'BTCUSDT',
    lado: 'long',
    modoMargen: 'isolated',
    apalancamiento: null,
    abiertaEnMs: cerradaEnMs - 60_000,
    cerradaEnMs,
    precioEntrada: '1',
    precioSalida: '1',
    cantidadCierre: '1',
    resultado,
    porcentaje: null,
    pnlPrecio: resultado,
    comisiones: '0',
    financiamiento: '0',
    superficie: 'v3'
  };
}

/** `n` posiciones que cierran cada `pasoMs`, la primera en `ultimaMs`. */
export function posicionesSeguidas(
  prefijo: string,
  n: number,
  ultimaMs: number,
  pasoMs = 1_000
): PosicionCerrada[] {
  return Array.from({ length: n }, (_, i) =>
    posicionCerrada(`${prefijo}${i}`, ultimaMs - i * pasoMs)
  );
}

export function historialSimulado(datos: PosicionCerrada[]) {
  const consultas: ConsultaPaginaHistorial[] = [];
  const fuente = (c: ConsultaPaginaHistorial): Promise<PaginaHistorial> => {
    consultas.push(c);
    const posiciones = datos
      .filter((p) => p.cerradaEnMs >= c.desdeMs && p.cerradaEnMs <= c.hastaMs)
      .sort((a, b) => b.cerradaEnMs - a.cerradaEnMs)
      .slice(0, c.limite);
    return Promise.resolve({ posiciones });
  };
  return { fuente, consultas, datos };
}
