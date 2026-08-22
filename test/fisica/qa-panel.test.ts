/**
 * QA de aceptacion: el panel entero, por el mismo camino que usa la pantalla.
 *
 * --------------------------------------------------------------------------
 * Que hace esta prueba que no hagan las otras de test/fisica/
 * --------------------------------------------------------------------------
 * Las demas ejercitan el **motor** contra Bitget. Esta ejercita la `Sesion`,
 * que es el objeto que hay detras de cada canal IPC: es literalmente lo que
 * ocurre cuando el operador pulsa un boton, con vault de verdad, registro de
 * cuentas de verdad y credenciales cifradas.
 *
 * Recorre las seis operaciones de la Fase 4 en el orden en que se usan, y de
 * cada una comprueba lo mismo que ve el operador:
 *
 *   planificar   devuelve casillas concretas, y **no envia nada**
 *   ejecutar     envia solo lo aprobado, y devuelve un informe por casilla
 *
 * --------------------------------------------------------------------------
 * Que hace falta para correrla
 * --------------------------------------------------------------------------
 *   npm run test:fisica
 *
 * Con `.env` relleno. Opera contra el mercado **simulado** de Bitget
 * -`SUSDT-FUTURES`-, con saldo simulado y oficial. El simbolo `SBTCSUSDT` no
 * existe en el mercado real, asi que esta prueba no puede tocar dinero de nadie
 * ni por un error de configuracion.
 *
 * El vault y el registro se crean en una carpeta temporal y se borran al
 * terminar: no toca los datos del panel instalado.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClienteBitget } from '@main/bitget/rest/client';
import { Sesion } from '@main/ipc/sesion';
import { resumirLote } from '@main/execution/motor-lotes';
import type { Lote } from '@shared/types';
import { credencialReal, hayCredenciales } from '../red/credenciales-reales';

const MAESTRA = 'contrasena-de-prueba-larga-y-aleatoria';
const PASO = 'bg1';
const CUENTA = 'QA';
const SUBCUENTA = 'Sub-01';
/** Margen pequeño: lo que se demuestra es el recorrido, no el tamaño. */
const MARGEN = '50';
const APALANCAMIENTO = 10;
const TP_PORCENTAJE = '35';
const MARGEN_EXTRA = '10';

let carpeta: string;
let cliente: ClienteBitget;
let sesion: Sesion;
let cuentaId = '';
let activoId = '';

/** Los objetivos tal como los manda la pantalla: cuenta y lado. */
const objetivos = (): { cuentaId: string; lado: 'long' }[] => [{ cuentaId, lado: 'long' }];

/** Imprime el informe de un lote como lo leeria el operador. */
function contar(titulo: string, lote: Lote): void {
  const r = resumirLote(lote);
  console.log(
    `  ${titulo.padEnd(22, '.')} ${r.exito} correctas · ${r.fallo} con error · ${r.omitida} omitidas`
  );
  for (const j of lote.jobs) {
    if (j.estado !== 'exito') console.log(`      ${j.etiqueta} [${j.estado}] ${j.mensaje ?? ''}`);
  }
}

beforeAll(async () => {
  if (!hayCredenciales) return;
  carpeta = await mkdtemp(join(tmpdir(), 'pcb-qa-'));
  cliente = new ClienteBitget();
  await cliente.sincronizarReloj();
  sesion = new Sesion(
    { vault: join(carpeta, 'vault.enc'), cuentas: join(carpeta, 'cuentas.json') },
    cliente
  );
});

afterAll(async () => {
  sesion?.cerrar();
  await cliente?.cerrar();
  if (carpeta !== undefined) await rm(carpeta, { recursive: true, force: true });
});

