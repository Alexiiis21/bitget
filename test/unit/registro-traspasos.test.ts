/**
 * Registro de traspasos.
 *
 * Lo que se prueba aquí es la propiedad por la que existe el archivo: que un
 * traspaso enviado del que no se recibió respuesta **quede señalado**, en vez de
 * desaparecer. Ese es el estado peligroso —el dinero pudo salir o no— y la única
 * forma de no perderlo es haberlo escrito antes de enviar.
 *
 * Y una que importa igual: una línea rota no puede llevarse por delante el resto
 * del historial.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RegistroTraspasos } from '@main/storage/registro-traspasos';

let carpeta: string;
let ruta: string;
let registro: RegistroTraspasos;

beforeEach(async () => {
  carpeta = await mkdtemp(join(tmpdir(), 'pcb-traspasos-'));
  /* En subcarpeta a propósito: el registro tiene que crearla él. */
  ruta = join(carpeta, 'traspasos', 'movimientos.jsonl');
  registro = new RegistroTraspasos(ruta);
});

afterEach(async () => {
  await rm(carpeta, { recursive: true, force: true });
});

const INTENTO = {
  clientOid: 'pcb-tr-001',
  uidMadre: '1513226215',
  uidOrigen: '111',
  etiquetaOrigen: 'Sub-01',
  uidDestino: '222',
  etiquetaDestino: 'Sub-02',
  importe: '30',
  moneda: 'USDT'
};

describe('registro de un traspaso completo', () => {
  it('guarda fecha, importe, origen, destino y resultado', async () => {
    await registro.anotarIntento(INTENTO);
    await registro.anotarResuelta({
      clientOid: 'pcb-tr-001',
      resultado: 'exito',
      transferId: 'bg-9988'
    });

    const [m] = await registro.listar();

    expect(m).toMatchObject({
      clientOid: 'pcb-tr-001',
      etiquetaOrigen: 'Sub-01',
      etiquetaDestino: 'Sub-02',
      importe: '30',
      moneda: 'USDT',
      resultado: 'exito',
      transferId: 'bg-9988'
    });
    expect(m?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(m?.resueltoEn).not.toBeNull();
  });

  it('anota el fallo con su motivo, sin perder el movimiento', async () => {
    await registro.anotarIntento(INTENTO);
    await registro.anotarResuelta({
      clientOid: 'pcb-tr-001',
      resultado: 'fallo',
      codigoBitget: '40014',
      mensaje: 'need transfer write permissions'
    });

    const [m] = await registro.listar();

    expect(m?.resultado).toBe('fallo');
    expect(m?.mensaje).toContain('transfer write');
  });
});

describe('el traspaso del que no se sabe nada', () => {
  /*
   * El caso que justifica escribir antes de enviar: el proceso murió entre la
   * petición y la respuesta. El dinero pudo salir o no.
   */
  it('un intento sin resolver queda como pendiente, no desaparece', async () => {
    await registro.anotarIntento(INTENTO);

    const [m] = await registro.listar();

    expect(m?.resultado).toBe('pendiente');
    expect(m?.transferId).toBeNull();
    expect(m?.resueltoEn).toBeNull();
  });

  it('los pendientes se pueden pedir aparte', async () => {
    await registro.anotarIntento(INTENTO);
    await registro.anotarIntento({ ...INTENTO, clientOid: 'pcb-tr-002' });
    await registro.anotarResuelta({ clientOid: 'pcb-tr-002', resultado: 'exito' });

    const pendientes = await registro.pendientes();

    expect(pendientes).toHaveLength(1);
    expect(pendientes[0]?.clientOid).toBe('pcb-tr-001');
  });

  /* Un pendiente no es un fallo: contarlo como tal invitaría a reenviarlo. */
  it('un pendiente no se cuenta como fallo', async () => {
    await registro.anotarIntento(INTENTO);

    const [m] = await registro.listar();

    expect(m?.resultado).not.toBe('fallo');
  });
});

describe('resistencia del archivo', () => {
  it('sobrevive a una línea corrupta y conserva las demás', async () => {
    await registro.anotarIntento(INTENTO);
    await registro.anotarIntento({ ...INTENTO, clientOid: 'pcb-tr-002' });

    /* Un corte de luz a mitad de escritura deja la última línea a medias. */
    const crudo = await readFile(ruta, 'utf8');
    await writeFile(ruta, `${crudo}{"ts":"2026-09-03T10:0`, 'utf8');

    const movimientos = await registro.listar();

    expect(movimientos).toHaveLength(2);
  });

  it('no falla cuando todavía no hay archivo', async () => {
    expect(await registro.listar()).toEqual([]);
    expect(await registro.pendientes()).toEqual([]);
  });

  it('es append-only: un movimiento nuevo no pisa los anteriores', async () => {
    await registro.anotarIntento(INTENTO);
    await registro.anotarResuelta({ clientOid: 'pcb-tr-001', resultado: 'exito' });
    await registro.anotarIntento({ ...INTENTO, clientOid: 'pcb-tr-002', importe: '50' });

    const movimientos = await registro.listar();

    expect(movimientos).toHaveLength(2);
    expect(movimientos.map((m) => m.clientOid).sort()).toEqual(['pcb-tr-001', 'pcb-tr-002']);
  });

  it('devuelve lo más reciente primero', async () => {
    await registro.anotarIntento(INTENTO, new Date('2026-09-01T10:00:00Z'));
    await registro.anotarIntento(
      { ...INTENTO, clientOid: 'pcb-tr-002' },
      new Date('2026-09-03T10:00:00Z')
    );

    const movimientos = await registro.listar();

    expect(movimientos[0]?.clientOid).toBe('pcb-tr-002');
  });
});
