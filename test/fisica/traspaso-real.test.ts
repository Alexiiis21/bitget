/**
 * Traspaso de saldo, de verdad y contra Bitget. **Mueve dinero real.**
 *
 * --------------------------------------------------------------------------
 * La prueba que las Fases 3 y 4 dejaron pendiente
 * --------------------------------------------------------------------------
 * Todo el traspaso —planificar, confirmar, enviar, registrar— se entregó probado
 * contra el exchange simulado, y no contra Bitget, por una razón que no era del
 * código: la clave de la cuenta madre no tenía permiso de traspaso (`40014 ·
 * need transfer write permissions`) ni esta IP en su lista blanca (`40018`).
 * docs/00-traspasos-fase-3.md §6 y docs/00-traspasos-fase-4.md §1.
 *
 * El 05/09/2026 se concedieron los dos. Esto es esa prueba.
 *
 * --------------------------------------------------------------------------
 * Qué mueve, y por qué se puede dejar corriendo sin miedo
 * --------------------------------------------------------------------------
 * Un importe mínimo de la cuenta madre a una de sus subcuentas, y **de vuelta**.
 * Empieza y acaba con el dinero donde estaba. Nada sale de Bitget: el traspaso
 * entre cuentas propias es lo único que este panel sabe hacer con el saldo, y
 * retirar a un destino externo no entra en el contrato ni entrará.
 *
 * Si la vuelta fallara, el importe se queda en la subcuenta —visible en la
 * pantalla de Saldos— y se devuelve desde el panel. No se pierde.
 *
 * Se ejecuta a propósito, nombrándola:
 *
 *   npx vitest run --config vitest.fisica.config.ts test/fisica/traspaso-real.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClienteBitget } from '@main/bitget/rest/client';
import { obtenerInfoCuenta } from '@main/bitget/rest/endpoints/cuenta';
import {
  obtenerSaldosSubcuentas,
  traspasarEntreSubcuentas
} from '@main/bitget/rest/endpoints/subcuentas';
import { MONEDA_TRASPASOS, resumirSaldos, type FilaSaldo } from '@main/domain/saldos-subcuentas';
import { planificarTraspaso } from '@main/domain/plan-traspaso';
import type { Credencial } from '@main/bitget/rest/signer';

/**
 * El importe de la prueba. Mínimo a propósito.
 *
 * No hay nada que demostrar con una cifra grande: lo que se comprueba es que la
 * petición está bien formada, que Bitget la acepta y que el saldo se mueve. Un
 * céntimo lo prueba igual que mil dólares, y si algo sale mal el importe atascado
 * es un céntimo.
 */
const IMPORTE = '0.5';

try {
  process.loadEnvFile('.env');
} catch {
  /* Sin .env se usan las variables del entorno, si las hay. */
}

/**
 * La credencial de la **cuenta madre**, y no la de `BITGET_DEMO_*`.
 *
 * Son dos claves distintas desde el 05/09/2026: la de traspasos es la única con
 * permiso para mover saldo. Un traspaso se firma siempre con la de la madre —es
 * ella quien mueve dinero entre sus subcuentas—, así que aquí no vale la que usa
 * el resto de la suite física para mandar órdenes.
 */
const VARIABLES = [
  'BITGET_MADRE_API_KEY',
  'BITGET_MADRE_SECRET_KEY',
  'BITGET_MADRE_PASSPHRASE'
] as const;

const faltantes = VARIABLES.filter((v) => (process.env[v] ?? '') === '');
const hayCredenciales = faltantes.length === 0;

const credencial: Credencial = {
  apiKey: process.env['BITGET_MADRE_API_KEY'] ?? '',
  secretKey: process.env['BITGET_MADRE_SECRET_KEY'] ?? '',
  passphrase: process.env['BITGET_MADRE_PASSPHRASE'] ?? ''
};

let cliente: ClienteBitget;
let uidMadre = '';
let uidSub = '';
/** Saldo de la subcuenta al empezar. Es contra lo que se compara al terminar. */
let saldoInicialSub = '0';

/** Las filas de saldo tal como las arma la pantalla, recién leídas. */
async function filas(): Promise<FilaSaldo[]> {
  const r = await obtenerSaldosSubcuentas(cliente, credencial);
  return resumirSaldos(r.datos, []).filas;
}

const buscar = (lista: readonly FilaSaldo[], uid: string): FilaSaldo | undefined =>
  lista.find((f) => f.uid === uid);

/**
 * Envía un traspaso pasando por el plan del panel, no por el endpoint pelado.
 *
 * Es lo que da valor a esta prueba: si solo se llamara a `traspasarEntreSubcuentas`
 * se comprobaría que Bitget responde, no que **el panel** hace bien el traspaso.
 */
async function traspasar(origen: string, destino: string, importe: string): Promise<string> {
  const lista = await filas();
  const id = `f${Date.now().toString(36)}`;

  const plan = planificarTraspaso(
    {
      uidOrigen: origen,
      uidDestino: destino,
      importe,
      uidMadre,
      etiquetaMadre: 'Cuenta madre',
      moneda: MONEDA_TRASPASOS,
      clientOid: `pcbtr${id}`,
      id,
      ahora: new Date().toISOString()
    },
    lista
  );

  const r = await traspasarEntreSubcuentas(cliente, credencial, {
    uidOrigen: plan.origen.uid,
    uidDestino: plan.destino.uid,
    importe: plan.importe,
    clientOid: plan.clientOid,
    moneda: plan.moneda
  });

  return r.datos.transferId ?? '';
}

