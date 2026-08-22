/**
 * Apertura de una posicion real en el mercado simulado de Bitget.
 *
 * --------------------------------------------------------------------------
 * Que demuestra
 * --------------------------------------------------------------------------
 * Que el motor de lotes abre de verdad: mismo codigo, misma firma, mismo
 * limitador y mismo `clientOid` que se usaran con dinero real. Lo unico que
 * cambia es el mercado -`SUSDT-FUTURES`, saldo simulado y oficial de Bitget-,
 * y ese cambio es del propio exchange: el simbolo `SBTCSUSDT` no existe en el
 * mercado real, asi que esta prueba **no puede** tocar dinero de nadie ni por
 * error de configuracion.
 *
 * Es la prueba que se ensena al cliente. Imprime lo que hizo en cada paso.
 *
 * Se ejecuta con `npm run test:fisica`. Sin credenciales se omite; en
 * staging falla ruidosamente en lugar de pasar en verde sin haber probado nada.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClienteBitget } from '@main/bitget/rest/client';
import { ErrorBitget } from '@main/bitget/errors';
import { MERCADO_SIMULADO } from '@main/bitget/mercado';
import { consultarOrden } from '@main/bitget/rest/endpoints/ordenes';
import { obtenerCuentaSimbolo } from '@main/bitget/rest/endpoints/cuenta';
import {
  MotorLotes,
  resumirLote,
  type CuentaEjecutable,
  type FuenteCuentas
} from '@main/execution/motor-lotes';
import type { PlanApertura } from '@main/execution/motor-lotes';
import { credencialReal, hayCredenciales } from '../red/credenciales-reales';

const SIMBOLO = 'SBTCSUSDT';
const CUENTA_ID = 'demo-1';
/** Margen por posicion. Pequeno a proposito: lo que se prueba es el camino, no el tamano. */
const MARGEN = '50';
const APALANCAMIENTO = 10;

let cliente: ClienteBitget;
let motor: MotorLotes;
let plan: PlanApertura;

/** Una sola cuenta: la credencial real contra el mercado simulado. */
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

describe.skipIf(!hayCredenciales)('apertura contra el mercado simulado de Bitget', () => {
  it('lee el saldo simulado de la cuenta', async () => {
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
  saldo disponible ..... ${r.datos.available} ${r.datos.marginCoin}
  modo de posicion ..... ${r.datos.posMode}
  modo de margen ....... ${r.datos.marginMode}`);

    expect(Number(r.datos.available)).toBeGreaterThan(0);
  });

  it('planifica sin enviar nada, con precio y cantidad reales', async () => {
    plan = await motor.planificar({
      mercado: MERCADO_SIMULADO,
      simbolo: SIMBOLO,
      objetivos: [{ cuentaId: CUENTA_ID, lado: 'long' }],
      margenInicial: MARGEN,
      apalancamiento: APALANCAMIENTO,
      precioLimite: null
    });

    const entrada = plan.entradas[0];
    console.log(`
  precio de marca ...... ${plan.precioReferencia}
  margen pedido ........ ${MARGEN} a ${APALANCAMIENTO}x
  cantidad calculada ... ${entrada?.size} SBTC
  nocional ............. ${entrada?.nocional}
  margen real .......... ${entrada?.margenReal}
  identificador ........ ${entrada?.clientOid}
  descartes ............ ${plan.descartes.length}`);

    expect(plan.entradas).toHaveLength(1);
    expect(Number(entrada?.size)).toBeGreaterThan(0);
    /* Truncar hacia abajo: nunca se compromete mas margen del que se pidio. */
    expect(Number(entrada?.margenReal)).toBeLessThanOrEqual(Number(MARGEN));
  });

  it('abre la posicion y Bitget la confirma', async () => {
    const lote = await motor.ejecutar(plan);
    const job = lote.jobs[0];

    console.log(`
  estado ............... ${job?.estado}
  orderId .............. ${job?.ordenId ?? '—'}
  codigo Bitget ........ ${job?.codigoBitget ?? '—'}
  mensaje .............. ${job?.mensaje ?? '—'}`);

    /*
     * 40126 no es un fallo del panel: es Bitget diciendo que este tipo de
     * cuenta no puede operar en el mercado simulado. Se distingue a proposito,
     * porque la accion que hay que tomar es del cliente y no del codigo.
     */
    if (job?.codigoBitget === '40126') {
      throw new Error(
        'Bitget rechaza la orden con 40126 «The current account type is not allowed to perform ' +
          'this operation». La credencial actual es de una SUBCUENTA y el mercado simulado ' +
          '(SUSDT-FUTURES) solo admite claves creadas desde la seccion de Trading Demo de la ' +
          'cuenta principal. El motor esta listo: falta esa clave. Ver docs/00-fase-4-apertura.md.'
      );
    }

    expect(resumirLote(lote).exito).toBe(1);
    expect(job?.ordenId).toBeTruthy();
  });

  it('la orden se puede recuperar por su identificador propio', async () => {
    const entrada = plan.entradas[0];
    const detalle = await consultarOrden(
      cliente,
      credencialReal,
      MERCADO_SIMULADO,
      SIMBOLO,
      entrada?.clientOid ?? ''
    );

    console.log(`
  consultada por clientOid: ${detalle === null ? 'no existe' : `${detalle.state}, ${detalle.size} SBTC`}`);

    expect(detalle).not.toBeNull();
  });

  it('limpia: cierra la posicion de prueba', async () => {
    try {
      await cliente.peticionFirmada(
        credencialReal,
        {
          metodo: 'POST',
          ruta: '/api/v2/mix/order/close-positions',
          cuerpo: {
            symbol: SIMBOLO,
            productType: MERCADO_SIMULADO.productType,
            holdSide: 'long'
          },
          idempotente: false
        },
        (await import('zod')).z.unknown()
      );
      console.log('\n  posicion de prueba cerrada.');
    } catch (e) {
      /*
       * El cierre es la segunda funcion de la Fase 4 y tendra su propio
       * endpoint; aqui solo se usa para no dejar la cuenta demo sucia.
       */
      const motivo = e instanceof ErrorBitget ? `${e.codigo} · ${e.mensajeOriginal}` : String(e);
      console.log(`\n  no se pudo cerrar la posicion de prueba: ${motivo}`);
    }
  });
});
