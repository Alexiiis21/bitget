/**
 * Escritura atomica.
 *
 * Lo que se prueba es la concurrencia: hasta el 26/09/2026 dos escrituras del
 * mismo archivo a la vez compartian el temporal `.tmp`, y una de las dos fallaba
 * al renombrar un temporal que la otra ya se habia llevado.
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { escribirAtomico } from '@main/storage/atomic-write';

let carpeta: string;

beforeEach(async () => {
  carpeta = await mkdtemp(join(tmpdir(), 'pcb-atomico-'));
});

afterEach(async () => {
  await rm(carpeta, { recursive: true, force: true });
});

describe('escribirAtomico', () => {
  it('varias escrituras simultaneas del mismo archivo terminan todas, y gana la ultima', async () => {
    const ruta = join(carpeta, 'cuentas.json');

    await Promise.all(Array.from({ length: 10 }, (_, n) => escribirAtomico(ruta, `v${n}`)));

    expect(await readFile(ruta, 'utf8')).toBe('v9');
    /* Ningun temporal huerfano. */
    expect(await readdir(carpeta)).toEqual(['cuentas.json']);
  });

  it('una escritura que falla no bloquea las siguientes', async () => {
    const ruta = join(carpeta, 'cuentas.json');
    /* Un contenido que `writeFile` no acepta: falla a mitad, sobre la misma ruta. */
    const fallida = escribirAtomico(ruta, 123 as unknown as string);
    const siguiente = escribirAtomico(ruta, 'ok');

    await expect(fallida).rejects.toThrow();
    await siguiente;

    expect(await readFile(ruta, 'utf8')).toBe('ok');
    expect(await readdir(carpeta)).toEqual(['cuentas.json']);
  });
});
