/**
 * Cliente REST de Bitget.
 *
 * Es el unico punto por el que sale trafico HTTP hacia el exchange. Todo lo
 * que esta encima -endpoints, servicios, cola de ejecucion- habla con esta
 * clase y nunca con undici.
 *
 * Lo que resuelve, en orden de importancia:
 *
 *  1. **Deteccion real de fallo.** Bitget responde HTTP 200 aunque la
 *     operacion haya sido rechazada; el veredicto esta en `code`. Aqui se
 *     comprueba siempre, y se traduce a `ErrorBitget` clasificado.
 *  2. **Correccion de reloj.** El exchange rechaza peticiones cuya marca de
 *     tiempo se desvie de la suya. El cliente mide el desfase contra
 *     `/api/v2/public/time` y firma con el reloj corregido.
 *  3. **Timeouts separados.** Conexion, cabeceras y cuerpo tienen limites
 *     propios: un socket colgado no puede bloquear una operacion sobre 100
 *     cuentas.
 *  4. **Validacion de forma.** Toda respuesta pasa por un esquema Zod. Si
 *     Bitget cambia un campo, se entera el panel, no el operador.
 *
 * Lo que deliberadamente NO hace: reintentar. La politica de reintento
 * depende de la clase de error y del lote, y vive en execution/retry.ts.
 * Este cliente informa, no decide. docs/01 secciones 8 y 9.
 */
import { Pool } from 'undici';
import type { z } from 'zod';
import { esStaging } from '@shared/entorno';
import { LimitadorPeticiones, type DiagnosticoLimitador } from '../../execution/rate-limiter';
import { enmascararApiKey, redactarTexto } from '../../security/redact';
import {
  errorDeEsquema,
  errorDeHttp,
  errorDeRespuesta,
  errorDeTransporte,
  ErrorBitget,
  CODIGO_EXITO
} from '../errors';
import { esquemaHoraServidor, esquemaSobre } from '../schemas/envelope';
import {
  cabecerasPublicas,
  cadenaConsulta,
  firmarPeticion,
  type Credencial,
  type MetodoHttp,
  type PeticionFirmable,
  type ValorConsulta
} from './signer';

export const HOST_BITGET = 'https://api.bitget.com';

/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║  DEPURACIÓN TEMPORAL · BORRAR ESTE BLOQUE Y SUS DOS LLAMADAS             ║
   ║                                                                          ║
   ║  Vuelca al terminal la respuesta cruda de Bitget. Existe para averiguar   ║
   ║  por qué una respuesta no encaja con su esquema; no debe quedarse en el   ║
   ║  código entregado.                                                       ║
   ║                                                                          ║
   ║  Siempre imprime cuando la validación falla. Con PCB_DEBUG_API=1          ║
   ║  imprime además cada respuesta firmada, para ver el recorrido entero.     ║
   ║                                                                          ║
   ║  El texto pasa por `redactarTexto`: si alguna clave registrada apareciera ║
   ║  en la respuesta, sale como [REDACTADO] en vez de al terminal.            ║
   ║                                                                          ║
   ║  Para borrarlo: elimina este bloque y busca `volcarRespuesta(` — son dos  ║
   ║  llamadas, ambas en `enviar()`.                                          ║
   ╚══════════════════════════════════════════════════════════════════════════╝ */
const DEPURAR_API = process.env['PCB_DEBUG_API'] === '1';

