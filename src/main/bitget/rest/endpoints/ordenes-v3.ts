/**
 * Colocacion, cierre y consulta de ordenes en la API V3 (UTA).
 *
 * Gemelo de `ordenes.ts`. Devuelve **las mismas formas** que aquel —
 * `OrdenColocada`, `ResultadoCierre`, `DetalleOrden`— para que el motor de lotes
 * no sepa con que superficie esta hablando. Todo lo que cambia son los nombres
 * de los parametros y la ruta.
 *
 * ==========================================================================
 * Los dos campos que deciden el lado, y por que no son intercambiables
 * ==========================================================================
 * En V2, con la cuenta en cobertura, el lado sale de la pareja
 * `side` + `tradeSide`:
 *
 *   abrir long    side buy   + tradeSide open
 *   cerrar long   side sell  + tradeSide close
 *
 * V3 retira `tradeSide` y lo sustituye por `posSide` + `reduceOnly`:
 *
 *   abrir long    side buy   + posSide long
 *   cerrar long   side sell  + posSide long  + reduceOnly true
 *
 * Fijarse en que `posSide` **no** cambia al cerrar: nombra la posicion sobre la
 * que se actua, no la direccion de la orden. Confundirlo con `side` abriria una
 * posicion contraria en vez de cerrar la que hay, y en cobertura las dos pueden
 * convivir, asi que el error no seria ruidoso: quedarian dos posiciones abiertas
 * y el operador veria la suya intacta.
 *
 * ==========================================================================
 * Estado de verificacion: NO capturado
 * ==========================================================================
 * Los nombres salen de la documentacion de Bitget al 7 de septiembre de 2026,
 * via `INTEGRACION_V3_UTA.md` seccion 6. Ninguna de estas peticiones se ha
 * enviado a la API real. Antes de operar con dinero real hay que ejercitarlas
 * contra una subcuenta UTA; ver el checklist de
 * `docs/00-uta-fase-1-equivalencias.md`.
 */
import type { z } from 'zod';
import { z as zod } from 'zod';
import { ErrorBitget } from '../../errors';
import { registroOrdenesUta, type RegistroOrdenesUta } from '../../registro-ordenes-uta';
import { categoriaDe, posSideDe } from '../../superficie';
import type { ClienteBitget, RespuestaRest } from '../client';
import type { Credencial } from '../signer';
import type {
  AperturaOrden,
  CierrePosicion,
  DetalleOrden,
  OrdenColocada,
  ResultadoCierre
} from './ordenes';

/*
 * Los esquemas se declaran aqui en vez de reutilizar los de `ordenes.ts`, por
 * dos razones. La practica: `ordenes.ts` importa este modulo para despachar, y
 * reutilizarlos crearia un ciclo en tiempo de ejecucion. La de fondo: la forma
 * de la respuesta de V3 **no esta capturada**, y compartir el esquema haria que
 * un cambio en una superficie moviera en silencio la validacion de la otra.
 */
const esquemaOrdenColocadaV3 = zod.object({
  orderId: zod.string(),
  clientOid: zod.string()
});

