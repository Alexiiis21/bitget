/**
 * Cuenta madre y pantalla de saldos, extremo a extremo en el proceso principal.
 *
 * Cubre lo que la Fase 2 promete y lo que puede salir mal de verdad:
 *
 *   1. El alta de una clave madre la verifica contra Bitget y la cifra.
 *   2. **Una clave valida que no es madre de nadie se acepta, pero avisa.** Es
 *      lo que ocurrio contra la API real el 03/09/2026: la clave del `.env`
 *      autenticaba, tenia permisos de sobra y devolvia cero subcuentas porque
 *      pertenecia a otra cuenta principal. Sin ese aviso, la pantalla sale
 *      vacia y nada explica por que.
 *   3. Los saldos cruzan lo que reporta Bitget con lo que el panel tiene dado
 *      de alta, sin que ninguna de las dos listas tape a la otra.
 *   4. Ningun secreto de la madre sale por el IPC ni queda en claro en disco.
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
  secretKey: 'secreto-de-la-madre-que-no-debe-salir',
  passphrase: 'frase-de-la-madre-que-no-debe-salir'
};

/** Respuesta de /api/v2/spot/account/info para la cuenta madre. */
const infoMadre = (userId = UID_MADRE): unknown =>
  sobreOk({ userId, authorities: ['coow', 'cpow', 'chow'], ips: '1.2.3.4', parentId: 0 });

/** Respuesta de /api/v2/mix/account/sub-account-assets. */
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

let carpeta: string;
let exchange: ExchangeSimulado;
let cliente: ClienteBitget;
let sesion: Sesion;
let rutaVault: string;

beforeEach(async () => {
  carpeta = await mkdtemp(join(tmpdir(), 'pcb-saldos-'));
  rutaVault = join(carpeta, 'vault.enc');

  exchange = await iniciarExchangeSimulado();
  cliente = new ClienteBitget({ host: exchange.url });
  sesion = new Sesion(
    {
      vault: rutaVault,
      cuentas: join(carpeta, 'cuentas.json'),
      activos: join(carpeta, 'activos.json')
    },
    cliente,
    { parametrosKdf: KDF_PRUEBAS }
  );
});

afterEach(async () => {
  sesion.cerrar();
  await cliente.cerrar();
  await exchange.cerrar();
  await rm(carpeta, { recursive: true, force: true });
});

/** Da de alta la madre con las dos respuestas que necesita su verificacion. */
const altaMadre = async (
  filas: { uid: string; disponible: string; transferible?: string }[] = [
    { uid: '5476143711', disponible: '100' }
  ]
): Promise<Awaited<ReturnType<Sesion['agregarMadre']>>> => {
  exchange.responder({ cuerpo: infoMadre() });
  exchange.responder({ cuerpo: saldos(filas) });
  return sesion.agregarMadre(ALTA_MADRE);
};

describe('alta de la cuenta madre', () => {
  it('la verifica, la guarda y devuelve cuantas subcuentas vio', async () => {
    await sesion.crear(MAESTRA);

    const r = await altaMadre([
      { uid: '5476143711', disponible: '100' },
      { uid: '5476143712', disponible: '200' }
    ]);

    expect(r.ok).toBe(true);
    expect(r.madre?.uidMadre).toBe(UID_MADRE);
    expect(r.madre?.subcuentasVistas).toBe(2);
    expect(r.advertencias).toEqual([]);
    expect(sesion.listarMadres()).toHaveLength(1);
  });

  /*
   * El caso del 03/09/2026. La clave es correcta y no hay nada que rechazar,
   * pero no sirve para lo que se la pide: hay que decirlo en el momento del
   * alta, no dejar que se descubra mirando una tabla vacia.
   */
  it('avisa cuando la clave no es madre de ninguna subcuenta', async () => {
    await sesion.crear(MAESTRA);

    const r = await altaMadre([]);

    expect(r.ok).toBe(true);
    expect(r.madre?.subcuentasVistas).toBe(0);
    expect(r.advertencias.map((a) => a.codigo)).toContain('sin-subcuentas');
    expect(r.advertencias[0]?.mensaje).toMatch(/cuenta principal/i);
  });

  it('no guarda nada si la clave no autentica', async () => {
    await sesion.crear(MAESTRA);
    exchange.responder({ estado: 400, cuerpo: { code: '40012', msg: 'apikey does not exist' } });

    const r = await sesion.agregarMadre(ALTA_MADRE);

    expect(r.ok).toBe(false);
    expect(r.madre).toBeNull();
    expect(sesion.listarMadres()).toEqual([]);
  });

  /* Autentica, pero no puede leer subcuentas: la lista blanca de IP, tipicamente. */
  it('no guarda nada si autentica pero no puede leer las subcuentas', async () => {
    await sesion.crear(MAESTRA);
    exchange.responder({ cuerpo: infoMadre() });
    exchange.responder({ estado: 400, cuerpo: { code: '40018', msg: 'Invalid IP' } });

    const r = await sesion.agregarMadre(ALTA_MADRE);

    expect(r.ok).toBe(false);
    expect(r.motivo).toMatch(/subcuentas/i);
    expect(sesion.listarMadres()).toEqual([]);
  });

  it('rota la clave sin duplicar la cuenta madre', async () => {
    await sesion.crear(MAESTRA);
    await altaMadre();
    await altaMadre();

    expect(sesion.listarMadres()).toHaveLength(1);
  });

  it('no deja dar de alta una madre con el panel bloqueado', async () => {
    await expect(sesion.agregarMadre(ALTA_MADRE)).rejects.toThrow('bloqueado');
  });
});