function volcarRespuesta(
  ruta: string,
  httpStatus: number,
  texto: string,
  motivo: string | null
): void {
  const cabecera = motivo === null ? 'RESPUESTA' : 'ESQUEMA RECHAZADO';
  console.error(`\n┌─ [DEBUG API] ${cabecera} · HTTP ${httpStatus}\n│  ruta: ${ruta}`);

  let cuerpo = redactarTexto(texto);
  try {
    cuerpo = JSON.stringify(JSON.parse(texto), null, 2);
    cuerpo = redactarTexto(cuerpo);
  } catch {
    /* Si no es JSON se enseña tal cual, que es justo lo que hay que ver. */
  }

  for (const linea of cuerpo.split('\n')) console.error(`│  ${linea}`);

  if (motivo !== null) {
    console.error('│');
    console.error('│  por qué no encaja:');
    for (const linea of motivo.split('\n')) console.error(`│    ${linea}`);
  }
  console.error('└─────────────────────────────────────────────\n');
}
/* ══════════════════════ FIN DEPURACIÓN TEMPORAL ══════════════════════ */

/** Bucket de los endpoints publicos: su limite es por IP, no por cuenta. */
const CLAVE_PUBLICA = 'publico';

/* ---------- tiempos ---------- */

/** Establecer la conexion TCP + TLS. */
const TIMEOUT_CONEXION_MS = 5_000;
/** Esperar a la primera linea de respuesta. Es el que corta un socket colgado. */
const TIMEOUT_CABECERAS_MS = 10_000;
/** Terminar de leer el cuerpo. */
const TIMEOUT_CUERPO_MS = 15_000;
/** Conexiones simultaneas del pool. docs/01 seccion 8. */
const CONEXIONES_POOL = 16;
/** Desfase de reloj a partir del cual conviene resincronizar. */
const DESFASE_TOLERADO_MS = 5_000;

export interface OpcionesCliente {
  /**
   * Host alternativo. Solo lo usan las pruebas, contra el exchange simulado.
   *
   * En staging se rechaza: ver el constructor.
   */
  host?: string;
  /** Reloj base. Se inyecta en las pruebas. */
  ahora?: () => number;
  /** Sobrescribe los tiempos por defecto. Las pruebas los bajan a milisegundos. */
  timeoutsMs?: { conexion?: number; cabeceras?: number; cuerpo?: number };
  /**
   * Limitador de peticiones. Si no se pasa, el cliente crea el suyo.
   *
   * Se comparte entre clientes cuando varios apuntan al mismo host: el techo
   * de Bitget es por IP, no por instancia de cliente.
   */
  limitador?: LimitadorPeticiones;
}

export interface PeticionRest {
  metodo: MetodoHttp;
  ruta: string;
  consulta?: Record<string, ValorConsulta>;
  cuerpo?: unknown;
  /**
   * `true` en consultas, `false` en toda orden de trading.
   *
   * Determina que ocurre si la conexion se corta con la peticion en vuelo:
   * una consulta se reintenta, una orden queda `indeterminada` y se resuelve
   * preguntando por su clientOid. No se infiere del metodo HTTP a proposito.
   */
  idempotente: boolean;
}

export interface RespuestaRest<T> {
  datos: T;
  /** Milisegundos de ida y vuelta. Alimenta el diagnostico por cuenta. */
  duracionMs: number;
  codigo: string;
}

export class ClienteBitget {
  private readonly pool: Pool;
  private readonly relojLocal: () => number;
  private readonly limitador: LimitadorPeticiones;
  /** Milisegundos a sumar al reloj local para obtener el del exchange. */
  private desfaseMs = 0;
  private sincronizado = false;

  constructor(opciones: OpcionesCliente = {}) {
    const host = opciones.host ?? HOST_BITGET;

    /*
     * En staging el host no se negocia. Es la puerta por la que entrarian datos
     * inventados con la apariencia de venir del exchange: un cliente apuntado a
     * un servidor local responderia saldos y posiciones con el formato exacto
     * de Bitget, y nada en la pantalla lo delataria. El entorno entero se apoya
     * en esta linea.
     */
    if (esStaging() && host !== HOST_BITGET) {
      throw new Error(
        `En staging el cliente solo habla con ${HOST_BITGET}; se pidio "${host}". ` +
          'El exchange simulado pertenece al entorno de desarrollo.'
      );
    }

    this.limitador = opciones.limitador ?? new LimitadorPeticiones();
    this.pool = new Pool(host, {
      connections: CONEXIONES_POOL,
      connectTimeout: opciones.timeoutsMs?.conexion ?? TIMEOUT_CONEXION_MS,
      headersTimeout: opciones.timeoutsMs?.cabeceras ?? TIMEOUT_CABECERAS_MS,
      bodyTimeout: opciones.timeoutsMs?.cuerpo ?? TIMEOUT_CUERPO_MS,
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000
    });
    this.relojLocal = opciones.ahora ?? Date.now;
  }

