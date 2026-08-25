/**
 * Runner del importador de subcuentas.
 *
 * No es una suite de pruebas: es la forma de ejecutar un script en TypeScript
 * que necesita los alias `@main`/`@shared` y el literal `__ENTORNO__`. Se
 * compila como staging a proposito -igual que el binario del cliente-, de modo
 * que el importador habla con la API real y ninguna pieza de simulacion puede
 * intervenir.
 *
 * Vive en su propio archivo para no contaminar `vitest.staging.config.ts`, que
 * es evidencia de auditoria y no debe incluir nada que escriba en la carpeta de
 * datos del operador.
 *
 * Se ejecuta con `npm run importar:subcuentas`.
 */
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __ENTORNO__: JSON.stringify('staging'), __MERCADO__: JSON.stringify('simulado') },
  resolve: {
    alias: {
      '@main': resolve('src/main'),
      '@shared': resolve('src/shared'),
      electron: resolve('test/stubs/electron.ts')
    }
  },
  test: {
    environment: 'node',
    include: ['scripts/importar-subcuentas.ts'],
    fileParallelism: false,
    /* Cada alta verifica contra Bitget: 10 cuentas son 20 peticiones. */
    testTimeout: 300_000,
    hookTimeout: 60_000
  }
});
