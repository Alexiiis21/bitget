/**
 * Traspaso entre subcuentas, extremo a extremo en el proceso principal.
 *
 * Es la primera funcion de esta serie que mueve dinero, asi que lo que se prueba
 * aqui no es solo que funcione, sino que **no pueda hacer dano**:
 *
 *   1. Planificar no envia nada. Cancelar no cuesta.
 *   2. Sin contrasena de paso no sale un dolar.
 *   3. Lo que se envia es lo aprobado, no lo que la pantalla diga despues.
 *   4. El intento queda en disco **antes** de salir a la red, de modo que un
 *      envio sin respuesta se puede señalar en vez de perderse.
 *   5. Un plan solo se puede ejecutar una vez.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClienteBitget } from '@main/bitget/rest/client';
import { Sesion } from '@main/ipc/sesion';
import { iniciarExchangeSimulado, sobreOk, type ExchangeSimulado } from '../mock-exchange/servidor';

/*
 * scrypt barato: estas pruebas crean un almacen por caso y lo que ejercitan es
 * la sesion, no la dureza del cifrado -que cubre test/unit/vault.test.ts-. Con
 * el coste real, varias suites en paralelo agotaban el limite de tiempo de
 * vitest de forma intermitente.
 */
const KDF_PRUEBAS = { N: 16, r: 1, p: 1 };

const MAESTRA = 'contrasena-de-prueba';
const PASO = 'bg1';
const UID_MADRE = '1513226215';

const ALTA_MADRE = {
  etiqueta: 'Cuenta Madre 1',
  apiKey: 'bg_madre1234567890ab',
  secretKey: 'secreto-de-la-madre',
  passphrase: 'frase-de-la-madre'
};

const infoMadre = (): unknown =>
  sobreOk({
    userId: UID_MADRE,
    authorities: ['coow', 'cpow', 'chow'],
    ips: '1.2.3.4',
    parentId: 0
  });

const saldos = (filas: { uid: string; disponible: string; transferible?: string }[]): unknown =>
  sobreOk(
    filas.map((f) => ({
      userId: f.uid,
      assetList: [
        {
          marginCoin: 'USDT',
          available: f.disponible,
          maxTransferOut: f.transferible ?? f.disponible,
          accountEquity: f.disponible,
          usdtEquity: f.disponible,
          locked: '0',
          unrealizedPL: '0'
        }
      ]
    }))
  );

/** Fila de saldo tal como la devuelve el exchange simulado. */
type FilaSaldo = { uid: string; disponible: string; transferible?: string };

const DOS_SUBCUENTAS: FilaSaldo[] = [
  { uid: '111', disponible: '100' },
  { uid: '222', disponible: '50' }
];

let carpeta: string;
let exchange: ExchangeSimulado;
let cliente: ClienteBitget;
let sesion: Sesion;
let rutaTraspasos: string;

beforeEach(async () => {
  carpeta = await mkdtemp(join(tmpdir(), 'pcb-traspaso-'));
  rutaTraspasos = join(carpeta, 'traspasos', 'movimientos.jsonl');

  exchange = await iniciarExchangeSimulado();
  cliente = new ClienteBitget({ host: exchange.url });
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

  /* Alta de la madre: verificacion + primera lectura de saldos. */
  exchange.responder({ cuerpo: infoMadre() });
  exchange.responder({ cuerpo: saldos(DOS_SUBCUENTAS) });
  await sesion.agregarMadre(ALTA_MADRE);
});

afterEach(async () => {
  sesion.cerrar();
  await cliente.cerrar();
  await exchange.cerrar();
  await rm(carpeta, { recursive: true, force: true });
});

/** Planifica un traspaso, encolando antes la lectura de saldos que necesita. */
const planificar = async (
  importe: string,
  filas = DOS_SUBCUENTAS,
  origen = '111',
  destino = '222'
) => {
  exchange.responder({ cuerpo: saldos(filas) });
  return sesion.planificarTraspaso({ uidOrigen: origen, uidDestino: destino, importe });
};

