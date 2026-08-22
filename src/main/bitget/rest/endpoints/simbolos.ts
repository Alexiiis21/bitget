/**
 * Catalogo de contratos (`/api/v2/mix/market/contracts`).
 *
 * Es el endpoint que hace posible abrir una posicion sin adivinar. Bitget no
 * acepta cualquier cantidad ni cualquier precio: cada simbolo tiene su paso
 * minimo, su numero de decimales y su nocional minimo, y una orden que no los
 * respeta se rechaza con un codigo generico que no dice cual de los tres fallo.
 * Consultarlo **antes** de enviar convierte ese rechazo en un mensaje concreto
 * para el operador, y ahorra 100 peticiones rechazadas en un lote de 100.
 *
 * El esquema no se dedujo de la documentacion: se capturo de la respuesta real
 * de api.bitget.com el 12 de agosto de 2026, para BTCUSDT (mercado real) y
 * SBTCSUSDT (mercado simulado). Solo se declaran los campos que el panel
 * consume; Zod ignora el resto, asi que Bitget puede anadir campos sin romper
 * nada.
 */
import type { z } from 'zod';
import { z as zod } from 'zod';
import type { Mercado } from '../../mercado';
import type { ClienteBitget, RespuestaRest } from '../client';

export const esquemaContrato = zod.object({
  symbol: zod.string(),
  baseCoin: zod.string(),
  quoteCoin: zod.string(),
  /** Cantidad minima por orden, en moneda base. P. ej. `0.0001` BTC. */
  minTradeNum: zod.string(),
  /** Decimales admitidos en la cantidad. `4` -> 0.0001 es el paso. */
  volumePlace: zod.string(),
  /** Decimales admitidos en el precio. */
  pricePlace: zod.string(),
  /**
   * Paso del precio, en unidades del ultimo decimal.
   *
   * El paso real es `priceEndStep / 10^pricePlace`: con `pricePlace` 1 y
   * `priceEndStep` 1, los precios van de 0,1 en 0,1. Hace falta para colocar un
   * Take Profit en un precio que Bitget acepte.
   */
  priceEndStep: zod.string(),
  /** La cantidad debe ser multiplo de este valor. */
  sizeMultiplier: zod.string(),
  /** Nocional minimo en USDT. Rechaza ordenes «de prueba» demasiado pequenas. */
  minTradeUSDT: zod.string(),
  minLever: zod.string(),
  maxLever: zod.string(),
  /** Cantidad maxima en una sola orden de mercado. */
  maxMarketOrderQty: zod.string(),
  maxOrderQty: zod.string(),
  /** `normal` | `maintain` | `limit_open` | `restrictedAPI` | `off`. */
  symbolStatus: zod.string()
});

export type Contrato = z.infer<typeof esquemaContrato>;

export const esquemaContratos = zod.array(esquemaContrato);

/**
 * Catalogo completo de un mercado.
 *
 * Es publico: no consume el cupo de ninguna cuenta. Se pide una vez y se
 * cachea, porque estos valores cambian de higos a brevas y pedirlos en cada
 * lote gastaria cupo que necesitan las ordenes.
 */
export function obtenerContratos(
  cliente: ClienteBitget,
  mercado: Mercado
): Promise<RespuestaRest<Contrato[]>> {
  return cliente.peticionPublica(
    {
      metodo: 'GET',
      ruta: '/api/v2/mix/market/contracts',
      consulta: { productType: mercado.productType },
      idempotente: true
    },
    esquemaContratos
  );
}

/* ---------- /api/v2/mix/market/ticker ---------- */

export const esquemaTicker = zod.array(
  zod.object({
    symbol: zod.string(),
    /** Ultimo precio negociado. */
    lastPr: zod.string(),
    /**
     * Precio de marca: el que Bitget usa para liquidar.
     *
     * Es el que se usa para dimensionar una apertura, no `lastPr`: el ultimo
     * negociado puede venir de una operacion suelta fuera de mercado, y con
     * apalancamiento esa diferencia se multiplica.
     */
    markPrice: zod.string()
  })
);

export type Ticker = z.infer<typeof esquemaTicker>;

export function obtenerTicker(
  cliente: ClienteBitget,
  mercado: Mercado,
  simbolo: string
): Promise<RespuestaRest<Ticker>> {
  return cliente.peticionPublica(
    {
      metodo: 'GET',
      ruta: '/api/v2/mix/market/ticker',
      consulta: { symbol: simbolo, productType: mercado.productType },
      idempotente: true
    },
    esquemaTicker
  );
}
