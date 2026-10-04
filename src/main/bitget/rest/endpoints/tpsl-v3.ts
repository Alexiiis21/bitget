/**
 * Take Profit de posicion en la API V3 (UTA): ordenes de estrategia `tpsl`.
 *
 * Gemelo de `tpsl.ts`. Devuelve las mismas formas que aquel para que el motor de
 * lotes no distinga la superficie.
 *
 * ==========================================================================
 * De donde sale
 * ==========================================================================
 * Documentacion de Bitget, seccion «Strategy Trading», leida el 01/10/2026:
 *
 *   POST /api/v3/trade/place-strategy-order     type=tpsl, tpslMode=full
 *   GET  /api/v3/trade/unfilled-strategy-orders type=tpsl
 *   POST /api/v3/trade/cancel-strategy-order    orderId
 *
 * Cierra el hueco 2.2 de `docs/00-uta-fase-1-equivalencias.md`: en V3 si hay
 * forma de poner un Take Profit sobre una posicion **ya abierta**, solo que no
 * esta junto a las ordenes sino en las de estrategia.
 *
 * Estado, capturado el 01/10/2026 contra una subcuenta UTA:
 *   - `unfilled-strategy-orders` responde `data` como array pelado, con
 *     `status: pending`, `takeProfit`, `posSide`, `qty`. Lo cubre `esquemaListaV3`.
 *   - `place-strategy-order` tpsl: siempre `31008`. Ver `colocarTakeProfitV3`.
 */
import { z as zod } from 'zod';
import type { Mercado } from '../../mercado';
import { categoriaDe, posSideDe } from '../../superficie';
import { anotarEvento, cuentaDe } from '../../../diagnostico/bitacora';
import { ErrorBitget } from '../../errors';
import type { ClienteBitget, RespuestaRest } from '../client';
import { esquemaListaV3 } from '../lista-v3';
import type { Credencial } from '../signer';
import type {
  CancelacionPlan,
  ColocacionTakeProfit,
  PlanColocado,
  PlanPendiente,
  ResultadoCancelacionPlan
} from './tpsl';

const esquemaColocadoV3 = zod.object({
  orderId: zod.string().nullish(),
  clientOid: zod.string().nullish()
});

/**
 * Pone un Take Profit sobre la posicion entera.
 *
 * Lo mismo que `pos_profit` en V2, con los nombres de V3:
 *
 *   V2 planType: pos_profit        V3 type: tpsl + tpslMode: full
 *   V2 triggerPrice                V3 takeProfit
 *   V2 triggerType: fill_price     V3 tpTriggerBy: market (ultimo precio)
 *   V2 holdSide                    V3 posSide
 *
 * `tpOrderType: market` cierra a mercado al dispararse, como en V2. Acepta
 * `clientOid`, asi que un reenvio no deja dos Take Profit del mismo plan.
 *
 * --------------------------------------------------------------------------
 * Bitget rechaza este endpoint sobre posiciones UTA: `31008`
 * --------------------------------------------------------------------------
 * Capturado el 01/10/2026 contra una subcuenta UTA en cobertura, con un short
 * abierto y visible en `current-position`: `31008 · There is no position in
 * this position` a **todas** las variantes -full; partial con qty; side buy y
 * sell; con y sin tpTriggerBy, market y mark; reduceOnly yes-. No es un
 * retraso: la posicion llevaba segundos abierta y aceptaba `set-margin`.
 *
 * Por eso la apertura UTA lleva el Take Profit dentro de `place-order` (ver
 * `abrirPosicionV3`) y aqui un `31008` se traduce a lo que el operador puede
 * hacer, en vez de reintentarlo.
 */
export async function colocarTakeProfitV3(
  cliente: ClienteBitget,
  credencial: Credencial,
  tp: ColocacionTakeProfit
): Promise<RespuestaRest<PlanColocado>> {
  try {
    return await enviarTakeProfitV3(cliente, credencial, tp);
  } catch (e) {
    if (!(e instanceof ErrorBitget) || e.codigo !== RECHAZO_TP_SEPARADO) throw e;
    throw new ErrorBitget(
      'En cuentas UTA Bitget no permite poner Take Profit a una posición ya abierta: ' +
        'solo se puede poner al abrirla, con el porcentaje de Take Profit del panel.',
      {
        clase: 'fatal-cuenta',
        codigo: e.codigo,
        mensajeOriginal: e.mensajeOriginal,
        httpStatus: e.httpStatus,
        reintentarEnMs: null
      }
    );
  }
}

/** `31008 · There is no position in this position`. Ver `colocarTakeProfitV3`. */
const RECHAZO_TP_SEPARADO = '31008';

function enviarTakeProfitV3(
  cliente: ClienteBitget,
  credencial: Credencial,
  tp: ColocacionTakeProfit
): Promise<RespuestaRest<PlanColocado>> {
  return cliente.peticionFirmada(
    credencial,
    {
      metodo: 'POST',
      ruta: '/api/v3/trade/place-strategy-order',
      cuerpo: {
        category: categoriaDe(tp.mercado),
        symbol: tp.simbolo,
        type: 'tpsl',
        tpslMode: 'full',
        ...posSideDe(tp.lado, credencial.holdMode ?? null),
        takeProfit: tp.precioDisparo,
        tpTriggerBy: 'market',
        tpOrderType: 'market',
        clientOid: tp.clientOid
      },
      idempotente: false
    },
    esquemaColocadoV3
  );
}

