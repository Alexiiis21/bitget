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
  ips: zod.string(),
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
