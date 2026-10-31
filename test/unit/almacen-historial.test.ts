/**
 * El historial en disco: que sobrevive a cerrar el panel, que un archivo roto o
 * ajeno no lo rompe, y que la baja de una cuenta no deja nada atrás aunque
 * llegue en mitad de una sincronización.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PaginaHistorial, PosicionCerrada } from '@main/domain/posicion-cerrada';
import { historialVacio, fusionarPosiciones } from '@main/historial/historial-cuenta';
import { SincronizadorHistorial, type CuentaHistorial } from '@main/historial/sincronizador';
import { posicionesSeguidas } from '../mock-exchange/historial-simulado';
import { AlmacenHistorialDisco } from '@main/storage/almacen-historial';

const AHORA = Date.parse('2026-10-12T12:00:00.000Z');

const posicion = (id: string): PosicionCerrada => ({
  positionId: id,
  symbol: 'BTCUSDT',
  lado: 'short',
  modoMargen: 'crossed',
  apalancamiento: null,
  abiertaEnMs: AHORA - 2_000,
  cerradaEnMs: AHORA - 1_000,
  precioEntrada: '84516',
  precioSalida: '84499.2',
  cantidadCierre: '0.0002',
  resultado: '-0.01692183',
  porcentaje: null,
  pnlPrecio: '0.00336',
  comisiones: '-0.02028182',
  financiamiento: '0',
  superficie: 'v3'
});

let carpeta: string;

beforeEach(async () => {
  carpeta = await mkdtemp(join(tmpdir(), 'pcb-historial-'));
});

afterEach(async () => {
  await rm(carpeta, { recursive: true, force: true });
});

describe('AlmacenHistorialDisco', () => {
  it('lo guardado se lee igual desde otra instancia: sobrevive a cerrar el panel', async () => {
    const h = {
      ...fusionarPosiciones(historialVacio('cta_1', 'u1'), [posicion('a'), posicion('b')]),
      cobertura: { desdeMs: 1, hastaMs: 2 },
      sincronizadoEn: 2
    };
    await new AlmacenHistorialDisco(carpeta).guardar(h);

    expect(await new AlmacenHistorialDisco(carpeta).leer('cta_1', 'u1')).toEqual(h);
  });

  it('sin archivo no hay historial', async () => {
    expect(await new AlmacenHistorialDisco(carpeta).leer('cta_1', 'u1')).toBeNull();
  });

  it('el archivo de otro UID no se enseña: la subcuenta se sustituyó', async () => {
    const almacen = new AlmacenHistorialDisco(carpeta);
    await almacen.guardar(fusionarPosiciones(historialVacio('cta_1', 'u1'), [posicion('a')]));

    expect(await almacen.leer('cta_1', 'u2')).toBeNull();
  });

  it('un archivo corrupto se lee como vacío y no rompe nada', async () => {
    await writeFile(join(carpeta, 'cta_1.json'), '{"version":1,"cuentaId":"cta_1","posic', 'utf8');
    expect(await new AlmacenHistorialDisco(carpeta).leer('cta_1', 'u1')).toBeNull();
  });

  it('una versión desconocida se lee como vacía', async () => {
    await writeFile(
      join(carpeta, 'cta_1.json'),
      JSON.stringify({
        version: 99,
        cuentaId: 'cta_1',
        uid: 'u1',
        cobertura: null,
        sincronizadoEn: null,
        posiciones: {}
      }),
      'utf8'
    );
    expect(await new AlmacenHistorialDisco(carpeta).leer('cta_1', 'u1')).toBeNull();
  });

  it('borrar quita el archivo, y borrar lo que no está no falla', async () => {
    const almacen = new AlmacenHistorialDisco(carpeta);
    await almacen.guardar(historialVacio('cta_1', 'u1'));
    await almacen.borrar('cta_1');
    await almacen.borrar('cta_1');

    expect(await readdir(carpeta)).toEqual([]);
  });

  it('un id con separadores no puede escribir fuera de la carpeta', async () => {
    const almacen = new AlmacenHistorialDisco(carpeta);
    await expect(almacen.guardar(historialVacio('../fuera', 'u1'))).rejects.toThrow(/no válido/);
    await expect(almacen.leer('a\\b', 'u1')).rejects.toThrow(/no válido/);
  });

  it('escrituras simultáneas de la misma cuenta dejan un archivo válido, el último', async () => {
    const almacen = new AlmacenHistorialDisco(carpeta);
    await Promise.all(
      Array.from({ length: 10 }, (_, n) =>
        almacen.guardar(fusionarPosiciones(historialVacio('cta_1', 'u1'), [posicion(`p${n}`)]))
      )
    );

    const h = await almacen.leer('cta_1', 'u1');
    expect(Object.keys(h?.posiciones ?? {})).toEqual(['p9']);
    /* Ni un temporal huérfano. */
    expect(await readdir(carpeta)).toEqual(['cta_1.json']);
  });
});

