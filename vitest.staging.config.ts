/**
 * Suite de staging: el codigo compilado como staging, contra la API real.
 *
 * --------------------------------------------------------------------------
 * Que la diferencia de `vitest.config.ts`
 * --------------------------------------------------------------------------
 * La suite normal compila `__ENTORNO__` como `'dev'` y habla con el exchange
 * simulado. Esta compila `__ENTORNO__` como `'staging'`, que es **el mismo
 * literal que lleva el binario que se le entrega al cliente**, y solo incluye
 * `test/red/`, que sale a api.bitget.com.
 *
 * La diferencia no es cosmetica. Con `__ENTORNO__ === 'staging'` se encienden
 * las tres defensas que el bundle de staging lleva puestas:
 *
 *   - `prohibidoEnStaging()` hace estallar cualquier pieza de simulacion que se
 *     invoque, incluido el exchange simulado. Por eso `test/integration/` no
 *     puede colarse aqui: no es que se excluya por politica, es que no
 *     arrancaria.
 *   - `ClienteBitget` rechaza cualquier host que no sea api.bitget.com, asi que
 *     no hay forma de apuntar la suite a un servidor propio.
 *   - `credenciales-reales.ts` exige credenciales de verdad en lugar de
 *     omitirse en silencio.
 *
 * Es decir: si esta suite pasa, lo hizo hablando con Bitget. No hay una
 * configuracion en la que pase sin hacerlo.
 *
 * Se ejecuta con `npm run test:staging`. Ver docs/adr/0007-entorno-staging-sin-docker.md.
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
    include: ['test/red/**/*.test.ts'],
    /*
     * En serie y sin paralelismo entre archivos.
     *
     * Todas las pruebas comparten el cupo de peticiones de una sola IP frente a
     * Bitget. Dos archivos a la vez se quitarian el cupo entre ellos y la suite
     * fallaria con 429 que no dicen nada sobre el panel.
     */
    fileParallelism: false,
    /* La red real no responde en los 5 s por defecto de forma fiable. */
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