  /** Reloj corregido con el desfase medido contra Bitget. */
  ahora(): number {
    return this.relojLocal() + this.desfaseMs;
  }

  get desfaseActualMs(): number {
    return this.desfaseMs;
  }

  get relojSincronizado(): boolean {
    return this.sincronizado;
  }

  async cerrar(): Promise<void> {
    await this.pool.close();
  }

  /**
   * Mide el desfase contra el reloj del exchange.
   *
   * Se descuenta la mitad del viaje de ida y vuelta, que es la estimacion
   * habitual del instante en que el servidor respondio. No pretende ser
   * exacta: basta con quedar muy por debajo de la ventana que tolera Bitget.
   *
   * Se llama al arrancar y cada vez que una firma se rechaza por marca de
   * tiempo. No requiere credenciales: es un endpoint publico.
   */
  async sincronizarReloj(): Promise<number> {
    const t0 = this.relojLocal();
    const { datos } = await this.peticionPublica(
      { metodo: 'GET', ruta: '/api/v2/public/time', idempotente: true },
      esquemaHoraServidor
    );
    const t1 = this.relojLocal();

    const servidorMs = Number(datos.serverTime);
    if (!Number.isFinite(servidorMs)) {
      throw errorDeEsquema('/api/v2/public/time', `serverTime no numerico: ${datos.serverTime}`);
    }

    this.desfaseMs = Math.round(servidorMs + (t1 - t0) / 2 - t1);
    this.sincronizado = true;
    return this.desfaseMs;
  }

  /** `true` cuando el desfase medido supera el margen comodo. */
  get relojDesviado(): boolean {
    return Math.abs(this.desfaseMs) > DESFASE_TOLERADO_MS;
  }

  /**
   * Peticion a un endpoint publico. No toca credenciales.
   *
   * Comparte un bucket propio, `publico`: Bitget limita estos endpoints por IP
   * y no por cuenta, asi que no deben gastar el cupo de ninguna.
   */
  async peticionPublica<E extends z.ZodType>(
    peticion: PeticionRest,
    esquema: E
  ): Promise<RespuestaRest<z.infer<E>>> {
    return this.limitador.ejecutar(CLAVE_PUBLICA, () =>
      this.enviar(
        {
          metodo: peticion.metodo,
          rutaCompleta: `${peticion.ruta}${cadenaConsulta(peticion.consulta)}`,
          cuerpo: '',
          cabeceras: cabecerasPublicas()
        },
        peticion.idempotente,
        esquema
      )
    );
  }

  /**
   * Peticion autenticada, firmada con el reloj corregido.
   *
   * El bucket se identifica con la API Key porque el limite de Bitget es **por
   * UID** y cada key pertenece a exactamente un UID. No se pide un
   * identificador aparte a proposito: un parametro que hay que acordarse de
   * pasar es un parametro que algun dia no se pasa, y saltarse el limitador
   * cuesta cinco minutos de bloqueo del exchange en mitad de una operacion.
   *
   * La firma se calcula **dentro** del limitador, no antes: si se firmara al
   * encolar, una espera de varios segundos dejaria la marca de tiempo vieja y
   * Bitget rechazaria la peticion por reloj.
   */
  async peticionFirmada<E extends z.ZodType>(
    credencial: Credencial,
    peticion: PeticionRest,
    esquema: E
  ): Promise<RespuestaRest<z.infer<E>>> {
    return this.limitador.ejecutar(credencial.apiKey, () => {
      const firmable: PeticionFirmable = {
        metodo: peticion.metodo,
        ruta: peticion.ruta,
        ...(peticion.consulta === undefined ? {} : { consulta: peticion.consulta }),
        ...(peticion.cuerpo === undefined ? {} : { cuerpo: peticion.cuerpo })
      };

      const firmada = firmarPeticion(credencial, firmable, () => this.ahora());
      return this.enviar(firmada, peticion.idempotente, esquema);
    });
  }

