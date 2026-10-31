/**
 * Telegram: el texto de los avisos y el cliente HTTP.
 *
 * El cliente se prueba contra un servidor local que imita la API de bots —sus
 * respuestas y sus errores—, sin salir a la red.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { escapar, LIMITE_TEXTO, mensajesTelegram, mensajePrueba } from '@main/alertas/mensajes';
import { ErrorTelegram, TelegramHttp } from '@main/alertas/telegram';
import type { EventoPendiente } from '@main/alertas/tipos';

const T = Date.parse('2026-10-15T15:30:00Z');
const opciones = { numeroPanel: 1, zona: 'America/Mexico_City', moneda: 'USDT', ahoraMs: T };

const pendiente = (parcial: Partial<EventoPendiente>): EventoPendiente => ({
  clave: `k${Math.random()}`,
  tipo: 'abrir',
  cuandoMs: T - 3_600_000,
  simbolo: 'BTCUSDT',
  lado: 'long',
  cantidad: '0.01',
  precio: '115000',
  importe: null,
  origen: 'app',
  clientOid: null,
  orderId: null,
  automatico: false,
  detalle: null,
  cuentaId: 'cta_1',
  identificador: 'PCB-1-A-1',
  etiqueta: 'Sub-01',
  grupo: 'A',
  ...parcial
});

describe('mensajesTelegram', () => {
  it('un mensaje por cuenta madre, con cada subcuenta bajo su identificador', () => {
    const m = mensajesTelegram(
      [
        pendiente({ clave: 'a1' }),
        pendiente({ clave: 'a3', identificador: 'PCB-1-A-3', etiqueta: 'Sub-03', tipo: 'cerrar' }),
        pendiente({
          clave: 'b2',
          grupo: 'B',
          identificador: 'PCB-1-B-2',
          etiqueta: 'Cliente Pérez'
        })
      ],
      opciones
    );

    expect(m).toHaveLength(2);
    expect(m[0]?.texto).toContain('Cuenta A');
    expect(m[0]?.texto).toContain('<b>PCB-1-A-1</b> · Sub-01');
    expect(m[0]?.texto).toContain('<b>PCB-1-A-3</b> · Sub-03');
    expect(m[0]?.texto).toContain('15/10, 08:30 · Abrió LONG BTCUSDT · 0.01 @ 115000 · App');
    expect(m[0]?.claves.sort()).toEqual(['a1', 'a3']);
    expect(m[1]?.texto).toContain('Cliente Pérez');
  });

  it('PCB-1-A-2 va antes que PCB-1-A-10', () => {
    const t =
      mensajesTelegram(
        [
          pendiente({ identificador: 'PCB-1-A-10', etiqueta: 'Sub-10' }),
          pendiente({ identificador: 'PCB-1-A-2', etiqueta: 'Sub-02' })
        ],
        opciones
      )[0]?.texto ?? '';
    expect(t.indexOf('PCB-1-A-2')).toBeLessThan(t.indexOf('PCB-1-A-10'));
  });

  it('el texto que viene de fuera se escapa: un nombre no puede inyectar HTML', () => {
    const t = mensajesTelegram([pendiente({ etiqueta: '<b>x</b> & y' })], opciones)[0]?.texto ?? '';
    expect(t).toContain('&lt;b&gt;x&lt;/b&gt; &amp; y');
    expect(escapar('<a&b>')).toBe('&lt;a&amp;b&gt;');
  });

  it('nada pasa del límite, y cada operación va en un solo mensaje', () => {
    const muchos = Array.from({ length: 300 }, (_, i) =>
      pendiente({ clave: `k${i}`, identificador: `PCB-1-A-${(i % 20) + 1}` })
    );
    const m = mensajesTelegram(muchos, opciones);

    expect(m.length).toBeGreaterThan(1);
    for (const x of m) expect(x.texto.length).toBeLessThanOrEqual(LIMITE_TEXTO);
    const claves = m.flatMap((x) => x.claves);
    expect(claves).toHaveLength(300);
    expect(new Set(claves).size).toBe(300);
    expect(m[1]?.texto).toContain('(continuación)');
  });

  it('describe cada tipo de operación', () => {
    const t =
      mensajesTelegram(
        [
          pendiente({ tipo: 'tp-sl-puesto', detalle: 'TP', precio: '120000', cantidad: null }),
          pendiente({ tipo: 'tp-sl-quitado', detalle: 'SL' }),
          pendiente({ tipo: 'margen-agregado', importe: '5', lado: null }),
          pendiente({
            tipo: 'traspaso-salida',
            importe: '100',
            simbolo: null,
            lado: null,
            origen: null
          })
        ],
        opciones
      )[0]?.texto ?? '';
    expect(t).toContain('Puso TP BTCUSDT LONG a 120000');
    expect(t).toContain('Quitó SL BTCUSDT LONG');
    expect(t).toContain('Agregó margen BTCUSDT · 5 USDT');
    expect(t).toContain('Envió un traspaso · 100 USDT');
  });

  it('la apertura con TP, el TP parcial con su cantidad y lo que crea Bitget', () => {
    const t =
      mensajesTelegram(
        [
          pendiente({ tipo: 'abrir', detalle: 'TP 120000', origen: 'web' }),
          pendiente({
            tipo: 'tp-sl-puesto',
            detalle: 'TP parcial',
            precio: '120000',
            cantidad: '0.005',
            origen: 'sys'
          })
        ],
        opciones
      )[0]?.texto ?? '';
    expect(t).toContain('Abrió LONG BTCUSDT · 0.01 @ 115000 · con TP 120000 · Web');
    expect(t).toContain('Puso TP parcial BTCUSDT LONG · 0.005 a 120000 · Bitget');
  });

  it('el mensaje de prueba nombra el panel', () => {
    expect(mensajePrueba(3)).toContain('PCB-3');
  });
});

/* ---------------- cliente HTTP ---------------- */

