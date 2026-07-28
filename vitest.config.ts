import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@main': resolve('src/main'),
      '@shared': resolve('src/shared'),
      /*
       * El modulo real de Electron arrastra la resolucion del binario y anade
       * ~30 s al arranque de la suite. Ver test/stubs/electron.ts.
       */
      electron: resolve('test/stubs/electron.ts')
    }
  },
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: ['src/main/**/*.ts', 'src/shared/**/*.ts'],
      /* El arranque de la ventana lo cubre la prueba e2e, no las unitarias. */
      exclude: ['src/main/index.ts']

      /*
       * Umbrales objetivo: { lines: 70, functions: 70, branches: 60, statements: 70 }.
       *
       * Se activan en la Fase 2, cuando exista nucleo que cubrir: la firma HMAC,
       * la cola de ejecucion, el calculo de Take Profit y el reconciliador.
       * Ver docs/01-stack-tecnologico.md seccion 11.
       *
       * Hoy el codigo es esqueleto; fijar un umbral que pase con el esqueleto
       * seria un numero sin significado.
       */
    }
  }
});
