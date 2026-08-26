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
import { trazaApertura } from '../../../debug-apertura';

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
  const cuerpo = {
    symbol: tp.simbolo,
    productType: tp.mercado.productType,
    marginCoin: tp.mercado.marginCoin,
    planType: 'pos_profit',
    triggerPrice: tp.precioDisparo,
    /* Por ultimo precio, como en la pantalla del operador. */
    triggerType: 'fill_price',
    holdSide: tp.lado,
    clientOid: tp.clientOid
  };

  /* DEPURACIÓN TEMPORAL · ver src/main/debug-apertura.ts */
  trazaApertura('3·cuerpo-take-profit', cuerpo);

  return cliente.peticionFirmada(
    credencial,
    {
      metodo: 'POST',
      ruta: '/api/v2/mix/order/place-tpsl-order',
      cuerpo,
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
 * aparece aqui, entro.
 *
 * --------------------------------------------------------------------------
 * El lado viene en `posSide`, no en `holdSide` (capturado el 25/08/2026)
 * --------------------------------------------------------------------------
 * Hasta esa fecha nunca se habia podido capturar una respuesta **con
 * contenido**: la cuenta de pruebas no podia abrir posiciones, asi que no habia
 * planes que listar y el esquema se escribio a partir de la documentacion. Ahi
 * el campo se llamaba `holdSide`, que es como se llama al **enviar**. Al
 * listar, Bitget lo devuelve como `posSide` y no incluye `holdSide` en
 * absoluto.
 *
 * La consecuencia era silenciosa y grave: `buscarTakeProfit` filtraba por un
 * campo que siempre venia vacio, no encontraba nunca nada, y el panel concluia
 * «esta posicion no tiene Take Profit puesto» **teniendolo**. Se mantiene
 * `holdSide` en el esquema por si alguna respuesta lo trae; el que se lee es
 * `posSide`.
 */
export const esquemaPlanPendiente = zod.object({
  orderId: zod.string().nullish(),
  clientOid: zod.string().nullish(),
  symbol: zod.string().nullish(),
  planType: zod.string().nullish(),
  triggerPrice: zod.string().nullish(),
  /** El lado, tal como lo devuelve el listado. */
  posSide: zod.string().nullish(),
  /** Como se llama el mismo dato al enviar. No aparece al listar. */
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
  /**
   * El tipo del plan que se quita, tal como lo devolvio Bitget al listarlo
   * -`pos_profit` para el Take Profit de posicion entera-.
   *
   * Va aqui y no fijo en el cuerpo porque enviar el tipo equivocado **no
   * falla**: responde exito y no cancela nada. Ver `cancelarPlan`.
   */
  planType: string;
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
 *
 * --------------------------------------------------------------------------
 * `planType` es el del plan, no la familia (comprobado el 25/08/2026)
 * --------------------------------------------------------------------------
 * `orders-plan-pending` se **consulta** con `planType: 'profit_loss'`, que es
 * la familia entera -Take Profit y Stop Loss-. Cancelar con ese mismo valor
 * parece lo coherente y es la trampa: Bitget responde
 *
 *   code 00000 · success · successList: [] · failureList: []
 *
 * y no cancela nada. Ni error, ni aviso, ni el plan en la lista de fallos:
 * exito con las dos listas vacias. Con `planType: 'pos_profit'` -el tipo que el
 * propio listado devuelve para ese plan- el plan aparece en `successList` y
 * desaparece de los pendientes.
 *
 * Probado contra la API con las cuatro variantes -`profit_loss` con y sin
 * `clientOid`, sin `marginCoin`, y `pos_profit`-: solo la ultima quita el Take
 * Profit. De ahi que el tipo viaje en `CancelacionPlan` en lugar de estar
 * escrito aqui: lo que se cancela es lo que Bitget dijo que hay puesto.
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
        planType: cancelacion.planType,
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
 *
 * El lado se lee de `posSide`, que es el nombre que trae el listado, con
 * `holdSide` como alternativa por si alguna respuesta lo devuelve asi. Ver el
 * comentario de `esquemaPlanPendiente`.
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
        (p.posSide ?? p.holdSide) === lado &&
        (p.planType ?? '').includes('profit') &&
        !(p.planType ?? '').includes('loss')
    ) ?? null
  );
}