const TOKEN = '123456789:AAFabcdefghijklmnopqrstuvwxyz012345';
let servidor: Server;
let base: string;
const recibidos: { ruta: string; cuerpo: Record<string, unknown> }[] = [];
let respuesta: { estado: number; cuerpo: unknown } = {
  estado: 200,
  cuerpo: { ok: true, result: {} }
};

beforeAll(async () => {
  servidor = createServer((req, res) => {
    let datos = '';
    req.on('data', (c: Buffer) => (datos += c.toString()));
    req.on('end', () => {
      recibidos.push({
        ruta: req.url ?? '',
        cuerpo: datos === '' ? {} : (JSON.parse(datos) as Record<string, unknown>)
      });
      res.writeHead(respuesta.estado, { 'content-type': 'application/json' });
      res.end(JSON.stringify(respuesta.cuerpo));
    });
  });
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => servidor.close(() => r()));
});

const fallo = async (p: Promise<unknown>): Promise<ErrorTelegram> => {
  const e = await p.then(
    () => null,
    (x: unknown) => x
  );
  expect(e).toBeInstanceOf(ErrorTelegram);
  return e as ErrorTelegram;
};

describe('TelegramHttp', () => {
  const tg = (): TelegramHttp => new TelegramHttp(base);

  it('envía con HTML y sin vista previa, al chat indicado', async () => {
    respuesta = { estado: 200, cuerpo: { ok: true, result: { message_id: 1 } } };
    await tg().enviar(TOKEN, '-1001234', '<b>hola</b>');
    const ultimo = recibidos.at(-1);
    expect(ultimo?.ruta).toBe(`/bot${TOKEN}/sendMessage`);
    expect(ultimo?.cuerpo).toMatchObject({
      chat_id: '-1001234',
      text: '<b>hola</b>',
      parse_mode: 'HTML'
    });
  });

  it('un token sin formato de @BotFather se rechaza sin salir a la red', async () => {
    const antes = recibidos.length;
    expect((await fallo(tg().comprobarBot('123/../../x'))).motivo).toBe('token-invalido');
    expect(recibidos).toHaveLength(antes);
  });

  it('traduce los errores de Telegram', async () => {
    respuesta = {
      estado: 401,
      cuerpo: { ok: false, error_code: 401, description: 'Unauthorized' }
    };
    expect((await fallo(tg().comprobarBot(TOKEN))).motivo).toBe('token-invalido');

    respuesta = {
      estado: 403,
      cuerpo: {
        ok: false,
        error_code: 403,
        description: 'Forbidden: bot was kicked from the group chat'
      }
    };
    expect((await fallo(tg().enviar(TOKEN, '-1', 'x'))).motivo).toBe('sin-acceso');

    respuesta = {
      estado: 400,
      cuerpo: { ok: false, error_code: 400, description: 'Bad Request: chat not found' }
    };
    expect((await fallo(tg().enviar(TOKEN, '-1', 'x'))).motivo).toBe('chat-no-encontrado');

    respuesta = {
      estado: 429,
      cuerpo: {
        ok: false,
        error_code: 429,
        description: 'Too Many Requests',
        parameters: { retry_after: 7 }
      }
    };
    const limite = await fallo(tg().enviar(TOKEN, '-1', 'x'));
    expect(limite).toMatchObject({ motivo: 'limite', reintentarEnS: 7 });
  });

  it('sin conexión es «red», no un error crudo', async () => {
    const caido = new TelegramHttp('http://127.0.0.1:1');
    expect((await fallo(caido.enviar(TOKEN, '-1', 'x'))).motivo).toBe('red');
  });

  it('encuentra los chats que escribieron al bot, sin repetirlos', async () => {
    respuesta = {
      estado: 200,
      cuerpo: {
        ok: true,
        result: [
          {
            update_id: 1,
            my_chat_member: { chat: { id: -1009, title: 'Alertas PCB', type: 'supergroup' } }
          },
          {
            update_id: 2,
            message: {
              chat: { id: -1009, title: 'Alertas PCB', type: 'supergroup' },
              text: '/start'
            }
          },
          {
            update_id: 3,
            message: { chat: { id: 555, first_name: 'Daniel', last_name: 'M', type: 'private' } }
          }
        ]
      }
    };
    expect(await tg().chatsRecientes(TOKEN)).toEqual([
      { id: '-1009', titulo: 'Alertas PCB', tipo: 'supergroup' },
      { id: '555', titulo: 'Daniel M', tipo: 'private' }
    ]);
  });
});
