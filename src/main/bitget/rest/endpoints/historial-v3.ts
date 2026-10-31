/**
 * Historial de posiciones cerradas en UTA (`/api/v3/position/history-position`).
 *
 * ==========================================================================
 * Estado de verificación: CAPTURADO
 * ==========================================================================
 * Esquema, paginación y ventana verificados contra api.bitget.com el
 * 12/10/2026 con nueve posiciones reales. Fixture en
 * `test/fixtures/historial/v3-history-position.json`, detalle en
 * docs/00-historial-fase-1.md. Lo que importa de lo capturado:
 *
 *   - Sobre `{ list, cursor }`. La lista viene de la más reciente a la más
 *     antigua por `updatedTime` (fecha de cierre).
 *   - `startTime`/`endTime` filtran por fecha de cierre y son inclusivos.
 *   - El `cursor` **no se usa**: en V2 su equivalente pierde posiciones que
 *     cierran casi a la vez (ver `historial/paginador.ts`), y no hay motivo
 *     para fiarse más del de V3. Se pagina por fecha.
 *   - `startTime`–`endTime` no puede pasar de 90 días, y nada anterior a 90
 *     días atrás se puede pedir. Quien llama parte el rango; aquí se pide uno.
 */
import { z } from 'zod';
import {
  decimalOCero,
  ladoDe,
  modoMargenDe,
  msDe,
  sumar,
  type PaginaHistorial,
  type PosicionCerrada
} from '../../../domain/posicion-cerrada';
import type { Mercado } from '../../mercado';
import { categoriaDe } from '../../superficie';
import type { ClienteBitget, RespuestaRest } from '../client';
import { esquemaListaV3 } from '../lista-v3';
import type { Credencial } from '../signer';

export const RUTA_HISTORIAL_V3 = '/api/v3/position/history-position';

export const esquemaPosicionCerradaV3 = z.object({
  positionId: z.string(),
  symbol: z.string(),
  posSide: z.string(),
  marginMode: z.string().nullish(),
  openPriceAvg: z.string(),
  closePriceAvg: z.string(),
  closeTotalPos: z.string(),
  cumRealisedPnl: z.string().nullish(),
  netProfit: z.string(),
  totalFunding: z.string().nullish(),
  openFeeTotal: z.string().nullish(),
  closeFeeTotal: z.string().nullish(),
  createdTime: z.union([z.string(), z.number()]),
  updatedTime: z.union([z.string(), z.number()]),
  /* No vienen en lo capturado; se leen si algún día Bitget los añade. */
  leverage: z.union([z.string(), z.number()]).nullish()
});

export type PosicionCerradaV3 = z.infer<typeof esquemaPosicionCerradaV3>;

export function normalizarV3(p: PosicionCerradaV3): PosicionCerrada {
  return {
    positionId: p.positionId,
    symbol: p.symbol,
    lado: ladoDe(p.posSide),
    modoMargen: modoMargenDe(p.marginMode),
    apalancamiento: p.leverage === null || p.leverage === undefined ? null : String(p.leverage),
    abiertaEnMs: msDe(p.createdTime, 'createdTime'),
    cerradaEnMs: msDe(p.updatedTime, 'updatedTime'),
    precioEntrada: p.openPriceAvg,
    precioSalida: p.closePriceAvg,
    cantidadCierre: p.closeTotalPos,
    resultado: decimalOCero(p.netProfit),
    porcentaje: null,
    pnlPrecio: decimalOCero(p.cumRealisedPnl),
    comisiones: sumar(p.openFeeTotal, p.closeFeeTotal),
    financiamiento: decimalOCero(p.totalFunding),
    superficie: 'v3'
  };
}

/**
 * Una página: las `limite` posiciones cerradas más recientes de `[desdeMs, hastaMs]`.
 *
 * Los dos extremos filtran por **fecha de cierre** y son **inclusivos**,
 * verificado en V2 y V3 el 13/10/2026. El paginador se apoya en las dos cosas.
 */
export interface ConsultaPaginaHistorial {
  desdeMs: number;
  hastaMs: number;
  limite: number;
}

export async function obtenerHistorialPosicionesV3(
  cliente: ClienteBitget,
  credencial: Credencial,
  mercado: Mercado,
  consulta: ConsultaPaginaHistorial
): Promise<RespuestaRest<PaginaHistorial>> {
  const r = await cliente.peticionFirmada(
    credencial,
    {
      metodo: 'GET',
      ruta: RUTA_HISTORIAL_V3,
      consulta: {
        category: categoriaDe(mercado),
        startTime: String(consulta.desdeMs),
        endTime: String(consulta.hastaMs),
        limit: String(consulta.limite)
      },
      idempotente: true
    },
    esquemaListaV3(esquemaPosicionCerradaV3)
  );

  return {
    datos: { posiciones: r.datos.lista.map(normalizarV3) },
    duracionMs: r.duracionMs,
    codigo: r.codigo
  };
}