const esquemaEstrategiaV3 = zod.object({
  orderId: zod.string().nullish(),
  clientOid: zod.string().nullish(),
  symbol: zod.string().nullish(),
  posSide: zod.string().nullish(),
  status: zod.string().nullish(),
  takeProfit: zod.string().nullish(),
  stopLoss: zod.string().nullish()
});

const esquemaEstrategiasV3 = esquemaListaV3(esquemaEstrategiaV3);

/** Estados en los que la orden de estrategia sigue viva. */
const VIVOS = new Set(['pending', 'submitting']);

const conValor = (v: string | null | undefined): boolean => v != null && v !== '' && Number(v) !== 0;

/**
 * Take Profit y Stop Loss puestos ahora, con la forma del listado de V2.
 *
 * --------------------------------------------------------------------------
 * `planType` se deduce, y una orden con los dos no cuenta como Take Profit
 * --------------------------------------------------------------------------
 * V3 no trae `planType`: una sola orden `tpsl` puede llevar Take Profit, Stop
 * Loss o los dos. Se traduce a los tipos de V2 para que `buscarTakeProfit`
 * siga funcionando igual:
 *
 *   solo takeProfit      pos_profit       -> es un Take Profit
 *   solo stopLoss        pos_loss         -> no lo es
 *   los dos              pos_profit_loss  -> NO se trata como Take Profit
 *
 * El tercero es deliberado: cancelar esa orden para cambiar el Take Profit
 * se llevaria tambien el Stop Loss, que puede ser la unica proteccion de la
 * posicion. `buscarTakeProfit` descarta todo lo que contiene `loss`.
 *
 * --------------------------------------------------------------------------
 * Un fallo de lectura devuelve lista vacia, igual que antes
 * --------------------------------------------------------------------------
 * El barrido llama aqui cada 45 s por cuenta y su fallo marca la cuenta como
 * caida (ver el comentario de `planesPendientes`). Hasta hoy V3 devolvia
 * siempre `[]`; si este endpoint fallara, se vuelve a ese mismo
 * comportamiento y se anota en la bitacora, en vez de tumbar el monitor de
 * toda subcuenta UTA. Los fallos transitorios si se propagan, para que quien
 * resuelve un envio indeterminado no concluya nada con una lectura caida.
 */
export async function planesPendientesV3(
  cliente: ClienteBitget,
  credencial: Credencial,
  mercado: Mercado
): Promise<PlanPendiente[]> {
  let r;
  try {
    r = await cliente.peticionFirmada(
      credencial,
      {
        metodo: 'GET',
        ruta: '/api/v3/trade/unfilled-strategy-orders',
        consulta: { category: categoriaDe(mercado), type: 'tpsl' },
        idempotente: true
      },
      esquemaEstrategiasV3
    );
  } catch (e) {
    if (e instanceof ErrorBitget && e.reintentable) throw e;
    anotarEvento({
      evento: 'tpsl-v3-ilegible',
      datos: {
        cuenta: cuentaDe(credencial.apiKey),
        mensaje: e instanceof Error ? e.message.slice(0, 200) : String(e)
      }
    });
    return [];
  }

  return r.datos.lista
    .filter((o) => o.status == null || VIVOS.has(o.status))
    .map((o) => {
      const tp = conValor(o.takeProfit);
      const sl = conValor(o.stopLoss);
      return {
        orderId: o.orderId,
        clientOid: o.clientOid,
        symbol: o.symbol,
        planType: tp && sl ? 'pos_profit_loss' : tp ? 'pos_profit' : 'pos_loss',
        triggerPrice: tp ? o.takeProfit : o.stopLoss,
        posSide: o.posSide,
        holdSide: null,
        status: o.status
      };
    });
}

/**
 * Quita una orden de estrategia por su `orderId`.
 *
 * V3 responde `data: null`, sin las listas de exito y fallo de V2. Se devuelve
 * la forma de V2 con el plan en `successList`: si Bitget no lo hubiera podido
 * cancelar, la peticion habria fallado con su codigo y no llegaria aqui. Quien
 * resuelve un envio indeterminado no se fia de esto y relee los pendientes.
 */
export async function cancelarPlanV3(
  cliente: ClienteBitget,
  credencial: Credencial,
  cancelacion: CancelacionPlan
): Promise<RespuestaRest<ResultadoCancelacionPlan>> {
  const r = await cliente.peticionFirmada(
    credencial,
    {
      metodo: 'POST',
      ruta: '/api/v3/trade/cancel-strategy-order',
      cuerpo: { orderId: cancelacion.orderId },
      idempotente: false
    },
    zod.unknown()
  );

  return {
    datos: { successList: [{ orderId: cancelacion.orderId, clientOid: null }], failureList: [] },
    duracionMs: r.duracionMs,
    codigo: r.codigo
  };
}
