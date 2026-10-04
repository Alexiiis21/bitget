/**
 * Endpoints de cuenta.
 *
 * Los esquemas de este archivo no se dedujeron de la documentacion: se
 * capturaron de respuestas reales de api.bitget.com contra la cuenta demo el
 * 28 de julio de 2026. Solo se declaran los campos que el panel consume; Zod
 * ignora el resto, asi que Bitget puede anadir campos sin romper nada.
 */
import type { z } from 'zod';
import { z as zod } from 'zod';
import type { ClienteBitget, RespuestaRest } from '../client';
import { noDisponibleEnV3 } from '../../superficie';
import { superficieDe, type Credencial } from '../signer';
import {
  ajustarMargenV3,
  estadoSimboloV3,
  fijarApalancamientoV3,
  obtenerCuentasFuturosV3
} from './cuenta-v3';

/* ---------- /api/v2/spot/account/info ---------- */

/**
 * Informacion de la cuenta y, sobre todo, **los permisos de la API Key**.
 *
 * Pese al prefijo `spot`, es un endpoint de cuenta y responde con una key que
 * solo tiene permiso de futuros: verificado contra la cuenta demo. Es el unico
 * sitio donde el exchange declara los permisos concedidos.
 *
 * `/api/v2/user/api-key-info` y `/api/v2/account/info` **no existen**: ambos
 * devuelven 40404. Se probaron antes de llegar aqui.
 */
export const esquemaInfoCuenta = zod.object({
  userId: zod.string(),
  /** Codigos de permiso, p. ej. ["coow","cpow"]. Ver verificacion.ts. */
  authorities: zod.array(zod.string()),
  /** IPs ligadas, separadas por coma. Cadena vacia = sin restriccion. */
  ips: zod.string().nullish(),
  /** Presente cuando la cuenta es subcuenta de otra. */
  parentId: zod.number().nullish()
});

export type InfoCuenta = z.infer<typeof esquemaInfoCuenta>;

export function obtenerInfoCuenta(
  cliente: ClienteBitget,
  credencial: Credencial
): Promise<RespuestaRest<InfoCuenta>> {
  return cliente.peticionFirmada(
    credencial,
    { metodo: 'GET', ruta: '/api/v2/spot/account/info', idempotente: true },
    esquemaInfoCuenta
  );
}

/* ---------- /api/v2/mix/account/accounts ---------- */

/** Saldo de la cuenta de futuros, por moneda de margen. */
export const esquemaCuentasFuturos = zod.array(
  zod.object({
    marginCoin: zod.string(),
    available: zod.string(),
    accountEquity: zod.string(),
    usdtEquity: zod.string(),
    locked: zod.string()
  })
);

export type CuentasFuturos = z.infer<typeof esquemaCuentasFuturos>;

/**
 * El saldo de futuros, por moneda de margen.
 *
 * En UTA no existe una cuenta de futuros aparte —ese es el sentido de
 * «unificada»— y el saldo vive en `/api/v3/account/assets`. `obtenerCuentasFuturosV3`
 * le da esta misma forma para que el barrido y la pantalla de saldos no
 * distingan, igual que en las cinco funciones de la Fase C.
 *
 * `marginCoin` solo se usa como ultimo recurso, para nombrar una fila que llegue
 * sin moneda. Quien llama filtra por la suya justo despues.
 */
export function obtenerCuentasFuturos(
  cliente: ClienteBitget,
  credencial: Credencial,
  productType = 'USDT-FUTURES',
  marginCoin = 'USDT'
): Promise<RespuestaRest<CuentasFuturos>> {
  if (superficieDe(credencial) === 'v3') {
    return obtenerCuentasFuturosV3(cliente, credencial, marginCoin);
  }

  return cliente.peticionFirmada(
    credencial,
    {
      metodo: 'GET',
      ruta: '/api/v2/mix/account/accounts',
      consulta: { productType },
      idempotente: true
    },
    esquemaCuentasFuturos
  );
}

/* ---------- /api/v2/mix/account/account ---------- */

