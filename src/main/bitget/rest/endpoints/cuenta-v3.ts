/**
 * Endpoints de cuenta en la API V3 (UTA): margen y apalancamiento.
 *
 * Gemelo de la mitad de `cuenta.ts` que el motor de lotes usa para operar.
 * Devuelve las mismas formas que aquel para que las maniobras no distingan la
 * superficie.
 *
 * ==========================================================================
 * Estado de verificacion: NO capturado
 * ==========================================================================
 * De la documentacion de Bitget al 7 de septiembre de 2026, no de respuestas
 * reales. Se confirma con `node scripts/sondear-v3.mjs --env UTA` y ejercitando
 * las dos escrituras contra una subcuenta UTA desechable.
 */
import { z as zod } from 'zod';
import type { Lado } from '@shared/types';
import { categoriaDe, posSideDe } from '../../superficie';
import type { ClienteBitget, RespuestaRest } from '../client';
import type { Credencial } from '../signer';
import { obtenerActivosCuenta, obtenerAjustesCuenta } from './ajustes-v3';
import {
  esquemaApalancamientoFijado,
  type ApalancamientoFijado,
  type CuentasFuturos
} from './cuenta';

/* ---------- POST /api/v3/account/set-margin ---------- */

/**
 * Anade o retira margen de una posicion abierta.
 *
 * --------------------------------------------------------------------------
 * El signo deja de viajar en el importe
 * --------------------------------------------------------------------------
 * V2 lo codifica en `amount`: positivo anade, negativo retira. V3 lo separa en
 * `operation` (`add` / `reduce`) con el importe siempre positivo. La traduccion
 * se hace aqui, a partir del signo que trae quien llama, para que el motor de
 * lotes siga hablando en el vocabulario de siempre.
 *
 * Igual que en V2, **no acepta `clientOid`**: no hay identificador que impida
 * que un reenvio mueva el margen dos veces. Por eso el motor nunca reintenta a
 * ciegas y relee el margen de la posicion antes de reenviar
 * (`MotorLotes.margenYaAplicado`). Esa red sigue siendo igual de necesaria aqui.
 */
export function ajustarMargenV3(
  cliente: ClienteBitget,
  credencial: Credencial,
  datos: {
    simbolo: string;
    category: string;
    cantidad: string;
    lado: Lado;
  }
): Promise<RespuestaRest<unknown>> {
  const negativo = datos.cantidad.trim().startsWith('-');
  const importe = negativo ? datos.cantidad.trim().slice(1) : datos.cantidad;

  return cliente.peticionFirmada(
    credencial,
    {
      metodo: 'POST',
      ruta: '/api/v3/account/set-margin',
      cuerpo: {
        category: datos.category,
        symbol: datos.simbolo,
        operation: negativo ? 'reduce' : 'add',
        amount: importe,
        ...posSideDe(datos.lado, credencial.holdMode ?? null)
      },
      idempotente: false
    },
    zod.unknown()
  );
}

/* ---------- POST /api/v3/account/set-leverage ---------- */

/**
 * Fija el apalancamiento de un simbolo.
 *
 * --------------------------------------------------------------------------
 * En cobertura son dos campos, no uno con lado
 * --------------------------------------------------------------------------
 * V2 manda `leverage` y, solo en aislado, un `holdSide` que dice a cual de los
 * dos lados se aplica. V3 lo parte en `longLeverage` y `shortLeverage`, de modo
 * que el lado deja de ser un parametro aparte y pasa a ser **el nombre del
 * campo**.
 *
 * `lado: null` —que en V2 significa «esta cuenta es cruzada y tiene uno solo»—
 * se traduce a `leverage` a secas.
 *
 * La respuesta se lee con el mismo esquema tolerante que en V2, porque quien
 * llama comprueba lo que quedo fijado y no se fia del codigo de exito: es la
 * leccion de la incidencia del 05/09/2026, y vale igual en las dos superficies.
 */
