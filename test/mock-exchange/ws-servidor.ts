/**
 * Servidor WebSocket simulado, con el protocolo privado de Bitget.
 *
 * Hace por el socket lo que `servidor.ts` hace por REST: producir a peticion
 * los casos que la cuenta demo no sabe provocar -un login rechazado, un `pong`
 * que no llega, un socket que se corta a mitad- y hacerlo sin salir a la red.
 *
 * Habla el protocolo de verdad sobre `ws`, no una simulacion de objetos: lo que
 * se prueba asi incluye el encuadre de los mensajes y el orden real de los
 * eventos, que es donde estan los fallos de esta capa.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { prohibidoEnStaging } from '@shared/entorno';

export interface OpcionesWsSimulado {
  /** Que contesta al `login`. Por defecto, exito. */
  login?: { ok: boolean; code?: string; msg?: string };
  /** `false` para aceptar la conexion y no contestar al `login` en absoluto. */
  responderLogin?: boolean;
  /** `false` para no contestar al `ping` y forzar la perdida de pong. */
  responderPong?: boolean;
  /** Canales que se rechazan en vez de confirmarse. */
  canalesQueFallan?: readonly string[];
}

export interface WsSimulado {
  url: string;
  /** Todo lo que ha llegado del cliente, en orden y sin parsear. */
  recibidos: string[];
  /** Los `op` recibidos, que es lo que suele comprobarse. */
  operaciones: () => string[];
  /** Empuja un mensaje a todos los clientes conectados. */
  empujar(mensaje: unknown): void;
  /** Corta la conexion sin avisar, como una caida de red. */
  cortar(): void;
  /** Cambia el comportamiento a mitad de una prueba. */
  configurar(opciones: OpcionesWsSimulado): void;
  /** Clientes conectados ahora mismo. */
  conectados: () => number;
  /** Cuantas veces se ha conectado alguien, contando reconexiones. */
  conexionesTotales: () => number;
  cerrar(): Promise<void>;
}

export async function iniciarWsSimulado(iniciales: OpcionesWsSimulado = {}): Promise<WsSimulado> {
  prohibidoEnStaging('El servidor WebSocket simulado');

  let opciones: OpcionesWsSimulado = { login: { ok: true }, responderPong: true, ...iniciales };
  const recibidos: string[] = [];
  const clientes = new Set<WebSocket>();
  let totales = 0;

  const http: Server = createServer();
  const wss = new WebSocketServer({ server: http });

  wss.on('connection', (socket: WebSocket) => {
    totales += 1;
    clientes.add(socket);
    socket.on('close', () => clientes.delete(socket));

    socket.on('message', (datos: unknown) => {
      const texto = String(datos);
      recibidos.push(texto);

      /* El latido de Bitget es texto plano, no JSON. */
      if (texto === 'ping') {
        if (opciones.responderPong !== false) socket.send('pong');
        return;
      }

      let mensaje: { op?: string; args?: unknown[] };
      try {
        mensaje = JSON.parse(texto) as { op?: string; args?: unknown[] };
      } catch {
        return;
      }

      if (mensaje.op === 'login') {
        if (opciones.responderLogin === false) return;
        const login = opciones.login ?? { ok: true };
        socket.send(
          JSON.stringify(
            login.ok
              ? { event: 'login', code: '0', msg: 'success' }
              : { event: 'login', code: login.code ?? '30012', msg: login.msg ?? 'invalid sign' }
          )
        );
        return;
      }

      if (mensaje.op === 'subscribe') {
        for (const arg of mensaje.args ?? []) {
          /*
           * El canal se llama `channel` en V2 y `topic` en V3. Se leen los dos
           * para que el mismo servidor sirva a las dos superficies: si aqui se
           * leyera solo `channel`, una suscripcion de UTA se confirmaria con el
           * nombre vacio y la conexion nunca llegaria a viva -que es justo el
           * fallo que estas pruebas tienen que poder distinguir de un acierto-.
           */
          const { channel, topic } = arg as { channel?: string; topic?: string };
          const canal = channel ?? topic ?? '';
          const falla = opciones.canalesQueFallan?.includes(canal) ?? false;
          socket.send(
            JSON.stringify(
              falla
                ? { event: 'error', code: '30001', msg: `channel ${canal} does not exist` }
                : { event: 'subscribe', code: '0', arg }
            )
          );
        }
      }
    });
  });

  await new Promise<void>((listo) => http.listen(0, '127.0.0.1', listo));
  const puerto = (http.address() as AddressInfo).port;

  return {
    url: `ws://127.0.0.1:${puerto}`,
    recibidos,
    operaciones: () =>
      recibidos.map((t) => {
        if (t === 'ping') return 'ping';
        try {
          return (JSON.parse(t) as { op?: string }).op ?? '?';
        } catch {
          return '?';
        }
      }),
    empujar: (mensaje) => {
      const texto = typeof mensaje === 'string' ? mensaje : JSON.stringify(mensaje);
      for (const c of clientes) c.send(texto);
    },
    cortar: () => {
      for (const c of clientes) c.terminate();
    },
    configurar: (nuevas) => {
      opciones = { ...opciones, ...nuevas };
    },
    conectados: () => clientes.size,
    conexionesTotales: () => totales,
    cerrar: () =>
      new Promise<void>((listo, fallo) => {
        for (const c of clientes) c.terminate();
        wss.close(() => http.close((e) => (e ? fallo(e) : listo())));
      })
  };
}

/** Un empujon del canal de posiciones, con la forma que manda Bitget. */
export const empujonPosiciones = (accion: 'snapshot' | 'update', data: unknown[]): unknown => ({
  action: accion,
  arg: { instType: 'SUSDT-FUTURES', channel: 'positions', coin: 'default' },
  data,
  ts: 1_700_000_000_000
});

/** Lo mismo para el canal de planes, que es de donde sale el Take Profit. */
export const empujonPlanes = (accion: 'snapshot' | 'update', data: unknown[]): unknown => ({
  action: accion,
  arg: { instType: 'SUSDT-FUTURES', channel: 'orders-algo', instId: 'default' },
  data,
  ts: 1_700_000_000_000
});

/**
 * Un empujon de un tema de UTA.
 *
 * Dos diferencias con los de V2, y las dos importan: el canal viaja en `topic`
 * y el `instType` es `UTA` para los tres temas, no el producto.
 */
export const empujonUta = (
  tema: 'position' | 'order' | 'account',
  accion: 'snapshot' | 'update',
  data: unknown[]
): unknown => ({
  action: accion,
  arg: { instType: 'UTA', topic: tema },
  data,
  ts: 1_700_000_000_000
});
