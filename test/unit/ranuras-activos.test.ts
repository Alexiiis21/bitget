/**
 * Las ocho casillas de activo, tal como se guardan en disco.
 *
 * --------------------------------------------------------------------------
 * Que se prueba aqui y por que importa
 * --------------------------------------------------------------------------
 * `activos.json` es texto plano en la carpeta del operador y puede llegar de
 * cualquier forma: con seis entradas, con doce, con el mismo simbolo repetido o
 * corrupto del todo. Ninguno de esos casos puede romper el arranque del panel, y
 * ninguno puede colarse hacia dentro: el numero de casillas es fijo -son ocho,
 * ver `RANURAS_ACTIVO`- y dos casillas con el mismo activo serian dos botones
 * llamados igual, porque la pantalla los identifica por su nombre corto.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RANURAS_ACTIVO } from '@shared/constants';
import {
  cargarRanuras,
  guardarRanuras,
  normalizarRanuras
} from '@main/storage/ranuras-activos';

const FABRICA = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

let carpeta: string;
let ruta: string;

beforeEach(async () => {
  carpeta = await mkdtemp(join(tmpdir(), 'pcb-ranuras-'));
  ruta = join(carpeta, 'activos.json');
});

afterEach(async () => {
  await rm(carpeta, { recursive: true, force: true });
});

describe('normalizar a las ocho casillas exactas', () => {
  it('sin nada guardado, las casillas son las de fabrica', () => {
    const r = normalizarRanuras(undefined, FABRICA);

    expect(r).toHaveLength(RANURAS_ACTIVO);
    expect(r.slice(0, 3)).toEqual(FABRICA);
    /* Las que sobran quedan vacias, que es un estado normal del selector. */
    expect(r.slice(3)).toEqual([null, null, null, null, null]);
  });

  it('una lista mas larga que ocho se recorta', () => {
    const doce = Array.from({ length: 12 }, (_, i) => `S${i}USDT`);

    const r = normalizarRanuras(doce, FABRICA);

    expect(r).toHaveLength(RANURAS_ACTIVO);
    expect(r[7]).toBe('S7USDT');
  });

  /*
   * El repetido no se guarda dos veces: se queda el primero. La pantalla
   * identifica el activo por su nombre corto, asi que dos casillas con BTC
   * serian dos botones iguales y el precio de uno se pintaria en los dos.
   */
  it('el mismo simbolo dos veces solo ocupa la primera casilla', () => {
    const r = normalizarRanuras(['BTCUSDT', 'ETHUSDT', 'BTCUSDT'], FABRICA);

    expect(r.slice(0, 3)).toEqual(['BTCUSDT', 'ETHUSDT', null]);
  });

  it('una cadena vacia cuenta como casilla vacia', () => {
    const r = normalizarRanuras(['BTCUSDT', '', '  ', 'ETHUSDT'], FABRICA);

    expect(r.slice(0, 4)).toEqual(['BTCUSDT', null, null, 'ETHUSDT']);
  });
});

describe('el archivo en disco', () => {
  it('lo que se guarda es lo que se lee', async () => {
    await guardarRanuras(ruta, { real: ['DOGEUSDT', null], simulado: ['SBTCSUSDT'] });

    expect(await cargarRanuras(ruta)).toEqual({
      real: ['DOGEUSDT', null],
      simulado: ['SBTCSUSDT']
    });
  });

  /* Sin archivo no hay configuracion: quien pregunta usa su lista de fabrica. */
  it('sin archivo devuelve vacio en vez de fallar', async () => {
    expect(await cargarRanuras(ruta)).toEqual({});
  });

  /*
   * Un archivo corrupto no se sobrescribe: se ignora y se deja donde esta.
   * Machacarlo perderia ademas la configuracion del otro mercado, que puede
   * estar intacta, y el panel arranca igual con las listas de fabrica.
   */
  it('un archivo ilegible no rompe el arranque ni se machaca', async () => {
    await writeFile(ruta, '{ esto no es json', 'utf8');

    expect(await cargarRanuras(ruta)).toEqual({});
    expect(await readFile(ruta, 'utf8')).toBe('{ esto no es json');
  });

  /*
   * Real y simulado ni siquiera comparten el espacio de nombres -`BTCUSDT` no
   * existe en el mercado de pruebas, donde es `SBTCSUSDT`-, asi que cada uno
   * guarda las suyas y cambiar de entorno no toca las del otro.
   */
  it('cada mercado guarda sus propias casillas', async () => {
    await guardarRanuras(ruta, { real: ['BTCUSDT'], simulado: ['SBTCSUSDT'] });

    const enDisco = await cargarRanuras(ruta);
    enDisco['real'] = ['DOGEUSDT'];
    await guardarRanuras(ruta, enDisco);

    expect((await cargarRanuras(ruta))['simulado']).toEqual(['SBTCSUSDT']);
  });
});
