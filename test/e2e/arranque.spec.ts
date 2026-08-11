import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

/**
 * Humo de arranque: la unica prueba que ejerce los tres procesos a la vez.
 *
 * Verifica lo que ningun typecheck puede verificar: que la ventana abre, que el
 * preload expone la API y que el renderer recibe datos reales del proceso
 * principal por el contrato de IPC. Requiere `npm run build` previo.
 */
let app: ElectronApplication;
let ventana: Page;

test.beforeAll(async () => {
  app = await electron.launch({ args: ['./out/main/index.js'] });
  ventana = await app.firstWindow();
  await ventana.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
});

test('la ventana abre con el titulo del producto', async () => {
  await expect(ventana).toHaveTitle(/Panel de Control Bitget/);
});

test('el preload expone la API y no filtra Node al renderer', async () => {
  const superficie = await ventana.evaluate(() => ({
    tienePcb: typeof (window as unknown as { pcb?: unknown }).pcb === 'object',
    tieneRequire: typeof (window as unknown as { require?: unknown }).require,
    tieneProcess: typeof (window as unknown as { process?: unknown }).process
  }));

  expect(superficie.tienePcb).toBe(true);
  /* Aislamiento de contexto: el renderer no puede alcanzar Node. docs/01 seccion 2. */
  expect(superficie.tieneRequire).toBe('undefined');
  expect(superficie.tieneProcess).toBe('undefined');
});

test('el IPC responde con la informacion del sistema', async () => {
  const info = await ventana.evaluate(() => window.pcb.sistemaInfo());

  expect(info.appVersion).toBeTruthy();
  expect(info.electron).toBeTruthy();
  expect(info.carpetaDatos.length).toBeGreaterThan(0);
  expect(typeof info.portable).toBe('boolean');
});

test('el panel arranca bloqueado, con el numero que llega por IPC', async () => {
  const info = await ventana.evaluate(() => window.pcb.sistemaInfo());

  /* Lo primero que se ve es el desbloqueo: sin contrasena no hay credenciales. */
  await expect(ventana.getByText('Contraseña maestra')).toBeVisible();
  await expect(ventana.getByText(`PCB · PANEL #${info.numeroPanel}`)).toBeVisible();
});

test('detras del bloqueo esta el panel del diseno aprobado v2', async () => {
  /*
   * `cuentas` arranca vacío hasta que se desbloquea el almacén (a diferencia
   * del diseño anterior, que precargaba datos de muestra): lo que se puede
   * verificar sin desbloquear es el armazón -encabezado y barra lateral-, no
   * el contenido de las cuentas.
   */
  await expect(ventana.getByText('Panel de Control Bitget')).toBeVisible();
  await expect(ventana.getByText('EJECUCIÓN')).toBeVisible();
  await expect(ventana.getByText('PARÁMETROS')).toBeVisible();
});
