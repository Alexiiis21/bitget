/**
 * Los canales de respaldo, tal como los invoca el renderer.
 *
 * --------------------------------------------------------------------------
 * Por qué esto existe además de `respaldo-credenciales.test.ts`
 * --------------------------------------------------------------------------
 * Aquel prueba el módulo; esto prueba las **reglas que solo viven en
 * `handlers.ts`** y que no están en ninguna otra parte:
 *
 *  1. Que restaurar exija el panel bloqueado. Es el riesgo grave del diseño: con
 *     el almacén abierto en memoria, `Sesion` sigue apuntando a la misma ruta y
 *     la siguiente escritura del vault volcaría el contenido VIEJO sobre lo
 *     recién restaurado. La restauración se perdería en silencio y nadie se
 *     enteraría hasta necesitar una clave.
 *  2. Que sin la contraseña maestra del panel actual no se reemplace nada.
 *  3. Que ninguna ruta viaje desde el renderer.
 *
 * El doble de `electron` guarda los manejadores para poder invocarlos; `rutas()`
 * y `carpetaRespaldos()` se desvían a una carpeta temporal.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain as ipcMainDeElectron } from 'electron';
import { ClienteBitget } from '@main/bitget/rest/client';
import { Sesion } from '@main/ipc/sesion';
import type {
  RespaldoDisponibleIpc,
  ResultadoRespaldoIpc,
  ResultadoRestauracionIpc
} from '@shared/ipc-contract';

/*
 * En ejecución, `'electron'` es el doble de `test/stubs/electron.ts` —lo aliasa
 * `vitest.config.ts`—, y ese guarda los manejadores en vez de tirarlos. `tsc`
 * no conoce ese alias y comprueba contra los tipos reales de Electron, así que
 * el acceso se declara aquí en lugar de fingir que `IpcMain` los tiene.
 */
const ipcMain = ipcMainDeElectron as unknown as {
  manejadores: Map<string, unknown>;
  invocar(canal: string, ...args: unknown[]): unknown;
};

const KDF_PRUEBAS = { N: 16, r: 1, p: 1 };
const MAESTRA = 'la-de-este-panel';

/** Rellenado en `beforeEach`; lo leen los dobles de `paths`. */
let base = '';
let respaldos = '';

vi.mock('@main/storage/paths', async (original) => {
  const real = await original<typeof import('@main/storage/paths')>();
  return {
    ...real,
    esPortable: () => true,
    carpetaDatos: () => base,
    carpetaRespaldos: () => respaldos,
    rutas: () => ({
      base,
      lock: join(base, '.lock'),
      instancia: join(base, 'instancia.json'),
      vault: join(base, 'vault.enc'),
      vaultBak: join(base, 'vault.enc.bak'),
      cuentas: join(base, 'cuentas.json'),
      activos: join(base, 'activos.json'),
      ordenesPendientes: join(base, 'ordenes', 'pendientes.jsonl'),
      cacheSimbolos: join(base, 'cache', 'simbolos.json'),
      logs: join(base, 'logs')
    })
  };
});

const { registrarIpc } = await import('@main/ipc/handlers');

const INSTANCIA = {
  id: 'inst_1',
  numero: 3,
  nombre: 'Panel #3',
  creadoEn: '2026-09-01T00:00:00.000Z'
};

let raiz = '';
let cliente: ClienteBitget;
let sesion: Sesion;

const crearRespaldo = (): Promise<ResultadoRespaldoIpc> =>
  ipcMain.invocar('respaldo:crear') as Promise<ResultadoRespaldoIpc>;

const buscar = (): Promise<RespaldoDisponibleIpc | null> =>
  ipcMain.invocar('respaldo:buscar') as Promise<RespaldoDisponibleIpc | null>;

const restaurar = (maestra?: string): Promise<ResultadoRestauracionIpc> =>
  ipcMain.invocar('respaldo:restaurar', maestra) as Promise<ResultadoRestauracionIpc>;

beforeEach(async () => {
  ipcMain.manejadores.clear();
  raiz = await mkdtemp(join(tmpdir(), 'pcb-canales-'));
  base = join(raiz, 'datos');
  respaldos = join(raiz, 'Documentos', 'respaldos');

  cliente = new ClienteBitget({ host: 'http://127.0.0.1:1' });
  sesion = new Sesion(
    {
      vault: join(base, 'vault.enc'),
      cuentas: join(base, 'cuentas.json'),
      activos: join(base, 'activos.json')
    },
    cliente,
    { parametrosKdf: KDF_PRUEBAS }
  );
  registrarIpc(sesion, INSTANCIA, 'simulado', join(base, 'instancia.json'));
});

afterEach(async () => {
  sesion.cerrar();
  await cliente.cerrar();
  await rm(raiz, { recursive: true, force: true });
});

