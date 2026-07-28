import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/*
 * Algunos entornos (la terminal integrada de VS Code, entre otros) exportan
 * ELECTRON_RUN_AS_NODE=1. Con esa variable, `npm run dev` arranca Electron como
 * Node puro y la ventana nunca abre: `app` queda indefinido.
 */
delete process.env['ELECTRON_RUN_AS_NODE'];

/**
 * Tres bundles independientes: principal, preload y renderer.
 *
 * `externalizeDepsPlugin` deja fuera del bundle todo lo que esta en
 * `dependencies` del package.json, porque el proceso principal lo resuelve en
 * runtime desde node_modules. Por eso el renderer no puede importar nada de ahi:
 * ver docs/01-stack-tecnologico.md seccion 15.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
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
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    build: {
      rollupOptions: { input: { index: resolve('src/preload/index.ts') } }
    }
  },

  renderer: {
    root: resolve('src/renderer'),
    plugins: [react(), tailwindcss()],
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
});
