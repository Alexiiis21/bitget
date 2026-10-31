/**
 * Alertas de Telegram de punta a punta: `Sesion` real, cliente real, exchange
 * simulado y un Telegram de mentira que guarda lo que recibe.
 *
 * Lo que se demuestra es el recorrido que va a hacer el operador: configurar
 * el bot con la contraseña de paso, que la primera revisión no avise nada de
 * antes, que una orden hecha desde la app llegue al chat con su identificador
 * y que un cierre del propio panel —sin `clientOid`, como los de verdad— no.
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ClienteBitget } from '@main/bitget/rest/client';
import { detenerBitacora, iniciarBitacora } from '@main/diagnostico/bitacora';
import { Sesion } from '@main/ipc/sesion';
import { archivoLogDeHoy } from '@main/storage/paths';
import { ErrorTelegram, type ClienteTelegram } from '@main/alertas/telegram';
import { iniciarExchangeSimulado, sobreOk, type ExchangeSimulado } from '../mock-exchange/servidor';

const KDF_PRUEBAS = { N: 16, r: 1, p: 1 };
const MAESTRA = 'contrasena-de-prueba';
const PASO = 'bg1';
const UID = '5476143799';
const TOKEN = '123456789:AAFabcdefghijklmnopqrstuvwxyz012345';

const ALTA = {
  etiqueta: 'Sub-01',
  grupoNombre: 'A',
  apiKey: 'bg_7Kq82ab3cd4ef19c',
  secretKey: 'secreto-que-no-debe-salir',
  passphrase: 'frase-que-no-debe-salir'
};

let carpeta: string;
let exchange: ExchangeSimulado;
let cliente: ClienteBitget;
let sesion: Sesion;
/** Lo que el Telegram de mentira recibió. */
let enviados: { chatId: string; texto: string }[];
/** Las órdenes que «Bitget» tiene en el historial ahora mismo. */
let ordenes: Record<string, unknown>[];
/** Los TP/SL que «Bitget» tiene puestos ahora mismo (`orders-plan-pending`). */
let planesVivos: Record<string, unknown>[];
/** Fallos que el Telegram de mentira devuelve, uno por envío, antes de aceptar. */
const fallosTelegram: Error[] = [];

const telegram: ClienteTelegram = {
  comprobarBot: (token) =>
    token === TOKEN
      ? Promise.resolve({ usuario: 'pcb_alertas_bot', nombre: 'PCB Alertas' })
      : Promise.reject(new Error('token malo')),
  chatsRecientes: () =>
    Promise.resolve([{ id: '-1009', titulo: 'Alertas PCB', tipo: 'supergroup' }]),
  enviar: (_token, chatId, texto) => {
    const fallo = fallosTelegram.shift();
    if (fallo !== undefined) return Promise.reject(fallo);
    enviados.push({ chatId, texto });
    return Promise.resolve();
  }
};

const rutas = () => ({
  vault: join(carpeta, 'vault.enc'),
  cuentas: join(carpeta, 'cuentas.json'),
  activos: join(carpeta, 'activos.json'),
  historial: join(carpeta, 'historial'),
  acciones: join(carpeta, 'acciones', 'propias.jsonl'),
  alertas: join(carpeta, 'alertas', 'estado.json')
});

const nuevaSesion = () =>
  new Sesion(rutas(), cliente, {
    parametrosKdf: KDF_PRUEBAS,
    telegram,
    numeroPanel: () => 7,
    esperaVigiaMs: 60_000,
    dormir: () => Promise.resolve()
  });