describe('sincronizador sobre disco', () => {
  const montar = (cuentas: Map<string, CuentaHistorial>, ahora = (): number => AHORA) =>
    new SincronizadorHistorial({
      almacen: new AlmacenHistorialDisco(carpeta),
      cuenta: (id) => cuentas.get(id) ?? null,
      ahoraMs: ahora,
      dormir: () => Promise.resolve()
    });

  it('tras «reabrir el panel», la sincronización es incremental y no duplica', async () => {
    const consultas: { desdeMs: number }[] = [];
    const paginas: PaginaHistorial[] = [
      { posiciones: [posicion('a')] },
      { posiciones: [posicion('a'), posicion('b')] }
    ];
    let i = 0;
    const fuente = (c: { desdeMs: number }): Promise<PaginaHistorial> => {
      consultas.push(c);
      return Promise.resolve(paginas[i++] ?? { posiciones: [] });
    };
    const cuentas = new Map([['cta_1', { uid: 'u1', fuente }]]);

    await montar(cuentas).sincronizar('cta_1');
    /* Instancia nueva: lo único que comparten es la carpeta. */
    const r = await montar(cuentas, () => AHORA + 60_000).sincronizar('cta_1');

    expect(consultas[1]?.desdeMs).toBeGreaterThan(consultas[0]?.desdeMs ?? Infinity);
    expect(r).toMatchObject({ nuevas: 1, total: 2 });

    const archivo = JSON.parse(await readFile(join(carpeta, 'cta_1.json'), 'utf8')) as {
      posiciones: Record<string, unknown>;
    };
    expect(Object.keys(archivo.posiciones).sort()).toEqual(['a', 'b']);
  });

  it('la baja a mitad de sincronización no deja archivo', async () => {
    let soltar: () => void = () => undefined;
    const freno = new Promise<void>((r) => {
      soltar = r;
    });
    let i = 0;
    const fuente = async (): Promise<PaginaHistorial> => {
      i++;
      if (i === 2) await freno;
      /* Páginas llenas para que el paginador pida la siguiente; la tercera, vacía, cierra. */
      return { posiciones: i < 3 ? posicionesSeguidas(`p${i}-`, 100, AHORA - i * 1_000_000) : [] };
    };
    const cuentas = new Map([['cta_1', { uid: 'u1', fuente }]]);
    const sync = montar(cuentas);

    const enCurso = sync.sincronizar('cta_1');
    /* Deja que la primera página llegue al disco. */
    for (let n = 0; n < 50 && !(await readdir(carpeta)).includes('cta_1.json'); n++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(await readdir(carpeta)).toEqual(['cta_1.json']);

    cuentas.delete('cta_1');
    const olvido = sync.olvidar('cta_1');
    soltar();

    await expect(enCurso).rejects.toMatchObject({ motivo: 'cuenta-desconocida' });
    await olvido;
    expect(await readdir(carpeta)).toEqual([]);
  });
});