export function fijarApalancamientoV3(
  cliente: ClienteBitget,
  credencial: Credencial,
  datos: {
    simbolo: string;
    category: string;
    apalancamiento: number;
    lado: Lado | null;
  }
): Promise<RespuestaRest<ApalancamientoFijado>> {
  const valor = String(datos.apalancamiento);

  return cliente.peticionFirmada(
    credencial,
    {
      metodo: 'POST',
      ruta: '/api/v3/account/set-leverage',
      cuerpo: {
        category: datos.category,
        symbol: datos.simbolo,
        ...(datos.lado === null
          ? { leverage: valor }
          : datos.lado === 'long'
            ? { longLeverage: valor }
            : { shortLeverage: valor })
      },
      idempotente: false
    },
    esquemaApalancamientoFijado
  );
}

/* ---------- GET /api/v3/account/assets ---------- */

/**
 * El saldo de una cuenta UTA con la forma que tenia en V2.
 *
 * ==========================================================================
 * Sin esto, el saldo de una subcuenta UTA no se refrescaba nunca
 * ==========================================================================
 * `BarridoPosiciones.leerSaldo` llama cada 45 s a `obtenerCuentasFuturos`, que
 * hasta la Fase D iba siempre a `/api/v2/mix/account/accounts`. En una cuenta
 * UTA esa ruta la rechaza Bitget, y el fallo **no se ve**: `leerSaldo` se traga
 * su propio error a proposito -para que un saldo caido no descarte la foto de
 * posiciones ni pinte la cuenta como desconectada-. El resultado era una columna
 * de saldo congelada en el valor que dejo la verificacion, indefinidamente y sin
 * ningun aviso.
 *
 * Es el tipo de fallo que solo aparece leyendo el camino entero, porque cada
 * pieza por separado se comporta como debe.
 *
 * `locked` sale de `locked` o `frozen` -no hay respuesta capturada- y cae a `'0'`
 * si no viene: es el unico campo del esquema de V2 que nadie lee hoy, asi que un
 * valor por defecto ahi no puede mentir sobre nada que se enseñe.
 */
export async function obtenerCuentasFuturosV3(
  cliente: ClienteBitget,
  credencial: Credencial,
  marginCoin: string
): Promise<RespuestaRest<CuentasFuturos>> {
  const r = await obtenerActivosCuenta(cliente, credencial);

  const datos: CuentasFuturos = r.datos.map((a) => ({
    marginCoin: a.coin ?? a.marginCoin ?? marginCoin,
    available: a.available ?? a.availableBalance ?? '',
    accountEquity: a.equity ?? a.accountEquity ?? '',
    usdtEquity: a.usdtEquity ?? a.equity ?? a.accountEquity ?? '',
    locked: a.locked ?? a.frozen ?? '0'
  }));

  return { datos, duracionMs: r.duracionMs, codigo: r.codigo };
}

/* ---------- lectura del estado de un simbolo ---------- */

/**
 * Modo de margen y apalancamiento de un simbolo, leidos de `account/settings`.
 *
 * En V2 hace falta una peticion por simbolo a `/api/v2/mix/account/account`. En
 * V3 la lista entera viene dentro de `symbolConfigList` de los ajustes de
 * cuenta, asi que se lee de ahi y se le da la forma que espera quien llama.
 *
 * `null` es «Bitget no informa de ese simbolo», y quien llama lo trata como «no
 * se sabe» —nunca como cero—: el motor lo usa para confirmar que un cambio de
 * apalancamiento se aplico de verdad, y un cero ahi haria fallar una casilla
 * que estaba bien.
 */
export async function estadoSimboloV3(
  cliente: ClienteBitget,
  credencial: Credencial,
  simbolo: string,
  category: string
): Promise<{ marginMode: string | null; leverage: number | null } | null> {
  const r = await obtenerAjustesCuenta(cliente, credencial);

  const config = (r.datos.symbolConfigList ?? []).find(
    (c) => c.symbol === simbolo && (c.category == null || c.category === category)
  );
  if (config === undefined) return null;

  return {
    marginMode: config.marginMode ?? null,
    leverage: config.leverage == null ? null : Number(config.leverage)
  };
}

/** Reexportado para que el despachador no tenga que importar de dos sitios. */
export { categoriaDe };