beforeEach(async () => {
  carpeta = await mkdtemp(join(tmpdir(), 'pcb-alertas-int-'));
  exchange = await iniciarExchangeSimulado();
  cliente = new ClienteBitget({ host: exchange.url });
  sesion = nuevaSesion();
  enviados = [];
  ordenes = [];
  planesVivos = [];

  exchange.responderCon((p) => {
    if (p.url.startsWith('/api/v2/mix/order/orders-history')) {
      return { cuerpo: sobreOk({ entrustedList: ordenes, endId: null }) };
    }
    if (p.url.startsWith('/api/v2/mix/order/orders-plan-history')) {
      return { cuerpo: sobreOk({ entrustedList: [], endId: null }) };
    }
    if (p.url.startsWith('/api/v2/mix/order/orders-plan-pending')) {
      const tipo = new URL(p.url, 'http://x').searchParams.get('planType');
      return {
        cuerpo: sobreOk({ entrustedList: tipo === 'profit_loss' ? planesVivos : [], endId: null })
      };
    }
    if (p.url.startsWith('/api/v2/mix/account/bill')) {
      return { cuerpo: sobreOk({ bills: [], endId: null }) };
    }
    if (p.url.startsWith('/api/v2/mix/order/close-positions')) {
      return { cuerpo: sobreOk({ successList: [], failureList: [] }) };
    }
    return null;
  });
});

afterEach(async () => {
  sesion.cerrar();
  await cliente.cerrar();
  await exchange.cerrar();
  await rm(carpeta, { recursive: true, force: true });
});

async function altaCuenta(): Promise<string> {
  await sesion.crear(MAESTRA);
  await sesion.fijarPaso(PASO);
  exchange.responder({
    cuerpo: sobreOk({ userId: UID, authorities: ['coow', 'cpow'], parentId: 1513226215 })
  });
  exchange.responder({
    cuerpo: sobreOk({
      marginCoin: 'USDT',
      available: '500',
      accountEquity: '500',
      marginMode: 'isolated',
      posMode: 'hedge_mode',
      isolatedLongLever: 10,
      isolatedShortLever: 10,
      crossedMarginLeverage: 10
    })
  });
  const alta = await sesion.agregar(ALTA);
  return alta.cuenta?.id ?? '';
}

const orden = (id: string, extra: Record<string, unknown>): Record<string, unknown> => ({
  orderId: id,
  clientOid: `17${id}`,
  symbol: 'BTCUSDT',
  baseVolume: '0.01',
  priceAvg: '115000',
  status: 'filled',
  side: 'buy',
  posSide: 'long',
  tradeSide: 'open',
  orderSource: 'market',
  enterPointSource: 'app',
  /* Ahora: después de activar las alertas, como una operación real hecha luego. */
  cTime: String(Date.now()),
  ...extra
});

describe('configurar el bot', () => {
  it('pide la contraseña de paso', async () => {
    await altaCuenta();
    const r = await sesion.configurarAlertas(
      { token: TOKEN, chatId: '-1009', chatTitulo: 'Alertas PCB' },
      'mala'
    );
    expect(r).toMatchObject({ ok: false, motivo: 'paso-incorrecto' });
    expect(enviados).toHaveLength(0);
  });

  it('envía el mensaje de prueba, guarda el bot y sigue ahí al reabrir el panel', async () => {
    await altaCuenta();
    const r = await sesion.configurarAlertas(
      { token: TOKEN, chatId: '-1009', chatTitulo: 'Alertas PCB' },
      PASO
    );

    expect(r).toMatchObject({ ok: true, estado: { configurado: true, chatTitulo: 'Alertas PCB' } });
    expect(enviados[0]?.texto).toContain('PCB-7 conectado');

    sesion.cerrar();
    sesion = nuevaSesion();
    await sesion.abrir(MAESTRA);
    expect(await sesion.estadoAlertas()).toMatchObject({
      configurado: true,
      chatId: '-1009',
      numeroPanel: 7
    });
  });

  it('encuentra el chat sin herramientas de fuera', async () => {
    await altaCuenta();
    expect(await sesion.buscarChatsTelegram(TOKEN)).toMatchObject({
      ok: true,
      bot: { usuario: 'pcb_alertas_bot' },
      chats: [{ id: '-1009', titulo: 'Alertas PCB' }]
    });
  });
});