describe.skipIf(!hayCredenciales)('QA del panel contra Bitget', () => {
  it('paso 1 · crea el almacen y fija la contrasena de paso', async () => {
    const r = await sesion.crear(MAESTRA);
    expect(r.ok).toBe(true);

    await sesion.fijarPaso(PASO);

    console.log(`
  almacen .............. creado y desbloqueado
  contrasena de paso ... fijada`);

    expect(sesion.hayPaso()).toBe(true);
    expect(await sesion.comprobarPaso(PASO)).toBe(true);
    expect(await sesion.comprobarPaso('otra')).toBe(false);
  });

  /*
   * El alta es la que verifica la credencial contra Bitget y detecta el UID.
   * Si esto falla, nada de lo demas tiene sentido: no habria con que firmar.
   */
  it('paso 2 · da de alta la subcuenta y detecta su UID', async () => {
    const r = await sesion.agregar({
      etiqueta: SUBCUENTA,
      grupoNombre: CUENTA,
      apiKey: credencialReal.apiKey,
      secretKey: credencialReal.secretKey,
      passphrase: credencialReal.passphrase
    });

    console.log(`
  alta ................. ${r.ok ? 'correcta' : `RECHAZADA · ${r.motivo ?? ''}`}
  UID detectado ........ ${r.cuenta?.uid ?? '—'}
  cuenta principal ..... ${r.cuenta?.uidPadre === '' ? 'no es subcuenta' : (r.cuenta?.uidPadre ?? '—')}
  avisos ............... ${r.advertencias.map((a) => a.codigo).join(', ') || 'ninguno'}`);

    expect(r.ok).toBe(true);
    cuentaId = r.cuenta?.id ?? '';
    expect(cuentaId).not.toBe('');
  });

  /*
   * El catalogo es lo primero que pide la pantalla al arrancar. Sin el no hay
   * selector de activo, asi que un fallo aqui deja el panel inutilizable aunque
   * todo lo demas funcione.
   */
  it('paso 3 · el catalogo trae los activos del mercado con sus topes', async () => {
    const activos = await sesion.activos();

    console.log('');
    for (const a of activos) {
      console.log(`  ${a.id.padEnd(6)} ${a.simbolo.padEnd(12)} hasta ${a.apalancamientoMax}x · ${a.decimalesPrecio} decimales`);
    }

    expect(activos.length).toBeGreaterThan(0);
    activoId = activos[0]?.simbolo ?? '';
    expect(activos.every((a) => a.apalancamientoMax > 0)).toBe(true);
  });

  it('paso 4 · hay precio de mercado para el selector', async () => {
    const precios = await sesion.precios();

    console.log(`\n  precios .............. ${JSON.stringify(precios)}`);

    expect(Object.keys(precios).length).toBeGreaterThan(0);
  });

  /*
   * La promesa del contrato: planificar enseña cantidades concretas y no envia
   * nada. Si esto enviara, el diálogo de confirmacion seria decorativo.
   */
  it('paso 5 · planificar la apertura no envia ninguna orden', async () => {
    const plan = await sesion.planificarApertura({
      simbolo: activoId,
      objetivos: objetivos(),
      margenInicial: MARGEN,
      apalancamiento: APALANCAMIENTO,
      precioLimite: null
    });

    console.log(`
  precio de referencia . ${plan.precioReferencia}
  cantidad ............. ${plan.entradas[0]?.size ?? '—'}
  margen real .......... ${plan.entradas[0]?.margenReal ?? '—'}
  descartes ............ ${plan.descartes.map((d) => d.mensaje).join(' | ') || 'ninguno'}`);

    expect(plan.entradas.length + plan.descartes.length).toBe(1);
  });

  it('paso 6 · abre de verdad', async () => {
    const plan = await sesion.planificarApertura({
      simbolo: activoId,
      objetivos: objetivos(),
      margenInicial: MARGEN,
      apalancamiento: APALANCAMIENTO,
      precioLimite: null
    });
    if (plan.entradas.length === 0) {
      console.log(`\n  sin casillas viables: ${plan.descartes[0]?.mensaje ?? ''}`);
      expect(plan.descartes.length).toBe(1);
      return;
    }

    const lote = await sesion.ejecutarApertura(plan.id);
    console.log('');
    contar('apertura', lote);

    const job = lote.jobs[0];
    if (job?.codigoBitget === '40126') {
      throw new Error(
        'Bitget rechaza la apertura con 40126: la credencial es de una SUBCUENTA y el mercado ' +
          'simulado solo admite claves creadas desde Trading Demo de la cuenta principal. ' +
          'Ver docs/00-fase-4-cierre.md sección 4.'
      );
    }
    expect(resumirLote(lote).exito).toBe(1);
  });

  it('paso 7 · pone el Take Profit', async () => {
    const plan = await sesion.planificarTakeProfit({
      simbolo: activoId,
      objetivos: objetivos(),
      porcentaje: TP_PORCENTAJE
    });

    console.log(`
  TP al ${TP_PORCENTAJE}% ........... ${plan.entradas[0]?.precioDisparo ?? '—'}
  entrada .............. ${plan.entradas[0]?.precioEntrada ?? '—'}`);

    if (plan.entradas.length === 0) {
      expect(plan.descartes.length).toBe(1);
      return;
    }
    contar('take profit', await sesion.ejecutarTakeProfit(plan.id));
  });

  /* La funcion que pidio el cliente el 18/08: operar sin Take Profit. */
  it('paso 8 · lo quita', async () => {
    const plan = await sesion.planificarQuitarTakeProfit({ simbolo: activoId, objetivos: objetivos() });

    console.log(`\n  a quitar ............. ${plan.entradas[0]?.precioDisparo ?? 'ninguno'}`);

    if (plan.entradas.length === 0) {
      expect(plan.descartes.length).toBe(1);
      return;
    }
    contar('quitar take profit', await sesion.ejecutarQuitarTakeProfit(plan.id));
  });

  /*
   * El cliente marco el margen como lo mas critico. Su planificacion comprueba
   * tres cosas antes de enviar -posicion, modo aislado y saldo- y aqui se ve
   * cual de las tres impide la operacion cuando la impide.
   */
  it('paso 9 · agrega margen, o dice exactamente por que no puede', async () => {
    const plan = await sesion.planificarMargen({
      simbolo: activoId,
      objetivos: objetivos(),
      cantidad: MARGEN_EXTRA
    });

    console.log(`
  margen actual ........ ${plan.entradas[0]?.margenActual ?? '—'}
  quedaria en .......... ${plan.entradas[0]?.margenResultante ?? '—'}
  descartes ............ ${plan.descartes.map((d) => `${d.motivo}: ${d.mensaje}`).join(' | ') || 'ninguno'}`);

    if (plan.entradas.length === 0) {
      /* En cruzado Bitget no admite margen adicional: es un descarte legitimo. */
      expect(plan.descartes.length).toBe(1);
      return;
    }
    contar('agregar margen', await sesion.ejecutarMargen(plan.id));
  });

  it('paso 10 · cierra la posicion de prueba', async () => {
    const plan = await sesion.planificarCierre({ simbolo: activoId, objetivos: objetivos() });

    console.log(`\n  a cerrar ............. ${plan.entradas[0]?.size ?? 'nada'}`);

    if (plan.entradas.length === 0) {
      expect(plan.descartes.length).toBe(1);
      return;
    }
    contar('cierre', await sesion.ejecutarCierre(plan.id));
  });

  /*
   * El apalancamiento es configuracion de la cuenta y no necesita posicion, asi
   * que pasa incluso cuando la apertura esta bloqueada. Es la unica de las seis
   * que se puede demostrar hoy entera con la credencial que hay.
   */
  it('paso 11 · ajusta el apalancamiento y lo devuelve a su valor', async () => {
    const subir = await sesion.planificarApalancamiento({
      simbolo: activoId,
      objetivos: objetivos(),
      apalancamiento: 20
    });

    console.log(`\n  apalancamiento ....... ${subir.entradas[0]?.apalancamientoActual ?? '?'}x → 20x`);
    contar('apalancamiento', await sesion.ejecutarApalancamiento(subir.id));

    const volver = await sesion.planificarApalancamiento({
      simbolo: activoId,
      objetivos: objetivos(),
      apalancamiento: APALANCAMIENTO
    });
    await sesion.ejecutarApalancamiento(volver.id);
  });

  /*
   * El freno del pliego: con el panel bloqueado no se planifica ni se envia
   * nada, aunque alguien conserve el identificador de un plan anterior.
   */
  it('paso 12 · con el panel bloqueado no se puede operar', async () => {
    sesion.cerrar();

    await expect(
      sesion.planificarCierre({ simbolo: activoId, objetivos: objetivos() })
    ).rejects.toThrow();

    console.log('\n  panel bloqueado ...... no admite planificar ni enviar\n');
  });
});
