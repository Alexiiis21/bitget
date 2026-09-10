/**
 * La credencial de la subcuenta **UTA** para las pruebas físicas.
 *
 * Aparte de `test/red/credenciales-reales.ts` porque es otra cuenta: aquella es
 * la subcuenta Classic con la que se ejercitan las cinco funciones en dinero
 * simulado, y esta es la cuenta unificada. Tenerlas en el mismo módulo llevaría
 * antes o después a firmar una petición de V3 con la clave de la Classic, que es
 * un rechazo confuso de diagnosticar.
 *
 * Viene sellada como `superficie: 'v3'` de fábrica, y eso no es un atajo: es lo
 * que hace `Sesion.credencialSellada` en producción a partir del modo detectado.
 * Una credencial sin sellar hablaría V2 y la prueba mediría otra cosa.
 */
import type { Credencial } from '@main/bitget/rest/signer';

const VARIABLES = ['BITGET_UTA_API_KEY', 'BITGET_UTA_SECRET_KEY', 'BITGET_UTA_PASSPHRASE'] as const;

try {
  process.loadEnvFile('.env');
} catch {
  /* Sin .env se usan las variables del entorno, si las hay. */
}

const faltantes = VARIABLES.filter((v) => (process.env[v] ?? '') === '');

/** `true` si hay con qué hablar con la cuenta UTA. */
export const hayCredencialUta = faltantes.length === 0;

/**
 * Corta la prueba nombrando lo que falta.
 *
 * ==========================================================================
 * Falla, no se omite
 * ==========================================================================
 * Es el mismo criterio que `credenciales-reales.ts` aplica en staging, y por la
 * misma razón: estas pruebas son la evidencia de que la migración a UTA
 * funciona. Una suite omitida sale en verde con todo saltado, y de un vistazo
 * eso es indistinguible de una suite que probó algo. Enseñarlo como validación
 * sería engañar sin querer.
 *
 * Quien no tenga la cuenta UTA configurada, sencillamente no ejecuta este
 * archivo: se nombra en la línea de comandos, no entra en ningún ciclo
 * automático.
 */
export function exigirUta(): void {
  if (hayCredencialUta) return;

  throw new Error(
    `Faltan las credenciales de la subcuenta UTA: ${faltantes.join(', ')}.\n` +
      'Rellénelas en .env (ver .env.example) con una API Key emitida sobre una cuenta\n' +
      'ya migrada a UTA. Esta prueba no se omite: sin la cuenta no puede validar nada,\n' +
      'y una prueba omitida en verde se confunde con una que pasó.'
  );
}

/** Credencial de la cuenta UTA, ya sellada para hablar V3. */
export const credencialUta: Credencial = {
  apiKey: process.env['BITGET_UTA_API_KEY'] ?? '',
  secretKey: process.env['BITGET_UTA_SECRET_KEY'] ?? '',
  passphrase: process.env['BITGET_UTA_PASSPHRASE'] ?? '',
  superficie: 'v3'
};

/** UID declarado en `.env`, para comprobar que se habla con la cuenta que se cree. */
export const uidUtaEsperado = process.env['BITGET_UTA_UID'] ?? '';
