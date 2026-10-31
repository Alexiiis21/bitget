/**
 * Posiciones abiertas en la API V3 (`/api/v3/position/current-position`).
 *
 * ==========================================================================
 * Normaliza a la forma de V2, no a la del dominio
 * ==========================================================================
 * Devuelve `PosicionBitget` —la forma que ya tenia la respuesta de V2— y no
 * directamente la `Posicion` del dominio. La diferencia importa: `PosicionBitget`
 * es lo que consumen **tres** sitios distintos, cada uno para lo suyo:
 *
 *   `buscarPosicion`             resolver un cierre indeterminado
 *   `MotorLotes.margenYaAplicado` comprobar si el margen se aplico
 *   `aPosicionDominio`            pintar el Centro de Monitoreo
 *
 * Traduciendo aqui a la forma de V2, los tres funcionan sobre cuentas UTA **sin
 * tocar ni una linea**, y la conversion a dominio sigue existiendo una sola vez.
 * Normalizar directamente a `Posicion` habria obligado a duplicar los otros dos
 * caminos.
 *
 * ==========================================================================
 * Estado de verificacion: NO capturado
 * ==========================================================================
 * Los nombres de campo salen de la documentacion de Bitget al 7 de septiembre de
 * 2026. Se confirman con `node scripts/sondear-v3.mjs --env UTA`.
 *
 * Dos campos se llaman distinto que en V2, capturados el 01/10/2026:
 *
 *   `marginSize`     en V3 es `positionBalance`. Lo lee `margenYaAplicado`, que
 *                    es la red que impide aplicar dos veces un aporte de margen.
 *   `unrealizedPL`   en V3 es `unrealisedPnl`. Sin el no hay ROE en el monitor.
 *
 * Si no llega ninguno, el campo sale ausente y quien lo lea vera «no se sabe»,
 * no un cero.
 */
import type { z } from 'zod';
import { z as zod } from 'zod';
import type { Mercado } from '../../mercado';
import { categoriaDe } from '../../superficie';
import type { ClienteBitget, RespuestaRest } from '../client';
import { esquemaListaV3 } from '../lista-v3';
import type { Credencial } from '../signer';
import type { PosicionBitget } from './posiciones';

export const esquemaPosicionV3 = zod.object({
  symbol: zod.string(),
  /** `long` | `short`. En V2 se llama `holdSide` al listar. */
  posSide: zod.string(),
  /** Tamano total de la posicion, en moneda base. */
  total: zod.string(),
  available: zod.string().nullish(),
  marginMode: zod.string().nullish(),
  /** El `openPriceAvg` de V2. Es el unico renombre que la doc confirma. */
  avgPrice: zod.string().nullish(),
  liquidationPrice: zod.string().nullish(),
  markPrice: zod.string().nullish(),
  leverage: zod.union([zod.string(), zod.number()]).nullish(),
  /*
   * Capturado el 01/10/2026 sobre una posicion real: el margen viene en
   * `positionBalance` y el PnL en `unrealisedPnl`, con «s». Ninguno de los
   * nombres que se suponian llegaba, y el monitor enseñaba guiones en margen,
   * P&L y ROE de toda posicion UTA. Se conservan los supuestos por si otra
   * respuesta los trae.
   */
  positionBalance: zod.string().nullish(),
  unrealisedPnl: zod.string().nullish(),
  marginSize: zod.string().nullish(),
  margin: zod.string().nullish(),
  unrealizedPL: zod.string().nullish(),
  unrealizedPnl: zod.string().nullish(),
  updatedTime: zod.union([zod.string(), zod.number()]).nullish()
});

export type PosicionV3 = z.infer<typeof esquemaPosicionV3>;

/**
 * V3 devuelve la lista dentro de un sobre con cursor, no como array suelto.
 *
 * El panel **no pagina**: opera ocho activos sobre cada subcuenta y la primera
 * pagina los cubre de sobra. Se admiten las dos formas porque ninguna esta
 * capturada; ver `rest/lista-v3.ts`, donde tambien esta escrito por que
 * `idLessThan` no aparece en este repositorio.
 */
export const esquemaPosicionesV3 = esquemaListaV3(esquemaPosicionV3);

/**
 * Una posicion de V3 con la forma que tenia en V2.
 *
 * Los campos ausentes se dejan **ausentes**, no en cero ni en cadena vacia: cada
 * consumidor ya sabe qué hacer con un `null` —la pantalla enseña un guion, el
 * motor lo trata como «no se sabe»— y rellenarlos aqui les quitaria esa
 * distincion.
 */
export function posicionV3AFormatoV2(cruda: PosicionV3): PosicionBitget {
  return {
    symbol: cruda.symbol,
    holdSide: cruda.posSide,
    total: cruda.total,
    available: cruda.available,
    /* UTA resuelve la moneda de margen sola: no viaja en la respuesta. */
    marginCoin: null,
    marginMode: cruda.marginMode,
    openPriceAvg: cruda.avgPrice,
    markPrice: cruda.markPrice,
    liquidationPrice: cruda.liquidationPrice,
    leverage: cruda.leverage,
    marginSize: cruda.positionBalance ?? cruda.marginSize ?? cruda.margin,
    unrealizedPL: cruda.unrealisedPnl ?? cruda.unrealizedPL ?? cruda.unrealizedPnl
  };
}

/**
 * Todas las posiciones abiertas de una cuenta UTA, en la forma de V2.
 *
 * Limite publicado: 20/s por UID, holgado frente al bucket de 8/s del panel, de
 * modo que no necesita techo propio en el limitador.
 */
export async function obtenerPosicionesV3(
  cliente: ClienteBitget,
  credencial: Credencial,
  mercado: Mercado
): Promise<RespuestaRest<PosicionBitget[]>> {
  const r = await cliente.peticionFirmada(
    credencial,
    {
      metodo: 'GET',
      ruta: '/api/v3/position/current-position',
      consulta: { category: categoriaDe(mercado) },
      idempotente: true
    },
    esquemaPosicionesV3
  );

  return {
    datos: r.datos.lista.map(posicionV3AFormatoV2),
    duracionMs: r.duracionMs,
    codigo: r.codigo
  };
}
