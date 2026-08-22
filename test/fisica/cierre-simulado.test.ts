/**
 * Abrir y cerrar de verdad en el mercado simulado de Bitget.
 *
 * --------------------------------------------------------------------------
 * Por que abre antes de cerrar
 * --------------------------------------------------------------------------
 * Un cierre no se puede demostrar sobre una cuenta vacia: lo unico que se veria
 * es «no habia nada que cerrar», que es precisamente el caso que **no** hay que
 * enseñar. Asi que esta prueba abre una posicion pequeña, comprueba que existe,
 * la cierra y comprueba que ya no esta. Es el recorrido completo de las dos
 * primeras funciones de la Fase 4, en un solo pase y contra Bitget.
 *
 * Dinero simulado y oficial: mercado `SUSDT-FUTURES`, precios y motor de
 * emparejamiento reales. El simbolo `SBTCSUSDT` no existe en el mercado real,
 * asi que esta prueba no puede tocar dinero de nadie ni por un error de
 * configuracion.
 *
 * Se ejecuta con `npm run test:fisica`. Imprime lo que hizo en cada paso.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClienteBitget } from '@main/bitget/rest/client';
import { MERCADO_SIMULADO } from '@main/bitget/mercado';
import { obtenerCuentaSimbolo } from '@main/bitget/rest/endpoints/cuenta';
import { buscarPosicion, obtenerPosiciones } from '@main/bitget/rest/endpoints/posiciones';
import {
  MotorLotes,
  resumirLote,
  type CuentaEjecutable,
  type FuenteCuentas,
  type PlanCierre
} from '@main/execution/motor-lotes';
import { credencialReal, hayCredenciales } from '../red/credenciales-reales';

const SIMBOLO = 'SBTCSUSDT';
const CUENTA_ID = 'demo-1';
const MARGEN = '50';
const APALANCAMIENTO = 10;

let cliente: ClienteBitget;
let motor: MotorLotes;
let planCierre: PlanCierre;

class UnaCuenta implements FuenteCuentas {
  saldo = '0';
  cuentaEjecutable(cuentaId: string): CuentaEjecutable | null {
    if (cuentaId !== CUENTA_ID) return null;
    return {
      cuentaId,
      etiqueta: 'Cuenta demo',
      credencial: credencialReal,
      saldoDisponible: this.saldo,
      modoMargen: 'crossed'
    };
  }
}

const fuente = new UnaCuenta();

beforeAll(async () => {
  if (!hayCredenciales) return;
  cliente = new ClienteBitget();
  await cliente.sincronizarReloj();
  motor = new MotorLotes(cliente, fuente);
});

afterAll(async () => {
  await cliente?.cerrar();
});

describe.skipIf(!hayCredenciales)('abrir y cerrar contra el mercado simulado', () => {
  it('paso 1 · hay saldo simulado con el que operar', async () => {
    const r = await obtenerCuentaSimbolo(
      cliente,
      credencialReal,
      SIMBOLO,
      MERCADO_SIMULADO.productType,
      MERCADO_SIMULADO.marginCoin
    );
    fuente.saldo = r.datos.available;

    console.log(`
  mercado .............. ${MERCADO_SIMULADO.productType} (dinero simulado, oficial de Bitget)
  saldo disponible ..... ${r.datos.available} ${r.datos.marginCoin}`);

    expect(Number(r.datos.available)).toBeGreaterThan(0);
  });

  it('paso 2 · abre una posicion de prueba', async () => {
    const plan = await motor.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: [{ cuentaId: CUENTA_ID, lado: 'long' }],
      margenInicial: MARGEN,
      apalancamiento: APALANCAMIENTO,
      precioLimite: null
    });
    const lote = await motor.ejecutar(plan);
    const job = lote.jobs[0];

    console.log(`
  cantidad ............. ${plan.entradas[0]?.size} SBTC a ${plan.precioReferencia}
  estado ............... ${job?.estado}
  codigo Bitget ........ ${job?.codigoBitget ?? '—'}`);

    if (job?.codigoBitget === '40126') {
      throw new Error(
        'Bitget rechaza la apertura con 40126: la credencial es de una SUBCUENTA y el mercado ' +
          'simulado solo admite claves creadas desde Trading Demo de la cuenta principal. ' +
          'Ver docs/00-fase-4-cierre.md sección 4.'
      );
    }
    expect(job?.estado).toBe('exito');
  });

  it('paso 3 · Bitget confirma que la posicion existe', async () => {
    const r = await obtenerPosiciones(cliente, credencialReal, MERCADO_SIMULADO);
    const abierta = buscarPosicion(r.datos, SIMBOLO, 'long');

    console.log(`
  posicion abierta ..... ${abierta?.total ?? 'ninguna'} SBTC
  precio de entrada .... ${abierta?.openPriceAvg ?? '—'}
  margen comprometido .. ${abierta?.marginSize ?? '—'}`);

    expect(abierta).not.toBeNull();
  });

  it('paso 4 · planifica el cierre y enseña que se va a cerrar', async () => {
    planCierre = await motor.planificarCierre({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: [{ cuentaId: CUENTA_ID, lado: 'long' }]
    });

    console.log(`
  a cerrar ............. ${planCierre.entradas[0]?.size} SBTC
  entrada .............. ${planCierre.entradas[0]?.precioEntrada ?? '—'}
  margen que se libera . ${planCierre.entradas[0]?.margenLiberado ?? '—'}
  descartes ............ ${planCierre.descartes.length}`);

    expect(planCierre.entradas).toHaveLength(1);
  });

  it('paso 5 · cierra y Bitget lo confirma', async () => {
    const lote = await motor.ejecutarCierre(planCierre);

    console.log(`
  estado ............... ${lote.jobs[0]?.estado}
  orderId .............. ${lote.jobs[0]?.ordenId ?? '—'}`);

    expect(resumirLote(lote).exito).toBe(1);
  });

  it('paso 6 · la posicion ya no existe', async () => {
    const r = await obtenerPosiciones(cliente, credencialReal, MERCADO_SIMULADO);
    const abierta = buscarPosicion(r.datos, SIMBOLO, 'long');

    console.log(`\n  posiciones abiertas tras el cierre: ${abierta === null ? 'ninguna' : abierta.total}`);

    expect(abierta).toBeNull();
  });

  /*
   * Cerrar dos veces no es un error del operador: es lo que pasa cuando pulsa
   * por segunda vez sin estar seguro. Tiene que salir como «no habia nada que
   * cerrar», no como un fallo que le haga buscar un problema.
   */
  it('paso 7 · volver a cerrar lo ya cerrado se cuenta como omitido', async () => {
    const plan = await motor.planificarCierre({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: [{ cuentaId: CUENTA_ID, lado: 'long' }]
    });

    console.log(`\n  al replanificar: ${plan.entradas.length} por cerrar, ${plan.descartes.length} descartadas`);
    console.log(`  motivo: ${plan.descartes[0]?.mensaje ?? '—'}`);

    expect(plan.entradas).toHaveLength(0);
    expect(plan.descartes[0]?.motivo).toBe('sin-posicion');
  });
});