describe('revisiones', () => {
  async function configurado(): Promise<string> {
    const id = await altaCuenta();
    await sesion.configurarAlertas(
      { token: TOKEN, chatId: '-1009', chatTitulo: 'Alertas PCB' },
      PASO
    );
    /* La foto de partida, que configurar lanza sola. */
    const base = await sesion.revisarAlertas();
    expect(base.nuevas).toBe(1);
    enviados.length = 0;
    /* Lo que pase desde aquí es posterior a la foto de partida. */
    await new Promise((r) => setTimeout(r, 5));
    return id;
  }

  it('la primera revisión no avisa lo de antes', async () => {
    ordenes = [orden('viejo', { cTime: String(Date.now() - 3_600_000) })];
    await configurado();
    expect(enviados).toHaveLength(0);
  });

  it('una orden hecha desde la app llega al chat con el identificador de la subcuenta', async () => {
    await configurado();
    ordenes = [orden('1', {})];

    const r = await sesion.revisarAlertas();

    expect(r).toMatchObject({ detectadas: 1, enviadas: 1, envio: 'ok' });
    expect(enviados).toHaveLength(1);
    expect(enviados[0]?.chatId).toBe('-1009');
    expect(enviados[0]?.texto).toContain('<b>PCB-7-A-1</b> · Sub-01');
    expect(enviados[0]?.texto).toContain('Abrió LONG BTCUSDT · 0.01 @ 115000 · App');

    /* La siguiente revisión no la repite. */
    const r2 = await sesion.revisarAlertas();
    expect(r2.detectadas).toBe(0);
    expect(enviados).toHaveLength(1);
  });

  it('un TP puesto desde la app se avisa mientras sigue vivo, sin esperar a que termine', async () => {
    await configurado();
    planesVivos = [
      {
        orderId: 'tp1',
        clientOid: '991',
        symbol: 'BTCUSDT',
        planType: 'pos_profit',
        triggerPrice: '120000',
        posSide: 'long',
        planStatus: 'live',
        enterPointSource: 'app',
        cTime: String(Date.now())
      }
    ];

    const r = await sesion.revisarAlertas();

    expect(r).toMatchObject({ detectadas: 1, enviadas: 1 });
    expect(enviados[0]?.texto).toContain('Puso TP BTCUSDT LONG a 120000 · App');
  });

  it('el TP que Bitget crea con una apertura de la web va en la misma línea', async () => {
    await configurado();
    /* Lo capturado el 28/10/2026: el plan, origen sys, 104 ms después de la orden. */
    const ahora = Date.now();
    ordenes = [orden('w1', { enterPointSource: 'web', cTime: String(ahora) })];
    planesVivos = [
      {
        orderId: 'tp-w1',
        clientOid: '1499504789282258945',
        symbol: 'BTCUSDT',
        planType: 'profit_plan',
        triggerPrice: '115268.3',
        size: '0.01',
        posSide: 'long',
        planStatus: 'live',
        enterPointSource: 'sys',
        cTime: String(ahora + 104)
      }
    ];
    /* Que el plan no quede después del final de la revisión. */
    await new Promise((r) => setTimeout(r, 200));

    const r = await sesion.revisarAlertas();

    expect(r).toMatchObject({ detectadas: 1, enviadas: 1 });
    expect(enviados).toHaveLength(1);
    expect(enviados[0]?.texto).toContain(
      'Abrió LONG BTCUSDT · 0.01 @ 115000 · con TP 115268.3 · Web'
    );
    expect(enviados[0]?.texto).not.toContain('Puso');

    /* Terminado —se cerró la posición—, ya no está vivo: tampoco sale solo después. */
    planesVivos = [];
    const r2 = await sesion.revisarAlertas();
    expect(r2.detectadas).toBe(0);
    expect(enviados).toHaveLength(1);
  });

  it('un cierre del propio panel no se avisa, aunque llegue sin clientOid', async () => {
    await configurado();
    /* Lo que hace el panel al cerrar: close-positions, que no admite clientOid. */
    await cliente.peticionFirmada(
      { apiKey: ALTA.apiKey, secretKey: ALTA.secretKey, passphrase: ALTA.passphrase },
      {
        metodo: 'POST',
        ruta: '/api/v2/mix/order/close-positions',
        cuerpo: { symbol: 'BTCUSDT', productType: 'USDT-FUTURES', holdSide: 'long' },
        idempotente: false
      },
      z.unknown()
    );
    ordenes = [orden('2', { tradeSide: 'close', side: 'sell', enterPointSource: 'api' })];

    const r = await sesion.revisarAlertas();

    expect(r.detectadas).toBe(0);
    expect(enviados).toHaveLength(0);
  });

  it('desactivar deja de leer y de avisar, y borra las marcas', async () => {
    await configurado();
    const r = await sesion.desactivarAlertas(PASO);
    expect(r).toMatchObject({ ok: true, estado: { configurado: false } });

    ordenes = [orden('3', {})];
    expect((await sesion.revisarAlertas()).envio).toBe('sin-configurar');
    expect(enviados).toHaveLength(0);
    expect(await readdir(join(carpeta, 'alertas')).catch(() => [])).toEqual([]);
  });

  it('con el panel bloqueado no hay alertas', async () => {
    await configurado();
    sesion.cerrar();
    await expect(sesion.estadoAlertas()).rejects.toThrow('bloqueado');
    await expect(sesion.revisarAlertas()).rejects.toThrow('bloqueado');
  });
});

