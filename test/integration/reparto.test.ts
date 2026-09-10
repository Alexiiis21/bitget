/**
 * Reparto y recogida masiva, extremo a extremo en el proceso principal.
 *
 * Lo que se prueba, ademas de que funcione:
 *
 *   1. La suma de lo enviado es exactamente el total aprobado.
 *   2. **Un fallo no detiene el lote**, y no hay rollback de lo que ya entro.
 *   3. Cada traspaso deja su propio rastro en disco, antes de salir a la red.
 *   4. Sin contrasena de paso no sale nada, y un plan se envia una sola vez.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
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

type Fila = { uid: string; disponible: string; transferible?: string };

const infoMadre = (): unknown =>
  sobreOk({
    userId: UID_MADRE,
    authorities: ['coow', 'cpow', 'chow'],
    ips: '1.2.3.4',
    parentId: 0
  });

const saldos = (filas: Fila[]): unknown =>
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

const TRES: Fila[] = [
  { uid: '111', disponible: '10' },
  { uid: '222', disponible: '20' },
  { uid: '333', disponible: '30' }
];

let carpeta: string;
let exchange: ExchangeSimulado;
let cliente: ClienteBitget;
let sesion: Sesion;
let rutaTraspasos: string;

beforeEach(async () => {
  carpeta = await mkdtemp(join(tmpdir(), 'pcb-reparto-'));
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

  exchange.responder({ cuerpo: infoMadre() });
  exchange.responder({ cuerpo: saldos(TRES) });
  await sesion.agregarMadre(ALTA_MADRE);
});

afterEach(async () => {
  sesion.cerrar();
  await cliente.cerrar();
  await exchange.cerrar();
  await rm(carpeta, { recursive: true, force: true });
});

const planReparto = async (total: string, modo: 'iguales' | 'igualar', filas = TRES) => {
  exchange.responder({ cuerpo: saldos(filas) });
  return sesion.planificarReparto({ destinos: filas.map((f) => f.uid), total, modo });
};

const planRecogida = async (filas = TRES) => {
  exchange.responder({ cuerpo: saldos(filas) });
  return sesion.planificarRecogida({ origenes: filas.map((f) => f.uid) });
};

/** Los cuerpos de los traspasos que llegaron al exchange. */
const traspasosEnviados = (): Record<string, string>[] =>
  exchange.peticiones
    .filter((p) => p.url.includes('subaccount-transfer'))
    .map((p) => JSON.parse(p.cuerpo) as Record<string, string>);

const lineas = async (): Promise<Record<string, unknown>[]> => {
  const crudo = await readFile(rutaTraspasos, 'utf8');
  return crudo
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
};

describe('reparto a partes iguales', () => {
  it('planifica un traspaso por subcuenta, desde la madre', async () => {
    const plan = await planReparto('90', 'iguales');

    expect(plan.tipo).toBe('reparto');
    expect(plan.movimientos).toHaveLength(3);
    expect(plan.total).toBe('90');
    for (const m of plan.movimientos) {
      expect(m.uidOrigen).toBe(UID_MADRE);
      expect(m.importe).toBe('30');
    }
  });

  it('envia todos y la suma es exactamente la aprobada', async () => {
    const plan = await planReparto('100', 'iguales');
    for (let i = 0; i < plan.movimientos.length; i += 1) {
      exchange.responder({ cuerpo: sobreOk({ transferId: `bg-${i}` }) });
    }

    const r = await sesion.ejecutarReparto(plan.id, PASO);

    expect(r.ok).toBe(true);
    expect(r.enviados).toBe(3);
    expect(r.fallidos).toBe(0);

    const enviados = traspasosEnviados();
    expect(enviados).toHaveLength(3);
    const suma = enviados.reduce((s, e) => s.plus(e['amount'] ?? '0'), new Decimal(0));
    expect(suma.toString()).toBe('100');
  });
});

describe('reparto igualando saldos', () => {
  it('deja fuera a la que ya esta por encima, y lo dice en los descartes', async () => {
    /* [10, 20, 30] + 30 → nivel 30: reciben 20 y 10; la tercera, nada. */
    const plan = await planReparto('30', 'igualar');

    expect(plan.movimientos.map((m) => m.importe)).toEqual(['20', '10']);
    expect(plan.descartes).toHaveLength(1);
    expect(plan.descartes[0]?.motivo).toBe('ya-por-encima');
    expect(plan.total).toBe('30');
  });
});

describe('recogida', () => {
  it('recoge el maximo transferible de cada una hacia la madre', async () => {
    const conPosicion: Fila[] = [
      { uid: '111', disponible: '10' },
      { uid: '222', disponible: '100', transferible: '40' }
    ];
    const plan = await planRecogida(conPosicion);

    expect(plan.tipo).toBe('recogida');
    expect(plan.movimientos.map((m) => m.importe)).toEqual(['10', '40']);
    for (const m of plan.movimientos) expect(m.uidDestino).toBe(UID_MADRE);
  });
});

