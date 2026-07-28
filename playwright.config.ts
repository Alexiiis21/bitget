import { defineConfig } from '@playwright/test';

/*
 * Algunos entornos (la terminal integrada de VS Code, entre otros) exportan
 * ELECTRON_RUN_AS_NODE=1. Con esa variable, Electron arranca como Node puro:
 * `app` queda indefinido y el lanzador de Playwright falla con "bad option".
 * No es un fallo del proyecto, pero cuesta media hora de diagnostico cada vez.
 */
delete process.env['ELECTRON_RUN_AS_NODE'];

/**
 * Pruebas de extremo a extremo sobre la aplicacion empaquetada.
 * Nunca apuntan a la API real de Bitget: el exchange simulado de
 * test/mock-exchange/ se levanta antes de la suite.
 */
export default defineConfig({
  testDir: './test/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' }
});