const lineas = async (): Promise<Record<string, unknown>[]> => {
  const crudo = await readFile(rutaTraspasos, 'utf8');
  return crudo
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
};

describe('planificar no mueve nada', () => {
  it('calcula origen, destino, importe y los dos saldos resultantes', async () => {
    const plan = await planificar('30');

    expect(plan.origen).toMatchObject({ uid: '111', antes: '100', despues: '70' });
    expect(plan.destino).toMatchObject({ uid: '222', antes: '50', despues: '80' });
    expect(plan.importe).toBe('30');
    expect(plan.maxTransferible).toBe('100');
  });

  /* Planificar no puede dejar rastro de dinero movido: no se ha movido nada. */
  it('no escribe nada en el registro', async () => {
    await planificar('30');

    expect(await sesion.historialTraspasos()).toEqual([]);
  });

  it('rechaza lo que supera el maximo transferible, sin enviar nada', async () => {
    /* 100 de saldo, pero solo 40 pueden salir: el resto esta en posiciones. */
    await expect(
      planificar('80', [{ uid: '111', disponible: '100', transferible: '40' }, DOS_SUBCUENTAS[1]!])
    ).rejects.toThrow(/40/);

    expect(await sesion.historialTraspasos()).toEqual([]);
  });

  /*
   * Los saldos se releen al planificar. Con los de hace un minuto, un traspaso
   * podria autorizarse contra un maximo transferible que ya no existe porque
   * mientras tanto se abrio una posicion.
   */
  it('vuelve a leer los saldos en cada planificacion', async () => {
    /* Con 100 disponibles, 30 se planifica sin problema. */
    const primero = await planificar('30');
    expect(primero.origen.antes).toBe('100');

    /*
     * Entre una planificacion y la siguiente se abre una posicion y el maximo
     * transferible cae a 10. El mismo traspaso que valia hace un momento tiene
     * que rechazarse ahora: es la prueba de que se valida contra lo que Bitget
     * dice en este instante y no contra una copia guardada.
     */
    await expect(
      planificar('30', [{ uid: '111', disponible: '10', transferible: '10' }, DOS_SUBCUENTAS[1]!])
    ).rejects.toThrow(/solo pueden salir 10/);

    /* Y lo que si cabe en el saldo nuevo, se planifica con las cifras nuevas. */
    const tercero = await planificar('8', [
      { uid: '111', disponible: '10', transferible: '10' },
      DOS_SUBCUENTAS[1]!
    ]);
    expect(tercero.origen).toMatchObject({ antes: '10', despues: '2' });
  });
});

describe('la contrasena de paso', () => {
  it('sin ella no sale un dolar, y no se anota ningun intento', async () => {
    const plan = await planificar('30');

    const r = await sesion.ejecutarTraspaso(plan.id, 'la-que-no-es');

    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('paso-incorrecto');
    expect(await sesion.historialTraspasos()).toEqual([]);
  });

  /* Y el plan sigue vigente: equivocarse de clave no obliga a rehacerlo. */
  it('un fallo de clave no invalida el plan', async () => {
    const plan = await planificar('30');
    await sesion.ejecutarTraspaso(plan.id, 'la-que-no-es');

    exchange.responder({ cuerpo: sobreOk({ transferId: 'bg-1', clientOid: plan.clientOid }) });
    const r = await sesion.ejecutarTraspaso(plan.id, PASO);

    expect(r.ok).toBe(true);
  });
});

