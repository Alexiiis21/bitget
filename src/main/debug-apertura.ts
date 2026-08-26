/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║  DEPURACIÓN TEMPORAL · BORRAR ESTE ARCHIVO Y SUS LLAMADAS                ║
   ║                                                                          ║
   ║  El cliente reporto en reunion (25/08/2026) que el Take Profit y el      ║
   ║  margen no se estan mandando correctamente, y sospecha del modo de       ║
   ║  margen (aislado / cruzado). Estas trazas siguen el recorrido completo,  ║
   ║  desde lo que el motor calcula hasta el `cuerpo` exacto que sale hacia   ║
   ║  Bitget, para poder comparar ambos lados:                                ║
   ║                                                                          ║
   ║    0. modoMargen que usa cada cuenta -> `Sesion.cuentaEjecutable`         ║
   ║    1. lo que planifica el motor       -> `MotorLotes.planificar` /        ║
   ║                                          `planificarTakeProfit`           ║
   ║    2. lo que se envia a `abrirPosicion` / `colocarTakeProfit`             ║
   ║       -> `MotorLotes.ejecutar` / `ejecutarTakeProfit`                     ║
   ║    3. el `cuerpo` final de la peticion -> `ordenes.ts` / `tpsl.ts`         ║
   ║                                                                          ║
   ║  Con los cuatro puntos se ve si el modo de margen que Bitget aplica de    ║
   ║  verdad es el mismo que el panel cree tener -la ficha local puede estar   ║
   ║  desactualizada si el operador la cambio desde la web de Bitget, ver      ║
   ║  `registro-cuentas.ts` § `actualizarModos`- y si el precio o el tamano     ║
   ║  que llegan al Take Profit y a la apertura son los que se calcularon.     ║
   ║                                                                          ║
   ║  ENCENDIDO POR DEFECTO mientras dure la investigacion. Se apaga con       ║
   ║  PCB_DEBUG_APERTURA=0. Al cerrar la incidencia se borra el archivo        ║
   ║  entero; no se queda apagado «por si acaso».                             ║
   ║                                                                          ║
   ║  Aqui NO se imprime ninguna credencial: solo identificadores de cuenta,   ║
   ║  simbolo, lado, y las cantidades y modos que se estan investigando.       ║
   ║                                                                          ║
   ║  Para borrarlo: elimina este archivo y busca `trazaApertura(`.            ║
   ╚══════════════════════════════════════════════════════════════════════════╝ */

const ACTIVA = process.env['PCB_DEBUG_APERTURA'] !== '0';

/** `true` cuando la traza esta encendida. Evita construir datos que no se usan. */
export const depurandoApertura = (): boolean => ACTIVA;

/**
 * Contador de lineas.
 *
 * Sin el, dos ejecuciones seguidas de la misma operacion producen un log
 * identico y no hay forma de saber donde acaba una y empieza la otra -que es
 * justo lo que hubo que averiguar el 26/08/2026 con el margen aplicado dos
 * veces-. Con el numero y la hora, cada linea se puede situar.
 */
let secuencia = 0;

const marca = (): string => {
  const t = new Date();
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  const ss = String(t.getSeconds()).padStart(2, '0');
  const ms = String(t.getMilliseconds()).padStart(3, '0');
  return `${String((secuencia += 1)).padStart(4, '0')} ${hh}:${mm}:${ss}.${ms}`;
};

/**
 * Una linea por paso, con los campos que importan de ese paso.
 *
 * Sale por `console.warn` -no `log`: la regla `no-console` del proyecto solo
 * admite `warn` y `error`-, asi que se ve en el terminal de `npm run dev:real` y
 * de `npm run dev:staging`.
 */
export function trazaApertura(paso: string, datos: Record<string, unknown> = {}): void {
  if (!ACTIVA) return;
  const campos = Object.entries(datos)
    .map(([clave, valor]) => `${clave}=${valor === null || valor === undefined ? '—' : String(valor)}`)
    .join(' · ');
  const cabeza = `[APERTURA ${marca()}] ${paso}`;
  console.warn(campos === '' ? cabeza : `${cabeza} · ${campos}`);
}

/**
 * Lo mismo, para un fallo. Sale por `console.error` y lleva el motivo entero.
 *
 * Existe porque la traza anterior solo seguia lo que **sale**: el `cuerpo` de
 * cada peticion. Lo que Bitget contestaba -y sobre todo lo que rechazaba- no
 * aparecia por ningun lado, asi que un envio que fallaba y otro que ni llegaba a
 * enviarse dejaban el mismo rastro: ninguno.
 */
export function trazaFallo(paso: string, e: unknown, datos: Record<string, unknown> = {}): void {
  if (!ACTIVA) return;
  const codigo = e !== null && typeof e === 'object' && 'codigo' in e ? String(e.codigo) : '—';
  trazaApertura(paso, {
    ...datos,
    codigoBitget: codigo,
    error: e instanceof Error ? e.message : String(e)
  });
}
