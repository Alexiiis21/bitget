/**
 * La bitácora de lo que el panel le pide a Bitget.
 *
 * Es lo que impide que un cierre o un ajuste del propio panel llegue a
 * Telegram como si lo hubiera hecho el cliente, así que lo que se prueba es que
 * no se pierda nada: ni con escrituras simultáneas, ni al purgar, ni entre
 * sesiones, ni con una línea rota por un apagón.
 */
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BitacoraAcciones, huellaCuenta, type AccionPropia } from '@main/storage/bitacora-acciones';

let carpeta: string;
let ruta: string;
beforeEach(async () => {
  carpeta = await mkdtemp(join(tmpdir(), 'pcb-bitacora-'));
  ruta = join(carpeta, 'acciones', 'propias.jsonl');
});
afterEach(async () => {
  await rm(carpeta, { recursive: true, force: true });
});

const accion = (ts: number, ruta2 = '/api/v2/mix/order/close-positions'): AccionPropia => ({
  ts,
  cuenta: 'h',
  metodo: 'POST',
  ruta: ruta2,
  cuerpo: { symbol: 'BTCUSDT' }
});

describe('BitacoraAcciones', () => {
  it('cien escrituras a la vez quedan enteras, en memoria y en disco', async () => {
    const b = new BitacoraAcciones(ruta);
    await Promise.all(Array.from({ length: 100 }, (_, i) => b.anotar(accion(i))));

    expect(await b.leerDesde(0)).toHaveLength(100);
    const lineas = (await readFile(ruta, 'utf8')).trim().split('\n');
    expect(lineas).toHaveLength(100);
    for (const l of lineas) expect(() => JSON.parse(l) as unknown).not.toThrow();
  });

  it('otra sesión lee lo que escribió la anterior', async () => {
    await new BitacoraAcciones(ruta).anotar(accion(5));
    expect(await new BitacoraAcciones(ruta).leerDesde(0)).toEqual([accion(5)]);
  });

  it('leerDesde filtra por fecha', async () => {
    const b = new BitacoraAcciones(ruta);
    await b.anotar(accion(10));
    await b.anotar(accion(20));
    expect((await b.leerDesde(15)).map((a) => a.ts)).toEqual([20]);
  });

  it('purgar quita lo viejo de la memoria y del disco, y lo nuevo sigue llegando', async () => {
    const b = new BitacoraAcciones(ruta);
    await b.anotar(accion(10));
    await b.anotar(accion(20));
    await b.purgar(15);
    await b.anotar(accion(30));

    expect((await b.leerDesde(0)).map((a) => a.ts)).toEqual([20, 30]);
    expect((await new BitacoraAcciones(ruta).leerDesde(0)).map((a) => a.ts)).toEqual([20, 30]);
  });

  it('una línea cortada por un apagón se descarta sin perder el resto', async () => {
    const b = new BitacoraAcciones(ruta);
    await b.anotar(accion(1));
    await appendFile(ruta, '{"ts":2,"cuenta":"h","met', 'utf8');
    await appendFile(ruta, '\n', 'utf8');
    await new BitacoraAcciones(ruta).anotar(accion(3));

    expect((await new BitacoraAcciones(ruta).leerDesde(0)).map((a) => a.ts)).toEqual([1, 3]);
  });

  it('la huella identifica la cuenta sin guardar la API Key', () => {
    const h = huellaCuenta('bg_7Kq82ab3cd4ef19c');
    expect(h).toHaveLength(16);
    expect(h).toBe(huellaCuenta('bg_7Kq82ab3cd4ef19c'));
    expect(h).not.toBe(huellaCuenta('bg_otra'));
    expect(h).not.toContain('bg_');
  });
});
