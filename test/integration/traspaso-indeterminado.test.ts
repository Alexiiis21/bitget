/**
 * El traspaso del que no se sabe si entro.
 *
 * ==========================================================================
 * Por que esta prueba es la mas importante de los traspasos
 * ==========================================================================
 * `errors.ts` separa el rechazo -Bitget contesto que no- del **indeterminado**:
 * se envio y no hubo respuesta. Tratar el segundo como un fallo es el error caro,
 * y no por pulcritud:
 *
 *   1. Al operador se le dice «fallo».
 *   2. El operador replanifica y vuelve a enviar.
 *   3. El plan nuevo lleva un `clientOid` **nuevo**.
 *   4. La proteccion contra duplicados del envio original ya no aplica.
 *   5. El mismo dinero se mueve dos veces.
 *
 * Aqui se comprueba que ese camino esta cerrado: un envio sin respuesta se
 * consulta, y si la consulta tampoco resuelve, queda **pendiente** -ni exito ni
 * fallo- y se dice con esas palabras.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClienteBitget } from '@main/bitget/rest/client';
import { Sesion } from '@main/ipc/sesion';
import { iniciarExchangeSimulado, sobreOk, type ExchangeSimulado } from '../mock-exchange/servidor';

const KDF_PRUEBAS = { N: 16, r: 1, p: 1 };
const MAESTRA = 'contrasena-de-prueba';
const PASO = 'bg1';
const UID_MADRE = '1513226215';

/** Timeouts cortos: la prueba fuerza uno a proposito y no puede tardar 15 s. */
const TIMEOUTS = { conexion: 400, cabeceras: 400, cuerpo: 400 };
/** Retraso mayor que el timeout: la peticion sale y la respuesta no llega. */
const MAS_QUE_EL_TIMEOUT = 1500;

const ALTA_MADRE = {
  etiqueta: 'Cuenta Madre 1',
  apiKey: 'bg_madre1234567890ab',
  secretKey: 'secreto-de-la-madre',
  passphrase: 'frase-de-la-madre'
};

const infoMadre = (): unknown =>
  sobreOk({ userId: UID_MADRE, authorities: ['coow', 'cpow', 'chow'], ips: '1.2.3.4', parentId: 0 });

const saldos = (): unknown =>
  sobreOk([
    {
      userId: '111',
      assetList: [
        {
          marginCoin: 'USDT',
          available: '100',
          maxTransferOut: '100',
          accountEquity: '100',
          usdtEquity: '100',
          locked: '0',
          unrealizedPL: '0'
        }
      ]
    },
    {
      userId: '222',
      assetList: [
        {
          marginCoin: 'USDT',
          available: '50',
          maxTransferOut: '50',
          accountEquity: '50',
          usdtEquity: '50',
          locked: '0',
          unrealizedPL: '0'
        }
      ]
    }
  ]);

let carpeta: string;
let exchange: ExchangeSimulado;
let cliente: ClienteBitget;
let sesion: Sesion;
let rutaTraspasos: string;

beforeEach(async () => {
  carpeta = await mkdtemp(join(tmpdir(), 'pcb-indeterminado-'));
  rutaTraspasos = join(carpeta, 'traspasos', 'movimientos.jsonl');

  exchange = await iniciarExchangeSimulado();
  cliente = new ClienteBitget({ host: exchange.url, timeoutsMs: TIMEOUTS });
  sesion = new Sesion(
    {
      vault: join(carpeta, 'vault.enc'),
      cuentas: join(carpeta, 'cuentas.json'),
      activos: join(carpeta, 'activos.json'),
      traspasos: rutaTraspasos
    },
    cliente,
    { parametrosKdf: KDF_PRUEBAS }
  );

  await sesion.crear(MAESTRA);
  await sesion.fijarPaso(PASO);
  exchange.responder({ cuerpo: infoMadre() });
  exchange.responder({ cuerpo: saldos() });
  await sesion.agregarMadre(ALTA_MADRE);
});

afterEach(async () => {
  sesion.cerrar();
  await cliente.cerrar();
  await exchange.cerrar();
  await rm(carpeta, { recursive: true, force: true });
});

const planificar = async () => {
  exchange.responder({ cuerpo: saldos() });
  return sesion.planificarTraspaso({ uidOrigen: '111', uidDestino: '222', importe: '30' });
};

const lineas = async (): Promise<Record<string, unknown>[]> => {
  const crudo = await readFile(rutaTraspasos, 'utf8');
  return crudo
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
};

