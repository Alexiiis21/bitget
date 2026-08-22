/**
 * El catalogo de activos que ve el operador, con datos del propio Bitget.
 *
 * --------------------------------------------------------------------------
 * Por que existe, si `simbolos.ts` ya trae los contratos
 * --------------------------------------------------------------------------
 * `obtenerContratos` devuelve los 754 contratos del exchange, con veinte campos
 * cada uno. La pantalla necesita otra cosa: los cinco que el cliente opera, en
 * su orden, con el nombre corto que reconoce y con los dos numeros que cambian
 * lo que puede escribir en el formulario -cuantos decimales tiene el precio y
 * hasta que apalancamiento llega ese activo-.
 *
 * Esa traduccion vive aqui y no en el renderer por la regla del proyecto: el
 * renderer no habla con la red, y tampoco decide que se puede operar.
 *
 * --------------------------------------------------------------------------
 * El apalancamiento maximo sale de aqui, y por eso el campo puede venir lleno
 * --------------------------------------------------------------------------
 * El cliente opera siempre al maximo de cada activo y son topes distintos
 * -BTC 150x, PEPE 75x, PAXG 50x, verificado el 18/08/2026-. Con este dato en la
 * pantalla, el campo de apalancamiento puede proponer el maximo del activo
 * elegido en lugar de obligarle a recordarlo, y sin gastar una peticion extra:
 * ya viene en el catalogo que hace falta consultar de todos modos.
 */
import type { ClienteBitget } from './rest/client';
import type { Mercado } from './mercado';
import { obtenerContratos, obtenerTicker, type Contrato } from './rest/endpoints/simbolos';

export interface ActivoOperable {
  /** Nombre corto para la pantalla: `BTC`, `PEPE`. Sin el sufijo del mercado. */
  id: string;
  /** Simbolo tal como lo espera la API: `BTCUSDT`, `SBTCSUSDT`. */
  simbolo: string;
  /** Rotulo del selector: `BTC/USDT`. */
  etiqueta: string;
  /** Decimales del precio. PEPE necesita 8; PAXG, 2. */
  decimalesPrecio: number;
  /** Tope de apalancamiento del activo en **este** mercado. */
  apalancamientoMax: number;
  apalancamientoMin: number;
  /** Nocional minimo por orden, en moneda de margen. */
  nocionalMinimo: string;
  operable: boolean;
}

/**
 * Nombre corto a partir del contrato.
 *
 * En el mercado simulado la moneda base lleva la `S` del prefijo -`SBTC`- y el
 * operador no la reconoce: lo que el ve en su pantalla de Bitget es BTC. Se
 * retira el prefijo para que el selector diga lo mismo en los dos mercados y
 * una prueba en simulado se parezca a la operacion real.
 */
function nombreCorto(mercado: Mercado, contrato: Contrato): string {
  const base = contrato.baseCoin;
  if (mercado.prefijoSimbolo === '' || !base.startsWith(mercado.prefijoSimbolo)) return base;
  return base.slice(mercado.prefijoSimbolo.length);
}

/**
 * Los activos operables del mercado, en el orden declarado.
 *
 * Un simbolo que el exchange no devuelva **no se inventa**: se omite. Es
 * preferible un selector con cuatro activos a uno con cinco donde el quinto
 * falla al planificar, porque el segundo lo descubre el operador con la
 * operacion ya empezada.
 */
export async function catalogoActivos(
  cliente: ClienteBitget,
  mercado: Mercado
): Promise<ActivoOperable[]> {
  const r = await obtenerContratos(cliente, mercado);
  const porSimbolo = new Map(r.datos.map((c) => [c.symbol, c]));

  const activos: ActivoOperable[] = [];
  for (const simbolo of mercado.simbolos) {
    const contrato = porSimbolo.get(simbolo);
    if (contrato === undefined) continue;

    const corto = nombreCorto(mercado, contrato);
    activos.push({
      id: corto,
      simbolo,
      etiqueta: `${corto}/${contrato.quoteCoin}`,
      decimalesPrecio: Number(contrato.pricePlace),
      apalancamientoMax: Number(contrato.maxLever),
      apalancamientoMin: Number(contrato.minLever),
      nocionalMinimo: contrato.minTradeUSDT,
      operable: contrato.symbolStatus === 'normal'
    });
  }
  return activos;
}

/**
 * Precio de marca de cada activo del catalogo.
 *
 * Es el mismo precio con el que se dimensiona una apertura, no el ultimo
 * negociado: si la pantalla enseñara uno y el plan usara otro, el operador
 * creeria que el panel calculo mal. Ver `esquemaTicker`.
 *
 * Un simbolo que falle no tumba la consulta de los demas: se queda sin precio y
 * la pantalla enseña un guion, que es la verdad.
 */
export async function preciosDe(
  cliente: ClienteBitget,
  mercado: Mercado,
  activos: readonly ActivoOperable[]
): Promise<Record<string, string>> {
  const precios: Record<string, string> = {};

  await Promise.all(
    activos.map(async (activo) => {
      try {
        const r = await obtenerTicker(cliente, mercado, activo.simbolo);
        const t = r.datos[0];
        if (t !== undefined) precios[activo.id] = t.markPrice;
      } catch {
        /* Sin precio la pantalla enseña un guion; el plan trae el suyo propio. */
      }
    })
  );

  return precios;
}
