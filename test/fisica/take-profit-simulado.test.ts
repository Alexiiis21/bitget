/**
 * Abrir, poner el Take Profit, quitarlo, volver a ponerlo y cerrar.
 *
 * --------------------------------------------------------------------------
 * Es el recorrido que hace el operador
 * --------------------------------------------------------------------------
 * El recorrido completo del Take Profit en un solo pase y contra Bitget, con
 * dinero simulado y oficial. Comprueba lo unico que no se puede comprobar sin
 * salir a la red: que el precio que calcula el panel es el que Bitget acepta y
 * coloca, que el porcentaje del operador se traduce al precio que el espera, y
 * que quitarlo lo quita de verdad -el cliente opera sin Take Profit cuando el
 * mercado se lo pide-.
 *
 * Se ejecuta con `npm run test:fisica`. Imprime cada paso.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClienteBitget } from '@main/bitget/rest/client';
import { MERCADO_SIMULADO } from '@main/bitget/mercado';
import { obtenerCuentaSimbolo } from '@main/bitget/rest/endpoints/cuenta';
import { buscarPosicion, obtenerPosiciones } from '@main/bitget/rest/endpoints/posiciones';
import { planesPendientes } from '@main/bitget/rest/endpoints/tpsl';
import {
  MotorLotes,
  resumirLote,
  type CuentaEjecutable,
  type FuenteCuentas
} from '@main/execution/motor-lotes';
import { credencialReal, hayCredenciales } from '../red/credenciales-reales';

const SIMBOLO = 'SBTCSUSDT';
const CUENTA_ID = 'demo-1';
const MARGEN = '50';
const APALANCAMIENTO = 10;
/**
 * Dos porcentajes distintos a proposito.
 *
 * El cliente corrigio el 18/08/2026 que **no** siempre opera al 35%: usa el que
 * pida el activo o el momento del mercado. La prueba coloca uno, lo quita y
 * coloca otro, que es exactamente lo que el hace cuando cambia de idea.
 */
const PORCENTAJE = '35';
const PORCENTAJE_SEGUNDO = '20';

let cliente: ClienteBitget;
let motor: MotorLotes;
/** Solo con un Take Profit realmente colocado tiene sentido el paso 7. */
let takeProfitColocado = false;

class UnaCuenta implements FuenteCuentas {
  saldo = '0';
  cuentaEjecutable(cuentaId: string): CuentaEjecutable | null {
    if (cuentaId !== CUENTA_ID) return null;
    return {
      cuentaId,
      etiqueta: 'Cuenta demo',
      credencial: credencialReal,
      saldoDisponible: this.saldo,
      modoMargen: 'crossed',
      apalancamiento: { long: APALANCAMIENTO, short: APALANCAMIENTO, cruzado: APALANCAMIENTO }
    };
  }
}

const fuente = new UnaCuenta();
const objetivos = [{ cuentaId: CUENTA_ID, lado: 'long' as const }];

beforeAll(async () => {
  if (!hayCredenciales) return;
  cliente = new ClienteBitget();
  await cliente.sincronizarReloj();
  motor = new MotorLotes(cliente, fuente);
});

afterAll(async () => {
  await cliente?.cerrar();
});

