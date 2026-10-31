/**
 * Historial de posiciones cerradas en Classic (`/api/v2/mix/position/history-position`).
 *
 * También es el **despachador**: `obtenerHistorialPosiciones` mira la
 * superficie de la credencial y manda las cuentas UTA a `historial-v3.ts`, igual
 * que `obtenerPosiciones` en `posiciones.ts`. Quien llama no decide nada.
 *
 * ==========================================================================
 * Estado de verificación: CAPTURADO
 * ==========================================================================
 * Verificado el 13/10/2026 con la clave de la cuenta madre (29 posiciones
 * reales). Los nombres coinciden con la documentación:
 *
 *   sobre        `{ list, endId }`. `endId` NO se usa: ver más abajo
 *   lado         `holdSide`
 *   precios      `openAvgPrice` / `closeAvgPrice`
 *   resultado    `pnl` (precio) y `netProfit` (neto)
 *   comisiones   `openFee` / `closeFee`, financiamiento `totalFunding`
 *   fechas       `ctime` / `utime`
 *
 * Por el mismo criterio que `posiciones.ts`, se exige solo lo imprescindible y
 * se admiten los nombres de V3 como alternativa: si Bitget nombra un campo de
 * otro modo, la validación falla con el nombre del campo en vez de enseñar un
 * resultado inventado. Se confirma con `npm run test:red` desde una IP
 * autorizada.
 */
import { z } from 'zod';
import {
  decimalOCero,
  ErrorHistorial,
  ladoDe,
  modoMargenDe,
  msDe,
  sumar,
  type PaginaHistorial,
  type PosicionCerrada
} from '../../../domain/posicion-cerrada';
import type { Mercado } from '../../mercado';
import type { ClienteBitget, RespuestaRest } from '../client';
import { superficieDe, type Credencial } from '../signer';
import { obtenerHistorialPosicionesV3, type ConsultaPaginaHistorial } from './historial-v3';

export const RUTA_HISTORIAL_V2 = '/api/v2/mix/position/history-position';

const numero = z.union([z.string(), z.number()]).nullish();

export const esquemaPosicionCerradaV2 = z.object({
  positionId: z.string(),
  symbol: z.string(),
  holdSide: z.string().nullish(),
  posSide: z.string().nullish(),
  marginMode: z.string().nullish(),
  openAvgPrice: z.string().nullish(),
  openPriceAvg: z.string().nullish(),
  closeAvgPrice: z.string().nullish(),
  closePriceAvg: z.string().nullish(),
  closeTotalPos: z.string(),
  pnl: z.string().nullish(),
  netProfit: z.string(),
  totalFunding: z.string().nullish(),
  openFee: z.string().nullish(),
  closeFee: z.string().nullish(),
  ctime: numero,
  utime: numero,
  createdTime: numero,
  updatedTime: numero,
  leverage: numero
});

export type PosicionCerradaV2 = z.infer<typeof esquemaPosicionCerradaV2>;

export const esquemaPaginaV2 = z.object({
  list: z.array(esquemaPosicionCerradaV2).nullish(),
  endId: z.string().nullish()
});

function exigir(v: string | null | undefined, campo: string): string {
  if (v === null || v === undefined || v === '') {
    throw new ErrorHistorial(
      'respuesta-invalida',
      `Bitget no devolvió «${campo}» en el historial.`
    );
  }
  return v;
}

export function normalizarV2(p: PosicionCerradaV2): PosicionCerrada {
  return {
    positionId: p.positionId,
    symbol: p.symbol,
    lado: ladoDe(exigir(p.holdSide ?? p.posSide, 'holdSide')),
    modoMargen: modoMargenDe(p.marginMode),
    apalancamiento: p.leverage === null || p.leverage === undefined ? null : String(p.leverage),
    abiertaEnMs: msDe(p.ctime ?? p.createdTime, 'ctime'),
    cerradaEnMs: msDe(p.utime ?? p.updatedTime, 'utime'),
    precioEntrada: exigir(p.openAvgPrice ?? p.openPriceAvg, 'openAvgPrice'),
    precioSalida: exigir(p.closeAvgPrice ?? p.closePriceAvg, 'closeAvgPrice'),
    cantidadCierre: p.closeTotalPos,
    resultado: decimalOCero(p.netProfit),
    porcentaje: null,
    pnlPrecio: decimalOCero(p.pnl),
    comisiones: sumar(p.openFee, p.closeFee),
    financiamiento: decimalOCero(p.totalFunding),
    superficie: 'v2'
  };
}

/**
 * Una página del historial de una cuenta, de la superficie que le toque.
 *
 * ==========================================================================
 * Por qué no se pagina con `idLessThan = endId`
 * ==========================================================================
 * Capturado el 13/10/2026 sobre la cuenta madre: paginando de dos en dos con
 * `idLessThan`, de 29 posiciones llegaron 28. La que faltaba había cerrado 1 ms
 * antes que la última de la página anterior. `endId` es un id interno cuyo
 * orden no coincide con el de la lista —que va por fecha de cierre—, y la
 * frontera entre páginas se come lo que cierra casi a la vez. En una suma de
 * resultados eso es un periodo mal calculado sin ningún aviso. El paginador
 * avanza por fecha de cierre; ver `historial/paginador.ts`.
 */
export async function obtenerHistorialPosiciones(
  cliente: ClienteBitget,
  credencial: Credencial,
  mercado: Mercado,
  consulta: ConsultaPaginaHistorial
): Promise<RespuestaRest<PaginaHistorial>> {
  if (superficieDe(credencial) === 'v3') {
    return obtenerHistorialPosicionesV3(cliente, credencial, mercado, consulta);
  }

  const r = await cliente.peticionFirmada(
    credencial,
    {
      metodo: 'GET',
      ruta: RUTA_HISTORIAL_V2,
      consulta: {
        productType: mercado.productType,
        startTime: String(consulta.desdeMs),
        endTime: String(consulta.hastaMs),
        limit: String(consulta.limite)
      },
      idempotente: true
    },
    esquemaPaginaV2
  );

  return {
    datos: { posiciones: (r.datos.list ?? []).map(normalizarV2) },
    duracionMs: r.duracionMs,
    codigo: r.codigo
  };
}
