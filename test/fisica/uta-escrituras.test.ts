/**
 * La única escritura que se puede validar sola contra una cuenta UTA real.
 *
 * ==========================================================================
 * Por qué solo el apalancamiento, y no las cinco funciones
 * ==========================================================================
 * De las cinco, el apalancamiento es la única que reúne las tres propiedades
 * que hacen que una prueba automática sea responsable con dinero de alguien:
 *
 *   no necesita posición    es configuración de la cuenta
 *   es idempotente          fijar 20x dos veces deja 20x
 *   es reversible           se restaura el valor original al terminar
 *
 * Las otras cuatro no. Margen y cierre exigen una posición abierta; la apertura
 * **la abre**; y el Take Profit está bloqueado en UTA desde la Fase C. Y hay una
 * agravante que no existía en la suite física de V2: aquella opera en
 * `SUSDT-FUTURES`, dinero simulado, y **V3 no lista esa categoría** —el §9.1 del
 * documento de equivalencias—. Si UTA no tiene mercado de práctica, una apertura
 * automática aquí sería una apertura con dinero real, sin nadie mirando.
 *
 * Eso no se automatiza. Las otras cuatro se validan desde el panel, con el
 * operador delante, siguiendo el procedimiento de la nota técnica
 * (`docs/00-entrega-v0.9.0-uta.md`). Es además mejor prueba: ejercita la
 * confirmación previa y el informe por cuenta, que es lo que el cliente usa.
 *
 * ==========================================================================
 * Cerrojo: no se ejecuta por descuido
 * ==========================================================================
 * `npm run test:fisica` la recoge junto a las demás, así que además de las
 * credenciales UTA exige una variable puesta a mano:
 *
 *   PCB_UTA_ESCRITURAS=1
 *
 * Sin ella se omite. Es la única prueba del repositorio que puede tocar una
 * cuenta con dinero real, y una variable que hay que escribir es la diferencia
 * entre decidirlo y que pase.
 *
 *   PCB_UTA_ESCRITURAS=1 npx vitest run --config vitest.fisica.config.ts test/fisica/uta-escrituras.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MERCADO_REAL } from '@main/bitget/mercado';
import { ClienteBitget } from '@main/bitget/rest/client';
import { obtenerCuentaSimbolo } from '@main/bitget/rest/endpoints/cuenta';
import {
  MotorLotes,
  type CuentaEjecutable,
  type FuenteCuentas
} from '@main/execution/motor-lotes';
import { credencialUta, hayCredencialUta } from './credenciales-uta';

/** El cerrojo. Ver la cabecera. */
const AUTORIZADO = process.env['PCB_UTA_ESCRITURAS'] === '1';
const CORRE = hayCredencialUta && AUTORIZADO;

const SIMBOLO = MERCADO_REAL.simbolos[0] ?? 'BTCUSDT';
const CUENTA_ID = 'uta-1';

/**
 * Un valor distinto del habitual para que el cambio se note al leerlo, y bajo a
 * propósito: si algo saliera mal y quedara puesto, un apalancamiento **menor**
 * es más conservador que el que había, no menos.
 */
const OBJETIVO = 5;

let cliente: ClienteBitget;
let motor: MotorLotes;
let apalancamientoOriginal = 0;
let modoMargenReal: 'isolated' | 'crossed' = 'crossed';

class UnaCuenta implements FuenteCuentas {
  cuentaEjecutable(cuentaId: string): CuentaEjecutable | null {
    if (cuentaId !== CUENTA_ID) return null;
    return {
      cuentaId,
      etiqueta: 'Subcuenta UTA',
      credencial: credencialUta,
      saldoDisponible: '0',
      /*
       * Tiene que ser el modo real de la cuenta: el motor decide con él si el
       * apalancamiento se fija por lado o para toda la cuenta, y comprueba
       * después el que Bitget diga. Desalineados, se fijaría uno y se leería el
       * otro —la incidencia del 05/09/2026, por la puerta de atrás—. Se lee de
       * la cuenta en el paso 1 y se guarda aquí.
       */
      modoMargen: modoMargenReal
    };
  }
}

