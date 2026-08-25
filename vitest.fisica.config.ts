/**
 * Pruebas fisicas de aceptacion: se opera de verdad contra Bitget.
 *
 * --------------------------------------------------------------------------
 * Por que no van con las demas
 * --------------------------------------------------------------------------
 * `test:red` y `test:staging` comprueban que el panel **habla** con Bitget:
 * conexion, firma, credenciales, alta de cuentas. Todas son de lectura o de
 * registro local y pasan siempre que haya red y credenciales validas.
 *
 * Estas otras **envian ordenes**. Se ejecutan contra el mercado simulado de
 * Bitget -`SUSDT-FUTURES`, saldo simulado y oficial-, y dependen de que la
 * cuenta tenga habilitado el trading demo. Mezclarlas con las anteriores
 * tendria dos efectos malos: una suite en rojo por un permiso que falta en
 * Bitget parecerian pruebas rotas, y quien quisiera comprobar solo la conexion
 * acabaria mandando ordenes sin pretenderlo.
 *
 * Se ejecutan a proposito, nombrandolas:
 *
 *   npm run test:fisica
 *
 * El entorno es `staging` -literal compilado, igual que el binario que se
 * entrega-, asi que las defensas de ese entorno estan encendidas: el cliente
 * solo acepta api.bitget.com y ninguna pieza de simulacion puede colarse.
 * Ver docs/adr/0007-entorno-staging-sin-docker.md.
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
    include: ['test/fisica/**/*.test.ts'],
    /* Una orden detras de otra: comparten el cupo de una sola IP. */
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
});
