/**
 * El freno de los intentos contra la contrasena maestra.
 *
 * Lo que se prueba aqui es la promesa que se le hizo al cliente: que fallar
 * repetidamente cuesta tiempo, que ese tiempo crece, que tiene tope y que
 * **sobrevive a cerrar el panel**. Esto ultimo es lo unico que separa un freno
 * de un adorno: si el contador se reiniciara al arrancar, bastaria con cerrar y
 * abrir el .exe entre intento e intento.
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ESPERA_BASE_MS,
  ESPERA_TOPE_MS,
  esperaTrasFallos,
  textoEspera
} from '@shared/espera-maestra';
import { FrenoMaestra } from '@main/security/freno-maestra';

let carpeta: string;
let ruta: string;
/** Reloj de mentira: las esperas se miden en minutos y nadie va a esperarlos. */
let reloj = 1_700_000_000_000;

beforeEach(async () => {
  carpeta = await mkdtemp(join(tmpdir(), 'pcb-freno-'));
  ruta = join(carpeta, 'intentos.json');
  reloj = 1_700_000_000_000;
});

const abrir = (): Promise<FrenoMaestra> => FrenoMaestra.cargar(ruta, { ahora: () => reloj });

describe('la tabla de esperas', () => {
  it('perdona los dos primeros fallos', () => {
    expect(esperaTrasFallos(0)).toBe(0);
    expect(esperaTrasFallos(1)).toBe(0);
    expect(esperaTrasFallos(2)).toBe(0);
  });

  it('empieza en tres minutos y dobla', () => {
    expect(esperaTrasFallos(3)).toBe(ESPERA_BASE_MS);
    expect(esperaTrasFallos(4)).toBe(2 * ESPERA_BASE_MS);
    expect(esperaTrasFallos(5)).toBe(4 * ESPERA_BASE_MS);
    expect(esperaTrasFallos(6)).toBe(8 * ESPERA_BASE_MS);
  });

  /* Sin tope, el octavo despiste dejaria al operador medio dia fuera. */
  it('no pasa de una hora por muchos fallos que se acumulen', () => {
    expect(esperaTrasFallos(8)).toBe(ESPERA_TOPE_MS);
    expect(esperaTrasFallos(40)).toBe(ESPERA_TOPE_MS);
  });
});

describe('el contador', () => {
  it('no frena hasta el tercer fallo', async () => {
    const freno = await abrir();

    expect(await freno.anotarFallo()).toBe(0);
    expect(await freno.anotarFallo()).toBe(0);
    expect(freno.frenado).toBe(false);

    expect(await freno.anotarFallo()).toBe(ESPERA_BASE_MS);
    expect(freno.frenado).toBe(true);
  });

  it('deja de frenar cuando pasa el tiempo', async () => {
    const freno = await abrir();
    for (let i = 0; i < 3; i += 1) await freno.anotarFallo();

    reloj += ESPERA_BASE_MS - 1_000;
    expect(freno.restanteMs()).toBe(1_000);

    reloj += 1_000;
    expect(freno.frenado).toBe(false);
  });

  /* Acertar borra el castigo entero: el cuarto intento vuelve a ser el primero. */
  it('un acierto devuelve el contador a cero', async () => {
    const freno = await abrir();
    for (let i = 0; i < 3; i += 1) await freno.anotarFallo();

    await freno.anotarAcierto();

    expect(freno.frenado).toBe(false);
    expect(freno.fallos).toBe(0);
    expect(await freno.anotarFallo()).toBe(0);
  });
});

describe('sobrevive al reinicio', () => {
  it('conserva la espera al volver a cargarse', async () => {
    const primero = await abrir();
    for (let i = 0; i < 3; i += 1) await primero.anotarFallo();

    /* Cerrar y abrir el panel es exactamente esto: otro objeto, mismo archivo. */
    const segundo = await abrir();

    expect(segundo.frenado).toBe(true);
    expect(segundo.restanteMs()).toBe(ESPERA_BASE_MS);
    expect(segundo.fallos).toBe(3);
  });

  it('el siguiente fallo sigue la cuenta donde estaba, no la reinicia', async () => {
    const primero = await abrir();
    for (let i = 0; i < 3; i += 1) await primero.anotarFallo();

    reloj += ESPERA_BASE_MS;
    const segundo = await abrir();

    expect(await segundo.anotarFallo()).toBe(2 * ESPERA_BASE_MS);
  });

  it('un archivo ilegible arranca en limpio en vez de tumbar el panel', async () => {
    await writeFile(ruta, 'esto no es json', 'utf8');

    const freno = await abrir();

    expect(freno.frenado).toBe(false);
    expect(freno.fallos).toBe(0);
  });
});

describe('el reloj movido', () => {
  /*
   * Atrasar la hora de Windows no puede ser la forma de saltarse la espera. Se
   * devuelve la espera entera: ver la cabecera de `freno-maestra.ts`, donde
   * queda escrito que adelantarla si la salta y por que se acepta.
   */
  it('atrasar el reloj no cumple la espera', async () => {
    const freno = await abrir();
    for (let i = 0; i < 3; i += 1) await freno.anotarFallo();

    reloj -= 24 * 60 * 60_000;

    expect(freno.restanteMs()).toBe(ESPERA_BASE_MS);
  });
});

describe('lo que se guarda en disco', () => {
  it('no escribe nada de la contrasena, solo el contador', async () => {
    const freno = await abrir();
    await freno.anotarFallo();

    const crudo = await readFile(ruta, 'utf8');

    expect(JSON.parse(crudo)).toEqual({
      fallos: 1,
      esperaDesde: null,
      duracionMs: 0
    });
  });
});

describe('el texto de la espera', () => {
  it('redondea hacia arriba para no invitar a intentarlo antes de tiempo', () => {
    expect(textoEspera(61_000)).toBe('2 minutos');
    expect(textoEspera(45_000)).toBe('45 segundos');
    expect(textoEspera(3 * 60_000)).toBe('3 minutos');
    expect(textoEspera(60 * 60_000)).toBe('1 hora');
    expect(textoEspera(0)).toBe('');
  });
});
