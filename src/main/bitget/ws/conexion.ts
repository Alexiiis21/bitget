/**
 * Un socket privado de Bitget: conectar, autenticar, suscribir y latir.
 *
 * Implementa el ciclo de vida que dibuja docs/02-arquitectura.html:
 *
 *   conectando -> autenticando -> suscribiendo -> viva
 *                      |                |           |
 *                   invalida         caida        caida
 *
 * Esta clase gobierna **una** conexion y no sabe nada de presupuestos ni de
 * reintentos: cuando se cae, lo dice y se calla. Quien decide si se vuelve a
 * intentar, cuando y con que cupo es `PoolSockets`. La separacion es la misma
 * que entre `RegistroConexiones` y `SupervisorReconexion`, y por el mismo
 * motivo: asi esto se prueba entero contra un servidor local, sin presupuestos
 * de por medio.
 *
 * --------------------------------------------------------------------------
 * Estado de verificacion del protocolo
 * --------------------------------------------------------------------------
 * La firma del `login` esta tomada de la documentacion de Bitget y es la misma
 * construccion que la de REST, con dos diferencias que son justo donde se
 * falla: el **timestamp va en segundos**, no en milisegundos, y la cadena
 * firmada es siempre `timestamp + 'GET' + '/user/verify'`, sin cuerpo y sin
 * consulta.
 *
 * Lo que **no** esta verificado contra el servidor real es el nombre exacto del
 * parametro comodin de cada suscripcion -`coin` en `positions`, `instId` en
 * `orders-algo`-. Vive en `ARGUMENTOS_CANAL`, en un solo sitio y señalado, para
 * que corregirlo sea una linea. `test/red/ws-privado.test.ts` lo comprueba
 * contra api.bitget.com con `npm run test:red`: si Bitget responde `event:
 * error` a una suscripcion, la prueba falla nombrando el canal.
 *
 * Se declara todo lo demas de forma defensiva, como los esquemas REST: un campo
 * que Bitget renombre hace fallar la validacion con su nombre, en vez de
 * producir en silencio una posicion sin precio de liquidacion.
 */
import { WebSocket } from 'ws';
import { z } from 'zod';
import { WS_PING_MS, WS_PONG_TIMEOUT_MS } from '@shared/constants';
import type { Mercado } from '../mercado';
import { firmar, type Credencial } from '../rest/signer';

export const URL_WS_PRIVADO = 'wss://ws.bitget.com/v2/ws/private';

/**
 * Cuanto se espera a que el servidor conteste al `login`.
 *
 * El mismo margen que al `pong`: si en diez segundos no ha contestado, o el
 * socket esta roto o el servidor no esta atendiendo, y las dos cosas se
 * arreglan igual -tirar la conexion y dejar que el pool decida-.
 */
const ESPERA_LOGIN_MS = 10_000;

/** Los dos canales que necesita el monitor. docs/01 seccion 8. */
export const CANAL_POSICIONES = 'positions';
export const CANAL_PLANES = 'orders-algo';

/**
 * El argumento comodin de cada canal. **Sin verificar contra el servidor real.**
 *
 * Bitget pide un tercer campo ademas de `instType` y `channel` para decir «todos
 * los simbolos», y no usa el mismo nombre en los dos canales: la documentacion
 * dice `coin` para `positions` e `instId` para `orders-algo`. Es exactamente la
 * clase de detalle que ya mordio una vez en este proyecto -ver `posSide` contra
 * `holdSide` en `tpsl.ts`-, asi que esta aqui aislado y no repartido por el
 * codigo.
 */
const ARGUMENTOS_CANAL: Record<string, Record<string, string>> = {
  [CANAL_POSICIONES]: { coin: 'default' },
  [CANAL_PLANES]: { instId: 'default' }
};

/* ---------- lo que llega por el socket ---------- */

/**
 * Respuesta a `login` o a `subscribe`.
 *
 * `code` viaja unas veces como cadena y otras como numero segun el evento, asi
 * que se admite lo uno y lo otro y se compara ya normalizado: exigir cadena
 * haria fallar la validacion de un login correcto.
 */
const esquemaEvento = z.object({
  event: z.string(),
  code: z.union([z.string(), z.number()]).nullish(),
  msg: z.string().nullish(),
  arg: z
    .object({
      instType: z.string().nullish(),
      channel: z.string().nullish(),
      instId: z.string().nullish(),
      coin: z.string().nullish()
    })
    .nullish()
});

