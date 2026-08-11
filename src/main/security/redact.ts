/**
 * Saneamiento de secretos antes de escribir un log o reportar un error.
 *
 * El riesgo real no es escribir `secretKey` a proposito: es que un error de
 * undici arrastre el objeto de la peticion completo -con sus cabeceras
 * ACCESS-*- hasta un `console.error`. Por eso hay dos defensas:
 *
 *   1. Por nombre de campo: se enmascara toda clave conocida como sensible.
 *   2. Por valor: los secretos vivos se registran al abrir el vault, y
 *      cualquier aparicion literal suya en un texto se sustituye, venga del
 *      campo que venga.
 *
 * docs/01-stack-tecnologico.md seccion 7.
 */

export const MARCA_REDACTADO = '[REDACTADO]';

/** Longitud minima para registrar un valor como secreto vivo. */
const LONGITUD_MINIMA_SECRETO = 8;
/** Corte de profundidad: evita colgarse con una estructura ciclica o enorme. */
const PROFUNDIDAD_MAXIMA = 8;

const CLAVES_SENSIBLES = new Set(
  [
    'apikey',
    'secretkey',
    'secret',
    'passphrase',
    'password',
    'contrasena',
    'pin',
    'access-key',
    'access-sign',
    'access-passphrase',
    'sign',
    'signature',
    'authorization',
    'token'
  ].map((c) => c.toLowerCase())
);

const secretosVivos = new Set<string>();

/**
 * Registra un valor como secreto vivo. Se llama al abrir el vault, una vez por
 * credencial. Los valores muy cortos se ignoran: sustituir una cadena de tres
 * caracteres destruiria texto legitimo del log.
 */
export function registrarSecreto(valor: string | undefined | null): void {
  if (typeof valor !== 'string') return;
  if (valor.length < LONGITUD_MINIMA_SECRETO) return;
  secretosVivos.add(valor);
}

/** Olvida los secretos registrados. Se llama al bloquear el vault. */
export function olvidarSecretos(): void {
  secretosVivos.clear();
}

/** Sustituye en un texto cualquier secreto vivo que aparezca literalmente. */
export function redactarTexto(texto: string): string {
  let salida = texto;
  for (const secreto of secretosVivos) {
    if (salida.includes(secreto)) salida = salida.split(secreto).join(MARCA_REDACTADO);
  }
  return salida;
}

/**
 * Enmascara una API key para mostrarla en la interfaz: primeros 2 y ultimos 4.
 *
 * Es el unico formato en el que una credencial cruza el IPC hacia el renderer.
 * docs/03 seccion 5.
 */
export function enmascararApiKey(apiKey: string): string {
  if (apiKey.length <= 6) return '•'.repeat(apiKey.length);
  return `${apiKey.slice(0, 2)}${'•'.repeat(8)}${apiKey.slice(-4)}`;
}

/**
 * Copia saneada de cualquier valor, lista para escribir en el log.
 *
 * No muta la entrada: el objeto original sigue sirviendo para operar.
 */
export function redactar(valor: unknown, profundidad = 0): unknown {
  if (profundidad > PROFUNDIDAD_MAXIMA) return MARCA_REDACTADO;

  if (typeof valor === 'string') return redactarTexto(valor);
  if (valor === null || typeof valor !== 'object') return valor;

  if (Array.isArray(valor)) return valor.map((item) => redactar(item, profundidad + 1));

  if (valor instanceof Error) {
    return {
      nombre: valor.name,
      mensaje: redactarTexto(valor.message),
      pila: valor.stack === undefined ? undefined : redactarTexto(valor.stack)
    };
  }

  const salida: Record<string, unknown> = {};
  for (const [clave, item] of Object.entries(valor)) {
    salida[clave] = CLAVES_SENSIBLES.has(clave.toLowerCase())
      ? MARCA_REDACTADO
      : redactar(item, profundidad + 1);
  }
  return salida;
}