describe('un fallo no detiene el lote', () => {
  /*
   * La regla de las seis operaciones: «falla esa cuenta, el lote continua».
   * Abortar a la mitad dejaria un reparto hecho a medias sin que nadie hubiera
   * decidido cual era la mitad buena.
   */
  it('sigue con los demas y cuenta aciertos y fallos', async () => {
    const plan = await planReparto('90', 'iguales');

    exchange.responder({ cuerpo: sobreOk({ transferId: 'bg-1' }) });
    exchange.responder({ estado: 400, cuerpo: { code: '43012', msg: 'Insufficient balance' } });
    exchange.responder({ cuerpo: sobreOk({ transferId: 'bg-3' }) });

    const r = await sesion.ejecutarReparto(plan.id, PASO);

    expect(r.ok).toBe(false);
    expect(r.enviados).toBe(2);
    expect(r.fallidos).toBe(1);
    expect(r.resultados.map((x) => x.ok)).toEqual([true, false, true]);
    expect(r.resultados[1]?.mensaje).toBeTruthy();

    /* Los tres se intentaron: el fallo del segundo no corto el tercero. */
    expect(traspasosEnviados()).toHaveLength(3);
  });

  /* Sin rollback: deshacer lo que ya entro seria mover dinero por iniciativa propia. */
  it('no deshace los traspasos que ya entraron', async () => {
    const plan = await planReparto('90', 'iguales');
    exchange.responder({ cuerpo: sobreOk({ transferId: 'bg-1' }) });
    exchange.responder({ estado: 400, cuerpo: { code: '43012', msg: 'Insufficient balance' } });
    exchange.responder({ estado: 400, cuerpo: { code: '43012', msg: 'Insufficient balance' } });

    await sesion.ejecutarReparto(plan.id, PASO);

    /* Tres envios y ni uno de vuelta. */
    expect(traspasosEnviados()).toHaveLength(3);
    const historial = await sesion.historialTraspasos();
    expect(historial.filter((m) => m.resultado === 'exito')).toHaveLength(1);
    expect(historial.filter((m) => m.resultado === 'fallo')).toHaveLength(2);
  });
});

describe('rastro en disco', () => {
  it('cada traspaso deja su intento antes de salir, y su desenlace despues', async () => {
    const plan = await planReparto('90', 'iguales');
    exchange.responder({ cuerpo: sobreOk({ transferId: 'bg-1' }) });
    exchange.responder({ estado: 400, cuerpo: { code: '43012', msg: 'Insufficient balance' } });
    exchange.responder({ cuerpo: sobreOk({ transferId: 'bg-3' }) });

    await sesion.ejecutarReparto(plan.id, PASO);

    const registro = await lineas();
    /* Tres intentos y tres desenlaces, intercalados. */
    expect(registro.filter((l) => l['tipo'] === 'intento')).toHaveLength(3);
    expect(registro.filter((l) => l['tipo'] === 'resuelta')).toHaveLength(3);
    expect(registro[0]).toMatchObject({ tipo: 'intento' });
    expect(registro[1]).toMatchObject({ tipo: 'resuelta' });

    /* Y cada uno con identificador propio: no se pisan entre ellos. */
    const oids = registro.filter((l) => l['tipo'] === 'intento').map((l) => l['clientOid']);
    expect(new Set(oids).size).toBe(3);
  });
});

describe('frenos', () => {
  it('sin contrasena de paso no sale nada, y no se anota ningun intento', async () => {
    const plan = await planReparto('90', 'iguales');

    const r = await sesion.ejecutarReparto(plan.id, 'la-que-no-es');

    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('paso-incorrecto');
    expect(traspasosEnviados()).toHaveLength(0);
    expect(await sesion.historialTraspasos()).toEqual([]);
  });

  it('un plan se envia una sola vez', async () => {
    const plan = await planReparto('90', 'iguales');
    for (let i = 0; i < 3; i += 1)
      exchange.responder({ cuerpo: sobreOk({ transferId: `bg-${i}` }) });
    await sesion.ejecutarReparto(plan.id, PASO);

    const enviadosTrasElPrimero = traspasosEnviados().length;
    await expect(sesion.ejecutarReparto(plan.id, PASO)).rejects.toThrow(/vigente/i);
    expect(traspasosEnviados()).toHaveLength(enviadosTrasElPrimero);
  });

  it('no planifica ni ejecuta con el panel bloqueado', async () => {
    const plan = await planReparto('90', 'iguales');
    sesion.cerrar();

    await expect(
      sesion.planificarReparto({ destinos: ['111'], total: '10', modo: 'iguales' })
    ).rejects.toThrow('bloqueado');
    await expect(sesion.ejecutarReparto(plan.id, PASO)).rejects.toThrow('bloqueado');
  });
});
