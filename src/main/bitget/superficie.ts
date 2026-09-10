/**
 * Traduccion de parametros entre las dos superficies de la API de Bitget.
 *
 * La tabla completa esta en `docs/00-uta-fase-1-equivalencias.md` seccion 3.
 * Aqui viven las piezas que el codigo necesita aplicar, y solo esas: este
 * modulo **no** es un traductor generico de peticiones. Un traductor que
 * adivine campos convertiria un renombre mal supuesto en una orden con el
 * parametro equivocado, y eso en V3 no falla de forma ruidosa -Bitget acepta la
 * peticion y hace otra cosa-.
 *
 * ==========================================================================
 * Estado de verificacion
 * ==========================================================================
 * **Nada de este archivo esta capturado contra la API real.** Sale de la
 * documentacion publicada por Bitget al 7 de septiembre de 2026, via
 * `INTEGRACION_V3_UTA.md`. Se confirma con `node scripts/sondear-v3.mjs`.
 *
 * Es el mismo estado en el que nacio `posiciones.ts`, y por la misma razon: se
 * escribe contra lo documentado, se marca como tal, y se corrige con la primera
 * respuesta real. Lo que no se hace es fingir que esta verificado.
 */
import type { HoldMode, Lado } from '@shared/types';
import { ErrorBitget } from './errors';
import type { Mercado } from './mercado';

/**
 * Falla una operacion que V3 todavia no sabe hacer.
 *
 * ==========================================================================
 * Por que fallar y no aproximar
 * ==========================================================================
 * Quedan endpoints de V2 sin equivalente confirmado en V3 —el ciclo de vida del
 * Take Profit y el modo de margen por simbolo, huecos 2.2 y 2.3 de
 * `docs/00-uta-fase-1-equivalencias.md`—. La tentacion es mandar el endpoint mas
 * parecido y ver que pasa. No se hace, y la razon esta escrita en este mismo
 * repositorio dos veces:
 *
 *   25/08/2026  cancelar un plan con el `planType` de la familia responde
 *               `00000 success` con las listas vacias **y no cancela nada**.
 *   05/09/2026  `set-leverage` con `holdSide` en una cuenta cruzada responde
 *               `00000` **y no cambia el apalancamiento**.
 *
 * En Bitget, un parametro mal supuesto no falla de forma ruidosa: responde
 * exito. Un endpoint mal supuesto haria lo mismo, y el operador leeria «Take
 * Profit puesto» sobre una posicion sin proteccion. Un fallo visible, con su
 * motivo, es estrictamente mejor que un exito que miente.
 *
 * La clase es `fatal-cuenta` —no `fatal-lote`— para que un lote mixto siga
 * adelante con las cuentas Classic y solo se marquen las UTA.
 */
export function noDisponibleEnV3(que: string, comoSeguir: string): ErrorBitget {
  return new ErrorBitget(`${que} todavía no está disponible en cuentas UTA. ${comoSeguir}`, {
    clase: 'fatal-cuenta',
    codigo: 'V3_SIN_EQUIVALENTE',
    mensajeOriginal: null,
    httpStatus: null,
    reintentarEnMs: null
  });
}

/**
 * `productType` de V2 -> `category` de V3.
 *
 * El renombre es directo y el valor ya viaja en mayusculas en el panel
 * (`USDT-FUTURES`), asi que no hay conversion de formato. Existe como funcion, y
 * no como acceso directo al campo, para que el punto de traduccion sea uno solo
 * y buscable: el dia que un `category` no coincida con su `productType` se
 * arregla aqui y no en ocho endpoints.
 */
export const categoriaDe = (mercado: Mercado): string => mercado.productType;

/**
 * Categorias que V3 declara admitir.
 *
 * `SUSDT-FUTURES` **no esta en la lista**, y ahi esta el problema abierto mas
 * caro de la migracion: el mercado de practica del panel es precisamente ese, y
 * toda la suite `test/fisica/` se apoya en el. Ver
 * `docs/00-uta-fase-1-equivalencias.md` seccion 9.1.
 */
export const CATEGORIAS_V3 = new Set([
  'SPOT',
  'MARGIN',
  'USDT-FUTURES',
  'COIN-FUTURES',
  'USDC-FUTURES'
]);

/**
 * `true` si V3 declara admitir el mercado indicado.
 *
 * Hoy devuelve `false` para el mercado simulado. No bloquea nada por si solo
 * -quien llama decide-, pero permite que el panel avise en vez de mandar una
 * peticion que el exchange rechazara sin explicar por que.
 */
export const mercadoSoportadoEnV3 = (mercado: Mercado): boolean =>
  CATEGORIAS_V3.has(categoriaDe(mercado));

/**
 * El fragmento `posSide` de un cuerpo de peticion V3.
 *
 * ==========================================================================
 * Este es el parametro que puede abrir una posicion en el lado contrario
 * ==========================================================================
 * En `hedge_mode` es **obligatorio**: sin el, Bitget no sabe sobre cual de las
 * dos posiciones vivas actuar. En `one_way_mode` hay una sola posicion por
 * simbolo y el parametro sobra.
 *
 * `holdMode === null` significa «no se ha leido todavia». Se trata como el caso
 * peligroso y **se envia** `posSide`: mandarlo de mas en una cuenta unilateral
 * es un parametro ignorado o un rechazo explicito, mientras que omitirlo en una
 * cuenta de cobertura deja que Bitget elija el lado. De los dos errores, solo
 * uno cuesta dinero.
 *
 * El panel opera en cobertura (docs/adr/0006), asi que el caso normal es
 * enviarlo.
 */
export function posSideDe(lado: Lado, holdMode: HoldMode | null): { posSide?: Lado } {
  return holdMode === 'one_way_mode' ? {} : { posSide: lado };
}

/**
 * Renombres de la respuesta de posiciones, V2 -> V3.
 *
 * Se declara como tabla y no se aplica con un bucle a proposito: los esquemas
 * Zod nombran sus campos uno a uno para que un cambio de la API falle la
 * validacion diciendo **que campo**. La tabla esta aqui para que la
 * correspondencia sea legible de un vistazo y para las pruebas.
 *
 * `marginSize` y `unrealizedPL` no aparecen en la documentacion de V3, y de
 * ellos dependen la columna de margen y el ROE del Centro de Monitoreo. Estan
 * marcados `null` hasta que la sonda diga como se llaman.
 */
export const CAMPOS_POSICION_V2_A_V3: Readonly<Record<string, string | null>> = {
  symbol: 'symbol',
  holdSide: 'posSide',
  total: 'total',
  marginMode: 'marginMode',
  openPriceAvg: 'avgPrice',
  liquidationPrice: 'liquidationPrice',
  leverage: 'leverage',
  marginSize: null,
  unrealizedPL: null
};