describe('revisión periódica con el panel abierto', () => {
  it('se repite sola y se detiene al bloquear', async () => {
    sesion.cerrar();
    sesion = new Sesion(rutas(), cliente, {
      parametrosKdf: KDF_PRUEBAS,
      telegram,
      numeroPanel: () => 7,
      esperaVigiaMs: 10,
      intervaloVigiaMs: 40,
      dormir: () => Promise.resolve()
    });
    await altaCuenta();
    const revisiones: number[] = [];
    sesion.alRevisarAlertas((r) => revisiones.push(r.revisadas));

    /* Espera a que pase algo, con un límite: cada revisión hace peticiones HTTP de verdad. */
    const hasta = async (cond: () => boolean): Promise<void> => {
      for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
      expect(cond()).toBe(true);
    };

    await sesion.configurarAlertas(
      { token: TOKEN, chatId: '-1009', chatTitulo: 'Alertas PCB' },
      PASO
    );
    /* La foto de partida y, desde ahí, una revisión cada 40 ms sin que nadie la pida. */
    await hasta(() => revisiones.length >= 3);

    /* Una operación de la app hecha con el panel abierto llega sin tocar nada. */
    ordenes = [orden('periodica', {})];
    await hasta(() => enviados.some((m) => m.texto.includes('Abrió LONG BTCUSDT')));

    sesion.cerrar();
    const alBloquear = revisiones.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(revisiones.length).toBe(alBloquear);
  });
});

/*
 * El rastro en la bitácora. Con el log de la v0.16.3 no se pudo saber por qué
 * no llegaban alertas: el vigía no anotaba nada. Aquí se comprueba que cada
 * paso deja su línea, que un fallo de Telegram dice su código y que el token
 * no aparece nunca.
 */
