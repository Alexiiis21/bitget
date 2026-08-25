/**
 * Entorno de ejecucion del panel.
 *
 *   dev      Datos de demostracion. `MockPanelService` inventa cuentas,
 *            posiciones y precios, y el panel no sale a la red.
 *   staging  API real de Bitget, vault real, carpeta de datos propia. No queda
 *            una sola pieza de simulacion en pie.
 *
 * **Se fija al construir, no al arrancar.** `__ENTORNO__` lo sustituye
 * `electron.vite.config.ts` por un literal en los tres bundles, segun el
 * `--mode` de la linea de comandos. Una variable que se leyera de `process.env`
 * en runtime podria cambiarse por accidente en la maquina del operador -o
 * quedarse puesta de una sesion anterior- y el panel arrancaria contra dinero
 * real creyendo estar en demostracion. Un literal compilado no tiene esa clase
 * de fallo: el binario de staging *es* de staging.
 *
 * El efecto secundario util es que el bundle de staging no contiene el codigo
 * del mock: al ser `__ENTORNO__` un literal, Rollup elimina la rama muerta y
 * `MockPanelService` no llega ni a empaquetarse. No hay datos inventados que
 * puedan aparecer porque no estan ahi.
 *
 * Aqui vive solo el contrato -valores, tipo y comprobaciones sobre una
 * constante-, sin logica de dominio: `src/shared/` no ejecuta reglas del
 * producto. docs/01-stack-tecnologico.md seccion 13.
 */

export const ENTORNOS = ['dev', 'staging'] as const;

export type Entorno = (typeof ENTORNOS)[number];

/** Valida un valor externo (linea de comandos, archivo `.env`) contra la lista. */
export const esEntorno = (valor: unknown): valor is Entorno =>
  typeof valor === 'string' && (ENTORNOS as readonly string[]).includes(valor);

export const entorno = (): Entorno => __ENTORNO__;

export const esStaging = (): boolean => __ENTORNO__ === 'staging';

export const esDev = (): boolean => __ENTORNO__ === 'dev';

/* ------------------------------------------------------------------------ */

/**
 * Mercado de Bitget contra el que opera el binario. **Tambien se fija al
 * construir.**
 *
 *   simulado  productType `SUSDT-FUTURES`, simbolos `SBTCSUSDT`, margen `SUSDT`
 *   real      productType `USDT-FUTURES`,  simbolos `BTCUSDT`,   margen `USDT`
 *
 * Es un eje distinto del entorno y por eso es un literal aparte: `staging`
 * habla con la API real de Bitget y aun asi debe poder operar contra el mercado
 * simulado mientras se prueba. De ahi que existan dos binarios de cliente, uno
 * por mercado, con el nombre del archivo diciendo cual es cual.
 *
 * **Antes vivia en `config.json`, junto al ejecutable, y se cambiaba editando
 * ese archivo.** Se movio aqui por lo mismo que `__ENTORNO__`: un archivo de
 * texto en la carpeta de datos es algo que alguien tiene que copiar en el sitio
 * correcto -y que se puede quedar del arranque anterior, o no copiarse-, y el
 * fallo posible era un panel que opera con dinero real creyendo estar en
 * pruebas. Un literal compilado no tiene esa clase de fallo: el binario real
 * *es* real, y no hay nada que el operador pueda mover para que deje de serlo.
 *
 * El panel lo enseña siempre en su barra superior, para que la respuesta a
 * «¿esto es dinero de verdad?» este en pantalla y no en el nombre del archivo.
 */
export const MERCADOS_COMPILABLES = ['simulado', 'real'] as const;

export type MercadoCompilado = (typeof MERCADOS_COMPILABLES)[number];

export const esMercadoCompilado = (valor: unknown): valor is MercadoCompilado =>
  typeof valor === 'string' && (MERCADOS_COMPILABLES as readonly string[]).includes(valor);

export const mercadoCompilado = (): MercadoCompilado => __MERCADO__;

export const esMercadoReal = (): boolean => __MERCADO__ === 'real';

/**
 * Corta cualquier pieza de simulacion que se invoque bajo staging.
 *
 * Es la red de seguridad detras de la eliminacion de codigo muerto: si alguien
 * alcanza un mock por un camino que Rollup no pudo podar, el panel falla con un
 * mensaje que nombra la pieza, en lugar de mostrar un numero inventado donde el
 * operador espera el saldo de su cuenta. Fallar ruidosamente es lo barato aqui.
 */
export function prohibidoEnStaging(pieza: string): void {
  if (__ENTORNO__ !== 'staging') return;
  throw new Error(
    `${pieza} no existe en staging: este entorno habla unicamente con la API real ` +
      'de Bitget. Para trabajar con datos simulados use el entorno de desarrollo ' +
      '(`npm run dev`).'
  );
}

declare global {
  /**
   * Lo inyecta `define` en electron.vite.config.ts y en vitest.config.ts.
   * Nunca se declara ni se asigna a mano en codigo de la aplicacion.
   */
  const __ENTORNO__: Entorno;

  /** Igual que `__ENTORNO__`, y por el mismo mecanismo. Ver `mercadoCompilado`. */
  const __MERCADO__: MercadoCompilado;
}
