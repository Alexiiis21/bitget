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
import { superficieDe, type Credencial } from '../signer';
import { abrirPosicionV3, cerrarPosicionV3, consultarOrdenV3 } from './ordenes-v3';

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
  /**
   * Precio de disparo del Take Profit que viaja **dentro** de la orden.
   *
   * Solo lo usa V3: en UTA es la unica forma de ponerle Take Profit a una
   * posicion (ver `abrirPosicionV3`). V2 lo ignora y coloca el suyo despues de
   * abrir, desde el precio de entrada real.
   */
  takeProfit?: string | null;
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
  /*
   * El despachador de superficie.
   *
   * Va aqui, dentro de la funcion de endpoint, y no en el motor de lotes: la
   * superficie es una propiedad de la API Key —ver `signer.ts`— asi que las
   * cinco maniobras pueden seguir llamando exactamente igual. Meter el `if` en
   * el motor habria significado seis ramas repartidas por el archivo que menos
   * conviene tocar.
   */
  if (superficieDe(credencial) === 'v3') return abrirPosicionV3(cliente, credencial, orden);

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

  return cliente.peticionFirmada(
    credencial,
    { metodo: 'POST', ruta: '/api/v2/mix/order/place-order', cuerpo, idempotente: false },
    esquemaOrdenColocada
  );
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
  if (superficieDe(credencial) === 'v3') return cerrarPosicionV3(cliente, credencial, cierre);

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
  /*
   * En V3 esta consulta no tiene endpoint, y `consultarOrdenV3` la responde con
   * lo que haya visto el socket -o lanza-. Lo que nunca hace es devolver
   * `null`, y esa es la diferencia que separa un aviso de una posicion
   * duplicada: `null` significa aqui «la orden NO entro», y quien lo recibe
   * ofrece reintentar. Ver la cabecera de `consultarOrdenV3`.
   */
  if (superficieDe(credencial) === 'v3') return consultarOrdenV3(simbolo, clientOid);

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