describe('rastro en la bitácora', () => {
  const logs = () => join(carpeta, 'logs');
  const leer = async (): Promise<{ texto: string; eventos: Record<string, unknown>[] }> => {
    /* La bitácora escribe sin esperar: se deja vaciar su cola. */
    await new Promise((r) => setTimeout(r, 50));
    const texto = await readFile(join(logs(), archivoLogDeHoy()), 'utf8');
    const eventos = texto
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l['tipo'] === 'evento');
    return { texto, eventos };
  };
  const de = (eventos: Record<string, unknown>[], nombre: string) =>
    eventos.filter((e) => e['evento'] === nombre);

  beforeEach(async () => {
    await iniciarBitacora(logs(), '9.9.9');
  });
  afterEach(() => {
    detenerBitacora();
    fallosTelegram.length = 0;
  });

  it('sin bot configurado lo dice, en vez de callar', async () => {
    await altaCuenta();
    sesion.cerrar();
    await sesion.abrir(MAESTRA);

    const { eventos } = await leer();
    expect(de(eventos, 'arranque')[0]).toMatchObject({ version: '9.9.9' });
    expect(de(eventos, 'vigia-iniciado').at(-1)).toMatchObject({
      origen: 'desbloqueo',
      activo: false,
      motivo: 'sin-bot-configurado'
    });
  });

  it('detectada, fallida con su código y enviada al reintentar; el token no sale', async () => {
    await altaCuenta();
    await sesion.configurarAlertas(
      { token: TOKEN, chatId: '-1009', chatTitulo: 'Alertas PCB' },
      PASO
    );
    await sesion.revisarAlertas();
    enviados.length = 0;
    await new Promise((r) => setTimeout(r, 5));

    /* El cliente cierra a mano en la app; Telegram no está a mano. */
    ordenes = [orden('m1', { tradeSide: 'close', side: 'sell' })];
    fallosTelegram.push(
      new ErrorTelegram('red', 'No hay conexión con Telegram.', null, 'ENOTFOUND')
    );
    const r1 = await sesion.revisarAlertas();
    expect(r1).toMatchObject({ detectadas: 1, enviadas: 0, envio: 'fallo', pendientes: 1 });

    /* La siguiente revisión lo envía: no se perdió. */
    const r2 = await sesion.revisarAlertas();
    expect(r2).toMatchObject({ detectadas: 0, enviadas: 1, envio: 'ok', pendientes: 0 });
    expect(enviados).toHaveLength(1);

    const { texto, eventos } = await leer();
    expect(de(eventos, 'vigia-iniciado').at(-1)).toMatchObject({
      origen: 'configuracion',
      activo: true,
      motivo: null
    });
    expect(de(eventos, 'alerta-detectada')).toEqual([
      expect.objectContaining({ cuenta: 'PCB-7-A-1', operacion: 'cerrar', simbolo: 'BTCUSDT' })
    ]);
    expect(de(eventos, 'alerta-fallida')).toEqual([
      expect.objectContaining({ motivo: 'red', codigo: 'ENOTFOUND', eventos: 1 })
    ]);
    expect(de(eventos, 'alerta-enviada')).toEqual([expect.objectContaining({ eventos: 1 })]);
    expect(de(eventos, 'vigia-revision').map((e) => e['envio'])).toEqual(
      expect.arrayContaining(['fallo', 'ok'])
    );
    expect(texto).not.toContain(TOKEN);
    expect(texto).not.toContain(TOKEN.split(':')[1]);
  });

  it('con Bitget caído la revisión no muere: lo anota y la siguiente recupera lo de entretanto', async () => {
    await altaCuenta();
    await sesion.configurarAlertas(
      { token: TOKEN, chatId: '-1009', chatTitulo: 'Alertas PCB' },
      PASO
    );
    await sesion.revisarAlertas();
    enviados.length = 0;
    await new Promise((r) => setTimeout(r, 5));

    ordenes = [orden('m2', {})];
    let caido = true;
    exchange.responderCon((p) => {
      if (caido && p.url.startsWith('/api/v2/mix/order/orders-history')) {
        return { estado: 503, cuerpo: 'Service Unavailable' };
      }
      if (p.url.startsWith('/api/v2/mix/order/orders-history')) {
        return { cuerpo: sobreOk({ entrustedList: ordenes, endId: null }) };
      }
      if (p.url.startsWith('/api/v2/mix/order/orders-plan-')) {
        return { cuerpo: sobreOk({ entrustedList: [], endId: null }) };
      }
      if (p.url.startsWith('/api/v2/mix/account/bill')) {
        return { cuerpo: sobreOk({ bills: [], endId: null }) };
      }
      return null;
    });

    const r1 = await sesion.revisarAlertas();
    expect(r1.errores).toHaveLength(1);
    expect(enviados).toHaveLength(0);

    caido = false;
    const r2 = await sesion.revisarAlertas();
    expect(r2).toMatchObject({ detectadas: 1, enviadas: 1, envio: 'ok' });

    const { eventos } = await leer();
    expect(de(eventos, 'vigia-error-cuenta')).toEqual([
      expect.objectContaining({ cuenta: 'PCB-7-A-1' })
    ]);
    expect(de(eventos, 'alerta-detectada')).toHaveLength(1);
  });
});
