/**
 * Ajuste de apalancamiento, de verdad y contra Bitget.
 *
 * --------------------------------------------------------------------------
 * La unica de las cinco funciones que se puede demostrar hoy entera
 * --------------------------------------------------------------------------
 * Las otras cuatro necesitan abrir una posicion, y eso esta bloqueado hasta que
 * exista una API Key de Trading Demo. Esta no: fijar el apalancamiento es
 * configuracion de la cuenta y **no necesita posicion**, asi que recorre el
 * camino completo -planificar, enviar, comprobar como quedo- con la credencial
 * que ya hay.
 *
 * Deja la cuenta como estaba al terminar.
 *
 * Se ejecuta con `npm run test:fisica`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClienteBitget } from '@main/bitget/rest/client';
import { MERCADO_SIMULADO } from '@main/bitget/mercado';
import { obtenerCuentaSimbolo } from '@main/bitget/rest/endpoints/cuenta';
import {
  MotorLotes,
  resumirLote,
  type CuentaEjecutable,
  type FuenteCuentas
} from '@main/execution/motor-lotes';
import { credencialReal, hayCredenciales } from '../red/credenciales-reales';

const SIMBOLO = 'SBTCSUSDT';
const CUENTA_ID = 'demo-1';
/** Un valor distinto del habitual, para que el cambio se note al leerlo. */
const OBJETIVO = 20;

let cliente: ClienteBitget;
let motor: MotorLotes;
let apalancamientoOriginal = 10;

class UnaCuenta implements FuenteCuentas {
  cuentaEjecutable(cuentaId: string): CuentaEjecutable | null {
    if (cuentaId !== CUENTA_ID) return null;
    return {
      cuentaId,
      etiqueta: 'Cuenta demo',
      credencial: credencialReal,
      saldoDisponible: '0',
      modoMargen: 'crossed'
    };
  }
}

const objetivos = [{ cuentaId: CUENTA_ID, lado: 'long' as const }];

/** Apalancamiento vigente segun el modo de la cuenta. */
async function leer(): Promise<number> {
  const r = await obtenerCuentaSimbolo(
    cliente,
    credencialReal,
    SIMBOLO,
    MERCADO_SIMULADO.productType,
    MERCADO_SIMULADO.marginCoin
  );
  return Number(
    r.datos.marginMode === 'crossed' ? r.datos.crossedMarginLeverage : r.datos.isolatedLongLever
  );
}

beforeAll(async () => {
  if (!hayCredenciales) return;
  cliente = new ClienteBitget();
  await cliente.sincronizarReloj();
  motor = new MotorLotes(cliente, new UnaCuenta());
});

afterAll(async () => {
  /* Se deja la cuenta como estaba, pase lo que pase. */
  if (hayCredenciales && cliente !== undefined) {
    try {
      const plan = await motor.planificarApalancamiento({
        mercado: MERCADO_SIMULADO,
        simbolo: SIMBOLO,
        objetivos,
        apalancamiento: apalancamientoOriginal
      });
      await motor.ejecutarApalancamiento(plan);
    } catch {
      /* Si no se pudo restaurar, lo dira la lectura del ultimo paso. */
    }
    await cliente.cerrar();
  }
});

describe.skipIf(!hayCredenciales)('ajuste de apalancamiento contra Bitget', () => {
  it('paso 1 · lee como esta la cuenta ahora', async () => {
    apalancamientoOriginal = await leer();
    console.log(`\n  apalancamiento actual ... ${apalancamientoOriginal}x`);
    expect(apalancamientoOriginal).toBeGreaterThan(0);
  });

  /*
   * El freno del pliego: si el problema esta en los parametros, no sale ni una
   * peticion. El tope sale del catalogo de Bitget, asi que no hay que gastar
   * una llamada para que el exchange diga que no.
   */
  it('paso 2 · rechaza un apalancamiento fuera del rango del activo', async () => {
    await expect(
      motor.planificarApalancamiento({
        mercado: MERCADO_SIMULADO,
        simbolo: SIMBOLO,
        objetivos,
        apalancamiento: 999
      })
    ).rejects.toThrow(/125x/);

    console.log('  fuera de rango .......... rechazado sin enviar nada');
  });

  it('paso 3 · planifica y enseña de qué a qué', async () => {
    const plan = await motor.planificarApalancamiento({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos,
      apalancamiento: OBJETIVO
    });

    console.log(
      `  plan .................... ${plan.entradas[0]?.apalancamientoActual ?? '?'}x → ${plan.entradas[0]?.apalancamiento}x`
    );
    expect(plan.entradas).toHaveLength(1);
  });

  it('paso 4 · lo fija y Bitget lo confirma', async () => {
    const plan = await motor.planificarApalancamiento({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos,
      apalancamiento: OBJETIVO
    });
    const lote = await motor.ejecutarApalancamiento(plan);

    console.log(`  enviado ................. ${lote.jobs[0]?.estado} · ${lote.jobs[0]?.mensaje ?? ''}`);
    expect(resumirLote(lote).exito).toBe(1);
  });

  it('paso 5 · la cuenta quedó en el valor pedido', async () => {
    const ahora = await leer();
    console.log(`  leído de Bitget ......... ${ahora}x`);
    expect(ahora).toBe(OBJETIVO);
  });

  /*
   * La propiedad que hace inofensivo cualquier reenvio: fijar el mismo valor
   * dos veces deja el mismo valor. Es lo que permite reintentar sin pensarlo.
   */
  it('paso 6 · repetirlo no cambia nada', async () => {
    const plan = await motor.planificarApalancamiento({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos,
      apalancamiento: OBJETIVO
    });
    await motor.ejecutarApalancamiento(plan);

    const ahora = await leer();
    console.log(`  tras repetir ............ ${ahora}x`);
    expect(ahora).toBe(OBJETIVO);
  });

  it('paso 7 · se restaura el valor original', async () => {
    const plan = await motor.planificarApalancamiento({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos,
      apalancamiento: apalancamientoOriginal
    });
    await motor.ejecutarApalancamiento(plan);

    const ahora = await leer();
    console.log(`  restaurado .............. ${ahora}x\n`);
    expect(ahora).toBe(apalancamientoOriginal);
  });
});
