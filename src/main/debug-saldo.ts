/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║  DEPURACIÓN TEMPORAL · BORRAR ESTE ARCHIVO Y SUS LLAMADAS                ║
   ║                                                                          ║
   ║  Sigue el recorrido del saldo, que es corto y tiene cuatro puntos donde   ║
   ║  puede quedarse en cero sin que nada lo diga en pantalla:                 ║
   ║                                                                          ║
   ║    0. la verificacion arranca -> `Sesion.verificar`                       ║
   ║    1. la consulta a Bitget    -> `bitget/verificacion.ts`                 ║
   ║    2. la anotacion en memoria -> `Sesion.anotarSaldo`                     ║
   ║    3. la proyeccion a la matriz -> `Sesion.cuentasPanel`                  ║
   ║                                                                          ║
   ║  Existe porque el saldo NO se persiste: solo aparece despues de que una   ║
   ║  credencial se verifica, y hasta entonces la casilla dice `0`, que es     ║
   ║  indistinguible de un cero real. Con estas trazas se ve cual de los       ║
   ║  cuatro pasos es el que falta.                                           ║
   ║                                                                          ║
   ║  **ENCENDIDO POR DEFECTO** mientras dure la investigacion, porque un      ║
   ║  interruptor que hay que acordarse de poner es un interruptor que no se   ║
   ║  pone: el sintoma que se persigue -saldo en cero- se ve al arrancar, y    ║
   ║  para entonces ya es tarde para relanzar con la variable puesta. Se apaga ║
   ║  con PCB_DEBUG_SALDO=0. Al cerrar la incidencia se borra el archivo       ║
   ║  entero; no se queda apagado «por si acaso».                             ║
   ║                                                                          ║
   ║  Aqui NO se imprime ninguna credencial: solo identificadores de cuenta,   ║
   ║  el mercado y cantidades.                                                 ║
   ║                                                                          ║
   ║  Para borrarlo: elimina este archivo y busca `trazaSaldo(`.               ║
   ╚══════════════════════════════════════════════════════════════════════════╝ */

const ACTIVA = process.env['PCB_DEBUG_SALDO'] !== '0';

/** `true` cuando la traza esta encendida. Evita construir datos que no se usan. */
export const depurandoSaldo = (): boolean => ACTIVA;

/**
 * Una linea por paso, con los campos que importan de ese paso.
 *
 * Sale por `console.warn` -no `log`: la regla `no-console` del proyecto solo
 * admite `warn` y `error`-, asi que se ve en el terminal de `npm run dev:real` y
 * de `npm run dev:staging`. En el `.exe` portable no hay terminal donde
 * leerlo: para el equipo del cliente hace falta el archivo de log, que es otra
 * pieza.
 */
export function trazaSaldo(paso: string, datos: Record<string, unknown> = {}): void {
  if (!ACTIVA) return;
  const campos = Object.entries(datos)
    .map(([clave, valor]) => `${clave}=${valor === null || valor === undefined ? '—' : String(valor)}`)
    .join(' · ');
  console.warn(campos === '' ? `[SALDO] ${paso}` : `[SALDO] ${paso} · ${campos}`);
}