/**
 * Cuenta para un simbolo concreto. Es la unica fuente de dos datos que
 * condicionan si la estrategia del operador puede ejecutarse:
 *
 *   posMode      `hedge_mode` permite LONG y SHORT a la vez. docs/adr/0006.
 *   marginMode   `isolated` es requisito para agregar margen. docs/01 §10.2.
 *
 * Ademas expone el apalancamiento por lado, que en cobertura es independiente.
 */
export const esquemaCuentaSimbolo = zod.object({
  marginCoin: zod.string(),
  available: zod.string(),
  accountEquity: zod.string(),
  /** `crossed` | `isolated`. */
  marginMode: zod.string(),
  /** `hedge_mode` | `one_way_mode`. */
  posMode: zod.string(),
  isolatedLongLever: zod.number().nullish(),
  isolatedShortLever: zod.number().nullish(),
  crossedMarginLeverage: zod.number().nullish()
});

export type CuentaSimbolo = z.infer<typeof esquemaCuentaSimbolo>;

/* ---------- /api/v2/mix/account/set-leverage ---------- */

/**
 * Fija el apalancamiento de una cuenta para un simbolo.
 *
 * --------------------------------------------------------------------------
 * Verificado contra la API real el 13/08/2026
 * --------------------------------------------------------------------------
 * Se cambio a 20x, se leyo 20x, se restauro a 10x. Devuelve el estado
 * resultante, asi que no hay que consultarlo despues para saber como quedo.
 *
 * Dos propiedades que lo hacen la mas benigna de las cinco funciones:
 *
 *  - **No necesita posicion.** Es configuracion de la cuenta, asi que se puede
 *    dejar puesta antes de operar nada.
 *  - **Es idempotente por naturaleza.** Fijar 150x dos veces deja 150x. Un
 *    reenvio accidental no tiene consecuencia, a diferencia de una orden.
 *
 * --------------------------------------------------------------------------
 * `holdSide` va **solo en margen aislado**
 * --------------------------------------------------------------------------
 * En aislado Bitget guarda un apalancamiento por lado -`isolatedLongLever` e
 * `isolatedShortLever`- y hay que decir cual se fija. En cruzado hay uno solo
 * -`crossedMarginLeverage`- y el lado no pinta nada.
 *
 * Se mandaba siempre, «para no depender de esa diferencia», y esa es la causa
 * de la incidencia del 05/09/2026: una cuenta cruzada aceptaba la peticion
 * -codigo 00000, sin error- y seguia con su apalancamiento de antes, porque lo
 * que se estaba fijando era el del lado aislado, que en cruzado no se aplica.
 * El panel lo daba por bueno leyendo `longLeverage` de la respuesta, asi que el
 * informe decia «Apalancamiento 150x» sobre una cuenta que seguia a 10x.
 *
 * `lado: null` es «esta cuenta no lo necesita». Quien llama decide, y comprueba
 * como quedo: ver `MotorLotes.ejecutarApalancamiento`.
 *
 * Fuera de rango responde `400172 · Leverage ratio exceeded the set limit`. El
 * panel lo comprueba antes contra `maxLever` del catalogo para no gastar una
 * peticion en una respuesta que ya se conoce.
 */
export const esquemaApalancamientoFijado = zod.object({
  symbol: zod.string(),
  marginCoin: zod.string(),
  longLeverage: zod.string().nullish(),
  shortLeverage: zod.string().nullish(),
  crossMarginLeverage: zod.string().nullish(),
  marginMode: zod.string().nullish()
});

export type ApalancamientoFijado = z.infer<typeof esquemaApalancamientoFijado>;

export function fijarApalancamiento(
  cliente: ClienteBitget,
  credencial: Credencial,
  datos: {
    simbolo: string;
    productType: string;
    marginCoin: string;
    apalancamiento: number;
    /** El lado, o `null` en cruzado: alli hay un solo apalancamiento. */
    lado: 'long' | 'short' | null;
  }
): Promise<RespuestaRest<ApalancamientoFijado>> {
  if (superficieDe(credencial) === 'v3') {
    return fijarApalancamientoV3(cliente, credencial, {
      simbolo: datos.simbolo,
      /* `productType` y `category` son el mismo valor con otro nombre. */
      category: datos.productType,
      apalancamiento: datos.apalancamiento,
      lado: datos.lado
    });
  }

  return cliente.peticionFirmada(
    credencial,
    {
      metodo: 'POST',
      ruta: '/api/v2/mix/account/set-leverage',
      cuerpo: {
        symbol: datos.simbolo,
        productType: datos.productType,
        marginCoin: datos.marginCoin,
        leverage: String(datos.apalancamiento),
        ...(datos.lado === null ? {} : { holdSide: datos.lado })
      },
      idempotente: false
    },
    esquemaApalancamientoFijado
  );
}

