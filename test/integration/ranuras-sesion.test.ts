/**
 * Editar las ocho casillas de activo, desde la sesion del panel.
 *
 * --------------------------------------------------------------------------
 * Que se prueba aqui y por que importa
 * --------------------------------------------------------------------------
 * Lo que el cliente pidio el 28/08/2026: cambiar que activo hay en cada casilla
 * -quitar BTC de la 1 y poner DOGE- **sin poder anadir una novena**. Eso son dos
 * promesas, y las dos se rompen en sitios distintos:
 *
 *   1. Lo que se elige tiene que existir y quedar guardado. Un simbolo que
 *      Bitget no ofrece guardado sin comprobar se convierte en una casilla que
 *      falla al planificar, con la operacion ya empezada.
 *   2. El numero de casillas no lo decide el renderer. `fijarRanura` es la unica
 *      puerta, y no acepta un indice fuera de las ocho.
 *
 * Se prueba contra el exchange simulado porque la validacion es justamente
 * «preguntale al catalogo», y una prueba que se saltara esa consulta no probaria
 * lo unico que importa.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClienteBitget } from '@main/bitget/rest/client';
import { MERCADO_REAL } from '@main/bitget/mercado';
import { Sesion } from '@main/ipc/sesion';
import { RANURAS_ACTIVO } from '@shared/constants';
import { iniciarExchangeSimulado, sobreOk, type ExchangeSimulado } from '../mock-exchange/servidor';

/*
 * scrypt barato: estas pruebas crean un almacen por caso y lo que ejercitan es
 * la sesion, no la dureza del cifrado -que cubre test/unit/vault.test.ts-. Con
 * el coste real, varias suites en paralelo agotaban el limite de tiempo de
 * vitest de forma intermitente.
 */
const KDF_PRUEBAS = { N: 16, r: 1, p: 1 };

const contrato = (symbol: string, baseCoin: string): unknown => ({
  symbol,
  baseCoin,
  quoteCoin: 'USDT',
  minTradeNum: '0.0001',
  volumePlace: '4',
  pricePlace: '1',
  priceEndStep: '1',
  sizeMultiplier: '0.0001',
  minTradeUSDT: '5',
  minLever: '1',
  maxLever: '150',
  maxMarketOrderQty: '220',
  maxOrderQty: '1200',
  symbolStatus: 'normal'
});

/** Los ocho de fabrica, mas dos que el panel no trae puestos. */
const CONTRATOS = [
  ...MERCADO_REAL.simbolos.map((s) => contrato(s, s.replace('USDT', ''))),
  contrato('ADAUSDT', 'ADA'),
  contrato('LINKUSDT', 'LINK')
];

let carpeta: string;
let rutaActivos: string;
let exchange: ExchangeSimulado;
let cliente: ClienteBitget;
let sesion: Sesion;

/** Una sesion nueva sobre la misma carpeta: lo que ve el panel al reiniciarse. */
const otraSesion = (): Sesion =>
  new Sesion(
    {
      vault: join(carpeta, 'vault.enc'),
      cuentas: join(carpeta, 'cuentas.json'),
      activos: rutaActivos
    },
    cliente,
    { parametrosKdf: KDF_PRUEBAS, mercado: 'real' }
  );

const ids = (ranuras: readonly ({ id: string } | null)[]): (string | null)[] =>
  ranuras.map((a) => a?.id ?? null);

beforeEach(async () => {
  carpeta = await mkdtemp(join(tmpdir(), 'pcb-ranuras-sesion-'));
  rutaActivos = join(carpeta, 'activos.json');

  exchange = await iniciarExchangeSimulado();
  exchange.responderCon(() => ({ cuerpo: sobreOk(CONTRATOS) }));
  cliente = new ClienteBitget({ host: exchange.url });
  sesion = otraSesion();
});

afterEach(async () => {
  sesion.cerrar();
  await cliente.cerrar();
  await exchange.cerrar();
  await rm(carpeta, { recursive: true, force: true });
});

