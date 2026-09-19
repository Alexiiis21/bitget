/**
 * El respaldo que se hace solo.
 *
 * Lo que importa aquí no es que escriba —eso ya lo prueba
 * `respaldo-credenciales.test.ts`—, sino **que no estorbe**: que una ráfaga de
 * altas no deje veinte archivos, que dos escrituras no se pisen, y sobre todo
 * que un fallo suyo no salga hacia quien lo disparó. El respaldo automático es
 * un añadido; el alta es el trabajo.
 */
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { programarRespaldo } from '@main/storage/respaldo-automatico';
import { NOMBRE_ALIAS } from '@main/storage/respaldo-credenciales';

const VAULT = JSON.stringify({
  formato: 'pcb-vault',
  version: 2,
  kdf: { algoritmo: 'scrypt', N: 16, r: 1, p: 1, longitudClave: 32, salt: 'x' },
  cifrado: { algoritmo: 'aes-256-gcm', iv: 'x', tag: 'x' },
  verificador: { iv: 'x', tag: 'x', dato: 'x' },
  payload: 'x',
  actualizadoEn: '2026-09-13T00:00:00.000Z'
});

const OPCIONES = {
  appVersion: '0.9.0',
  entorno: 'staging',
  mercado: 'real' as const,
  panelOrigen: 1
};

let raiz = '';
let datos = '';
let respaldos = '';
let origen: { vault: string; cuentas: string; activos: string };

/** Cuántos respaldos fechados hay escritos, sin contar el alias. */
const fechados = async (): Promise<number> => {
  try {
    return (await readdir(respaldos)).filter((n) => n !== NOMBRE_ALIAS).length;
  } catch {
    return 0;
  }
};

beforeEach(async () => {
  vi.useFakeTimers();
  raiz = await mkdtemp(join(tmpdir(), 'pcb-auto-'));
  datos = join(raiz, 'datos');
  respaldos = join(raiz, 'respaldos');
  await mkdir(datos);
  origen = {
    vault: join(datos, 'vault.enc'),
    cuentas: join(datos, 'cuentas.json'),
    activos: join(datos, 'activos.json')
  };
  await writeFile(origen.vault, VAULT, 'utf8');
  await writeFile(origen.cuentas, JSON.stringify({ version: 4, grupos: [], cuentas: [] }), 'utf8');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('agrupar la ráfaga', () => {
  /*
   * El caso real: el operador pega cinco subcuentas seguidas. Sin agrupar
   * serían cinco archivos, y la poda empezaría a tirar de los antiguos por una
   * sola sesión de altas.
   */
  it('varias peticiones seguidas escriben un solo respaldo', async () => {
    const auto = programarRespaldo({
      origen,
      carpeta: respaldos,
      respaldo: OPCIONES,
      esperaMs: 3000
    });

    auto.pedir();
    auto.pedir();
    auto.pedir();
    await vi.advanceTimersByTimeAsync(3000);
    await auto.parar();

    expect(await fechados()).toBe(1);
  });

  it('no escribe nada antes de que pase la espera', async () => {
    const auto = programarRespaldo({
      origen,
      carpeta: respaldos,
      respaldo: OPCIONES,
      esperaMs: 3000
    });

    auto.pedir();
    await vi.advanceTimersByTimeAsync(2000);

    expect(await fechados()).toBe(0);
    await auto.parar();
  });

  /*
   * Lo que sale de cada tanda es un archivo, pero dos tandas son dos archivos:
   * los fechados de sesiones distintas no se pisan, que es lo que permite que
   * una baja equivocada no se lleve por delante el respaldo bueno.
   *
   * Se drena con `parar()` entre las dos en vez de encadenarlas: la escritura
   * es E/S de verdad y no una microtarea, así que sin drenar el reloj podría
   * cambiar antes de que la primera llegue a nombrar su archivo.
   */
  it('dos tandas separadas son dos respaldos', async () => {
    const config = { origen, carpeta: respaldos, respaldo: OPCIONES, esperaMs: 1000 };

    const primera = programarRespaldo(config);
    primera.pedir();
    await vi.advanceTimersByTimeAsync(1000);
    await primera.parar();
    expect(await fechados()).toBe(1);

    vi.setSystemTime(new Date(Date.now() + 5000));

    const segunda = programarRespaldo(config);
    segunda.pedir();
    await vi.advanceTimersByTimeAsync(1000);
    await segunda.parar();

    expect(await fechados()).toBe(2);
  });
});

describe('lo que no puede pasar', () => {
  /*
   * La garantía que sostiene el enganche en `Sesion`: si respaldar falla, el
   * alta que lo disparó no se entera. `pedir()` es síncrono y no lanza.
   */
  it('un fallo al escribir no se propaga a quien pidió el respaldo', async () => {
    const fallos: unknown[] = [];
    const auto = programarRespaldo({
      origen,
      /* Una ruta imposible: un archivo donde debería haber una carpeta. */
      carpeta: join(origen.vault, 'no-puede-ser-carpeta'),
      respaldo: OPCIONES,
      esperaMs: 100,
      alFallar: (e) => fallos.push(e)
    });

    expect(() => auto.pedir()).not.toThrow();
    await vi.advanceTimersByTimeAsync(100);
    await auto.parar();

    expect(fallos.length).toBeGreaterThan(0);
  });

  /*
   * Un panel recién instalado no tiene almacén, y eso no es un fallo del que
   * avisar: es lo normal hasta la primera API key.
   */
  it('sin almacén no avisa de nada', async () => {
    const fallos: unknown[] = [];
    const auto = programarRespaldo({
      origen: { ...origen, vault: join(datos, 'no-existe.enc') },
      carpeta: respaldos,
      respaldo: OPCIONES,
      esperaMs: 100,
      alFallar: (e) => fallos.push(e)
    });

    auto.pedir();
    await vi.advanceTimersByTimeAsync(100);
    await auto.parar();

    expect(fallos).toHaveLength(0);
    expect(await fechados()).toBe(0);
  });

  /* Tras `parar()` no queda nada programado: el panel se está cerrando. */
  it('no programa nada después de parar', async () => {
    const auto = programarRespaldo({
      origen,
      carpeta: respaldos,
      respaldo: OPCIONES,
      esperaMs: 100
    });
    await auto.parar();

    auto.pedir();
    await vi.advanceTimersByTimeAsync(1000);

    expect(await fechados()).toBe(0);
  });
});

describe('al cerrar el panel', () => {
  /*
   * El último alta es justo la que no puede quedarse sin respaldar: es la que
   * el operador acaba de hacer antes de cerrar.
   */
  it('parar escribe lo que estaba esperando su turno', async () => {
    const auto = programarRespaldo({
      origen,
      carpeta: respaldos,
      respaldo: OPCIONES,
      esperaMs: 3000
    });

    auto.pedir();
    /* Sin dejar que venza la espera: se cierra el panel de inmediato. */
    await auto.parar();

    expect(await fechados()).toBe(1);
  });

  it('parar sin nada pendiente no escribe nada', async () => {
    const auto = programarRespaldo({
      origen,
      carpeta: respaldos,
      respaldo: OPCIONES,
      esperaMs: 3000
    });

    await auto.parar();

    expect(await fechados()).toBe(0);
  });
});