/* ---------- /api/v2/mix/account/set-margin-mode ---------- */

/**
 * Fija el modo de margen de una cuenta **para un simbolo**.
 *
 * --------------------------------------------------------------------------
 * El modo de margen es por simbolo, no por cuenta
 * --------------------------------------------------------------------------
 * Es la confusion que costo la incidencia del 25/08/2026. `/mix/account/account`
 * lleva `symbol` y este tambien: una misma cuenta puede tener BTC en cruzado y
 * SOL en aislado. Leer el modo de un simbolo y aplicarlo a otro -que es lo que
 * hacia el panel, leyendo siempre `mercado.simbolos[0]`- reconfiguraba en
 * silencio el simbolo que se operaba, porque `marginMode` viaja **dentro** de
 * `place-order`.
 *
 * De ahi que el modo lo elija el operador en el panel y se fije aqui, antes de
 * abrir: asi lo que queda configurado en Bitget es lo que se aprobo, y no el
 * resto de un simbolo que no se estaba operando.
 *
 * --------------------------------------------------------------------------
 * No se puede cambiar con la posicion abierta
 * --------------------------------------------------------------------------
 * Bitget lo rechaza si el simbolo tiene posiciones o ordenes vivas. Es correcto
 * -cambiar el modo bajo una posicion abierta cambiaria su liquidacion- y por eso
 * el motor solo llama aqui cuando el modo **de verdad** difiere del pedido: si
 * ya coincide, no hay nada que fijar y una posicion abierta no estorba.
 */
export function fijarModoMargen(
  cliente: ClienteBitget,
  credencial: Credencial,
  datos: {
    simbolo: string;
    productType: string;
    marginCoin: string;
    modoMargen: 'isolated' | 'crossed';
  }
): Promise<RespuestaRest<ApalancamientoFijado>> {
  /*
   * En UTA el modo de margen deja de ser por simbolo y se declara a nivel de
   * cuenta o posicion, asi que este endpoint no tiene equivalente conocido.
   *
   * Fallar aqui es lo correcto y no una limitacion que se pueda ignorar: el
   * motor solo llama a esta funcion cuando el modo real **difiere** del que el
   * operador aprobo. Dejar pasar el fallo abriria la posicion en un modo
   * distinto del confirmado, que es el fallo del 25/08/2026 por la puerta de
   * atras. La casilla queda como fallo sin haber enviado ninguna orden.
   */
  if (superficieDe(credencial) === 'v3') {
    return Promise.reject(
      noDisponibleEnV3(
        'Cambiar el modo de margen de un activo',
        `Ponga ${datos.simbolo} en margen ${datos.modoMargen === 'isolated' ? 'aislado' : 'cruzado'} ` +
          'desde Bitget, o elija en el panel el modo que la cuenta ya tiene.'
      )
    );
  }

  return cliente.peticionFirmada(
    credencial,
    {
      metodo: 'POST',
      ruta: '/api/v2/mix/account/set-margin-mode',
      cuerpo: {
        symbol: datos.simbolo,
        productType: datos.productType,
        marginCoin: datos.marginCoin,
        marginMode: datos.modoMargen
      },
      idempotente: false
    },
    esquemaApalancamientoFijado
  );
}

/* ---------- /api/v2/mix/account/set-margin ---------- */

/**
 * Anade margen a una posicion abierta.
 *
 * --------------------------------------------------------------------------
 * Lo que hay que saber, y que Bitget no dice claro
 * --------------------------------------------------------------------------
 * **Solo funciona en margen aislado.** En cruzado responde
 * `40808 · Parameter verification exception margin mode == FIXED`, verificado
 * el 13/08/2026. El panel lo comprueba antes de enviar para poder decirlo en
 * castellano y sin gastar la peticion.
 *
 * **No lleva identificador propio.** A diferencia de una orden, aqui no hay
 * `clientOid` que impida que un reenvio anada el margen dos veces. Por eso el
 * motor **nunca reintenta a ciegas** un envio del que no recibio respuesta:
 * vuelve a leer el margen de la posicion y compara. Ver `motor-lotes.ts`.
 *
 * `amount` positivo anade; negativo retira. El panel solo anade: retirar margen
 * acerca la liquidacion y no esta en el alcance contratado.
 */
