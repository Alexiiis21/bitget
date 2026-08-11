import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { esEntorno, type Entorno } from './src/shared/entorno';

/*
 * Algunos entornos (la terminal integrada de VS Code, entre otros) exportan
 * ELECTRON_RUN_AS_NODE=1. Con esa variable, `npm run dev` arranca Electron como
 * Node puro y la ventana nunca abre: `app` queda indefinido.
 */
delete process.env['ELECTRON_RUN_AS_NODE'];

/**
 * El entorno sale del `--mode` de la linea de comandos, y de ningun otro sitio.
 *
 *   npm run dev           -> mode `development` -> entorno `dev`
 *   npm run dev:staging   -> mode `staging`     -> entorno `staging`
 *   npm run build         -> mode `production`  -> entorno `dev`
 *
 * Que `production` mapee a `dev` no es un descuido: hoy el unico backend
 * completo es el de demostracion, y `npm run build` sigue produciendo el panel
 * de demostracion que producia antes de existir staging. Cuando el proceso
 * principal cubra posiciones y ordenes (Fase 6), este mapeo es la linea que hay
 * que revisar.
 */
function entornoDeModo(mode: string): Entorno {
  return mode === 'staging' ? 'staging' : 'dev';
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
  const entorno = entornoDeModo(mode);

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

  /* Un unico literal, compartido por los tres bundles. Ver src/shared/entorno.ts. */
  const define = { __ENTORNO__: JSON.stringify(entorno) };

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
