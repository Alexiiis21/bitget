/**
 * Exchange simulado.
 *
 * Un servidor HTTP local que responde como Bitget, incluidos los casos que la
 * cuenta demo no sabe producir a peticion: rechazar con HTTP 200, colgarse sin
 * responder, devolver 429, cambiar el formato de un campo.
 *
 * docs/01-stack-tecnologico.md seccion 11.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { prohibidoEnStaging } from '@shared/entorno';

export interface PeticionRecibida {
  metodo: string;
  url: string;
  cabeceras: Record<string, string | string[] | undefined>;
  cuerpo: string;
}

export interface Respuesta {
  /** Estado HTTP. Por defecto 200. */
  estado?: number;
  /** Objeto que se serializa a JSON, o texto crudo para simular una pasarela. */
  cuerpo?: unknown;
  /** Retraso antes de empezar a responder. Sirve para forzar timeouts. */
  retrasoMs?: number;
  cabeceras?: Record<string, string>;
}

export interface ExchangeSimulado {
  url: string;
  /** Encola la siguiente respuesta. Se consumen en orden. */
  responder(respuesta: Respuesta): void;
  /** Respuesta usada cuando la cola esta vacia. */
  responderSiempre(respuesta: Respuesta): void;
  peticiones: PeticionRecibida[];
  cerrar(): Promise<void>;
}

const SOBRE_OK = { code: '00000', msg: 'success', requestTime: 1_700_000_000_000, data: {} };

export async function iniciarExchangeSimulado(): Promise<ExchangeSimulado> {
  prohibidoEnStaging('El exchange simulado');

  const cola: Respuesta[] = [];
  const peticiones: PeticionRecibida[] = [];
  let porDefecto: Respuesta = { estado: 200, cuerpo: SOBRE_OK };

  const servidor: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const trozos: Buffer[] = [];
    req.on('data', (t: Buffer) => trozos.push(t));
    req.on('end', () => {
      peticiones.push({
        metodo: req.method ?? '',
        url: req.url ?? '',
        cabeceras: req.headers,
        cuerpo: Buffer.concat(trozos).toString('utf8')
      });

      const respuesta = cola.shift() ?? porDefecto;
      const emitir = (): void => {
        const cuerpo =
          typeof respuesta.cuerpo === 'string'
            ? respuesta.cuerpo
            : JSON.stringify(respuesta.cuerpo ?? SOBRE_OK);
        res.writeHead(respuesta.estado ?? 200, {
          'Content-Type': 'application/json',
          ...respuesta.cabeceras
        });
        res.end(cuerpo);
      };

      if (respuesta.retrasoMs !== undefined && respuesta.retrasoMs > 0) {
        setTimeout(emitir, respuesta.retrasoMs).unref();
      } else {
        emitir();
      }
    });
  });

  await new Promise<void>((listo) => servidor.listen(0, '127.0.0.1', listo));
  const puerto = (servidor.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${puerto}`,
    responder: (respuesta) => cola.push(respuesta),
    responderSiempre: (respuesta) => {
      porDefecto = respuesta;
    },
    peticiones,
    cerrar: () =>
      new Promise<void>((listo, fallo) => servidor.close((e) => (e ? fallo(e) : listo())))
  };
}

/** Sobre de exito con los datos indicados. */
export const sobreOk = (data: unknown): unknown => ({
  code: '00000',
  msg: 'success',
  requestTime: 1_700_000_000_000,
  data
});

/** Sobre de rechazo: HTTP 200, pero con codigo de error. El caso traicionero. */
export const sobreError = (code: string, msg: string): unknown => ({
  code,
  msg,
  requestTime: 1_700_000_000_000,
  data: null
});