describe('el envio se cuelga y la consulta lo encuentra', () => {
  it('cuenta como exito, no como fallo', async () => {
    const plan = await planificar();

    /* El envio no responde... */
    exchange.responder({ retrasoMs: MAS_QUE_EL_TIMEOUT, cuerpo: sobreOk({}) });
    /* ...pero Bitget si tiene registrado el movimiento. */
    exchange.responder({
      cuerpo: sobreOk([{ clientOid: plan.clientOid, transferId: 'bg-777', status: 'Successful' }])
    });

    const r = await sesion.ejecutarTraspaso(plan.id, PASO);

    expect(r.ok).toBe(true);
    expect(r.transferId).toBe('bg-777');

    const historial = await sesion.historialTraspasos();
    expect(historial[0]?.resultado).toBe('exito');
  });
});

describe('el envio se cuelga y la consulta no resuelve', () => {
  /*
   * El caso peligroso. No encontrar el registro **no demuestra** que no entro:
   * Bitget puede tardar en registrarlo. Se queda pendiente.
   */
  it('no lo da por fallido: queda pendiente y lo dice', async () => {
    const plan = await planificar();

    exchange.responder({ retrasoMs: MAS_QUE_EL_TIMEOUT, cuerpo: sobreOk({}) });
    /* La consulta responde, pero sin ese movimiento. */
    exchange.responder({ cuerpo: sobreOk([]) });

    const r = await sesion.ejecutarTraspaso(plan.id, PASO);

    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('indeterminado');
    /* El mensaje tiene que desaconsejar repetirlo, que es el error caro. */
    expect(r.mensaje).toMatch(/comprueba/i);
    expect(r.mensaje).toMatch(/dos veces/i);
  });

  it('el registro lo deja pendiente: ni exito ni fallo', async () => {
    const plan = await planificar();
    exchange.responder({ retrasoMs: MAS_QUE_EL_TIMEOUT, cuerpo: sobreOk({}) });
    exchange.responder({ cuerpo: sobreOk([]) });

    await sesion.ejecutarTraspaso(plan.id, PASO);

    const historial = await sesion.historialTraspasos();
    expect(historial[0]?.resultado).toBe('pendiente');
    expect(await sesion.traspasosPendientes()).toHaveLength(1);

    /* Y en disco: hay intento, y NO hay linea de resuelta que lo cierre. */
    const registro = await lineas();
    expect(registro.filter((l) => l['tipo'] === 'intento')).toHaveLength(1);
    expect(registro.filter((l) => l['tipo'] === 'resuelta')).toHaveLength(0);
  });

  it('aguanta que la consulta tambien falle', async () => {
    const plan = await planificar();
    exchange.responder({ retrasoMs: MAS_QUE_EL_TIMEOUT, cuerpo: sobreOk({}) });
    exchange.responder({ estado: 500, cuerpo: { code: '50001', msg: 'server error' } });

    const r = await sesion.ejecutarTraspaso(plan.id, PASO);

    expect(r.motivo).toBe('indeterminado');
    expect((await sesion.historialTraspasos())[0]?.resultado).toBe('pendiente');
  });
});

describe('un rechazo de verdad sigue siendo un fallo', () => {
  /* Lo contrario también importa: no todo se vuelve «no se sabe». */
  it('Bitget contesta que no y se anota como fallo', async () => {
    const plan = await planificar();
    exchange.responder({ estado: 400, cuerpo: { code: '43012', msg: 'Insufficient balance' } });

    const r = await sesion.ejecutarTraspaso(plan.id, PASO);

    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('rechazado');
    expect((await sesion.historialTraspasos())[0]?.resultado).toBe('fallo');
    /* Y no se consultó: un rechazo no necesita comprobación. */
    expect(exchange.peticiones.filter((p) => p.url.includes('sub-main-trans-record'))).toHaveLength(
      0
    );
  });
});

describe('en el reparto masivo', () => {
  it('los sin confirmar se cuentan aparte de los fallidos', async () => {
    exchange.responder({ cuerpo: saldos() });
    const plan = await sesion.planificarReparto({
      destinos: ['111', '222'],
      total: '20',
      modo: 'iguales'
    });

    /* El primero entra; el segundo se cuelga y la consulta no lo encuentra. */
    exchange.responder({ cuerpo: sobreOk({ transferId: 'bg-1' }) });
    exchange.responder({ retrasoMs: MAS_QUE_EL_TIMEOUT, cuerpo: sobreOk({}) });
    exchange.responder({ cuerpo: sobreOk([]) });

    const r = await sesion.ejecutarReparto(plan.id, PASO);

    expect(r.enviados).toBe(1);
    expect(r.indeterminados).toBe(1);
    /* Lo que importa: NO cuenta como fallo. */
    expect(r.fallidos).toBe(0);
    expect(r.ok).toBe(false);
  });
});