describe('respaldar desde el canal', () => {
  it('sin credenciales todavía lo dice, y no escribe nada', async () => {
    const r = await crearRespaldo();

    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('sin-vault');
    await expect(buscar()).resolves.toBeNull();
  });

  it('con almacén deja el archivo y lo nombra', async () => {
    await sesion.crear(MAESTRA);

    const r = await crearRespaldo();

    expect(r.ok).toBe(true);
    expect(r.nombre).toMatch(/^respaldo-pcb-\d{4}-\d{2}-\d{2}-\d{6}\.pcbak$/);
    expect(r.carpeta).toBe(respaldos);
  });

  /* Respaldar copia bytes cifrados: no abre el vault ni necesita la maestra. */
  it('funciona con el panel bloqueado', async () => {
    await sesion.crear(MAESTRA);
    sesion.cerrar();
    expect(await sesion.estadoVault()).toBe('bloqueado');

    const r = await crearRespaldo();

    expect(r.ok).toBe(true);
  });

  /*
   * RNF-001 en la frontera: lo que sale del proceso principal es fecha, versión
   * y número de cuentas. Ni un secreto, y tampoco la ruta del archivo —el
   * renderer no elige qué restaurar, solo pide que se restaure lo que se le
   * enseñó—.
   */
  it('lo que sale del canal no lleva secretos ni rutas de archivo', async () => {
    await sesion.crear(MAESTRA);
    await crearRespaldo();

    const hallado = await buscar();

    expect(hallado).not.toBeNull();
    expect(JSON.stringify(hallado)).not.toContain(MAESTRA);
    expect(Object.keys(hallado ?? {})).not.toContain('archivo');
    expect(hallado?.panelOrigen).toBe(3);
  });
});

describe('restaurar: las guardias del canal', () => {
  /*
   * El riesgo grave del diseño, y la razón de que esta comprobación esté en el
   * manejador y no solo en la pantalla: un canal invocable desde el renderer no
   * puede provocar que la restauración se pierda en silencio.
   */
  it('se niega con el panel desbloqueado', async () => {
    await sesion.crear(MAESTRA);
    await crearRespaldo();
    expect(await sesion.estadoVault()).toBe('desbloqueado');

    const r = await restaurar(MAESTRA);

    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('panel-abierto');
    expect(r.mensaje).toContain('Bloquee el panel');
  });

  it('sin respaldo en la carpeta lo dice, y no toca el almacén', async () => {
    await sesion.crear(MAESTRA);
    const antes = await readFile(join(base, 'vault.enc'), 'utf8');
    sesion.cerrar();

    const r = await restaurar(MAESTRA);

    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('no-existe');
    expect(await readFile(join(base, 'vault.enc'), 'utf8')).toBe(antes);
  });

  /* Con almacén, la maestra de *este* panel es lo que autoriza el reemplazo. */
  it('una maestra equivocada no reemplaza nada', async () => {
    await sesion.crear(MAESTRA);
    await crearRespaldo();
    const antes = await readFile(join(base, 'vault.enc'), 'utf8');
    sesion.cerrar();

    const r = await restaurar('la-que-no-es');

    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('maestra-incorrecta');
    expect(await readFile(join(base, 'vault.enc'), 'utf8')).toBe(antes);
  });

  it('sin maestra ni siquiera llega a intentarlo', async () => {
    await sesion.crear(MAESTRA);
    await crearRespaldo();
    sesion.cerrar();

    /* `esquemaContrasena` rechaza `undefined` en la frontera: viaja como excepción. */
    await expect(restaurar()).rejects.toThrow();
  });

  it('con la maestra correcta reemplaza y aparta el anterior', async () => {
    await sesion.crear(MAESTRA);
    await crearRespaldo();
    sesion.cerrar();

    const r = await restaurar(MAESTRA);

    expect(r.ok).toBe(true);
    expect(r.reemplazo).toMatch(/^vault\.enc\.reemplazado-/);
    /* Y el que se apartó sigue ahí: apartar no es borrar. */
    await expect(readFile(join(base, r.reemplazo ?? ''), 'utf8')).resolves.toContain('pcb-vault');
  });

  /*
   * Un panel recién estrenado no tiene nada que destruir: se restaura de un
   * clic, sin contraseña. Es el requisito llevado hasta el final.
   */
  it('sin almacén en destino restaura sin pedir contraseña', async () => {
    await sesion.crear(MAESTRA);
    await crearRespaldo();
    sesion.cerrar();
    /* Se simula la instalación nueva: misma carpeta de respaldos, sin almacén. */
    await rm(join(base, 'vault.enc'));

    const r = await restaurar();

    expect(r.ok).toBe(true);
    expect(r.reemplazo).toBeNull();
    await expect(readFile(join(base, 'vault.enc'), 'utf8')).resolves.toContain('pcb-vault');
  });

  it('un respaldo de una versión futura se rechaza sin tocar nada', async () => {
    await sesion.crear(MAESTRA);
    const creado = await crearRespaldo();
    const antes = await readFile(join(base, 'vault.enc'), 'utf8');
    sesion.cerrar();

    const ruta = join(respaldos, creado.nombre ?? '');
    const archivo = JSON.parse(await readFile(ruta, 'utf8'));
    archivo.version = 99;
    await writeFile(ruta, JSON.stringify(archivo), 'utf8');
    await writeFile(join(respaldos, 'respaldo-pcb-ultimo.pcbak'), JSON.stringify(archivo), 'utf8');

    const r = await restaurar(MAESTRA);

    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('version-futura');
    expect(await readFile(join(base, 'vault.enc'), 'utf8')).toBe(antes);
  });
});