const esquemaCierreV3 = zod.object({
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

/* ---------- POST /api/v3/trade/place-order ---------- */

/**
 * Envia una apertura por V3.
 *
 * `marginMode` se sigue enviando aunque V3 lo declare opcional: en UTA es el
 * unico sitio donde se declara el modo de la posicion -no hay un paso previo
 * que lo fije, ver `planificar` en el motor-, de modo que omitirlo haria que
 * Bitget aplicase el de la cuenta y no el que eligio el operador.
 */
export function abrirPosicionV3(
  cliente: ClienteBitget,
  credencial: Credencial,
  orden: AperturaOrden
): Promise<RespuestaRest<OrdenColocada>> {
  const cuerpo: Record<string, string> = {
    category: categoriaDe(orden.mercado),
    symbol: orden.simbolo,
    side: orden.lado === 'long' ? 'buy' : 'sell',
    orderType: orden.precioLimite === null ? 'market' : 'limit',
    /* `size` en V2. Misma semantica: cantidad en moneda base. */
    qty: orden.size,
    marginMode: orden.modoMargen,
    clientOid: orden.clientOid,
    ...posSideDe(orden.lado, credencial.holdMode ?? null)
  };

  if (orden.precioLimite !== null) {
    cuerpo['price'] = orden.precioLimite;
    /* `force: 'gtc'` en V2. */
    cuerpo['timeInForce'] = 'gtc';
  }

  /*
   * El Take Profit va dentro de la orden, no despues.
   *
   * Capturado el 01/10/2026 contra una subcuenta UTA en cobertura: con la
   * posicion ya abierta, `place-strategy-order` responde `31008 · There is no
   * position` a toda variante probada -full, partial con qty, con y sin side,
   * reduceOnly, tpTriggerBy market/mark-. Con `takeProfit` en `place-order` la
   * orden entra y Bitget crea el Take Profit como estrategia `tpsl` pendiente,
   * que aparece en `unfilled-strategy-orders` y se cancela solo al cerrar.
   *
   * Sin `tpTriggerBy`: se valido sin el, y Bitget aplica `market` (ultimo
   * precio), que es el mismo disparo que `fill_price` en V2.
   */
  if (orden.takeProfit != null) {
    cuerpo['takeProfit'] = orden.takeProfit;
    cuerpo['tpOrderType'] = 'market';
  }

  return cliente.peticionFirmada(
    credencial,
    { metodo: 'POST', ruta: '/api/v3/trade/place-order', cuerpo, idempotente: false },
    esquemaOrdenColocadaV3
  );
}

/* ---------- POST /api/v3/trade/close-positions ---------- */

/**
 * Cierra a mercado toda la posicion de un simbolo y un lado.
 *
 * Conserva la propiedad que hace correcto al cierre en V2: le dice a Bitget
 * «cierra lo que haya» en vez de una cantidad fija, de modo que un cambio de
 * tamano entre la lectura y el envio no deja un resto abierto sin que nadie lo
 * note.
 *
 * Limite publicado: **5/s por UID**, por debajo del bucket por cuenta del panel
 * (8/s). Por eso esta ruta tiene techo propio en `LIMITES_POR_ENDPOINT`.
 */
export function cerrarPosicionV3(
  cliente: ClienteBitget,
  credencial: Credencial,
  cierre: CierrePosicion
): Promise<RespuestaRest<ResultadoCierre>> {
  return cliente.peticionFirmada(
    credencial,
    {
      metodo: 'POST',
      ruta: '/api/v3/trade/close-positions',
      cuerpo: {
        category: categoriaDe(cierre.mercado),
        symbol: cierre.simbolo,
        clientOid: cierre.clientOid,
        ...posSideDe(cierre.lado, credencial.holdMode ?? null)
      },
      idempotente: false
    },
    esquemaCierreV3
  );
}

/* ---------- consulta por clientOid ---------- */

/**
 * Esquema del detalle de una orden en V3.
 *
 * Se declara con los nombres de V2 mas los renombres esperados, porque quien lo
 * consume —`consultarOrden`— espera un `DetalleOrden`.
 */
export const esquemaDetalleOrdenV3 = zod.object({
  orderId: zod.string(),
  clientOid: zod.string(),
  symbol: zod.string(),
  qty: zod.string().nullish(),
  size: zod.string().nullish(),
  status: zod.string().nullish(),
  state: zod.string().nullish(),
  filledQty: zod.string().nullish(),
  baseVolume: zod.string().nullish(),
  avgPrice: zod.string().nullish(),
  priceAvg: zod.string().nullish()
});

/**
 * Pregunta si una orden entro, por el identificador que puso el panel.
 *
 * ==========================================================================
 * Sin endpoint, pero ya no siempre a ciegas
 * ==========================================================================
 * Es la pieza sobre la que se apoya el tri-estado: cuando la conexion se corta
 * **despues** de enviar una apertura, no se sabe si la orden entro, y la unica
 * salida correcta es preguntar por su `clientOid`. Reintentar a ciegas duplica
 * la posicion; descartar deja una posicion abierta que nadie vigila.
 *
 * En V2 la responde `GET /api/v2/mix/order/detail`, con la asimetria que la
 * hace utilizable: `40109` significa «no existe», es decir **no entro**.
 *
 * En V3 **sigue sin conocerse el endpoint equivalente ni el codigo que
 * sustituye al 40109** —el hueco 2.1 de
 * `docs/00-uta-fase-1-equivalencias.md`—. Lo que anade la Fase E es una segunda
 * fuente que no es REST: el tema `order` del socket de UTA. Si el socket
 * anuncio esa orden, Bitget la conoce, y eso responde la pregunta sin
 * endpoint.
 *
 * --------------------------------------------------------------------------
 * Responde que si, o no responde. Nunca dice que no
 * --------------------------------------------------------------------------
 * `null` significa, en el contrato de `consultarOrden`, **«la orden no entro»**,
 * y quien lo recibe da la casilla por fallida y la ofrece para reintentar. Esta
 * funcion **no devuelve `null` jamas**: o encuentra la orden en el registro, o
 * lanza.
 *
 * La razon es que «no consta en el registro» no es «no entro». Puede que el
 * socket estuviera caido, que la cuenta estuviera fria -sin socket, por cupo del
 * pool- o que el empujon llegue un instante despues. Convertir eso en un `null`
 * reintentaria una apertura que si entro, y quedarian dos posiciones abiertas
 * con dinero real. Es exactamente la regla dura numero 2.
 *
 * Lanzar deja la casilla en `indeterminada`, que es la verdad: se envio y no se
 * sabe. El operador lo ve marcado y lo comprueba en Bitget.
 */
export function consultarOrdenV3(
  simbolo: string,
  clientOid: string,
  registro: RegistroOrdenesUta = registroOrdenesUta
): Promise<DetalleOrden | null> {
  const vista = registro.buscar(clientOid, simbolo);

  if (vista !== null) {
    /*
     * Se devuelve con la forma de V2 —`DetalleOrden`— porque quien pregunta es
     * `consultarOrden`, que no sabe de superficies. `state` viaja tal cual lo
     * mando Bitget: quien lo lee hoy solo distingue «hay orden» de «no la hay»,
     * y traducir estados que no estan capturados solo podria estropearlo.
     */
    return Promise.resolve({
      orderId: vista.orderId,
      clientOid: vista.clientOid,
      symbol: vista.symbol,
      size: vista.size ?? '',
      state: vista.state,
      baseVolume: vista.baseVolume,
      priceAvg: vista.priceAvg
    });
  }

  return Promise.reject(
    new ErrorBitget(
      'No se pudo comprobar si la orden entró: en cuentas UTA la consulta por identificador ' +
        'no está disponible y el socket no anunció esta orden. Compruebe la posición en ' +
        'Bitget antes de reintentar.',
      {
        clase: 'indeterminada',
        codigo: 'V3_SIN_CONSULTA_POR_CLIENTOID',
        mensajeOriginal: 'GET /api/v3/trade/order-info sin confirmar; sin rastro en el socket',
        httpStatus: null,
        reintentarEnMs: null
      }
    )
  );
}

export type DetalleOrdenV3 = z.infer<typeof esquemaDetalleOrdenV3>;
