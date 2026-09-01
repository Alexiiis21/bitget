/**
 * El catalogo de activos que ve el operador, con datos del propio Bitget.
 *
 * --------------------------------------------------------------------------
 * Por que existe, si `simbolos.ts` ya trae los contratos
 * --------------------------------------------------------------------------
 * `obtenerContratos` devuelve los 754 contratos del exchange, con veinte campos
 * cada uno. La pantalla necesita otra cosa: los ocho que el cliente opera, en
 * su orden, con el nombre corto que reconoce y con los dos numeros que cambian
 * lo que puede escribir en el formulario -cuantos decimales tiene el precio y
 * hasta que apalancamiento llega ese activo-.
 *
 * Desde el 28/08/2026 hay una segunda vista de lo mismo, `catalogoCompleto`, que
 * si devuelve los 754. No es una contradiccion: alimenta el **buscador** con el
 * que el operador decide que activo va en cada casilla, y nada de lo que sale de
 * ahi se puede operar hasta que ocupa una de las ocho.
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

/** Un contrato de Bitget, traducido a lo que la pantalla necesita. */
function aActivo(mercado: Mercado, contrato: Contrato): ActivoOperable {
  const corto = nombreCorto(mercado, contrato);
  return {
    id: corto,
    simbolo: contrato.symbol,
    etiqueta: `${corto}/${contrato.quoteCoin}`,
    decimalesPrecio: Number(contrato.pricePlace),
    apalancamientoMax: Number(contrato.maxLever),
    apalancamientoMin: Number(contrato.minLever),
    nocionalMinimo: contrato.minTradeUSDT,
    operable: contrato.symbolStatus === 'normal'
  };
}

/**
 * Las casillas del selector, resueltas contra el catalogo y **con sus huecos**.
 *
 * `ranuras` son los simbolos que el operador tiene puestos, en su orden; por
 * defecto, la lista de fabrica del mercado. Desde el 28/08/2026 quien las decide
 * es el operador y llegan de `activos.json` -ver `ranuras-activos.ts`-, pero el
 * criterio no cambio: es una lista corta y explicita, no «todo lo que devuelva
 * Bitget».
 *
 * La posicion se conserva: la casilla 3 vacia sale como `null` y no desaparece.
 * La pantalla las dibuja numeradas y el operador las edita por su numero, asi
 * que perder los huecos por el camino renumeraria las casillas cada vez que se
 * vacia una.
 *
 * Un simbolo que el exchange no devuelva **no se inventa**: su casilla sale
 * vacia. Es preferible un selector con cuatro activos a uno con cinco donde el
 * quinto falla al planificar, porque el segundo lo descubre el operador con la
 * operacion ya empezada.
 */
export async function activosDeRanuras(
  cliente: ClienteBitget,
  mercado: Mercado,
  ranuras: readonly (string | null)[] = mercado.simbolos
): Promise<(ActivoOperable | null)[]> {
  const contratos = await porSimboloDe(cliente, mercado);

  return ranuras.map((simbolo) => {
    if (simbolo === null) return null;
    const contrato = contratos.get(simbolo);
    return contrato === undefined ? null : aActivo(mercado, contrato);
  });
}

/**
 * Todo lo que el mercado ofrece, para el buscador.
 *
 * Son los 754 contratos del exchange, y solo se usan para **elegir** que va en
 * cada casilla: nunca para operar. Van ordenados por nombre corto porque el
 * orden en que Bitget los devuelve no significa nada para quien busca.
 */
export async function catalogoCompleto(
  cliente: ClienteBitget,
  mercado: Mercado
): Promise<ActivoOperable[]> {
  const r = await obtenerContratos(cliente, mercado);
  return r.datos
    .map((contrato) => aActivo(mercado, contrato))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Los contratos del mercado, indexados por simbolo. */
async function porSimboloDe(
  cliente: ClienteBitget,
  mercado: Mercado
): Promise<Map<string, Contrato>> {
  const r = await obtenerContratos(cliente, mercado);
  return new Map(r.datos.map((c) => [c.symbol, c]));
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
