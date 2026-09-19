/**
 * Apalancamiento con dos casillas, contra Bitget de verdad.
 *
 * ==========================================================================
 * Para que existe: contestar «¿fue el panel o fue el cliente?»
 * ==========================================================================
 * Un cliente reporto que con dos cuentas principales el apalancamiento **solo
 * cambiaba en la A**. No se sabia de donde habia sacado el dato, asi que esta
 * prueba esta escrita para **discriminar**, no para confirmar: el paso 1 no
 * afirma nada, pregunta. Rellena contra la API real la tabla de verdad de
 * `set-leverage` y de ahi sale el veredicto que se imprime al final.
 *
 * La hermana determinista es `test/integration/apalancamiento-dos-fichas.test.ts`,
 * que simula esa misma tabla y se queda en CI. Esta comprueba que la tabla
 * simulada es la de Bitget.
 *
 * --------------------------------------------------------------------------
 * Por que basta una credencial para probar «dos cuentas»
 * --------------------------------------------------------------------------
 * Lo que separaba a la cuenta A de la B no era la cuenta: era la **ficha**
 * `modoMargen` que `FuenteCuentas` entrega al motor, que guarda el modo del
 * primer simbolo del mercado y solo se refresca al verificar la credencial.
 * Dos cuentas con el mismo modo real en el simbolo operado podian llegar con
 * fichas distintas segun cuando se verifico cada una.
 *
 * Asi que se montan dos casillas -`cuenta-a` y `cuenta-b`- sobre la **misma**
 * credencial y con fichas distintas. La limitacion que eso impone, y que hay
 * que tener presente al leer los resultados: las dos actuan sobre la misma
 * cuenta real, de modo que lo que se afirma es sobre el **informe del lote**
 * -que casilla quedo en exito y cuantas peticiones costo-, no sobre dos
 * estados finales independientes. Es suficiente: el sintoma del cliente era
 * una casilla que no quedaba fijada.
 *
 * Deja la cuenta como estaba al terminar. Se ejecuta con `npm run test:fisica`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClienteBitget } from '@main/bitget/rest/client';
import { MERCADO_SIMULADO } from '@main/bitget/mercado';
import {
  fijarApalancamiento,
  fijarModoMargen,
  obtenerCuentaSimbolo
} from '@main/bitget/rest/endpoints/cuenta';
import { obtenerPosiciones } from '@main/bitget/rest/endpoints/posiciones';
import {
  MotorLotes,
  resumirLote,
  type CuentaEjecutable,
  type FuenteCuentas
} from '@main/execution/motor-lotes';
import type { Job, Lote } from '@shared/types';
import { credencialReal, hayCredenciales } from '../red/credenciales-reales';

const SIMBOLO = 'SBTCSUSDT';

/**
 * Valores bajos a proposito: si algo saliera mal y quedara puesto, un
 * apalancamiento **menor** que el que habia es mas conservador, no menos.
 */
const OBJETIVO = 5;
const SONDA = 4;

type ModoMargen = 'isolated' | 'crossed';

let cliente: ClienteBitget;
let apalancamientoOriginal = 0;
let modoReal: ModoMargen = 'isolated';

/** Lo que Bitget hace ante cada forma. De aqui sale el veredicto, no de una suposicion. */
interface Celda {
  aceptada: boolean;
  tuvoEfecto: boolean;
  motivo: string;
}

const tabla: Partial<Record<`${ModoMargen}/${'con-lado' | 'sin-lado'}`, Celda>> = {};

const pinta = (c: Celda | undefined): string =>
  c === undefined
    ? 'sin probar'
    : !c.aceptada
      ? `RECHAZADA · ${c.motivo}`
      : c.tuvoEfecto
        ? 'aceptada y CAMBIA'
        : 'aceptada y NO cambia nada';

/**
 * Dos casillas sobre la misma credencial, con la ficha como unica diferencia.
 *
 * Es el escenario del cliente reducido a lo unico que lo producia.
 */
class DosCasillas implements FuenteCuentas {
  private readonly fichas: Record<string, ModoMargen>;

  constructor(fichas: Record<string, ModoMargen>) {
    this.fichas = fichas;
  }

  cuentaEjecutable(cuentaId: string): CuentaEjecutable | null {
    const ficha = this.fichas[cuentaId];
    if (ficha === undefined) return null;
    return {
      cuentaId,
      etiqueta: cuentaId.toUpperCase(),
      credencial: credencialReal,
      saldoDisponible: '0',
      modoMargen: ficha
    };
  }