export function ajustarMargen(
  cliente: ClienteBitget,
  credencial: Credencial,
  datos: {
    simbolo: string;
    productType: string;
    marginCoin: string;
    cantidad: string;
    lado: 'long' | 'short';
  }
): Promise<RespuestaRest<unknown>> {
  if (superficieDe(credencial) === 'v3') {
    return ajustarMargenV3(cliente, credencial, {
      simbolo: datos.simbolo,
      category: datos.productType,
      cantidad: datos.cantidad,
      lado: datos.lado
    });
  }

  return cliente.peticionFirmada(
    credencial,
    {
      metodo: 'POST',
      ruta: '/api/v2/mix/account/set-margin',
      cuerpo: {
        symbol: datos.simbolo,
        productType: datos.productType,
        marginCoin: datos.marginCoin,
        amount: datos.cantidad,
        holdSide: datos.lado
      },
      idempotente: false
    },
    zod.unknown()
  );
}

export async function obtenerCuentaSimbolo(
  cliente: ClienteBitget,
  credencial: Credencial,
  simbolo: string,
  productType = 'USDT-FUTURES',
  marginCoin = 'USDT'
): Promise<RespuestaRest<CuentaSimbolo>> {
  /*
   * En V3 no hay un endpoint por simbolo: la lista entera viene dentro de
   * `account/settings`. Se lee de ahi y se le da esta forma.
   *
   * Dos campos salen vacios a proposito, y conviene saberlo antes de usarlos:
   * `available` y `accountEquity` **no** estan en esa respuesta —viven en
   * `account/assets`— y esta funcion solo la llama hoy quien busca el
   * apalancamiento. Si algun dia alguien lee el saldo de aqui en una cuenta UTA,
   * leera cadena vacia; la fuente correcta es `obtenerActivosCuenta`.
   */
  if (superficieDe(credencial) === 'v3') {
    const estado = await estadoSimboloV3(cliente, credencial, simbolo, productType);
    /*
     * `symbolConfigList` trae **un** apalancamiento por simbolo, no uno por
     * lado. Se copia en los tres campos para que quien elija rama —cruzado o
     * aislado, long o short— encuentre el mismo numero, que es el que aplica.
     */
    const lev = estado?.leverage ?? null;
    /*
     * ======================================================================
     * Simbolo ausente de `symbolConfigList` = margen cruzado
     * ======================================================================
     * Capturado el 30/09/2026 con `sondear-v3.mjs --env UTA`: una cuenta UTA
     * que no ha configurado ningun simbolo devuelve `symbolConfigList: []`, y
     * `account/settings` no trae ningun modo por defecto a nivel de cuenta.
     * Bitget solo lista los simbolos configurados, y documenta el cruzado como
     * modo cuando no se especifica otro.
     *
     * Dejarlo en cadena vacia hacia que el motor se negara a fijar el
     * apalancamiento de cualquier simbolo nuevo en una cuenta UTA: justo la
     * primera operacion que se hace sobre el. Una entrada que **si** esta pero
     * sin `marginMode` sigue siendo «no se sabe».
     */
    const modo = estado === null ? 'crossed' : (estado.marginMode ?? '');
    return {
      datos: {
        marginCoin,
        available: '',
        accountEquity: '',
        marginMode: modo,
        posMode: credencial.holdMode ?? '',
        isolatedLongLever: lev,
        isolatedShortLever: lev,
        crossedMarginLeverage: lev
      },
      duracionMs: 0,
      codigo: '00000'
    };
  }

  return cliente.peticionFirmada(
    credencial,
    {
      metodo: 'GET',
      ruta: '/api/v2/mix/account/account',
      consulta: { symbol: simbolo, productType, marginCoin },
      idempotente: true
    },
    esquemaCuentaSimbolo
  );
}