const objetivos = [{ cuentaId: CUENTA_ID, lado: 'long' as const }];

/** Apalancamiento vigente según el modo de la cuenta. */
async function leer(): Promise<{ apalancamiento: number; modo: 'isolated' | 'crossed' }> {
  const r = await obtenerCuentaSimbolo(
    cliente,
    credencialUta,
    SIMBOLO,
    MERCADO_REAL.productType,
    MERCADO_REAL.marginCoin
  );
  const modo = r.datos.marginMode === 'crossed' ? 'crossed' : 'isolated';
  return {
    modo,
    apalancamiento: Number(
      modo === 'crossed' ? r.datos.crossedMarginLeverage : r.datos.isolatedLongLever
    )
  };
}

beforeAll(async () => {
  if (!CORRE) return;
  cliente = new ClienteBitget();
  await cliente.sincronizarReloj();
  motor = new MotorLotes(cliente, new UnaCuenta());
});

afterAll(async () => {
  if (!CORRE || cliente === undefined) return;

  /* Se deja la cuenta como estaba, pase lo que pase. */
  if (apalancamientoOriginal > 0) {
    try {
      const plan = await motor.planificarApalancamiento({
        mercado: MERCADO_REAL,
        simbolo: SIMBOLO,
        objetivos,
        apalancamiento: apalancamientoOriginal
      });
      await motor.ejecutarApalancamiento(plan);
      console.log(`\n  restaurado .............. ${apalancamientoOriginal}x`);
    } catch {
      console.log(
        `\n  ⚠ NO se pudo restaurar el apalancamiento. Estaba en ${apalancamientoOriginal}x; ` +
          `compruébelo en Bitget para ${SIMBOLO}.`
      );
    }
  }
  await cliente.cerrar();
});

describe.skipIf(!CORRE)('apalancamiento contra una subcuenta UTA real', () => {
  it('paso 1 · lee cómo está la cuenta ahora', async () => {
    const estado = await leer();
    apalancamientoOriginal = estado.apalancamiento;
    modoMargenReal = estado.modo;

    console.log(`\n  símbolo ................. ${SIMBOLO}`);
    console.log(`  modo de margen .......... ${modoMargenReal}`);
    console.log(`  apalancamiento actual ... ${apalancamientoOriginal}x`);

    /*
     * Un cero aquí no es «la cuenta está a cero»: es que `symbolConfigList` no
     * trae este símbolo, y entonces el motor no puede comprobar cómo quedó el
     * cambio. Se corta antes de escribir nada.
     */
    expect(apalancamientoOriginal).toBeGreaterThan(0);
  });

  it('paso 2 · rechaza un apalancamiento fuera de rango sin enviar nada', async () => {
    await expect(
      motor.planificarApalancamiento({
        mercado: MERCADO_REAL,
        simbolo: SIMBOLO,
        objetivos,
        apalancamiento: 9_999
      })
    ).rejects.toThrow();

    console.log('  fuera de rango .......... rechazado sin enviar nada');
  });

  it('paso 3 · lo fija por V3 y Bitget lo confirma', async () => {
    const plan = await motor.planificarApalancamiento({
      mercado: MERCADO_REAL,
      simbolo: SIMBOLO,
      objetivos,
      apalancamiento: OBJETIVO
    });

    const resultado = await motor.ejecutarApalancamiento(plan);
    expect(resultado.jobs.every((j) => j.estado === 'exito')).toBe(true);

    /*
     * ======================================================================
     * Esta relectura es la prueba, no el código de éxito
     * ======================================================================
     * El 05/09/2026 Bitget respondió `00000` a un `set-leverage` y no cambió
     * nada. En V3 los nombres de campo son distintos —`longLeverage` en vez de
     * `leverage` + `holdSide`— y **no están capturados**, así que la misma
     * clase de fallo silencioso es exactamente lo que hay que descartar aquí.
     * Si el número no cambió, la petición estaba mal formada por muy verde que
     * saliera.
     */
    const despues = await leer();
     
    console.log(`  fijado .................. ${apalancamientoOriginal}x → ${despues.apalancamiento}x`);

    expect(despues.apalancamiento).toBe(OBJETIVO);
  });
});