/**
 * Un empujon de datos.
 *
 * `action` es lo que decide como se aplica -`snapshot` sustituye el conjunto,
 * `update` hace upsert-, y por eso es el unico campo que no se admite ausente:
 * aplicar un `update` como si fuera una foto borraria las demas posiciones de
 * la cuenta.
 */
const esquemaEmpujon = z.object({
  action: z.string(),
  arg: z.object({ channel: z.string().nullish() }).nullish(),
  data: z.array(z.unknown()).nullish(),
  ts: z.union([z.string(), z.number()]).nullish()
});

export type AccionEmpujon = 'snapshot' | 'update';

export type EstadoSocket =
  | 'cerrado'
  | 'conectando'
  | 'autenticando'
  | 'suscribiendo'
  | 'viva'
  | 'invalida';

/**
 * Por que se cayo una conexion.
 *
 * `credencial` es la unica que **no** se reintenta: reconectar con la misma
 * clave rechazada gastaria cupo de conexiones -300 cada 5 minutos por IP- para
 * recibir el mismo rechazo. Las demas son transitorias por definicion.
 */
export type MotivoCaida = 'credencial' | 'red' | 'sin-pong' | 'suscripcion' | 'cerrado-local';

export interface AvisosConexion {
  /** Un empujon de uno de los dos canales, ya clasificado. */
  alEmpujar(canal: string, accion: AccionEmpujon, datos: readonly unknown[]): void;
  /** La conexion quedo viva: autenticada y con los dos canales suscritos. */
  alQuedarViva?(): void;
  /** La conexion se fue. `codigo` y `mensaje` son los crudos de Bitget, si los hubo. */
  alCaer(motivo: MotivoCaida, detalle: { codigo: string | null; mensaje: string | null }): void;
}

export interface OpcionesConexion {
  url?: string;
  pingMs?: number;
  pongTimeoutMs?: number;
  esperaLoginMs?: number;
  ahora?: () => number;
  programar?: (fn: () => void, ms: number) => unknown;
  cancelar?: (id: unknown) => void;
  /** Se inyecta en las pruebas para no depender del modulo `ws` real. */
  crearSocket?: (url: string) => WebSocket;
}

/** `0`, `'0'` y `'00000'` son el mismo exito segun el evento. */
function esExito(codigo: string | number | null | undefined): boolean {
  if (codigo === null || codigo === undefined) return true;
  const texto = String(codigo);
  return texto === '0' || texto === '00000';
}

export class ConexionBitget {
  private readonly cuentaId: string;
  private readonly credencial: Credencial;
  private readonly mercado: Mercado;
  private readonly avisos: AvisosConexion;

  private readonly url: string;
  private readonly pingMs: number;
  private readonly pongTimeoutMs: number;
  private readonly esperaLoginMs: number;
  private readonly ahora: () => number;
  private readonly programar: (fn: () => void, ms: number) => unknown;
  private readonly cancelar: (id: unknown) => void;
  private readonly crearSocket: (url: string) => WebSocket;

  private socket: WebSocket | null = null;
  private estadoActual: EstadoSocket = 'cerrado';
  /** Canales confirmados por el servidor. La conexion no esta viva hasta tenerlos todos. */
  private readonly suscritos = new Set<string>();
  private temporizadorPing: unknown = null;
  private temporizadorPong: unknown = null;
  private temporizadorLogin: unknown = null;
  /** Impide que un `close` posterior a una caida ya avisada vuelva a avisar. */
  private caidaAvisada = false;

  constructor(
    cuentaId: string,
    credencial: Credencial,
    mercado: Mercado,
    avisos: AvisosConexion,
    opciones: OpcionesConexion = {}
  ) {
    this.cuentaId = cuentaId;
    this.credencial = credencial;
    this.mercado = mercado;
    this.avisos = avisos;
    this.url = opciones.url ?? URL_WS_PRIVADO;
    this.pingMs = opciones.pingMs ?? WS_PING_MS;
    this.pongTimeoutMs = opciones.pongTimeoutMs ?? WS_PONG_TIMEOUT_MS;
    this.esperaLoginMs = opciones.esperaLoginMs ?? ESPERA_LOGIN_MS;
    this.ahora = opciones.ahora ?? Date.now;
    this.programar = opciones.programar ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancelar = opciones.cancelar ?? ((id) => clearTimeout(id as NodeJS.Timeout));
    this.crearSocket = opciones.crearSocket ?? ((url) => new WebSocket(url));
  }

  get id(): string {
    return this.cuentaId;
  }

  get estado(): EstadoSocket {
    return this.estadoActual;
  }

  get estaViva(): boolean {
    return this.estadoActual === 'viva';
  }

