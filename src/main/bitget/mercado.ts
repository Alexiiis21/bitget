/**
 * Los dos mercados de Bitget, y por que son un concepto explicito.
 *
 * --------------------------------------------------------------------------
 * Real y simulado no son el mismo mercado con una bandera
 * --------------------------------------------------------------------------
 * Bitget no ofrece un «modo demo» que se active en la cabecera de la peticion:
 * ofrece **otro mercado**, con otro `productType`, otros simbolos y otra moneda
 * de margen. Capturado de la API real el 12/08/2026:
 *
 *   real      productType `USDT-FUTURES`   simbolo `BTCUSDT`    margen `USDT`
 *   simulado  productType `SUSDT-FUTURES`  simbolo `SBTCSUSDT`  margen `SUSDT`
 *
 * Esto es una ventaja de seguridad y conviene aprovecharla: una orden dirigida
 * al mercado simulado **no puede** ejecutarse por error contra dinero real,
 * porque el simbolo ni siquiera existe alli. No hay bandera que se pueda quedar
 * mal puesta; hay dos universos separados por el propio exchange.
 *
 * Por eso el mercado viaja dentro de cada peticion en lugar de vivir en una
 * configuracion global: quien construye una orden esta obligado a decir en cual
 * de los dos la quiere, y el compilador no le deja olvidarlo.
 */

export type ClaveMercado = 'real' | 'simulado';

export interface Mercado {
  clave: ClaveMercado;
  /** `USDT-FUTURES` o `SUSDT-FUTURES`. Va en casi todas las peticiones. */
  productType: string;
  /** Moneda de margen: `USDT` o `SUSDT`. */
  marginCoin: string;
  /** Prefijo de los simbolos del mercado simulado. Vacio en el real. */
  prefijoSimbolo: string;
  /**
   * Los simbolos que el panel deja operar, en el orden en que se enseñan.
   *
   * Es una lista corta y explicita, no «todo lo que devuelva Bitget». El
   * cliente opera cinco activos y solo cinco; un selector con los 754 contratos
   * del exchange convertiria una eleccion de un vistazo en una busqueda, y
   * abriria la puerta a operar por error un activo que no es el suyo.
   *
   * El mercado simulado no tiene los mismos: Bitget solo ofrece tres para
   * practicar, y XRP esta ahi porque es lo que hay, no porque se opere.
   */
  simbolos: readonly string[];
}

export const MERCADO_REAL: Mercado = {
  clave: 'real',
  productType: 'USDT-FUTURES',
  marginCoin: 'USDT',
  prefijoSimbolo: '',
  simbolos: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'PEPEUSDT', 'PAXGUSDT', 'SUIUSDT', 'DOGEUSDT', 'XRPUSDT']
};

/**
 * Mercado de dinero simulado, oficial de Bitget.
 *
 * Es donde se hacen las pruebas fisicas de la Fase 4: precios reales, motor de
 * emparejamiento real y saldo simulado. Solo tiene tres simbolos -SBTCSUSDT,
 * SETHSUSDT y SXRPSUSDT-, suficientes para demostrar la ejecucion.
 */
export const MERCADO_SIMULADO: Mercado = {
  clave: 'simulado',
  productType: 'SUSDT-FUTURES',
  marginCoin: 'SUSDT',
  prefijoSimbolo: 'S',
  simbolos: ['SBTCSUSDT', 'SETHSUSDT', 'SXRPSUSDT', 'SSUISUSDT', 'SDOGESUSDT']
};

export const MERCADOS: Record<ClaveMercado, Mercado> = {
  real: MERCADO_REAL,
  simulado: MERCADO_SIMULADO
};

/** `true` si el simbolo pertenece al mercado indicado. */
export function perteneceA(mercado: Mercado, simbolo: string): boolean {
  return mercado.clave === 'simulado'
    ? simbolo.startsWith('S') && simbolo.endsWith('SUSDT')
    : !simbolo.endsWith('SUSDT');
}
