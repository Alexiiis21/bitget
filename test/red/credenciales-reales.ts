/**
 * Credenciales reales para las pruebas que salen a la red.
 *
 * --------------------------------------------------------------------------
 * Por que existe: una suite que se omite parece una suite que pasa
 * --------------------------------------------------------------------------
 * Estas pruebas necesitan una API Key de verdad, y en una maquina que no la
 * tenga no pueden correr. La salida obvia -`describe.skipIf`- tiene un problema
 * serio cuando lo que se esta haciendo es demostrarle a alguien que el panel
 * habla con Bitget: sin `.env`, vitest imprime la suite en verde con todo
 * omitido, y de un vistazo eso es indistinguible de una suite que ha probado
 * algo. En una auditoria, ensenar eso como prueba de conexion seria enganar sin
 * querer.
 *
 * De ahi las dos velocidades:
 *
 *   `npm run test:red`      dev.     Sin credenciales se omite, para no
 *                                    estorbar en una maquina cualquiera.
 *   `npm run test:staging`  staging. Sin credenciales **falla**, ruidosamente,
 *                                    nombrando lo que falta.
 *
 * La distincion no se controla con una variable de entorno que alguien pueda
 * dejarse puesta: se lee de `__ENTORNO__`, que es un literal que Vite compila
 * segun el archivo de configuracion con el que se invoco la suite. La suite de
 * staging *es* de staging, igual que el binario. Ver src/shared/entorno.ts.
 */
import { esStaging } from '@shared/entorno';
import type { Credencial } from '@main/bitget/rest/signer';

const VARIABLES = ['BITGET_DEMO_API_KEY', 'BITGET_DEMO_SECRET_KEY', 'BITGET_DEMO_PASSPHRASE'] as const;

try {
  process.loadEnvFile('.env');
} catch {
  /* Sin .env se usan las variables del entorno, si las hay. */
}

const faltantes = VARIABLES.filter((v) => (process.env[v] ?? '') === '');

/**
 * En staging, la ausencia de credenciales es un fallo de configuracion de la
 * prueba, no una circunstancia de la maquina. Se corta aqui -al cargar el
 * modulo- para que el mensaje salga antes que cualquier resultado verde.
 */
if (esStaging() && faltantes.length > 0) {
  throw new Error(
    `Faltan credenciales reales para la suite de staging: ${faltantes.join(', ')}.\n` +
      'Copie .env.example a .env y rellenelo con una cuenta real de Bitget.\n' +
      'Esta suite no se omite: sin credenciales no puede demostrar nada, y una ' +
      'suite omitida en verde se confunde con una suite que paso.'
  );
}

/** Credencial real, o cadenas vacias si no hay `.env` (solo posible fuera de staging). */
export const credencialReal: Credencial = {
  apiKey: process.env['BITGET_DEMO_API_KEY'] ?? '',
  secretKey: process.env['BITGET_DEMO_SECRET_KEY'] ?? '',
  passphrase: process.env['BITGET_DEMO_PASSPHRASE'] ?? ''
};

/** `true` si hay las tres claves. En staging siempre lo es: si no, no se llega aqui. */
export const hayCredenciales = faltantes.length === 0;

/**
 * UID esperado, si se declaro en `.env`.
 *
 * No participa en la firma. Sirve para una comprobacion que en una demostracion
 * vale mas que cualquier otra: que la cuenta que responde es **la que se
 * esperaba**, y no otra credencial que quedo en el entorno.
 */
export const uidEsperado = process.env['BITGET_DEMO_UID'] ?? '';