describe('secretos de la cuenta madre', () => {
  it('no salen por el IPC ni quedan en claro en disco', async () => {
    await sesion.crear(MAESTRA);
    const r = await altaMadre();

    const serializado = JSON.stringify({ alta: r, listado: sesion.listarMadres() });
    expect(serializado).not.toContain(ALTA_MADRE.secretKey);
    expect(serializado).not.toContain(ALTA_MADRE.passphrase);
    expect(serializado).not.toContain(ALTA_MADRE.apiKey);

    const enDisco = await readFile(rutaVault, 'utf8');
    expect(enDisco).not.toContain(ALTA_MADRE.secretKey);
    expect(enDisco).not.toContain(ALTA_MADRE.passphrase);
  });
});

describe('lectura de saldos', () => {
  it('devuelve una fila por subcuenta, con disponible y transferible', async () => {
    await sesion.crear(MAESTRA);
    await altaMadre();

    /* Una con posicion abierta: tiene 300 pero solo pueden salir 120. */
    exchange.responder({
      cuerpo: saldos([
        { uid: '5476143711', disponible: '100' },
        { uid: '5476143712', disponible: '300', transferible: '120' }
      ])
    });

    const hoja = await sesion.saldosSubcuentas();

    expect(hoja.uidMadre).toBe(UID_MADRE);
    expect(hoja.filas).toHaveLength(2);
    expect(hoja.filas[1]).toMatchObject({ disponible: '300', maxTransferible: '120' });
    expect(hoja.totalDisponible).toBe('400');
    expect(hoja.totalTransferible).toBe('220');
  });

  /*
   * Una subcuenta que Bitget reporta y el panel no conoce se enseña igual: un
   * traspaso se firma con la clave de la madre y no necesita la suya, asi que
   * esconderla seria esconder dinero que existe y se puede mover.
   */
  it('incluye las subcuentas que el panel no tiene dadas de alta', async () => {
    await sesion.crear(MAESTRA);
    await altaMadre();
    exchange.responder({ cuerpo: saldos([{ uid: '9999888877', disponible: '250' }]) });

    const hoja = await sesion.saldosSubcuentas();

    expect(hoja.filas).toHaveLength(1);
    expect(hoja.filas[0]).toMatchObject({ uid: '9999888877', cuentaId: null, soloEnBitget: true });
  });

  it('explica que falta la credencial en vez de fallar de forma opaca', async () => {
    await sesion.crear(MAESTRA);

    await expect(sesion.saldosSubcuentas()).rejects.toThrow(/cuenta principal/i);
  });

  it('no lee saldos con el panel bloqueado', async () => {
    await expect(sesion.saldosSubcuentas()).rejects.toThrow('bloqueado');
  });
});

describe('baja de la cuenta madre', () => {
  it('exige la contrasena de paso', async () => {
    await sesion.crear(MAESTRA);
    await sesion.fijarPaso(PASO);
    await altaMadre();

    expect(await sesion.eliminarMadre(UID_MADRE, 'la-que-no-es')).toBe('paso-incorrecto');
    expect(sesion.listarMadres()).toHaveLength(1);

    expect(await sesion.eliminarMadre(UID_MADRE, PASO)).toBe('borrada');
    expect(sesion.listarMadres()).toEqual([]);
  });
});