describe('las casillas de partida', () => {
  it('sin nada guardado son los ocho de fabrica', async () => {
    const ranuras = await sesion.ranuras();

    expect(ranuras).toHaveLength(RANURAS_ACTIVO);
    expect(ids(ranuras)).toEqual(['BTC', 'ETH', 'SOL', 'PEPE', 'PAXG', 'SUI', 'DOGE', 'XRP']);
  });

  /* Una casilla vacia no es un activo: no se puede seleccionar ni operar. */
  it('«activos» son las casillas llenas, sin los huecos', async () => {
    await sesion.fijarRanura(0, null);

    expect(ids(await sesion.ranuras())[0]).toBeNull();
    expect((await sesion.activos()).map((a) => a.id)).not.toContain('BTC');
    expect(await sesion.activos()).toHaveLength(RANURAS_ACTIVO - 1);
  });
});

describe('cambiar el activo de una casilla', () => {
  /* El ejemplo del cliente, tal cual: se quita BTC de la 1 y se pone DOGE. */
  it('sustituye el activo y deja las demas casillas donde estaban', async () => {
    const ranuras = await sesion.fijarRanura(0, 'ADAUSDT');

    expect(ids(ranuras)).toEqual(['ADA', 'ETH', 'SOL', 'PEPE', 'PAXG', 'SUI', 'DOGE', 'XRP']);
  });

  it('vaciar una casilla la deja vacia, no la borra', async () => {
    const ranuras = await sesion.fijarRanura(2, null);

    expect(ranuras).toHaveLength(RANURAS_ACTIVO);
    expect(ids(ranuras)[2]).toBeNull();
    /* Las de atras no se corren: el operador las edita por su numero. */
    expect(ids(ranuras)[3]).toBe('PEPE');
  });

  it('lo elegido sigue puesto al reiniciar el panel', async () => {
    await sesion.fijarRanura(0, 'LINKUSDT');
    await sesion.fijarRanura(7, null);

    expect(ids(await otraSesion().ranuras())).toEqual([
      'LINK',
      'ETH',
      'SOL',
      'PEPE',
      'PAXG',
      'SUI',
      'DOGE',
      null
    ]);
  });
});

describe('lo que no se puede hacer', () => {
  /*
   * Guardar un simbolo sin comprobarlo lo convierte en una casilla que falla al
   * planificar, y eso lo descubre el operador con la operacion empezada.
   */
  it('un simbolo que Bitget no ofrece se rechaza y no cambia nada', async () => {
    await expect(sesion.fijarRanura(0, 'LUNAUSDT')).rejects.toThrow(/no ofrece LUNAUSDT/);

    expect(ids(await sesion.ranuras())[0]).toBe('BTC');
  });

  /*
   * El mismo activo en dos casillas serian dos botones llamados igual: la
   * pantalla los identifica por su nombre corto, y el precio de uno se pintaria
   * en los dos. Se dice en que casilla esta ya.
   */
  it('el mismo activo no puede ocupar dos casillas', async () => {
    await expect(sesion.fijarRanura(3, 'BTCUSDT')).rejects.toThrow(/ya está en la casilla 1/);

    expect(ids(await sesion.ranuras())[3]).toBe('PEPE');
  });

  /* Poner el que ya esta en esa misma casilla no es un duplicado. */
  it('repetir el activo que ya estaba en esa casilla no molesta', async () => {
    const ranuras = await sesion.fijarRanura(0, 'BTCUSDT');

    expect(ids(ranuras)[0]).toBe('BTC');
  });

  /* Ocho casillas, ni una mas: la novena no existe y no se crea al escribirla. */
  it('no hay novena casilla', async () => {
    await expect(sesion.fijarRanura(RANURAS_ACTIVO, 'ADAUSDT')).rejects.toThrow(/no existe/);

    expect(await sesion.ranuras()).toHaveLength(RANURAS_ACTIVO);
  });
});

describe('el catalogo del buscador', () => {
  /*
   * El buscador si ve el mercado entero -es de donde se elige- y el selector
   * sigue viendo ocho. La separacion es lo que mantiene el panel operable: se
   * busca en un acto aparte y se opera entre ocho de un vistazo.
   */
  it('trae todo el mercado, incluido lo que no ocupa ninguna casilla', async () => {
    const catalogo = await sesion.catalogo();

    expect(catalogo.some((a) => a.id === 'ADA')).toBe(true);
    expect(catalogo.length).toBeGreaterThan((await sesion.activos()).length);
  });
});