  /** Abre el socket y arranca la secuencia. No espera a que termine. */
  conectar(): void {
    if (this.socket !== null) return;

    this.caidaAvisada = false;
    this.suscritos.clear();
    this.estadoActual = 'conectando';

    const socket = this.crearSocket(this.url);
    this.socket = socket;

    socket.on('open', () => this.autenticar());
    socket.on('message', (datos: unknown) => this.recibir(String(datos)));
    socket.on('error', (e: Error) => this.caer('red', { codigo: null, mensaje: e.message }));
    /*
     * `close` llega tambien detras de cada caida que ya se ha avisado -tirar el
     * socket lo provoca-, por eso `caer` es idempotente: sin eso, una perdida de
     * pong produciria dos avisos y el pool programaria dos reconexiones.
     */
    socket.on('close', () => this.caer('red', { codigo: null, mensaje: 'El socket se cerro.' }));
  }

  /**
   * Cierra por decision propia.
   *
   * Avisa con `cerrado-local` para que el pool sepa que no hay nada que
   * reintentar: la conexion no se perdio, se retiro -la cuenta se quedo sin
   * posiciones y libera el cupo, o el panel se esta bloqueando-.
   */
  cerrar(): void {
    if (this.socket === null) {
      this.estadoActual = 'cerrado';
      return;
    }
    this.caer('cerrado-local', { codigo: null, mensaje: null });
  }

  /* ---------------- secuencia ---------------- */

  /**
   * Envia el `login`.
   *
   * El timestamp va en **segundos**, a diferencia del de REST. Es el error
   * clasico de esta llamada: con milisegundos, Bitget responde que la firma no
   * es valida y el mensaje no dice nada del timestamp.
   */
  private autenticar(): void {
    this.estadoActual = 'autenticando';

    const timestamp = String(Math.floor(this.ahora() / 1_000));
    const sign = firmar(this.credencial.secretKey, `${timestamp}GET/user/verify`);

    this.enviar({
      op: 'login',
      args: [
        {
          apiKey: this.credencial.apiKey,
          passphrase: this.credencial.passphrase,
          timestamp,
          sign
        }
      ]
    });

    this.temporizadorLogin = this.programar(() => {
      this.temporizadorLogin = null;
      if (this.estadoActual !== 'autenticando') return;
      this.caer('red', { codigo: null, mensaje: 'Bitget no contesto al login.' });
    }, this.esperaLoginMs);
  }

  private suscribir(): void {
    this.estadoActual = 'suscribiendo';

    this.enviar({
      op: 'subscribe',
      args: [CANAL_POSICIONES, CANAL_PLANES].map((canal) => ({
        instType: this.mercado.productType,
        channel: canal,
        ...ARGUMENTOS_CANAL[canal]
      }))
    });
  }

  /* ---------------- mensajes ---------------- */

  private recibir(texto: string): void {
    /*
     * El latido de Bitget son mensajes de aplicacion, no `ping`/`pong` del
     * protocolo: llega el texto `pong` a secas, que no es JSON.
     */
    if (texto === 'pong') {
      this.cancelarPong();
      return;
    }

    let crudo: unknown;
    try {
      crudo = JSON.parse(texto);
    } catch {
      /* Un mensaje que no es JSON ni `pong` no es nuestro. Se ignora. */
      return;
    }

    const evento = esquemaEvento.safeParse(crudo);
    if (evento.success) {
      this.procesarEvento(evento.data);
      return;
    }

    const empujon = esquemaEmpujon.safeParse(crudo);
    if (!empujon.success) return;

    const canal = empujon.data.arg?.channel ?? '';
    const accion: AccionEmpujon = empujon.data.action === 'snapshot' ? 'snapshot' : 'update';
    this.avisos.alEmpujar(canal, accion, empujon.data.data ?? []);
  }