describe('el envio', () => {
  it('manda a Bitget exactamente lo aprobado', async () => {
    const plan = await planificar('30');
    exchange.responder({ cuerpo: sobreOk({ transferId: 'bg-9988', clientOid: plan.clientOid }) });

    const r = await sesion.ejecutarTraspaso(plan.id, PASO);

    expect(r.ok).toBe(true);
    expect(r.transferId).toBe('bg-9988');

    const enviada = exchange.peticiones.at(-1);
    expect(enviada?.url).toContain('/api/v2/spot/wallet/subaccount-transfer');
    expect(enviada?.metodo).toBe('POST');
    expect(JSON.parse(enviada?.cuerpo ?? '{}')).toMatchObject({
      fromType: 'usdt_futures',
      toType: 'usdt_futures',
      coin: 'USDT',
      amount: '30',
      fromUserId: '111',
      toUserId: '222',
      clientOid: plan.clientOid
    });
  });

  it('registra el movimiento con fecha, importe, origen, destino y resultado', async () => {
    const plan = await planificar('30');
    exchange.responder({ cuerpo: sobreOk({ transferId: 'bg-9988' }) });
    await sesion.ejecutarTraspaso(plan.id, PASO);

    const [m] = await sesion.historialTraspasos();

    /*
     * Se etiquetan por UID porque en esta prueba las subcuentas no estan dadas
     * de alta en el panel: solo las reporta la madre. Es un caso real -se puede
     * traspasar a una subcuenta que el panel no opera- y el registro guarda lo
     * que se vio en pantalla, que es justamente el UID.
     */
    expect(m).toMatchObject({
      etiquetaOrigen: '111',
      etiquetaDestino: '222',
      importe: '30',
      moneda: 'USDT',
      resultado: 'exito',
      transferId: 'bg-9988'
    });
    expect(m?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  /*
   * El orden importa mas que el contenido: si el `intento` se escribiera despues
   * de la respuesta, un proceso que muere en medio no dejaria rastro de que el
   * dinero pudo haber salido.
   */
  it('anota el intento ANTES de salir a la red', async () => {
    const plan = await planificar('30');
    /* El exchange responde error: aun asi el intento tuvo que quedar escrito. */
    exchange.responder({
      estado: 400,
      cuerpo: { code: '40014', msg: 'need transfer write permissions' }
    });

    await sesion.ejecutarTraspaso(plan.id, PASO);

    const registro = await lineas();
    expect(registro[0]).toMatchObject({ tipo: 'intento', importe: '30' });
    expect(registro[1]).toMatchObject({ tipo: 'resuelta', resultado: 'fallo' });
  });

  it('un rechazo de Bitget queda anotado con su codigo y no se reintenta', async () => {
    const plan = await planificar('30');
    exchange.responder({
      estado: 400,
      cuerpo: { code: '40014', msg: 'need transfer write permissions' }
    });

    const antes = exchange.peticiones.length;
    const r = await sesion.ejecutarTraspaso(plan.id, PASO);

    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('rechazado');

    const [m] = await sesion.historialTraspasos();
    expect(m?.resultado).toBe('fallo');
    expect(m?.mensaje).toBeTruthy();

    /* Una sola peticion: no hay reenvio a ciegas de algo que mueve dinero. */
    expect(exchange.peticiones.length).toBe(antes + 1);
  });
});

describe('un plan se envia una sola vez', () => {
  it('el segundo envio no llega a Bitget', async () => {
    const plan = await planificar('30');
    exchange.responder({ cuerpo: sobreOk({ transferId: 'bg-1' }) });
    await sesion.ejecutarTraspaso(plan.id, PASO);

    const despuesDelPrimero = exchange.peticiones.length;

    await expect(sesion.ejecutarTraspaso(plan.id, PASO)).rejects.toThrow(/vigente/i);
    expect(exchange.peticiones.length).toBe(despuesDelPrimero);

    /* Y en el registro hay un movimiento, no dos. */
    expect(await sesion.historialTraspasos()).toHaveLength(1);
  });

  it('el identificador del envio se deriva del plan, no es aleatorio', async () => {
    const plan = await planificar('30');

    /* Mismo plan, mismo clientOid: es lo que impide duplicar en el exchange. */
    expect(plan.clientOid).toContain(plan.id);
  });
});

describe('el panel bloqueado', () => {
  it('ni planifica ni ejecuta', async () => {
    const plan = await planificar('30');
    sesion.cerrar();

    await expect(
      sesion.planificarTraspaso({ uidOrigen: '111', uidDestino: '222', importe: '30' })
    ).rejects.toThrow('bloqueado');
    await expect(sesion.ejecutarTraspaso(plan.id, PASO)).rejects.toThrow('bloqueado');
  });
});
