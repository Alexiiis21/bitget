import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/*
 * La suite no corre en staging, y no es una precaucion simbolica: casi todas
 * estas pruebas construyen clientes contra el exchange simulado, escriben
 * vaults de usar y tirar y borran carpetas de datos. Ejecutarlas apuntando al
 * entorno donde viven las credenciales reales es justo lo que no debe poder
 * hacerse por descuido.
 */
if (process.env['APP_ENV'] === 'staging') {
  throw new Error(
    'Las pruebas no se ejecutan en staging: ese entorno solo habla con la API real de ' +
      'Bitget. Ejecute la suite sin APP_ENV, o con APP_ENV=dev.'
  );
}

export default defineConfig({
  /* Las pruebas corren siempre en dev. Ver src/shared/entorno.ts. */
  define: { __ENTORNO__: JSON.stringify('dev'), __MERCADO__: JSON.stringify('simulado') },
  resolve: {
    alias: {
      '@main': resolve('src/main'),
      '@shared': resolve('src/shared'),
      /* El store del renderer es JavaScript corriente y se prueba como tal. */
      '@': resolve('src/renderer/src'),
      /*
       * El modulo real de Electron arrastra la resolucion del binario y anade
       * ~30 s al arranque de la suite. Ver test/stubs/electron.ts.
       */
      electron: resolve('test/stubs/electron.ts')
    }
  },
  test: {
    environment: 'node',
    /*
     * Las pruebas de red salen a api.bitget.com de verdad, y por eso no corren
     * en el ciclo normal: dependen de que haya conexion y del estado del
     * exchange. Se piden a proposito con `npm run test:red`, que las nombra en
     * la linea de comandos; solo entonces se anaden al include.
     */
    include: [
      'test/unit/**/*.test.ts',
      'test/integration/**/*.test.ts',
      /* El store del renderer: misma suite, carpeta propia por la frontera. */
      'test/renderer/**/*.test.ts',
      ...(process.argv.some((arg) => arg.includes('test/red')) ? ['test/red/**/*.test.ts'] : [])
    ],
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
