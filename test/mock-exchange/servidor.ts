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
  /**
   * Responde en funcion de la peticion.
   *
   * Hace falta para los lotes: con trescientas ordenes en vuelo no se puede
   * encolar una respuesta por cada una, y lo que se quiere probar es
   * precisamente que **unas** fallen y otras no, segun a que cuenta van. Tiene
   * prioridad sobre la cola; devolver `null` cede el turno a esta.
   */
  responderCon(manejador: ((p: PeticionRecibida) => Respuesta | null) | null): void;
  /**
   * Convierte la cuenta simulada en UTA.
   *
   * Por defecto el exchange simulado es una cuenta **clasica**: rechaza todo
   * `/api/v3/*`, que es lo que hace Bitget con una key emitida sobre una cuenta
   * de las de siempre. Pasar los ajustes la convierte en UTA y
   * `/api/v3/account/settings` empieza a responderlos; `null` la devuelve a
   * clasica.
   *
   * Los demas `/api/v3/*` pasan entonces por la resolucion normal -manejador,
   * cola, por defecto-, de modo que una prueba de UTA sigue controlando lo que
   * responde cada endpoint.
   */
  simularUta(ajustes: Record<string, unknown> | null): void;
  /**
   * Fija que responde la superficie V3, pase lo que pase.
   *
   * Tiene prioridad sobre `simularUta` y sobre el rechazo por defecto, y es la
   * unica forma de simular en V3 lo que no es ni exito ni rechazo de negocio: un
   * 429, un 500, un cuerpo ilegible. `null` restaura el comportamiento normal.
   *
   * Existe aparte de `responderCon` a proposito: el manejador general **no** ve
   * las peticiones a V3, para que un manejador escrito para V2 no conteste sin
   * querer a la deteccion de modo y convierta la cuenta simulada en UTA.
   */
  responderV3(respuesta: Respuesta | null): void;
  peticiones: PeticionRecibida[];
  cerrar(): Promise<void>;
}

const SOBRE_OK = { code: '00000', msg: 'success', requestTime: 1_700_000_000_000, data: {} };

/**
 * Lo que responde V3 a una key de cuenta clasica.
 *
 * ==========================================================================
 * El codigo concreto esta pendiente de capturar
 * ==========================================================================
 * `40404` es un valor de relleno: el codigo real con que V3 rechaza una key
 * clasica **todavia no se ha observado** -es el hueco 4.1 de
 * `docs/00-uta-fase-1-equivalencias.md`, y lo resuelve
 * `node scripts/sondear-v3.mjs --env DEMO`-.
 *
 * Que sea de relleno no invalida estas pruebas, y conviene entender por que:
 * `detectarModo` trata **cualquier** fallo de negocio como cuenta clasica, sin
 * mirar el codigo. Es correcto por construccion, y por eso se puede probar
 * antes de conocer el valor. El unico sitio donde el codigo exacto importara es
 * el reintento cruzado, que es otro paquete.
 */
const RECHAZO_V3 = {
  code: '40404',
  msg: 'Request URL NOT FOUND',
  requestTime: 1_700_000_000_000,
  data: null
};

export async function iniciarExchangeSimulado(): Promise<ExchangeSimulado> {
  prohibidoEnStaging('El exchange simulado');

  const cola: Respuesta[] = [];
  const peticiones: PeticionRecibida[] = [];
  let porDefecto: Respuesta = { estado: 200, cuerpo: SOBRE_OK };
  let manejador: ((p: PeticionRecibida) => Respuesta | null) | null = null;
  /** `null` = cuenta clasica, que es el caso por defecto. */
  let ajustesUta: Record<string, unknown> | null = null;
  /** Respuesta impuesta a toda la superficie V3, por encima de lo demas. */
  let respuestaV3: Respuesta | null = null;

  /**
   * Que responder a una peticion.
   *
   * La superficie V3 se decide **antes** que el manejador y la cola, y ese orden
   * es load-bearing: la deteccion de modo pregunta por `/api/v3/account/settings`
   * al empezar cada verificacion, y si esa pregunta consumiera un elemento de la
   * cola FIFO desplazaria todas las respuestas encoladas de la prueba. Una
   * cuenta clasica -el caso por defecto- rechaza V3 sin gastar cola.
   */
  const resolver = (recibida: PeticionRecibida): Respuesta => {
    if (recibida.url.startsWith('/api/v3/')) {
      if (respuestaV3 !== null) return respuestaV3;
      if (ajustesUta === null) return { estado: 200, cuerpo: RECHAZO_V3 };

      if (recibida.url.startsWith('/api/v3/account/settings')) {
        return {
          estado: 200,
          cuerpo: {
            code: '00000',
            msg: 'success',
            requestTime: 1_700_000_000_000,
            data: ajustesUta
          }
        };
      }

      /*
       * Los demas endpoints de una cuenta UTA si pasan por el manejador.
       *
       * Solo con `simularUta` activo, que es la diferencia que importa: una
       * prueba que no ha pedido UTA no puede contestar V3 sin querer con un
       * manejador escrito para V2, y una que si lo ha pedido controla cada
       * endpoint como en V2.
       */
      return manejador?.(recibida) ?? cola.shift() ?? porDefecto;
    }

    return manejador?.(recibida) ?? cola.shift() ?? porDefecto;
  };

  const servidor: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const trozos: Buffer[] = [];
    req.on('data', (t: Buffer) => trozos.push(t));
    req.on('end', () => {
      const recibida: PeticionRecibida = {
        metodo: req.method ?? '',
        url: req.url ?? '',
        cabeceras: req.headers,
        cuerpo: Buffer.concat(trozos).toString('utf8')
      };
      peticiones.push(recibida);

      const respuesta = resolver(recibida);
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
    responderCon: (fn) => {
      manejador = fn;
    },
    simularUta: (ajustes) => {
      ajustesUta = ajustes;
    },
    responderV3: (respuesta) => {
      respuestaV3 = respuesta;
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