  objetivos(): { cuentaId: string; lado: 'long' }[] {
    return Object.keys(this.fichas).map((cuentaId) => ({ cuentaId, lado: 'long' as const }));
  }
}

function motorCon(fichas: Record<string, ModoMargen>): {
  motor: MotorLotes;
  casillas: DosCasillas;
} {
  const casillas = new DosCasillas(fichas);
  return { motor: new MotorLotes(cliente, casillas), casillas };
}

/** El estado real del simbolo en la cuenta: modo, apalancamiento y modo de posicion. */
async function leer(): Promise<{
  modo: ModoMargen;
  apalancamiento: number;
  modoPosicion: string;
}> {
  const r = await obtenerCuentaSimbolo(
    cliente,
    credencialReal,
    SIMBOLO,
    MERCADO_SIMULADO.productType,
    MERCADO_SIMULADO.marginCoin
  );
  const modo: ModoMargen = r.datos.marginMode === 'crossed' ? 'crossed' : 'isolated';
  return {
    modo,
    apalancamiento: Number(
      modo === 'crossed' ? r.datos.crossedMarginLeverage : r.datos.isolatedLongLever
    ),
    modoPosicion: String(r.datos.posMode ?? '?')
  };
}

/** Pide el cambio con una forma concreta, sin pasar por el motor. */
async function pedir(
  lado: 'long' | null,
  apalancamiento: number
): Promise<{ ok: true } | { ok: false; motivo: string }> {
  try {
    await fijarApalancamiento(cliente, credencialReal, {
      simbolo: SIMBOLO,
      productType: MERCADO_SIMULADO.productType,
      marginCoin: MERCADO_SIMULADO.marginCoin,
      apalancamiento,
      lado
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, motivo: e instanceof Error ? e.message : String(e) };
  }
}

/** Prueba una celda de la tabla: pide el cambio y comprueba si de verdad cambio. */
async function probar(modo: ModoMargen, lado: 'long' | null): Promise<Celda> {
  const antes = await leer();
  /* Un valor distinto del que hay, para que «cambio» signifique algo. */
  const objetivo = antes.apalancamiento === SONDA ? SONDA + 1 : SONDA;

  const r = await pedir(lado, objetivo);
  const despues = await leer();
  const celda: Celda = {
    aceptada: r.ok,
    tuvoEfecto: despues.apalancamiento === objetivo,
    motivo: r.ok ? '' : r.motivo
  };

  tabla[`${modo}/${lado === null ? 'sin-lado' : 'con-lado'}`] = celda;
  return celda;
}

/** Cambia el modo del simbolo, o dice por que no pudo. */
async function ponerModo(modo: ModoMargen): Promise<boolean> {
  try {
    await fijarModoMargen(cliente, credencialReal, {
      simbolo: SIMBOLO,
      productType: MERCADO_SIMULADO.productType,
      marginCoin: MERCADO_SIMULADO.marginCoin,
      modoMargen: modo
    });
    return true;
  } catch (e) {
    console.log(`  ⚠ no se pudo poner en ${modo}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** Bitget no deja cambiar el modo con posiciones vivas, y tampoco hay que intentarlo. */
async function haySitioParaCambiarElModo(): Promise<boolean> {
  const r = await obtenerPosiciones(cliente, credencialReal, MERCADO_SIMULADO);
  return r.datos.filter((p) => p.symbol === SIMBOLO && Number(p.total ?? 0) !== 0).length === 0;
}

const jobDe = (lote: Lote, cuentaId: string): Job =>
  lote.jobs.find((j) => j.cuentaId === cuentaId) as Job;

const peticionDe = (casillas: DosCasillas, apalancamiento = OBJETIVO) => ({
  mercado: MERCADO_SIMULADO,
  simbolo: SIMBOLO,
  objetivos: casillas.objetivos(),
  apalancamiento
});

beforeAll(async () => {
  if (!hayCredenciales) return;
  cliente = new ClienteBitget();
  await cliente.sincronizarReloj();
});

afterAll(async () => {
  if (!hayCredenciales || cliente === undefined) return;

  /* Se deja la cuenta como estaba, pase lo que pase. */
  if (apalancamientoOriginal > 0) {
    const r = await pedir(modoReal === 'crossed' ? null : 'long', apalancamientoOriginal);
    console.log(
      r.ok
        ? `\n  restaurado .............. ${apalancamientoOriginal}x`
        : `\n  ⚠ NO se pudo restaurar. Estaba en ${apalancamientoOriginal}x; ` +
            `compruébelo en Bitget para ${SIMBOLO}. Motivo: ${r.motivo}`
    );
  }
  await cliente.cerrar();
});

describe.skipIf(!hayCredenciales)('apalancamiento en dos casillas, contra Bitget', () => {
  it('paso 1 · fotografía de la cuenta', async () => {
    const estado = await leer();
    apalancamientoOriginal = estado.apalancamiento;
    modoReal = estado.modo;

    console.log(`\n  símbolo ................. ${SIMBOLO}`);
    console.log(`  modo de margen real ..... ${estado.modo}`);
    console.log(`  modo de posición ........ ${estado.modoPosicion}`);
    console.log(`  apalancamiento actual ... ${estado.apalancamiento}x`);

    expect(estado.apalancamiento).toBeGreaterThan(0);
  });

  /*
   * El paso que convierte esto en una prueba y no en una confirmacion.
   *
   * No da por hecho lo que Bitget hace con la forma que no corresponde al
   * modo: lo pregunta, en los dos modos y con las dos formas. De las cuatro
   * celdas sale el veredicto, y solo de ahi.
   *
   * Hay dos maneras de que un cambio «no se aplique», y no dan el mismo
   * sintoma: un **rechazo** deja la casilla en fallo -el operador lo ve- y un
   * **`00000` sin efecto** la deja en exito -el operador no lo ve-. Cual de
   * las dos produce cada celda es justo lo que decide si el cliente vio un
   * fallo del panel o un numero viejo en pantalla.
   */
  it('paso 2 · la tabla de verdad de set-leverage, preguntada a Bitget', async () => {
    const otro: ModoMargen = modoReal === 'isolated' ? 'crossed' : 'isolated';
    const puedeCambiarModo = await haySitioParaCambiarElModo();

    console.log(`\n  ── tabla de verdad de set-leverage en ${SIMBOLO} ──`);

    /* Primero el modo en que ya está: no requiere tocar nada. */
    console.log(`  ${modoReal} · con lado ..... ${pinta(await probar(modoReal, 'long'))}`);
    console.log(`  ${modoReal} · sin lado ..... ${pinta(await probar(modoReal, null))}`);

    if (!puedeCambiarModo) {
      console.log(`  ${otro} · (no se prueba: hay posición abierta en ${SIMBOLO})`);
    } else if (await ponerModo(otro)) {
      console.log(`  ${otro} · con lado ..... ${pinta(await probar(otro, 'long'))}`);
      console.log(`  ${otro} · sin lado ..... ${pinta(await probar(otro, null))}`);
      /* Se devuelve el símbolo a su modo antes de seguir. */
      await ponerModo(modoReal);
      expect((await leer()).modo).toBe(modoReal);
    }

    /* No se afirma ninguna celda: se deja escrito lo que Bitget contestó. */
    expect(Object.keys(tabla).length).toBeGreaterThanOrEqual(2);
  }, 60_000);

  /*
   * Lo primero que habia que descartar: que el bucle multicuenta se comiera la
   * segunda casilla. No se la come.
   */
  it('paso 3 · con las dos fichas correctas, las dos casillas quedan fijadas', async () => {
    const { motor, casillas } = motorCon({ 'cuenta-a': modoReal, 'cuenta-b': modoReal });

    const lote = await motor.ejecutarApalancamiento(
      await motor.planificarApalancamiento(peticionDe(casillas))
    );

    console.log(`\n  dos fichas correctas .... ${resumirLote(lote).exito}/2 en éxito`);
    expect(resumirLote(lote).exito).toBe(2);
    expect((await leer()).apalancamiento).toBe(OBJETIVO);
  });

  /*
   * El escenario del cliente: misma cuenta, mismo simbolo, mismo modo real, y
   * la ficha de la B con el modo contrario.
   *
   * Antes del 10/09/2026 esto dejaba la B en fallo cuando el simbolo estaba en
   * aislado. Ahora la ficha no decide nada -el modo se lee del simbolo al
   * planificar- y las dos tienen que quedar fijadas.
   */
  it('paso 4 · con la ficha de la B equivocada, la B también queda fijada', async () => {
    const contraria: ModoMargen = modoReal === 'isolated' ? 'crossed' : 'isolated';
    /* Se parte de un valor distinto para que «quedó fijado» signifique algo. */
    await pedir(modoReal === 'crossed' ? null : 'long', SONDA);

    const { motor, casillas } = motorCon({ 'cuenta-a': modoReal, 'cuenta-b': contraria });
    const lote = await motor.ejecutarApalancamiento(
      await motor.planificarApalancamiento(peticionDe(casillas))
    );

    console.log(
      `  ficha B = ${contraria} ... A:${jobDe(lote, 'cuenta-a').estado} · B:${jobDe(lote, 'cuenta-b').estado}`
    );
    if (jobDe(lote, 'cuenta-b').estado !== 'exito') {
      console.log(`  motivo de la B .......... ${jobDe(lote, 'cuenta-b').mensaje ?? ''}`);
    }

    expect(jobDe(lote, 'cuenta-a').estado).toBe('exito');
    expect(jobDe(lote, 'cuenta-b').estado).toBe('exito');
    expect((await leer()).apalancamiento).toBe(OBJETIVO);
  });

  /*
   * La otra mitad del sintoma: lo que el panel **enseña**.
   *
   * `apalancamientoActual` salia de la cache de la ultima verificacion, que es
   * del primer simbolo del mercado, asi que la confirmacion podia decir
   * «10x → 5x» sobre una cuenta que ya estaba a 5x. Desde el 10/09/2026 sale de
   * la lectura del simbolo, y tiene que coincidir con lo que diga Bitget.
   */
  it('paso 5 · lo que el panel dice que hay coincide con lo que Bitget dice que hay', async () => {
    const { motor, casillas } = motorCon({ 'cuenta-a': modoReal });
    const plan = await motor.planificarApalancamiento(peticionDe(casillas, OBJETIVO));
    const real = await leer();

    console.log(`\n  el panel dice ........... ${plan.entradas[0]?.apalancamientoActual ?? '?'}x`);
    console.log(`  Bitget dice ............. ${real.apalancamiento}x`);
    console.log(`  modo en la entrada ...... ${plan.entradas[0]?.modoMargen ?? '?'}`);

    expect(plan.entradas[0]?.apalancamientoActual).toBe(real.apalancamiento);
    expect(plan.entradas[0]?.modoMargen).toBe(real.modo);
  });

  /*
   * El veredicto sale de la tabla, no de una hipotesis. Las dos formas de que
   * un cambio no se aplique dejan rastros distintos, y por eso se separan:
   *
   *   rechazo             -> casilla en FALLO. El operador lo ve.
   *   `00000` sin efecto  -> casilla en EXITO que no cambio nada. No lo ve.
   *
   * La segunda es la que acaba en «me dijeron que estaba puesto y no lo
   * estaba», y es la que hay que perseguir si aparece.
   */
  it('paso 6 · veredicto', () => {
    const celdas = Object.entries(tabla);
    const rechazos = celdas.filter(([, c]) => !c.aceptada);
    const mudas = celdas.filter(([, c]) => c.aceptada && !c.tuvoEfecto);

    console.log('\n  ─────────────────────────────────────────────────────────────');
    for (const [nombre, celda] of celdas) console.log(`  ${nombre} → ${pinta(celda)}`);
    console.log('');

    if (rechazos.length > 0) {
      console.log(`  RECHAZA: ${rechazos.map(([n]) => n).join(', ')}`);
      console.log('  → Con la ficha desalineada esa casilla salía en FALLO y la de al');
      console.log('    lado en éxito: el síntoma «en la A sí y en la B no», y visible');
      console.log('    en el informe del lote.');
    }
    if (mudas.length > 0) {
      console.log(`  ACEPTA SIN EFECTO: ${mudas.map(([n]) => n).join(', ')}`);
      console.log('  → Éste es el peligroso: la casilla sale en ÉXITO sin cambiar nada.');
      console.log('    El motor lo detecta releyendo el campo del modo que Bitget declara');
      console.log('    (desde el 05/09/2026); antes de eso el informe mentía.');
    }
    if (rechazos.length === 0 && mudas.length === 0) {
      console.log('  Todas las formas se aceptaron Y surtieron efecto.');
      console.log('  → Con esta cuenta y este símbolo, el panel no puede producir');
      console.log('    «no cambió» por la vía de la ficha desalineada. Si el cliente lo');
      console.log('    vio, mirar qué leyó: la matriz sólo pinta el apalancamiento de una');
      console.log('    posición abierta, y la caché del panel sólo se refrescaba al');
      console.log('    verificar la credencial.');
    }
    console.log('  ─────────────────────────────────────────────────────────────\n');

    expect(celdas.length).toBeGreaterThanOrEqual(2);
  });
});
