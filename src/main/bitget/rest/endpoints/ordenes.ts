/**
 * Colocacion y consulta de ordenes.
 *
 * --------------------------------------------------------------------------
 * El `clientOid` es la pieza que impide duplicar una posicion
 * --------------------------------------------------------------------------
 * Toda orden viaja con un identificador que genera el panel, no Bitget. Sirve
 * para dos cosas, y la segunda es la que protege el dinero:
 *
 *  1. Bitget rechaza un `clientOid` repetido, asi que dos envios accidentales
 *     de la misma orden no abren dos posiciones.
 *  2. Cuando la conexion se corta **despues** de enviar, no se sabe si la orden
 *     entro. Reintentar a ciegas puede duplicarla; descartarla puede dejar una
 *     posicion abierta que nadie vigila. La salida es preguntar por el
 *     `clientOid`: si Bitget la conoce, entro; si no, no entro. Por eso
 *     `consultarOrden` existe y por eso `place-order` se marca como **no
 *     idempotente**. docs/03 seccion 10.
 *
 * --------------------------------------------------------------------------
 * Modo cobertura: `side` y `tradeSide` no son lo mismo
 * --------------------------------------------------------------------------
 * En modo cobertura -el que usa el operador, ADR 0006- hacen falta los dos
 * campos, y confundirlos cierra una posicion en vez de abrirla:
 *
 *   abrir long    side `buy`   + tradeSide `open`
 *   abrir short   side `sell`  + tradeSide `open`
 *   cerrar long   side `sell`  + tradeSide `close`
 *   cerrar short  side `buy`   + tradeSide `close`
 *
 * Este modulo solo construye aperturas. El cierre es otra funcion de la Fase 4
 * y tendra su propio endpoint, para que ninguna de las dos pueda producir la
 * otra por un parametro mal puesto.
 */
import type { z } from 'zod';
import { z as zod } from 'zod';
import type { Lado } from '@shared/types';
import type { Mercado } from '../../mercado';
import type { ClienteBitget, RespuestaRest } from '../client';
import type { Credencial } from '../signer';

/** `crossed` reparte el margen de toda la cuenta; `isolated` lo acota a la posicion. */
export type ModoMargenApi = 'crossed' | 'isolated';

export interface AperturaOrden {
  mercado: Mercado;
  simbolo: string;
  lado: Lado;
  modoMargen: ModoMargenApi;
  /** Cantidad en moneda base, ya ajustada al paso del simbolo. */
  size: string;
  /** Precio limite, o `null` para orden a mercado. */
  precioLimite: string | null;
  /** Identificador propio. Es la garantia de no duplicar. */
  clientOid: string;
}

export const esquemaOrdenColocada = zod.object({
  orderId: zod.string(),
  clientOid: zod.string()
});

export type OrdenColocada = z.infer<typeof esquemaOrdenColocada>;

/**
 * Envia una apertura.
 *
 * `idempotente: false` no es un detalle: le dice al cliente REST que, si la
 * conexion se corta con la peticion en vuelo, el resultado es **indeterminado**
 * y no se puede reintentar solo. Ver `bitget/errors.ts`.
 */
export function abrirPosicion(
  cliente: ClienteBitget,
  credencial: Credencial,
  orden: AperturaOrden
): Promise<RespuestaRest<OrdenColocada>> {
  const cuerpo: Record<string, string> = {
    symbol: orden.simbolo,
    productType: orden.mercado.productType,
    marginCoin: orden.mercado.marginCoin,
    marginMode: orden.modoMargen,
    size: orden.size,
    side: orden.lado === 'long' ? 'buy' : 'sell',
    tradeSide: 'open',
    orderType: orden.precioLimite === null ? 'market' : 'limit',
    clientOid: orden.clientOid
  };

  if (orden.precioLimite !== null) {
    cuerpo['price'] = orden.precioLimite;
    cuerpo['force'] = 'gtc';
  }

  console.log('[DEBUG APERTURA] Enviando orden de apertura:', JSON.stringify(cuerpo, null, 2));

  return cliente.peticionFirmada(
    credencial,
    { metodo: 'POST', ruta: '/api/v2/mix/order/place-order', cuerpo, idempotente: false },
    esquemaOrdenColocada
  ).then(res => {
    console.log('[DEBUG APERTURA] Orden colocada con éxito:', res);
    return res;
  }).catch(err => {
    console.error('[DEBUG APERTURA] Fallo al colocar orden:', err);
    throw err;
  });
}

