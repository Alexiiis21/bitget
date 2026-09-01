/**
 * Identidad del panel (`instancia.json`).
 *
 * --------------------------------------------------------------------------
 * Que se prueba aqui y por que importa
 * --------------------------------------------------------------------------
 * El numero que se ve en la cabecera -«#3»- es como el operador sabe en que
 * panel esta trabajando, y hasta el 28/08/2026 el campo se dejaba teclear pero
 * el cambio no sobrevivia a un reinicio: no habia nada que lo escribiera. Un
 * rotulo que no recuerda es peor que uno que no se deja tocar, porque hace creer
 * al operador que este panel es el #3 cuando ha vuelto a ser el #1.
 *
 * Lo que se prueba: que el numero se guarda, que se lee al arrancar y que
 * cambiarlo **no toca el resto de la identidad** -`id` y `creadoEn` son de la
 * instalacion, no del operador, y con ellos se distinguen dos carpetas de datos
 * copiadas de la misma-.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cargarInstancia, fijarNumeroPanel } from '@main/storage/instancia';

let carpeta: string;
let ruta: string;

beforeEach(async () => {
  carpeta = await mkdtemp(join(tmpdir(), 'pcb-instancia-'));
  ruta = join(carpeta, 'instancia.json');
});

afterEach(async () => {
  await rm(carpeta, { recursive: true, force: true });
});

describe('la primera vez', () => {
  it('crea la identidad y la deja escrita', async () => {
    const instancia = await cargarInstancia(ruta);

    expect(instancia.numero).toBe(1);
    expect(JSON.parse(await readFile(ruta, 'utf8'))).toEqual(instancia);
  });
});

describe('cambiar el numero del panel', () => {
  it('se guarda y sigue puesto al volver a arrancar', async () => {
    const instancia = await cargarInstancia(ruta);

    await fijarNumeroPanel(ruta, instancia, 7);

    /* Lo ve el proceso que ya estaba en marcha... */
    expect(instancia.numero).toBe(7);
    /* ...y el que arranca despues, que es lo que fallaba. */
    expect((await cargarInstancia(ruta)).numero).toBe(7);
  });

  it('no toca el resto de la identidad', async () => {
    const instancia = await cargarInstancia(ruta);
    const { id, creadoEn, nombre } = instancia;

    await fijarNumeroPanel(ruta, instancia, 42);

    const releida = await cargarInstancia(ruta);
    expect(releida.id).toBe(id);
    expect(releida.creadoEn).toBe(creadoEn);
    expect(releida.nombre).toBe(nombre);
  });

  it('el ultimo valor es el que queda', async () => {
    const instancia = await cargarInstancia(ruta);

    await fijarNumeroPanel(ruta, instancia, 2);
    await fijarNumeroPanel(ruta, instancia, 23);
    await fijarNumeroPanel(ruta, instancia, 234);

    expect((await cargarInstancia(ruta)).numero).toBe(234);
  });
});

describe('un archivo ilegible', () => {
  /*
   * No se sobrescribe al leerlo: el panel arranca con una identidad de
   * emergencia y el archivo se conserva. Machacarlo perderia el numero que el
   * operador ya tiene asociado a esta maquina.
   */
  it('arranca igual y deja el archivo donde estaba', async () => {
    await writeFile(ruta, '{ esto no es json', 'utf8');

    const instancia = await cargarInstancia(ruta);

    expect(instancia.numero).toBe(1);
    expect(await readFile(ruta, 'utf8')).toBe('{ esto no es json');
  });
});
