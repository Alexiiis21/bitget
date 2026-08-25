import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { esEntorno, type Entorno, type MercadoCompilado } from './src/shared/entorno';

/*
 * Algunos entornos (la terminal integrada de VS Code, entre otros) exportan
 * ELECTRON_RUN_AS_NODE=1. Con esa variable, `npm run dev` arranca Electron como
 * Node puro y la ventana nunca abre: `app` queda indefinido.
 */
delete process.env['ELECTRON_RUN_AS_NODE'];

/**
 * Cada modo declara dos cosas, y las dos salen del `--mode` de la linea de
 * comandos y de ningun otro sitio: **contra que backend** habla el panel y
 * **contra que mercado** de Bitget opera.
 *
 *   npm run dev                       development   dev      simulado
 *   npm run build                     production    dev      simulado
 *   npm run dev:staging               staging       staging  simulado
 *   npm run package:portable:staging  staging       staging  simulado
 *   npm run package:portable:real     staging-real  staging  real
 *
 * Son dos ejes distintos: `staging` significa «API real de Bitget, vault real,
 * cero simulacion», y aun asi debe poder operar contra el mercado simulado
 * mientras se prueba. Por eso el mercado no se deduce del entorno; tiene su
 * propio modo y su propio binario, con el mercado en el nombre del archivo.
 *
 * Que `production` mapee a `dev` no es un descuido: hoy el unico backend
 * completo es el de demostracion, y `npm run build` sigue produciendo el panel
 * de demostracion que producia antes de existir staging. Cuando el proceso
 * principal cubra posiciones y ordenes (Fase 6), este mapeo es la linea que hay
 * que revisar.
 */
const MODOS: Record<string, { entorno: Entorno; mercado: MercadoCompilado }> = {
  development: { entorno: 'dev', mercado: 'simulado' },
  production: { entorno: 'dev', mercado: 'simulado' },
  staging: { entorno: 'staging', mercado: 'simulado' },
  'staging-real': { entorno: 'staging', mercado: 'real' }
};

/**
 * Un modo desconocido cae en lo inofensivo: demostracion y mercado simulado.
 *
 * Es la misma regla que sigue todo lo demas aqui. De los dos errores posibles
 * ante un `--mode` mal escrito, construir un panel de pruebas es el que no
 * cuesta dinero.
 */
function configuracionDeModo(mode: string): { entorno: Entorno; mercado: MercadoCompilado } {
  return MODOS[mode] ?? { entorno: 'dev', mercado: 'simulado' };
}

/**
 * Tres bundles independientes: principal, preload y renderer.
 *
 * `externalizeDepsPlugin` deja fuera del bundle todo lo que esta en
 * `dependencies` del package.json, porque el proceso principal lo resuelve en
 * runtime desde node_modules. Por eso el renderer no puede importar nada de ahi:
 * ver docs/01-stack-tecnologico.md seccion 15.
 */
export default defineConfig(({ mode }) => {
  const { entorno, mercado } = configuracionDeModo(mode);

  /*
   * El archivo `.env` del modo es la configuracion visible del entorno; el
   * literal `__ENTORNO__` es lo que manda. Se cotejan para que no puedan
   * separarse en silencio: un `.env.staging` que pidiera el servicio de
   * demostracion produciria un binario etiquetado como staging enseñando datos
   * inventados, que es exactamente el fallo que este entorno existe para
   * impedir.
   */
  const env = loadEnv(mode, process.cwd(), '');
  const declarado = env['APP_ENV'];
  if (declarado !== undefined && declarado !== '') {
    if (!esEntorno(declarado)) {
      throw new Error(`APP_ENV="${declarado}" no es un entorno valido. Use dev o staging.`);
    }
    if (declarado !== entorno) {
      throw new Error(
        `El modo "${mode}" corresponde al entorno "${entorno}", pero el archivo .env del ` +
          `modo declara APP_ENV="${declarado}". Corrija uno de los dos.`
      );
    }
  }
  if (entorno === 'staging' && env['VITE_PANEL_SERVICE'] !== 'ipc') {
    throw new Error(
      'En staging, VITE_PANEL_SERVICE debe ser "ipc". Revise .env.staging: el panel de ' +
        'staging no puede montarse sobre el servicio de demostracion.'
    );
  }

  /* Dos literales, compartidos por los tres bundles. Ver src/shared/entorno.ts. */
  const define = {
    __ENTORNO__: JSON.stringify(entorno),
    __MERCADO__: JSON.stringify(mercado)
  };

  if (mercado === 'real') {
    console.warn(
      `[PCB] mode="${mode}" — este binario opera contra el MERCADO REAL de Bitget: ` +
        'sus ordenes mueven dinero de verdad.'
    );
  }

  return {
    main: {
      plugins: [externalizeDepsPlugin()],
      define,
      resolve: {
        alias: {
          '@main': resolve('src/main'),
          '@shared': resolve('src/shared')
        }
      },
      build: {
        rollupOptions: { input: { index: resolve('src/main/index.ts') } }
      }
    },

    preload: {
      plugins: [externalizeDepsPlugin()],
      define,
      resolve: {
        alias: { '@shared': resolve('src/shared') }
      },
      build: {
        rollupOptions: { input: { index: resolve('src/preload/index.ts') } }
      }
    },

    renderer: {
      root: resolve('src/renderer'),
      /*
       * Vite busca los archivos `.env` en `root`, que aqui es `src/renderer/`.
       * Sin esto, el renderer no veria `.env.staging` y `VITE_PANEL_SERVICE`
       * llegaria vacio al bundle.
       */
      envDir: resolve('.'),
      plugins: [react()],
      define,
      resolve: {
        alias: {
          '@': resolve('src/renderer/src'),
          '@shared': resolve('src/shared')
        }
      },
      build: {
        rollupOptions: { input: { index: resolve('src/renderer/index.html') } }
      }
    }
  };
});
