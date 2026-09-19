/**
 * La regla de la espera creciente tras fallar la contrasena maestra.
 *
 * Vive en `shared` porque la necesitan los dos lados y tienen que decir lo
 * mismo: el proceso principal la **impone** -ver `main/security/freno-maestra.ts`,
 * que es donde ademas se guarda en disco- y la pantalla la **cuenta**, con el
 * mismo texto, mientras el operador espera. Dos copias de esta tabla serian dos
 * esperas distintas para el mismo fallo.
 *
 * Aqui no hay estado ni disco: solo la aritmetica y su redaccion.
 */

/** Fallos que se perdonan antes de la primera espera. */
export const FALLOS_SIN_ESPERA = 2;
/** La primera espera, y la base que se dobla. */
export const ESPERA_BASE_MS = 3 * 60_000;
/** Ninguna espera pasa de aqui. */
export const ESPERA_TOPE_MS = 60 * 60_000;

/**
 * Cuanto se espera tras `fallos` fallos consecutivos.
 *
 *   1, 2    sin espera. Teclear mal una clave larga es normal, y castigar el
 *           primer desliz molestaria a diario a quien si conoce la clave.
 *   3       3 min
 *   4       6 min
 *   5       12 min
 *   6       24 min
 *   7       48 min
 *   8+      60 min, el tope
 *
 * El tope existe por la misma razon que la espera: doblar sin limite convierte
 * el octavo despiste en medio dia sin panel, y eso vuelve a ser un bloqueo con
 * otro nombre. Una hora frena a quien tantea -sesenta intentos al dia- sin
 * dejar fuera a quien acabara acordandose de su clave.
 */
export function esperaTrasFallos(fallos: number): number {
  const castigados = fallos - FALLOS_SIN_ESPERA;
  if (castigados <= 0) return 0;
  return Math.min(ESPERA_TOPE_MS, ESPERA_BASE_MS * 2 ** (castigados - 1));
}

/**
 * «3 minutos», «1 hora», «45 segundos».
 *
 * Una sola redaccion para los cuatro sitios que la enseñan -desbloqueo,
 * seguridad, restauracion y la cuenta atras-: cuatro formas de escribir la
 * misma espera es como el operador acaba sin saber si son cuatro esperas o una.
 *
 * Redondea hacia arriba a proposito. Decir «1 minuto» cuando faltan 61 segundos
 * hace que el operador lo intente antes de tiempo y se lleve otra negativa, que
 * parece un panel que no cumple lo que dice.
 */
export function textoEspera(ms: number): string {
  if (ms <= 0) return '';

  const segundos = Math.ceil(ms / 1_000);
  if (segundos < 60) return `${segundos} segundo${segundos === 1 ? '' : 's'}`;

  const minutos = Math.ceil(segundos / 60);
  if (minutos < 60) return `${minutos} minuto${minutos === 1 ? '' : 's'}`;

  const horas = Math.floor(minutos / 60);
  const resto = minutos % 60;
  const cabeza = `${horas} hora${horas === 1 ? '' : 's'}`;
  return resto === 0 ? cabeza : `${cabeza} y ${resto} minuto${resto === 1 ? '' : 's'}`;
}
