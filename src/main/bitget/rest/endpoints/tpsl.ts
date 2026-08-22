/**
 * Take Profit de posicion (`/api/v2/mix/order/place-tpsl-order`).
 *
 * --------------------------------------------------------------------------
 * Lo que se verifico contra la API real el 13/08/2026
 * --------------------------------------------------------------------------
 * - Exige `triggerPrice`. **No acepta un porcentaje**: enviando `triggerPercent`
 *   sigue respondiendo «The trigger price cannot be empty». El calculo del
 *   precio lo hace el panel. Ver `domain/precio-take-profit.ts`.
 * - `planType: 'pos_profit'` cierra la **posicion entera** y no lleva cantidad,
 *   que es lo que el operador usa («Posición completa · Todas cerrables»). Con
 *   `profit_plan` Bitget pide ademas un `size`: es el Take Profit parcial, que
 *   no esta en el alcance.
 * - Acepta `clientOid`, asi que un reenvio accidental no deja dos Take Profit
 *   sobre la misma posicion.
 *
 * Lo unico que **no** se pudo verificar es el valor de `triggerType`: Bitget
 * comprueba que exista la posicion antes que ese parametro, y la cuenta de
 * pruebas no puede abrir ninguna. Se envia `fill_price` -disparo por ultimo
 * precio- porque es lo que muestra la pantalla del operador; queda como punto
 * de comprobacion de la prueba fisica.
 */
import type { z } from 'zod';
import { z as zod } from 'zod';
import type { Lado } from '@shared/types';
import type { Mercado } from '../../mercado';
import type { ClienteBitget, RespuestaRest } from '../client';
import type { Credencial } from '../signer';

export interface ColocacionTakeProfit {
  mercado: Mercado;
  simbolo: string;
  lado: Lado;
  /** Precio de disparo, ya calculado y ajustado al paso del simbolo. */
  precioDisparo: string;
  clientOid: string;
}

export const esquemaPlanColocado = zod.object({
  orderId: zod.string().nullish(),
  clientOid: zod.string().nullish()
});

export type PlanColocado = z.infer<typeof esquemaPlanColocado>;

export function colocarTakeProfit(
  cliente: ClienteBitget,
  credencial: Credencial,
  tp: ColocacionTakeProfit
): Promise<RespuestaRest<PlanColocado>> {
  return cliente.peticionFirmada(
    credencial,
    {
      metodo: 'POST',
      ruta: '/api/v2/mix/order/place-tpsl-order',
      cuerpo: {
        symbol: tp.simbolo,
        productType: tp.mercado.productType,
        marginCoin: tp.mercado.marginCoin,
        planType: 'pos_profit',
        triggerPrice: tp.precioDisparo,
        /* Por ultimo precio, como en la pantalla del operador. */
        triggerType: 'fill_price',
        holdSide: tp.lado,
        clientOid: tp.clientOid
      },
      idempotente: false
    },
    esquemaPlanColocado
  );
}

/* ---------- /api/v2/mix/order/orders-plan-pending ---------- */

/**
 * Take Profit y Stop Loss que hay puestos ahora mismo.
 *
 * Es la verdad de fondo cuando un envio se queda sin respuesta: si el plan
 * aparece aqui, entro. Los campos van casi todos opcionales porque no se ha
 * podido capturar una respuesta con contenido -la cuenta de pruebas no puede
 * abrir posiciones-, y ante la duda es mejor que la validacion no invente nada.
 */
export const esquemaPlanPendiente = zod.object({
  orderId: zod.string().nullish(),
  clientOid: zod.string().nullish(),
  symbol: zod.string().nullish(),
  planType: zod.string().nullish(),
  triggerPrice: zod.string().nullish(),
  holdSide: zod.string().nullish(),
  status: zod.string().nullish()
});

export type PlanPendiente = z.infer<typeof esquemaPlanPendiente>;

export const esquemaPlanesPendientes = zod.object({
  entrustedList: zod.array(esquemaPlanPendiente).nullish()
});

