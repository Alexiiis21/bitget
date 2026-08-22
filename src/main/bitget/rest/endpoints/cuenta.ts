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
import type { Credencial } from '../signer';

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

export function obtenerCuentasFuturos(
  cliente: ClienteBitget,
  credencial: Credencial,
  productType = 'USDT-FUTURES'
): Promise<RespuestaRest<CuentasFuturos>> {
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
 * `holdSide` es opcional. En margen aislado Bitget guarda un apalancamiento por
 * lado y hay que indicarlo; en cruzado hay uno solo y el lado se ignora. Se
 * manda siempre para no depender de esa diferencia.
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
    lado: 'long' | 'short';
  }
): Promise<RespuestaRest<ApalancamientoFijado>> {
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
        holdSide: datos.lado
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

export function obtenerCuentaSimbolo(
  cliente: ClienteBitget,
  credencial: Credencial,
  simbolo: string,
  productType = 'USDT-FUTURES',
  marginCoin = 'USDT'
): Promise<RespuestaRest<CuentaSimbolo>> {
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
