/**
 * Que activo hay en cada una de las ocho casillas del selector (`activos.json`).
 *
 * --------------------------------------------------------------------------
 * Por que esto vive en disco y no en el codigo
 * --------------------------------------------------------------------------
 * Hasta el 28/08/2026 los ocho simbolos eran una constante de `mercado.ts`:
 * cambiar uno era recompilar el panel. El cliente pidio poder cambiarlos el
 * mismo, sin dejar de ser ocho -ver `RANURAS_ACTIVO`-, asi que la lista pasa a
 * ser un dato del sistema, junto al numero de panel y al registro de cuentas.
 *
 * Se guarda **por mercado** porque real y simulado ni siquiera comparten el
 * espacio de nombres: `BTCUSDT` no existe en el mercado de pruebas, donde ese
 * mismo activo es `SBTCSUSDT`. Una lista comun dejaria las ocho casillas vacias
 * al cambiar de entorno, o peor, llenas de simbolos que ese mercado no conoce.
 *
 * Lo que hay aqui son **simbolos**, no nombres cortos: `BTCUSDT`, no `BTC`. El
 * nombre corto es una traduccion para la pantalla y cambia con el mercado; el
 * simbolo es lo que el exchange entiende y lo unico que se puede volver a
 * resolver contra el catalogo dentro de seis meses.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { RANURAS_ACTIVO } from '@shared/constants';
import { escribirAtomico, existe } from './atomic-write';

/**
 * Las casillas de cada mercado, tal como estan en disco.
 *
 * `null` es una casilla vacia, y es un estado normal: el mercado de pruebas
 * solo ofrece tres contratos, asi que alli cinco casillas estan vacias desde el
 * primer arranque.
 */
export type RanurasMercado = (string | null)[];
export type RanurasEnDisco = Record<string, RanurasMercado>;

const esquemaRanuras = z.record(z.string(), z.array(z.string().max(32).nullable()));

/**
 * Ajusta una lista cualquiera a las ocho casillas exactas.
 *
 * Se aplica siempre -al leer el disco y al guardar- porque el archivo es texto
 * plano en la carpeta del operador y puede llegar con seis entradas, con doce o
 * con el mismo simbolo repetido. Ninguno de esos casos debe romper el arranque,
 * y ninguno debe colarse hacia dentro:
 *
 *  - Sobran: se recortan. Faltan: se rellenan con casillas vacias.
 *  - Repetidos: se queda el primero. Dos casillas con el mismo activo se verian
 *    como dos opciones distintas que hacen lo mismo, y la pantalla las
 *    identifica por su nombre corto -las dos serian `BTC`-, asi que la segunda
 *    ni siquiera se podria seleccionar.
 *  - Cadenas vacias: cuentan como casilla vacia.
 */
export function normalizarRanuras(
  lista: readonly (string | null)[] | undefined,
  porDefecto: readonly string[]
): RanurasMercado {
  const origen = lista ?? porDefecto;
  const salida: RanurasMercado = [];
  const vistos = new Set<string>();

  for (let i = 0; i < RANURAS_ACTIVO; i += 1) {
    const valor = origen[i];
    const simbolo = typeof valor === 'string' && valor.trim() !== '' ? valor.trim() : null;
    if (simbolo === null || vistos.has(simbolo)) {
      salida.push(null);
      continue;
    }
    vistos.add(simbolo);
    salida.push(simbolo);
  }
  return salida;
}

/**
 * Lee las casillas guardadas. Un archivo ilegible no se sobrescribe.
 *
 * Devuelve lo que haya, sin normalizar y sin inventar mercados: quien pregunta
 * sabe con que lista de fabrica completar el suyo, y esta funcion no tiene por
 * que conocer los mercados. Un archivo corrupto se trata como si no existiera
 * -se vuelve a la lista de fabrica- y se deja donde esta: machacarlo perderia la
 * configuracion del otro mercado, que puede estar intacta.
 */
export async function cargarRanuras(ruta: string): Promise<RanurasEnDisco> {
  if (!(await existe(ruta))) return {};
  try {
    return esquemaRanuras.parse(JSON.parse(await readFile(ruta, 'utf8')));
  } catch {
    return {};
  }
}

export async function guardarRanuras(ruta: string, datos: RanurasEnDisco): Promise<void> {
  await escribirAtomico(ruta, JSON.stringify(datos, null, 2));
}
