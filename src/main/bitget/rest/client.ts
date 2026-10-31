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
 *     `/api/v2/public/time`, firma con el reloj corregido y **vuelve a medirlo
 *     solo** cuando Bitget rechaza una firma por marca caducada.
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
import {
  anotarPeticion,
  cargaParaLog,
  cuentaDe,
  superficieDeRuta
} from '../../diagnostico/bitacora';
import { LimitadorPeticiones, type DiagnosticoLimitador } from '../../execution/rate-limiter';
import { enmascararApiKey, redactarTexto } from '../../security/redact';
import {
  errorDeEsquema,
  errorDeHttp,
  errorDeRespuesta,
  errorDeTransporte,
  ErrorBitget,
  CODIGO_EXITO,
  CODIGO_MARCA_CADUCADA
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
/**
 * Separacion minima entre dos medidas del desfase.
 *
 * Un reloj desviado hace fallar **todas** las cuentas a la vez, asi que sin
 * esta guarda un solo desbarajuste de reloj dispararia cien peticiones a
 * `/api/v2/public/time` en el mismo segundo -y el cupo de ese endpoint es por
 * IP-. Si la medida es de hace menos de esto, el desfase ya esta al dia y el
 * rechazo viene de otra cosa: la latencia de la peticion, o un reloj que se
 * mueve mientras se la mide.
 */
const RESINCRONIZACION_MINIMA_MS = 30_000;

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

/**
 * Una escritura que el panel está a punto de enviar a Bitget.
 *
 * La recibe el observador de `observarEscrituras` justo antes de firmar. La
 * credencial no viaja entera: solo la API Key, que es la que identifica la
 * cuenta y no sirve para firmar nada sin el secreto.
 */
export interface EscrituraBitget {
  ts: number;
  apiKey: string;
  metodo: MetodoHttp;
  ruta: string;
  cuerpo: unknown;
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
  private observadorEscrituras: ((e: EscrituraBitget) => Promise<void>) | null = null;
  /** Milisegundos a sumar al reloj local para obtener el del exchange. */
  private desfaseMs = 0;
  private sincronizado = false;
  /**
   * Instante -en reloj local- del ultimo **intento** de medir el desfase.
   *
   * Cuenta el intento y no el exito a proposito: si la medida falla por red, lo
   * que no conviene es repetirla con cada una de las cien cuentas que estan
   * fallando por el mismo motivo.
   */
  private ultimaSincronizacion: number | null = null;
  /** Medida en curso, compartida por todas las peticiones que la pidieron. */
  private resincronizando: Promise<void> | null = null;

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
    this.ultimaSincronizacion = t0;
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
   * Vuelve a medir el desfase despues de que Bitget rechazara una firma por
   * marca de tiempo.
   *
   * ==========================================================================
   * Por que hace falta, y que pasaba sin esto
   * ==========================================================================
   * `40008` esta catalogado como `retryable`, de modo que el motor y el
   * supervisor lo reintentan. Pero reintentar **no arregla un reloj**: si el
   * equipo lleva dias apagado y Windows aun no ha resincronizado su hora, cada
   * reintento vuelve a firmar con la misma marca desviada y vuelve a recibir el
   * mismo rechazo, con backoff, indefinidamente. El panel se quedaba con las
   * cuentas caidas y sin nada que el operador pudiera corregir: su credencial
   * estaba bien.
   *
   * Aqui se cierra ese lazo. El cliente sigue sin reintentar -eso es de
   * `execution/`, ver la cabecera- pero deja el desfase medido **antes** de que
   * llegue el reintento, que es lo unico que lo hace distinto del anterior.
   *
   * ==========================================================================
   * Nunca puede cambiar el error que lo provoco
   * ==========================================================================
   * Si la medida falla -sin red, o `/api/v2/public/time` caido-, se traga el
   * fallo: quien llamo estaba gestionando un rechazo del exchange y tiene que
   * recibir **ese**, no uno de la sonda que se lanzo para diagnosticarlo.
   */
  private corregirReloj(): Promise<void> {
    /* Ya hay una medida en vuelo: las cien cuentas que fallaron esperan esa. */
    if (this.resincronizando !== null) return this.resincronizando;

    if (
      this.ultimaSincronizacion !== null &&
      this.relojLocal() - this.ultimaSincronizacion < RESINCRONIZACION_MINIMA_MS
    ) {
      return Promise.resolve();
    }

    const tarea = this.sincronizarReloj()
      .then(
        () => undefined,
        () => undefined
      )
      .finally(() => {
        this.resincronizando = null;
      });

    this.resincronizando = tarea;
    return tarea;
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
   *
   * La ruta se le pasa al limitador para que aplique el techo propio de los
   * endpoints que lo tienen -V3 los publica por endpoint y por UID-. Para una
   * ruta sin techo declarado, que son casi todas, no cambia nada.
   *
   * --------------------------------------------------------------------------
   * La correccion de reloj va FUERA del limitador, y no es un detalle de estilo
   * --------------------------------------------------------------------------
   * `corregirReloj` hace su propia peticion, que necesita un hueco de
   * concurrencia. Llamarla dentro del callback -es decir, con el hueco de esta
   * peticion todavia ocupado- se bloquearia a si misma en cuanto el reloj
   * desviado hiciera fallar a la vez tantas cuentas como huecos hay: todas
   * esperando una medida que no puede entrar porque las esperas la tienen
   * tomada. Aqui el `finally` del limitador ya devolvio el hueco.
   */
  async peticionFirmada<E extends z.ZodType>(
    credencial: Credencial,
    peticion: PeticionRest,
    esquema: E
  ): Promise<RespuestaRest<z.infer<E>>> {
    try {
      return await this.limitador.ejecutar(
        credencial.apiKey,
        async () => {
          await this.avisarEscritura(credencial, peticion);
          const firmable: PeticionFirmable = {
            metodo: peticion.metodo,
            ruta: peticion.ruta,
            ...(peticion.consulta === undefined ? {} : { consulta: peticion.consulta }),
            ...(peticion.cuerpo === undefined ? {} : { cuerpo: peticion.cuerpo })
          };

          const firmada = firmarPeticion(credencial, firmable, () => this.ahora());
          return this.enviar(
            firmada,
            peticion.idempotente,
            esquema,
            cuentaDe(credencial.apiKey)
          );
        },
        peticion.ruta
      );
    } catch (e) {
      /*
       * El reintento lo decide quien corresponda; lo que se hace aqui es dejar
       * el reloj bien **antes** de que llegue, que es lo unico que puede hacer
       * que el siguiente intento termine distinto. Ver `corregirReloj`.
       */
      if (e instanceof ErrorBitget && e.codigo === CODIGO_MARCA_CADUCADA) {
        await this.corregirReloj();
      }
      throw e;
    }
  }

  /**
   * Avisa de cada escritura **antes** de enviarla. Lo usa la bitácora de
   * acciones propias, que es lo que permite a las alertas distinguir lo que hizo
   * el panel de lo que hizo el cliente por su cuenta. Ver
   * `storage/bitacora-acciones.ts`. `null` deja de avisar.
   */
  observarEscrituras(observador: ((e: EscrituraBitget) => Promise<void>) | null): void {
    this.observadorEscrituras = observador;
  }

  /**
   * Va dentro del hueco del limitador y justo antes de firmar, para que la hora
   * anotada sea la del envío y no la de la cola.
   *
   * Un fallo del observador **no** frena la orden. La bitácora solo sirve para
   * no avisar de más; dejar de operar porque no se pudo escribir una línea sería
   * pagar con una orden perdida lo que, como mucho, cuesta una alerta de sobra.
   */
  private async avisarEscritura(credencial: Credencial, peticion: PeticionRest): Promise<void> {
    if (peticion.metodo === 'GET' || this.observadorEscrituras === null) return;
    try {
      await this.observadorEscrituras({
        ts: this.ahora(),
        apiKey: credencial.apiKey,
        metodo: peticion.metodo,
        ruta: peticion.ruta,
        cuerpo: peticion.cuerpo ?? null
      });
    } catch {
      /* Ver arriba: la bitácora nunca detiene una orden. */
    }
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

  /**
   * Envia y **anota**. Es el unico sitio por el que pasa toda peticion.
   *
   * La bitacora se engancha aqui y no en cada endpoint por lo mismo que el
   * limitador: un punto que hay que acordarse de invocar es un punto que algun
   * dia no se invoca, y entonces falta justo la linea que hacia falta. Ver
   * `diagnostico/bitacora.ts`.
   *
   * Anotar no puede cambiar el resultado: el error se relanza tal cual y la
   * escritura no se espera.
   */
  private async enviar<E extends z.ZodType>(
    firmada: {
      metodo: MetodoHttp;
      rutaCompleta: string;
      cuerpo: string;
      cabeceras: Record<string, string>;
    },
    idempotente: boolean,
    esquema: E,
    cuenta = 'publica'
  ): Promise<RespuestaRest<z.infer<E>>> {
    const arranque = this.relojLocal();
    /*
     * Las peticiones que cambian algo -ordenes, apalancamiento, modo de margen,
     * traspasos- anotan tambien lo que contesto Bitget. Los GET no: son el
     * sondeo de saldos y posiciones, con listas largas cada pocos segundos.
     */
    const muta = firmada.metodo !== 'GET';
    let dataCruda: unknown;

    const anotar = (
      httpStatus: number | null,
      codigo: string | null,
      mensaje: string | null
    ): void => {
      anotarPeticion({
        metodo: firmada.metodo,
        ruta: firmada.rutaCompleta,
        superficie: superficieDeRuta(firmada.rutaCompleta),
        cuenta,
        httpStatus,
        codigo,
        ms: this.relojLocal() - arranque,
        mensaje,
        cuerpo: firmada.cuerpo,
        ...(muta && dataCruda !== undefined ? { respuesta: dataCruda } : {})
      });
    };

    /*
     * Lo enviado, a la consola de `npm run dev`. Solo lo que cambia algo y
     * solo en staging, por lo mismo que los rechazos de abajo.
     */
    const cuerpoConsola = (): string =>
      firmada.cuerpo === '' ? '' : ` cuerpo=${JSON.stringify(cargaParaLog(firmada.cuerpo))}`;

    try {
      const r = await this.enviarSinAnotar(firmada, idempotente, esquema, (d) => {
        dataCruda = d;
      });
      anotar(200, r.codigo, null);
      if (esStaging() && muta) {
        console.warn(
          `[PCB] ${firmada.metodo} ${firmada.rutaCompleta} cuenta=${cuenta}${cuerpoConsola()} ` +
            `-> ${r.codigo} ${JSON.stringify(cargaParaLog(dataCruda))}`
        );
      }
      return r;
    } catch (e) {
      if (e instanceof ErrorBitget) {
        anotar(e.httpStatus, e.codigo, e.mensajeOriginal ?? e.message);
        /*
         * Ademas del archivo, a la consola: es lo que ve el operador en la
         * terminal de `npm run dev`, y un codigo sin catalogar (fatal-cuenta
         * por defecto) solo se puede diagnosticar con el texto crudo de
         * Bitget, que la pantalla no ensena. Solo en staging: es donde hay
         * respuestas reales del exchange que valga la pena leer aqui.
         */
        /*
         * El 40084 de `account/settings` no es un fallo: es la deteccion de modo
         * preguntando «¿eres UTA?» y la cuenta clasica contestando que no. Sale
         * una vez por cuenta clasica en cada arranque, y como «rechazo» parecia
         * un error que no lo es. Ver `detectarModo`.
         */
        if (esStaging() && e.codigo === '40084' && firmada.rutaCompleta.startsWith('/api/v3/account/settings')) {
          console.warn(`[PCB] cuenta=${cuenta}: modo clásico (no es UTA)`);
        } else if (esStaging()) {
          console.warn(
            `[PCB] bitget rechazo ${firmada.metodo} ${firmada.rutaCompleta} cuenta=${cuenta}` +
              `${cuerpoConsola()} codigo=${e.codigo ?? 'sin-codigo'} ` +
              `http=${e.httpStatus ?? 'sin-http'} — ${redactarTexto(e.mensajeOriginal ?? e.message)}`
          );
        }
      } else {
        const mensaje = e instanceof Error ? e.message : String(e);
        anotar(null, null, mensaje);
        if (esStaging()) {
          console.warn(
            `[PCB] fallo de transporte en ${firmada.metodo} ${firmada.rutaCompleta} ` +
              `cuenta=${cuenta}${cuerpoConsola()}: ${redactarTexto(mensaje)}`
          );
        }
      }
      throw e;
    }
  }

  private async enviarSinAnotar<E extends z.ZodType>(
    firmada: {
      metodo: MetodoHttp;
      rutaCompleta: string;
      cuerpo: string;
      cabeceras: Record<string, string>;
    },
    idempotente: boolean,
    esquema: E,
    /** Recibe el `data` crudo del sobre, antes del esquema. Solo para la bitacora. */
    alRecibirData?: (data: unknown) => void
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
      throw errorDeEsquema(firmada.rutaCompleta, sobre.error.message);
    }
    alRecibirData?.(sobre.data.data);

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
      throw errorDeEsquema(firmada.rutaCompleta, datos.error.message);
    }

    return { datos: datos.data as z.infer<E>, duracionMs, codigo: sobre.data.code };
  }
}

export { ErrorBitget };
