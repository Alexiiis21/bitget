/**
 * Traer las credenciales de una instalación anterior.
 *
 * Lo que se prueba aquí no es la comodidad de importar: es que **no se pierda
 * nada**. Una importación mal hecha sobrescribe el único archivo que guarda las
 * API keys, y de eso no se vuelve. Por eso las primeras tres pruebas son las
 * tres negativas.
 */
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  importarCredenciales,
  type DestinoImportacion
} from '@main/storage/importar-credenciales';

/** Un sobre con la forma que comprueba el importador, sin descifrar nada. */
const VAULT = JSON.stringify({
  formato: 'pcb-vault',
  version: 3,
  kdf: { nombre: 'scrypt', salt: 'x', n: 1, r: 1, p: 1 },
  cifrado: { iv: 'x', tag: 'x' },
  verificador: { iv: 'x', tag: 'x', dato: 'x' },
  payload: 'x',
  actualizadoEn: '2026-09-05T00:00:00.000Z'
});

const CUENTAS = JSON.stringify({
  version: 3,
  grupos: [{ id: 'g1', nombre: 'A', orden: 0, colapsado: false }],
  cuentas: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }]
});

let origen = '';
let destinoDir = '';
let destino: DestinoImportacion;

const rutasDe = (base: string): DestinoImportacion => ({
  base,
  vault: join(base, 'vault.enc'),
  vaultBak: join(base, 'vault.enc.bak'),
  cuentas: join(base, 'cuentas.json'),
  activos: join(base, 'activos.json')
});

beforeEach(async () => {
  const raiz = await mkdtemp(join(tmpdir(), 'pcb-import-'));
  origen = join(raiz, 'datos-staging');
  destinoDir = join(raiz, 'nuevo');
  await mkdir(origen);
  await mkdir(destinoDir);
  destino = rutasDe(destinoDir);
});

describe('lo que no se puede hacer nunca', () => {
  /*
   * La regla que sostiene todo lo demás. Dentro de `vault.enc` están las únicas
   * copias de las API keys: escribir encima no se deshace, y un `.bak` no salva
   * de haber pisado el archivo bueno.
   */
  it('no sobrescribe un almacén que ya existe en destino', async () => {
    await writeFile(destino.vault, 'EL ALMACEN BUENO', 'utf8');
    await writeFile(join(origen, 'vault.enc'), VAULT, 'utf8');

    const r = await importarCredenciales(origen, destino);

    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('ya-hay-vault');
    /* Y sobre todo: sigue estando el de antes, intacto. */
    expect(await readFile(destino.vault, 'utf8')).toBe('EL ALMACEN BUENO');
  });

  it('rechaza una carpeta sin vault, y nombra lo que hay que buscar', async () => {
    const r = await importarCredenciales(origen, destino);

    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('sin-vault');
    expect(r.mensaje).toContain('vault.enc');
  });

  /* Una carpeta con un archivo que se llama igual pero no lo es. */
  it('rechaza un vault que no tiene el formato del panel', async () => {
    await writeFile(join(origen, 'vault.enc'), '{"esto":"no es un vault"}', 'utf8');

    const r = await importarCredenciales(origen, destino);

    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('vault-ilegible');
  });

  it('rechaza la carpeta que el panel ya está usando', async () => {
    await writeFile(join(destinoDir, 'vault.enc.otro'), 'x', 'utf8');

    const r = await importarCredenciales(destinoDir, destino);

    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('misma-carpeta');
  });
});

describe('la importación', () => {
  beforeEach(async () => {
    await writeFile(join(origen, 'vault.enc'), VAULT, 'utf8');
    await writeFile(join(origen, 'cuentas.json'), CUENTAS, 'utf8');
    await writeFile(join(origen, 'activos.json'), '{"real":{}}', 'utf8');
    await writeFile(join(origen, 'vault.enc.bak'), VAULT, 'utf8');
  });

  it('copia el almacén, el registro y las casillas de activo', async () => {
    const r = await importarCredenciales(origen, destino);

    expect(r.ok).toBe(true);
    expect(await readFile(destino.vault, 'utf8')).toBe(VAULT);
    expect(await readFile(destino.cuentas, 'utf8')).toBe(CUENTAS);
    expect(await readFile(destino.activos, 'utf8')).toBe('{"real":{}}');
    expect(await readFile(destino.vaultBak, 'utf8')).toBe(VAULT);
  });

  /* Copia, no mueve: si algo sale mal, el sistema anterior sigue entero. */
  it('deja la carpeta de origen intacta', async () => {
    await importarCredenciales(origen, destino);

    expect(await readFile(join(origen, 'vault.enc'), 'utf8')).toBe(VAULT);
    expect(await readFile(join(origen, 'cuentas.json'), 'utf8')).toBe(CUENTAS);
  });

  it('dice cuántas subcuentas trajo', async () => {
    const r = await importarCredenciales(origen, destino);

    expect(r.cuentas).toBe(3);
  });

  /* La contraseña no viaja: el archivo va cifrado tal cual y se abre con la suya. */
  it('avisa de que hace falta la contraseña de esa instalación', async () => {
    const r = await importarCredenciales(origen, destino);

    expect(r.mensaje).toContain('contraseña maestra');
  });

  /*
   * `instancia.json` se queda fuera a proposito: lleva el numero de panel y la
   * identidad de esa instalacion, y dos paneles con el mismo numero es la
   * confusion que ese numero existe para evitar.
   */
  it('no copia la identidad de la instalación anterior', async () => {
    await writeFile(join(origen, 'instancia.json'), '{"numero":7}', 'utf8');

    await importarCredenciales(origen, destino);

    await expect(readFile(join(destinoDir, 'instancia.json'), 'utf8')).rejects.toThrow();
  });

  /* Un origen sin `cuentas.json` sigue siendo importable: el vault es lo que importa. */
  it('importa aunque falten los archivos accesorios', async () => {
    const soloVault = join(destinoDir, '..', 'solo-vault');
    await mkdir(soloVault);
    await writeFile(join(soloVault, 'vault.enc'), VAULT, 'utf8');

    const r = await importarCredenciales(soloVault, destino);

    expect(r.ok).toBe(true);
    expect(r.cuentas).toBeNull();
  });
});