  private procesarEvento(evento: z.infer<typeof esquemaEvento>): void {
    const codigo = evento.code === null || evento.code === undefined ? null : String(evento.code);
    const mensaje = evento.msg ?? null;

    if (evento.event === 'login') {
      this.cancelarLogin();
      if (!esExito(evento.code)) {
        /*
         * Una credencial rechazada no se reintenta.
         *
         * Reconectar con la misma clave gastaria cupo del presupuesto de
         * conexiones -300 cada 5 minutos por IP- para recibir el mismo rechazo.
         * La cuenta se queda en REST, que sigue enseñando sus posiciones, y
         * vuelve cuando alguien corrija la clave y la verificacion la reviva.
         */
        this.estadoActual = 'invalida';
        this.caer('credencial', { codigo, mensaje });
        return;
      }
      this.suscribir();
      return;
    }

    if (evento.event === 'subscribe') {
      const canal = evento.arg?.channel ?? '';
      this.suscritos.add(canal);
      if (this.suscritos.has(CANAL_POSICIONES) && this.suscritos.has(CANAL_PLANES)) {
        this.estadoActual = 'viva';
        this.arrancarPing();
        this.avisos.alQuedarViva?.();
      }
      return;
    }

    if (evento.event === 'error') {
      /*
       * Un error durante la autenticacion es de la credencial; despues, de la
       * suscripcion. La distincion decide si se reintenta, asi que se hace por
       * el estado en que llega y no por el codigo: los codigos de esta API
       * todavia no estan verificados contra el servidor real, y equivocarse
       * hacia «reintentable» cuesta cupo de conexiones cada pocos segundos.
       */
      const enLogin = this.estadoActual === 'autenticando';
      if (enLogin) this.estadoActual = 'invalida';
      this.caer(enLogin ? 'credencial' : 'suscripcion', { codigo, mensaje });
    }
  }

  /* ---------------- latido ---------------- */

  /**
   * Ping de aplicacion cada 20 s.
   *
   * El servidor corta a los 120 s sin recibir nada, asi que veinte da seis
   * oportunidades antes de perder la conexion. Si el `pong` no llega en diez
   * segundos, el socket esta muerto aunque el sistema operativo aun no lo sepa:
   * se tira y se avisa, que es lo unico que devuelve la cuenta a REST sin
   * dejarla ciega mientras tanto. docs/01 seccion 8.
   */
  private arrancarPing(): void {
    this.cancelarPing();
    this.temporizadorPing = this.programar(() => {
      this.temporizadorPing = null;
      if (this.estadoActual !== 'viva') return;

      this.enviar('ping');
      this.temporizadorPong = this.programar(() => {
        this.temporizadorPong = null;
        this.caer('sin-pong', { codigo: null, mensaje: 'Bitget no contesto al ping.' });
      }, this.pongTimeoutMs);

      this.arrancarPing();
    }, this.pingMs);
  }

  private cancelarPing(): void {
    if (this.temporizadorPing !== null) {
      this.cancelar(this.temporizadorPing);
      this.temporizadorPing = null;
    }
  }

  private cancelarPong(): void {
    if (this.temporizadorPong !== null) {
      this.cancelar(this.temporizadorPong);
      this.temporizadorPong = null;
    }
  }

  private cancelarLogin(): void {
    if (this.temporizadorLogin !== null) {
      this.cancelar(this.temporizadorLogin);
      this.temporizadorLogin = null;
    }
  }

  /* ---------------- fin ---------------- */

  /**
   * Cierra y avisa, una sola vez.
   *
   * La idempotencia no es defensiva: tirar el socket dispara su propio `close`,
   * asi que toda caida produce al menos dos llamadas aqui. Sin la guarda, el
   * pool recibiria dos avisos por caida y programaria dos reconexiones para la
   * misma cuenta, que es como se agota el presupuesto de conexiones por IP.
   */
  private caer(motivo: MotivoCaida, detalle: { codigo: string | null; mensaje: string | null }): void {
    if (this.caidaAvisada) return;
    this.caidaAvisada = true;

    this.cancelarPing();
    this.cancelarPong();
    this.cancelarLogin();

    const socket = this.socket;
    this.socket = null;
    if (this.estadoActual !== 'invalida') this.estadoActual = 'cerrado';
    this.suscritos.clear();

    if (socket !== null) {
      /* Sin escuchas: su `close` ya no tiene a quien avisar. */
      socket.removeAllListeners();

      /*
       * Menos una, y no es opcional.
       *
       * `ws` emite `error` al abortar un socket, y un `error` sin escuchas en
       * un EventEmitter **lanza**: quitar todas las escuchas y cerrar convierte
       * cada cierre en una excepcion no capturable que tumba el proceso
       * principal. Un `try` alrededor de `close()` no la atrapa, porque el
       * evento llega despues, en otro turno del bucle.
       */
      socket.on('error', () => undefined);

      if (socket.readyState === WebSocket.CONNECTING) {
        /*
         * Un socket a medio abrir no se puede cerrar con el saludo cortes: hay
         * que abortarlo. `close()` sobre una conexion que aun no existe es
         * justamente lo que dispara ese `error`.
         */
        socket.terminate();
      } else {
        socket.close();
      }
    }

    this.avisos.alCaer(motivo, detalle);
  }

  private enviar(mensaje: unknown): void {
    if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(typeof mensaje === 'string' ? mensaje : JSON.stringify(mensaje));
  }
}
