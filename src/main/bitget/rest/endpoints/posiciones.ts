/**
 * Posiciones abiertas (`/api/v2/mix/position/all-position`).
 *
 * Es lo que hace posible confirmar un cierre antes de enviarlo: sin esto, el
 * panel solo podria decir «voy a cerrar 34 casillas» sin saber cuantas tienen
 * de verdad algo abierto. Con esto puede decir «34 posiciones, esta cantidad
 * en cada una, y estas 6 casillas ya estaban cerradas».
 *
 * --------------------------------------------------------------------------
 * Estado de verificacion de este esquema
 * --------------------------------------------------------------------------
 * El endpoint y su sobre **si** estan verificados contra api.bitget.com el 12
 * de agosto de 2026: responde `[]` cuando no hay posiciones. Los **campos** de
 * una posicion abierta no se han podido capturar todavia, porque la cuenta de
 * pruebas no puede abrir ninguna (ver docs/00-fase-4-apertura.md seccion 4).
 *
 * Por eso todo lo que no es imprescindible se declara opcional: si Bitget
 * nombra un campo de otro modo, el panel no se rompe en silencio ni inventa un
 * numero — falla la validacion con el nombre del campo, que es lo que hay que
 * corregir. Los tres campos exigidos son los que identifican la posicion y sin
 * los cuales no se puede cerrar nada.
 */
import type { z } from 'zod';
import { z as zod } from 'zod';
import type { Lado } from '@shared/types';
import type { Mercado } from '../../mercado';
import type { ClienteBitget, RespuestaRest } from '../client';
import type { Credencial } from '../signer';

export const esquemaPosicion = zod.object({
  symbol: zod.string(),
  /** `long` | `short`. En modo cobertura las dos conviven. docs/adr/0006. */
  holdSide: zod.string(),
  /** Tamano total de la posicion, en moneda base. */
  total: zod.string(),
  /** Parte disponible para cerrar; el resto esta comprometido en ordenes. */
  available: zod.string().nullish(),
  marginCoin: zod.string().nullish(),
  marginMode: zod.string().nullish(),
  openPriceAvg: zod.string().nullish(),
  liquidationPrice: zod.string().nullish(),
  leverage: zod.union([zod.string(), zod.number()]).nullish(),
  marginSize: zod.string().nullish(),
  unrealizedPL: zod.string().nullish()
});

export type PosicionBitget = z.infer<typeof esquemaPosicion>;

export const esquemaPosiciones = zod.array(esquemaPosicion);

/**
 * Todas las posiciones abiertas de una cuenta en un mercado.
 *
 * Una sola peticion devuelve los dos lados, asi que cerrar long y short de la
 * misma subcuenta no cuesta dos consultas.
 */
export function obtenerPosiciones(
  cliente: ClienteBitget,
  credencial: Credencial,
  mercado: Mercado
): Promise<RespuestaRest<PosicionBitget[]>> {
  return cliente.peticionFirmada(
    credencial,
    {
      metodo: 'GET',
      ruta: '/api/v2/mix/position/all-position',
      consulta: { productType: mercado.productType, marginCoin: mercado.marginCoin },
      idempotente: true
    },
    esquemaPosiciones
  );
}

/** La posicion de un simbolo y lado concretos, o `null` si no hay ninguna. */
export function buscarPosicion(
  posiciones: readonly PosicionBitget[],
  simbolo: string,
  lado: Lado
): PosicionBitget | null {
  const encontrada = posiciones.find(
    (p) => p.symbol === simbolo && p.holdSide.toLowerCase() === lado && Number(p.total) > 0
  );
  return encontrada ?? null;
}