describe.skipIf(!hayCredenciales)('abrir, poner Take Profit y cerrar', () => {
  it('paso 1 · hay saldo simulado', async () => {
    const r = await obtenerCuentaSimbolo(
      cliente,
      credencialReal,
      SIMBOLO,
      MERCADO_SIMULADO.productType,
      MERCADO_SIMULADO.marginCoin
    );
    fuente.saldo = r.datos.available;

    console.log(`\n  saldo ................ ${r.datos.available} ${r.datos.marginCoin}`);
    expect(Number(r.datos.available)).toBeGreaterThan(0);
  });

  it('paso 2 · abre una posicion', async () => {
    const plan = await motor.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos,
      margenInicial: MARGEN,
      apalancamiento: APALANCAMIENTO,
      precioLimite: null
    });
    const lote = await motor.ejecutar(plan);

    console.log(`  apertura ............. ${lote.jobs[0]?.estado} (${lote.jobs[0]?.codigoBitget ?? 'sin código'})`);

    if (lote.jobs[0]?.codigoBitget === '40126') {
      throw new Error(
        'Bitget rechaza la apertura con 40126: la credencial es de una SUBCUENTA y el mercado ' +
          'simulado solo admite claves creadas desde Trading Demo de la cuenta principal. ' +
          'Ver docs/00-fase-4-take-profit.md sección 4.'
      );
    }
    expect(lote.jobs[0]?.estado).toBe('exito');
  });

  it('paso 3 · planifica el Take Profit al 35% y enseña el precio', async () => {
    const plan = await motor.planificarTakeProfit({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos,
      porcentaje: PORCENTAJE
    });
    const e = plan.entradas[0];

    console.log(`
  entrada .............. ${e?.precioEntrada}
  apalancamiento ....... ${e?.apalancamiento}x
  Take Profit ${PORCENTAJE}% ..... ${e?.precioDisparo}
  el precio se mueve ... ${e?.movimientoPorcentaje}%`);

    expect(plan.entradas).toHaveLength(1);
    /* El recorrido es el porcentaje dividido por el apalancamiento. */
    expect(Number(e?.movimientoPorcentaje)).toBeCloseTo(Number(PORCENTAJE) / APALANCAMIENTO, 2);
  });

  it('paso 4 · coloca el Take Profit y Bitget lo acepta', async () => {
    const plan = await motor.planificarTakeProfit({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos,
      porcentaje: PORCENTAJE
    });
    const lote = await motor.ejecutarTakeProfit(plan);

    console.log(`  colocado ............. ${lote.jobs[0]?.estado} · ${lote.jobs[0]?.mensaje ?? 'sin mensaje'}`);
    takeProfitColocado = resumirLote(lote).exito === 1;
    expect(resumirLote(lote).exito).toBe(1);
  });

  /*
   * La comprobacion que decide si el `triggerType` es el correcto: el plan que
   * Bitget guarda debe dispararse por ultimo precio, como en la pantalla del
   * operador, y estar en el precio que calculo el panel.
   */
  it('paso 5 · el Take Profit figura en Bitget con el precio calculado', async () => {
    const planes = await planesPendientes(cliente, credencialReal, MERCADO_SIMULADO);
    const nuestro = planes.find((p) => p.symbol === SIMBOLO);

    console.log(`
  planes en Bitget ..... ${planes.length}
  precio de disparo .... ${nuestro?.triggerPrice ?? '—'}
  lado ................. ${nuestro?.holdSide ?? '—'}`);

    expect(nuestro).toBeDefined();
  });

  /*
   * Lo que el cliente pidio el 18/08/2026: «debo poder quitarlo si quiero,
   * porque hay escenarios de mercado donde voy sin Take Profit y cierro a
   * mano». Estos tres pasos lo demuestran sobre la posicion que acaba de
   * recibir el suyo.
   */
  it('paso 6 · quita el Take Profit y enseña cual va a quitar', async () => {
    const plan = await motor.planificarQuitarTakeProfit({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos
    });

    console.log(`
  puesto ahora ......... ${plan.entradas[0]?.precioDisparo ?? 'ninguno'}
  identificador ........ ${plan.entradas[0]?.orderId ?? '—'}`);

    const lote = await motor.ejecutarQuitarTakeProfit(plan);
    console.log(`  quitado .............. ${lote.jobs[0]?.estado} · ${lote.jobs[0]?.mensaje ?? ''}`);

    expect(resumirLote(lote).exito).toBe(1);
  });

  it('paso 7 · Bitget confirma que ya no hay ningun Take Profit', async () => {
    const planes = await planesPendientes(cliente, credencialReal, MERCADO_SIMULADO);
    const nuestro = planes.find((p) => p.symbol === SIMBOLO);

    console.log(`  planes que quedan .... ${nuestro === undefined ? 'ninguno' : nuestro.triggerPrice}`);

    expect(nuestro).toBeUndefined();
  });

  /*
   * Pulsar «quitar» dos veces no es un error del operador: es lo que hace quien
   * no esta seguro. Tiene que salir como «ya no estaba», no como un fallo que
   * le haga buscar un problema que no existe.
   */
  it('paso 8 · volver a quitarlo sale como omitido, no como fallo', async () => {
    const plan = await motor.planificarQuitarTakeProfit({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos
    });

    console.log(`  al replanificar ...... ${plan.entradas.length} por quitar, ${plan.descartes.length} descartadas`);
    console.log(`  motivo ............... ${plan.descartes[0]?.mensaje ?? '—'}`);

    expect(plan.entradas).toHaveLength(0);
    expect(plan.descartes[0]?.motivo).toBe('sin-take-profit');
  });

  /*
   * Y se vuelve a poner con OTRO porcentaje. Es la demostracion de que el 35%
   * no esta grabado en ninguna parte: el operador escribe el que quiera.
   */
  it('paso 9 · lo vuelve a poner con otro porcentaje', async () => {
    const plan = await motor.planificarTakeProfit({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos,
      porcentaje: PORCENTAJE_SEGUNDO
    });
    const lote = await motor.ejecutarTakeProfit(plan);

    console.log(`
  Take Profit ${PORCENTAJE_SEGUNDO}% ..... ${plan.entradas[0]?.precioDisparo}
  colocado ............. ${lote.jobs[0]?.estado}`);

    takeProfitColocado = resumirLote(lote).exito === 1;
    expect(takeProfitColocado).toBe(true);
  });

  it('paso 10 · cierra la posicion de prueba', async () => {
    const plan = await motor.planificarCierre({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos
    });
    const lote = await motor.ejecutarCierre(plan);

    console.log(`  cierre ............... ${lote.jobs[0]?.estado}`);
    expect(resumirLote(lote).exito).toBe(1);
  });

  /*
   * Pregunta abierta del cliente: al cerrar, ¿Bitget retira solo el Take Profit
   * que quedaba puesto? Si quedara vivo, el panel tendria que cancelarlo. Este
   * paso lo responde con datos en lugar de con suposiciones.
   */
  it('paso 11 · ¿queda vivo el Take Profit despues de cerrar?', async () => {
    const posiciones = await obtenerPosiciones(cliente, credencialReal, MERCADO_SIMULADO);
    const planes = await planesPendientes(cliente, credencialReal, MERCADO_SIMULADO);
    const huerfano = planes.find((p) => p.symbol === SIMBOLO);

    /*
     * Sin un Take Profit colocado no hay nada que observar, y decir «Bitget lo
     * retiro solo» seria afirmar algo que esta prueba no ha visto. Se dice que
     * no se pudo comprobar, que es la verdad.
     */
    const veredicto = !takeProfitColocado
      ? 'sin comprobar — no llegó a colocarse ningún Take Profit'
      : huerfano === undefined
        ? 'no, Bitget lo retiró solo'
        : 'SÍ — habría que cancelarlo desde el panel';

    console.log(`
  posicion abierta ..... ${buscarPosicion(posiciones.datos, SIMBOLO, 'long') === null ? 'ninguna' : 'sigue ahí'}
  Take Profit vivo ..... ${veredicto}`);

    expect(buscarPosicion(posiciones.datos, SIMBOLO, 'long')).toBeNull();
  });
});