  /**
   * Estado del presupuesto de peticiones, con las claves enmascaradas.
   *
   * Las API Key identifican los buckets, pero no deben salir enteras hacia el
   * log ni hacia la pantalla. RNF-001.
   */
  diagnosticoLimites(): DiagnosticoLimitador {
    const d = this.limitador.diagnostico();
    return {
      ...d,
      cuentasPenalizadas: d.cuentasPenalizadas.map((c) =>
        c === CLAVE_PUBLICA ? c : enmascararApiKey(c)
      )
    };
  }

  /* ---------- nucleo ---------- */

  private async enviar<E extends z.ZodType>(
    firmada: {
      metodo: MetodoHttp;
      rutaCompleta: string;
      cuerpo: string;
      cabeceras: Record<string, string>;
    },
    idempotente: boolean,
    esquema: E
  ): Promise<RespuestaRest<z.infer<E>>> {
    const inicio = this.relojLocal();

    let httpStatus: number;
    let texto: string;

    try {
      const respuesta = await this.pool.request({
        path: firmada.rutaCompleta,
        method: firmada.metodo,
        headers: firmada.cabeceras,
        ...(firmada.cuerpo === '' ? {} : { body: firmada.cuerpo })
      });
      httpStatus = respuesta.statusCode;
      texto = await respuesta.body.text();
    } catch (causa) {
      throw errorDeTransporte(causa, idempotente);
    }

    const duracionMs = this.relojLocal() - inicio;

    let crudo: unknown;
    try {
      crudo = JSON.parse(texto);
    } catch {
      /* Sin JSON no hay `code` que mirar: manda el estado HTTP. */
      throw errorDeHttp(httpStatus, texto.slice(0, 500), idempotente);
    }

    const sobre = esquemaSobre.safeParse(crudo);
    if (!sobre.success) {
      /* DEPURACIÓN TEMPORAL · BORRAR */
      volcarRespuesta(firmada.rutaCompleta, httpStatus, texto, sobre.error.message);
      throw errorDeEsquema(firmada.rutaCompleta, sobre.error.message);
    }

    /*
     * El veredicto real. Un 200 con code distinto de 00000 es un rechazo, y
     * tratarlo como exito seria dar por abierta una posicion que no existe.
     */
    if (sobre.data.code !== CODIGO_EXITO) {
      throw errorDeRespuesta(sobre.data.code, sobre.data.msg, httpStatus);
    }

    if (httpStatus < 200 || httpStatus >= 300) {
      throw errorDeHttp(httpStatus, texto.slice(0, 500), idempotente);
    }

    const datos = esquema.safeParse(sobre.data.data);
    if (!datos.success) {
      /* DEPURACIÓN TEMPORAL · BORRAR */
      volcarRespuesta(firmada.rutaCompleta, httpStatus, texto, datos.error.message);
      throw errorDeEsquema(firmada.rutaCompleta, datos.error.message);
    }

    /* DEPURACIÓN TEMPORAL · BORRAR */
    if (DEPURAR_API) volcarRespuesta(firmada.rutaCompleta, httpStatus, texto, null);

    return { datos: datos.data as z.infer<E>, duracionMs, codigo: sobre.data.code };
  }
}

export { ErrorBitget };