/** Bitget no siempre refleja el saldo en la misma respuesta: se espera un poco. */
async function esperarSaldo(uid: string, esperado: string, intentos = 8): Promise<string> {
  let ultimo = '';
  for (let i = 0; i < intentos; i += 1) {
    const fila = buscar(await filas(), uid);
    ultimo = fila?.disponible ?? '';
    if (ultimo === esperado || Number(ultimo) === Number(esperado)) return ultimo;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return ultimo;
}

beforeAll(async () => {
  if (!hayCredenciales) return;
  cliente = new ClienteBitget();
  await cliente.sincronizarReloj();

  const info = await obtenerInfoCuenta(cliente, credencial);
  uidMadre = info.datos.userId;
});

afterAll(async () => {
  if (hayCredenciales && cliente !== undefined) await cliente.cerrar();
});

describe.skipIf(!hayCredenciales)('traspaso de saldo contra Bitget', () => {
  it('paso 1 · la clave de la madre responde y reporta sus subcuentas', async () => {
    const lista = await filas();

    console.log(`\n  cuenta madre ............ ${uidMadre}`);
    console.log(`  subcuentas reportadas ... ${lista.length}`);

    expect(uidMadre).not.toBe('');
    expect(lista.length).toBeGreaterThan(0);
  });

  /*
   * El destino se elige leyendo, no se fija en el archivo: las subcuentas se
   * crearon por API y sus UID cambian entre entornos.
   */
  it('paso 2 · elige una subcuenta de destino y anota su saldo de partida', async () => {
    const lista = await filas();
    const destino = lista.find((f) => f.disponible !== null);

    expect(destino).toBeDefined();
    uidSub = destino?.uid ?? '';
    saldoInicialSub = destino?.disponible ?? '0';

    console.log(`  subcuenta de destino .... ${uidSub}`);
    console.log(`  su saldo ahora .......... ${saldoInicialSub} ${MONEDA_TRASPASOS}`);
  });

  /*
   * El plan es lo que el operador aprueba. De la madre no se conoce el saldo
   * -no se reporta a si misma-, asi que su antes y su despues van vacios; el de
   * la subcuenta si se calcula, y es el que se comprueba despues contra Bitget.
   */
  it('paso 3 · planifica el traspaso de la madre a la subcuenta', async () => {
    const lista = await filas();
    const plan = planificarTraspaso(
      {
        uidOrigen: uidMadre,
        uidDestino: uidSub,
        importe: IMPORTE,
        uidMadre,
        etiquetaMadre: 'Cuenta madre',
        moneda: MONEDA_TRASPASOS,
        clientOid: 'pcbtr-plan',
        id: 'plan',
        ahora: new Date().toISOString()
      },
      lista
    );

    console.log(
      `  plan .................... ${plan.origen.etiqueta} → ${plan.destino.etiqueta} · ${plan.importe} ${plan.moneda}`
    );
    console.log(`  la subcuenta quedaria en  ${plan.destino.despues}`);

    expect(plan.origen.uid).toBe(uidMadre);
    /* De la madre no se inventa un saldo que Bitget no informa. */
    expect(plan.origen.antes).toBe('');
    expect(plan.destino.despues).toBe(String(Number(saldoInicialSub) + Number(IMPORTE)));
  });

  it('paso 4 · lo envía y Bitget lo acepta', async () => {
    const transferId = await traspasar(uidMadre, uidSub, IMPORTE);

    console.log(`  enviado ................. transferId ${transferId || '(sin id)'}`);
    expect(transferId).not.toBe('');
  }, 60_000);

  it('paso 5 · el dinero llegó a la subcuenta', async () => {
    const esperado = String(Number(saldoInicialSub) + Number(IMPORTE));
    const ahora = await esperarSaldo(uidSub, esperado);

    console.log(`  saldo de la subcuenta ... ${ahora} ${MONEDA_TRASPASOS}`);
    expect(Number(ahora)).toBeCloseTo(Number(esperado), 6);
  }, 60_000);

  /*
   * La vuelta prueba la otra direccion -la que usa «Recoger saldo»- y ademas la
   * validacion que solo existe saliendo de una subcuenta: ahi si se conoce el
   * maximo transferible, y el plan lo comprueba antes de enviar.
   */
  it('paso 6 · lo devuelve a la madre y la subcuenta queda como estaba', async () => {
    const transferId = await traspasar(uidSub, uidMadre, IMPORTE);
    console.log(`  devuelto ................ transferId ${transferId || '(sin id)'}`);

    const ahora = await esperarSaldo(uidSub, saldoInicialSub);
    console.log(`  saldo de la subcuenta ... ${ahora} ${MONEDA_TRASPASOS} (era ${saldoInicialSub})\n`);

    expect(transferId).not.toBe('');
    expect(Number(ahora)).toBeCloseTo(Number(saldoInicialSub), 6);
  }, 60_000);
});