/* ---------- /api/v2/mix/order/close-positions ---------- */

export interface CierrePosicion {
  mercado: Mercado;
  simbolo: string;
  lado: Lado;
  clientOid: string;
}

/**
 * Respuesta del cierre relampago.
 *
 * Bitget devuelve dos listas: lo que acepto y lo que rechazo. Que exista
 * `failureList` es la razon de que este endpoint no se pueda dar por bueno solo
 * porque la peticion devuelva codigo de exito.
 */
export const esquemaCierre = zod.object({
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

export type ResultadoCierre = z.infer<typeof esquemaCierre>;

/**
 * Cierra a mercado toda la posicion de un simbolo y un lado.
 *
 * --------------------------------------------------------------------------
 * Por que el cierre relampago y no una orden con cantidad
 * --------------------------------------------------------------------------
 * Se podria cerrar con `place-order` indicando `tradeSide: close` y la cantidad
 * exacta. Se descarto a proposito: entre que el panel lee la posicion y que la
 * orden sale pueden pasar segundos, y en ese hueco la posicion puede haber
 * cambiado de tamano -un Take Profit que se ejecuta a medias, un
 * reposicionamiento del operador-. Una cantidad fija cerraria de menos y
 * dejaria un resto abierto **sin que nadie lo note**, que es exactamente el
 * fallo que no se puede permitir en una funcion llamada «cerrar».
 *
 * `close-positions` le dice a Bitget «cierra lo que haya». El tamano lo resuelve
 * el exchange en el momento, no el panel con un dato de hace un rato.
 *
 * Lleva `clientOid` -verificado el 12/08/2026: el endpoint lo acepta-, asi que
 * un reenvio accidental no puede convertirse en dos cierres.
 */
export function cerrarPosicion(
  cliente: ClienteBitget,
  credencial: Credencial,
  cierre: CierrePosicion
): Promise<RespuestaRest<ResultadoCierre>> {
  return cliente.peticionFirmada(
    credencial,
    {
      metodo: 'POST',
      ruta: '/api/v2/mix/order/close-positions',
      cuerpo: {
        symbol: cierre.simbolo,
        productType: cierre.mercado.productType,
        holdSide: cierre.lado,
        clientOid: cierre.clientOid
      },
      idempotente: false
    },
    esquemaCierre
  );
}

/* ---------- /api/v2/mix/order/detail ---------- */

export const esquemaDetalleOrden = zod.object({
  orderId: zod.string(),
  clientOid: zod.string(),
  symbol: zod.string(),
  size: zod.string(),
  /** `live` | `partially_filled` | `filled` | `canceled`. */
  state: zod.string(),
  /** Cantidad ya ejecutada. */
  baseVolume: zod.string().nullish(),
  priceAvg: zod.string().nullish()
});

export type DetalleOrden = z.infer<typeof esquemaDetalleOrden>;

/**
 * Pregunta por una orden usando el identificador que puso el panel.
 *
 * Es la unica forma correcta de resolver una orden indeterminada: se consulta,
 * no se reintenta. Devuelve `null` cuando Bitget no la conoce, que es la
 * respuesta que confirma que la orden **no** entro.
 */
export async function consultarOrden(
  cliente: ClienteBitget,
  credencial: Credencial,
  mercado: Mercado,
  simbolo: string,
  clientOid: string
): Promise<DetalleOrden | null> {
  try {
    const r = await cliente.peticionFirmada(
      credencial,
      {
        metodo: 'GET',
        ruta: '/api/v2/mix/order/detail',
        consulta: { symbol: simbolo, productType: mercado.productType, clientOid },
        idempotente: true
      },
      esquemaDetalleOrden
    );
    return r.datos;
  } catch (e) {
    /*
     * Bitget responde 40109 -«la orden no existe»- cuando el clientOid nunca
     * llego. Es una respuesta valida a la pregunta, no un fallo: significa que
     * la orden no entro y que se puede volver a enviar sin duplicar nada.
     */
    if (e instanceof Error && 'codigo' in e && (e as { codigo: string | null }).codigo === '40109') {
      return null;
    }
    throw e;
  }
}