export async function planesPendientes(
  cliente: ClienteBitget,
  credencial: Credencial,
  mercado: Mercado
): Promise<PlanPendiente[]> {
  const r = await cliente.peticionFirmada(
    credencial,
    {
      metodo: 'GET',
      ruta: '/api/v2/mix/order/orders-plan-pending',
      consulta: { productType: mercado.productType, planType: 'profit_loss' },
      idempotente: true
    },
    esquemaPlanesPendientes
  );
  return r.datos.entrustedList ?? [];
}

/* ---------- /api/v2/mix/order/cancel-plan-order ---------- */

export interface CancelacionPlan {
  mercado: Mercado;
  simbolo: string;
  /** Identificador que dio Bitget al plan. Sale de `planesPendientes`. */
  orderId: string;
}

/**
 * Resultado de la cancelacion. Mismas dos listas que el cierre relampago.
 *
 * Verificado el 18/08/2026: cancelar un plan que no existe responde
 * `00000 success` con las **dos listas vacias**. Es decir, el codigo de exito
 * no significa que se haya quitado nada, y hay que mirar el contenido.
 */
export const esquemaCancelacionPlan = zod.object({
  successList: zod
    .array(zod.object({ orderId: zod.string().nullish(), clientOid: zod.string().nullish() }))
    .nullish(),
  failureList: zod
    .array(
      zod.object({
        orderId: zod.string().nullish(),
        clientOid: zod.string().nullish(),
        errorMsg: zod.string().nullish(),
        errorCode: zod.string().nullish()
      })
    )
    .nullish()
});

export type ResultadoCancelacionPlan = z.infer<typeof esquemaCancelacionPlan>;

/**
 * Quita un Take Profit puesto.
 *
 * --------------------------------------------------------------------------
 * `orderIdList` no es opcional aqui, aunque Bitget lo acepte sin el
 * --------------------------------------------------------------------------
 * Verificado el 18/08/2026: si se omite `orderIdList`, Bitget acepta la
 * peticion igual y **cancela todos** los planes de ese simbolo. Un descuido que
 * dejara la lista vacia no fallaria: quitaria los Take Profit de posiciones que
 * el operador no habia seleccionado, y lo haria devolviendo `success`.
 *
 * De ahi que este parametro sea obligatorio en la firma y siempre lleve
 * exactamente un elemento: el modo «cancelar todo» no se puede alcanzar desde
 * el panel ni por accidente.
 *
 * Se cancela por `orderId` -el que dio Bitget- y no por `clientOid`, porque el
 * plan a quitar puede haberlo puesto el operador desde la app de Bitget y
 * entonces no tiene ningun identificador nuestro.
 */
export function cancelarPlan(
  cliente: ClienteBitget,
  credencial: Credencial,
  cancelacion: CancelacionPlan
): Promise<RespuestaRest<ResultadoCancelacionPlan>> {
  return cliente.peticionFirmada(
    credencial,
    {
      metodo: 'POST',
      ruta: '/api/v2/mix/order/cancel-plan-order',
      cuerpo: {
        symbol: cancelacion.simbolo,
        productType: cancelacion.mercado.productType,
        marginCoin: cancelacion.mercado.marginCoin,
        planType: 'profit_loss',
        orderIdList: [{ orderId: cancelacion.orderId }]
      },
      idempotente: false
    },
    esquemaCancelacionPlan
  );
}

/**
 * El Take Profit puesto sobre una posicion concreta, o `null` si no hay.
 *
 * Bitget devuelve en la misma lista los Take Profit y los Stop Loss de todos
 * los simbolos de la cuenta, asi que hay que filtrar por tres cosas. La tercera
 * es la que importa: **un Stop Loss no se puede confundir con un Take Profit**,
 * porque quitar el Stop Loss creyendo que se quita el Take Profit dejaria la
 * posicion sin su unica proteccion.
 *
 * El filtro es por `planType` que contenga `profit` -`pos_profit` para la
 * posicion entera, `profit_plan` para el parcial- y nunca `loss`.
 */
export function buscarTakeProfit(
  planes: readonly PlanPendiente[],
  simbolo: string,
  lado: Lado
): PlanPendiente | null {
  return (
    planes.find(
      (p) =>
        p.symbol === simbolo &&
        p.holdSide === lado &&
        (p.planType ?? '').includes('profit') &&
        !(p.planType ?? '').includes('loss')
    ) ?? null
  );
}
