/**
 * Runner del diagnostico de la carpeta de datos (`scripts/diagnosticar-datos.ts`).
 *
 * No es una suite de pruebas: es la forma de ejecutar un script en TypeScript
 * con los alias `@main`/`@shared`, reutilizando el codigo real del vault en vez
 * de una segunda implementacion del formato. El script solo lee: no abre
 * ninguna conexion ni escribe en la carpeta que revisa.
 *
 * Se ejecuta con `npm run diagnosticar:datos`.
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
    include: ['scripts/diagnosticar-datos.ts'],
    /* scrypt con los parametros reales: ~0,5 s por apertura, dos vaults. */
    testTimeout: 60_000
  }
});
