/**
 * El pool de sockets: quien tiene conexion en vivo y quien se queda en REST.
 *
 * Resuelve el Hallazgo 2 de docs/01: Bitget admite **100 conexiones por IP** y
 * el panel gobierna 100 subcuentas, cada una con su credencial y por tanto con
 * su propia conexion. No caben. Y no hace falta que quepan: una cuenta sin
 * posiciones no aporta ninguna fila al monitor, asi que el socket se le da a
 * quien tiene algo que enseñar.
 *
 *   caliente   tiene posiciones abiertas -o acaba de recibir una operacion-.
 *              Socket con `positions` y `orders-algo`.
 *   frio       sin posiciones. Se refresca con el barrido REST cada 45 s, y no
 *              se pierde nada visible porque no hay nada que enseñar.
 *
 * En cuanto aparece una posicion, la cuenta se promueve. En cuanto la pierde,
 * libera el hueco.
 *
 * --------------------------------------------------------------------------
 * Los tres techos, y por que hacen falta tres controles
 * --------------------------------------------------------------------------
 *   80 sockets a la vez        20 % por debajo del techo de 100 por IP
 *   240 conexiones / 5 min     20 % por debajo del techo de 300
 *   5 conexiones por segundo   arranque escalonado
 *
 * El segundo y el tercero **no** son el mismo limite expresado de dos formas, y
 * por eso son dos buckets. El de la ventana es un promedio: 240 en cinco
 * minutos deja abrir 80 de golpe y seguir teniendo margen. El del segundo es
 * una forma: sin el, esos 80 saldrian en la misma vuelta del bucle y Bitget
 * veria una rafaga que no distingue de un ataque. Con los dos, el arranque
 * tarda unos dieciseis segundos y un corte de red que tire los 80 se recupera
 * de forma ordenada, que es justo lo que evita el bloqueo de IP de 5 minutos.
 *
 * --------------------------------------------------------------------------
 * Que NO hace
 * --------------------------------------------------------------------------
 * No habla el protocolo -eso es de `ConexionBitget`- ni decide que es una
 * posicion viva -eso es de `AlmacenPosiciones`-. Pregunta a `FuentePool` quien
 * esta caliente, reparte los huecos que tiene y avisa a quien se queda fuera.
 */
import {
  WS_ARRANQUE_POR_SEGUNDO,
  WS_MAX_CONCURRENTES,
  WS_PRESUPUESTO_CONEXIONES,
  WS_TICK_MS
} from '@shared/constants';
import type { AlmacenPosiciones } from '../../domain/almacen-posiciones';
import { esperaReconexion } from '../../domain/estado-conexion';
import { BucketTokens } from '../../execution/rate-limiter';
import type { Mercado } from '../mercado';
import type { Credencial } from '../rest/signer';
import {
  CANAL_PLANES,
  CANAL_POSICIONES,
  ConexionBitget,
  type AccionEmpujon,
  type MotivoCaida,
  type OpcionesConexion
} from './conexion';
import { posicionesDeEmpujon, takeProfitDeEmpujon } from './empujones';

/** Ventana del presupuesto de conexiones: cinco minutos. */
const VENTANA_CONEXIONES_MS = 300_000;

export interface CuentaSocket {
  cuentaId: string;
  credencial: Credencial;
}

export interface FuentePool {
  /**
   * Las cuentas que merecen socket, **en orden de prioridad**.
   *
   * El orden importa cuando no caben todas: quien lo implementa pone primero
   * las que ya tienen posiciones abiertas y despues las que solo son objetivo
   * de la ultima operacion. Si hay que dejar a alguien en REST, que sea a quien
   * todavia no tiene nada que enseñar.
   */
  cuentasCalientes(): CuentaSocket[];
  /** `false` con el panel bloqueado. */
  operativa(): boolean;
  /**
   * La cuenta se queda sin conexion en vivo por falta de cupo, o la recupera.
   *
   * Es lo que impide degradar en silencio: el panel enseña «modo REST» en esa
   * casilla y el operador sabe que ese dato puede llevar hasta 45 s de retraso.
   * docs/01 seccion 8.
   */
  marcarModoRest(cuentaId: string, enModoRest: boolean): void;
  /** Bitget rechazo la credencial en el `login`. No se reintenta. */
  alRechazarCredencial?(cuentaId: string, detalle: { codigo: string | null; mensaje: string | null }): void;
}

export interface OpcionesPool {
  maxConcurrentes?: number;
  presupuestoConexiones?: number;
  arranquePorSegundo?: number;
  tickMs?: number;
  ahora?: () => number;
  azar?: () => number;
  programar?: (fn: () => void, ms: number) => unknown;
  cancelar?: (id: unknown) => void;
  /** Se pasan tal cual a cada `ConexionBitget`. Las pruebas fijan aqui la URL. */
  conexion?: OpcionesConexion;
}

interface Ficha {
  conexion: ConexionBitget | null;
  /** Intentos seguidos fallidos. Alimenta el backoff. */
  intentos: number;
  /** Instante del proximo intento, o `null` si puede intentarse ya. */
  proximoIntento: number | null;
  /** Credencial rechazada en el login: no se vuelve a intentar en esta sesion. */
  invalida: boolean;
  /** Si esta cuenta esta hoy marcada como «modo REST» hacia la pantalla. */
  enModoRest: boolean;
}

export class PoolSockets {
  private readonly mercado: Mercado;
  private readonly almacen: AlmacenPosiciones;
  private readonly fuente: FuentePool;

  private readonly maxConcurrentes: number;
  private readonly tickMs: number;
  private readonly ahora: () => number;
  private readonly azar: () => number;
  private readonly programar: (fn: () => void, ms: number) => unknown;
  private readonly cancelar: (id: unknown) => void;
  private readonly opcionesConexion: OpcionesConexion;

  /** Presupuesto de la ventana de 5 minutos. */
  private readonly ventana: BucketTokens;
  /** Forma del arranque: como maximo N conexiones nuevas por segundo. */
  private readonly arranque: BucketTokens;

  private readonly fichas = new Map<string, Ficha>();
  private temporizador: unknown = null;
  private encendido = false;

  constructor(
    mercado: Mercado,
    almacen: AlmacenPosiciones,
    fuente: FuentePool,
    opciones: OpcionesPool = {}
  ) {
    this.mercado = mercado;
    this.almacen = almacen;
    this.fuente = fuente;
    this.maxConcurrentes = opciones.maxConcurrentes ?? WS_MAX_CONCURRENTES;
    this.tickMs = opciones.tickMs ?? WS_TICK_MS;
    this.ahora = opciones.ahora ?? Date.now;
    this.azar = opciones.azar ?? Math.random;
    this.programar = opciones.programar ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancelar = opciones.cancelar ?? ((id) => clearTimeout(id as NodeJS.Timeout));
    this.opcionesConexion = opciones.conexion ?? {};

    const presupuesto = opciones.presupuestoConexiones ?? WS_PRESUPUESTO_CONEXIONES;
    this.ventana = new BucketTokens(
      presupuesto,
      presupuesto / (VENTANA_CONEXIONES_MS / 1_000),
      this.ahora
    );
    const porSegundo = opciones.arranquePorSegundo ?? WS_ARRANQUE_POR_SEGUNDO;
    this.arranque = new BucketTokens(porSegundo, porSegundo, this.ahora);
  }

  get estaEncendido(): boolean {
    return this.encendido;
  }

  /** Cuentas con socket vivo ahora mismo. Alimenta `socketsCalientes` del panel. */
  get vivos(): string[] {
    const salida: string[] = [];
    for (const [cuentaId, ficha] of this.fichas) {
      if (ficha.conexion?.estaViva === true) salida.push(cuentaId);
    }
    return salida;
  }

  /** Sockets abiertos o abriendose. Es lo que cuenta contra el techo de la IP. */
  get ocupados(): number {
    let n = 0;
    for (const ficha of this.fichas.values()) if (ficha.conexion !== null) n += 1;
    return n;
  }

  iniciar(): void {
    if (this.encendido) return;
    this.encendido = true;
    this.dormir();
    this.revisar();
  }

  detener(): void {
    this.encendido = false;
    if (this.temporizador !== null) {
      this.cancelar(this.temporizador);
      this.temporizador = null;
    }
    this.cerrarTodo();
  }

  private dormir(): void {
    if (!this.encendido) return;
    this.temporizador = this.programar(() => {
      this.temporizador = null;
      this.revisar();
      this.dormir();
    }, this.tickMs);
  }

  /**
   * Un ciclo: cierra lo que sobra, abre lo que cabe y avisa a quien se queda.
   *
   * Publico a proposito, como el ciclo del supervisor: las pruebas lo llaman
   * directamente y comprueban el reparto sin temporizadores de por medio.
   */
  revisar(): void {
    if (!this.encendido) return;

    if (!this.fuente.operativa()) {
      /*
       * Panel bloqueado: fuera todos los sockets. No es higiene, es que un
       * socket vivo seguiria empujando posiciones a un almacen que se acaba de
       * vaciar, y el monitor volveria a llenarse por detras del cerrojo.
       */
      this.cerrarTodo();
      return;
    }

    const calientes = this.fuente.cuentasCalientes();
    const sigueCaliente = new Set(calientes.map((c) => c.cuentaId));

    /* Lo que se enfrio libera su hueco antes de repartir: si no, no cabe nadie. */
    for (const [cuentaId, ficha] of this.fichas) {
      if (sigueCaliente.has(cuentaId)) continue;
      this.soltar(cuentaId, ficha);
    }

    for (const cuenta of calientes) {
      const ficha = this.fichaDe(cuenta.cuentaId);

      if (ficha.conexion !== null || ficha.invalida) continue;
      if (ficha.proximoIntento !== null && ficha.proximoIntento > this.ahora()) continue;

      /*
       * Tres puertas, y las tres tienen que abrirse: hueco de socket, cupo de
       * la ventana y cupo del segundo. Se comprueban antes de gastar ninguna,
       * por lo mismo que el limitador de peticiones consulta sus dos buckets
       * antes de consumir: gastar el token de la ventana y descubrir despues
       * que no hay hueco tira cupo que nadie usa.
       */
      if (this.ocupados >= this.maxConcurrentes) {
        this.marcarRest(cuenta.cuentaId, ficha, true);
        continue;
      }
      if (!this.ventana.hayToken() || !this.arranque.hayToken()) break;

      this.ventana.consumir();
      this.arranque.consumir();
      this.abrir(cuenta, ficha);
    }
  }

  private fichaDe(cuentaId: string): Ficha {
    let ficha = this.fichas.get(cuentaId);
    if (ficha === undefined) {
      ficha = { conexion: null, intentos: 0, proximoIntento: null, invalida: false, enModoRest: false };
      this.fichas.set(cuentaId, ficha);
    }
    return ficha;
  }

  private abrir(cuenta: CuentaSocket, ficha: Ficha): void {
    const conexion = new ConexionBitget(
      cuenta.cuentaId,
      cuenta.credencial,
      this.mercado,
      {
        alEmpujar: (canal, accion, datos) => this.aplicar(cuenta.cuentaId, canal, accion, datos),
        alQuedarViva: () => {
          /* Reconecto: el backoff vuelve a empezar y la cuenta sale de modo REST. */
          ficha.intentos = 0;
          ficha.proximoIntento = null;
          this.marcarRest(cuenta.cuentaId, ficha, false);
        },
        alCaer: (motivo, detalle) => this.alCaer(cuenta.cuentaId, ficha, motivo, detalle)
      },
      this.opcionesConexion
    );

    ficha.conexion = conexion;
    conexion.conectar();
  }

  /**
   * Aplica un empujon al almacen.
   *
   * La distincion entre `snapshot` y `update` se respeta tal cual llega, y es
   * la unica parte de esto que no se puede tomar a la ligera: una foto
   * sustituye **todas** las posiciones de la cuenta. Aplicar como foto lo que
   * era un cambio suelto borraria del monitor las demas posiciones de esa
   * casilla. docs/01 seccion 8.
   */
  private aplicar(
    cuentaId: string,
    canal: string,
    accion: AccionEmpujon,
    datos: readonly unknown[]
  ): void {
    const instante = new Date(this.ahora()).toISOString();

    if (canal === CANAL_POSICIONES) {
      const posiciones = posicionesDeEmpujon(cuentaId, datos, instante);
      if (accion === 'snapshot') {
        this.almacen.aplicarInstantanea(cuentaId, posiciones);
        return;
      }
      for (const posicion of posiciones) this.almacen.aplicarActualizacion(posicion);
      return;
    }

    if (canal === CANAL_PLANES) {
      for (const cambio of takeProfitDeEmpujon(datos)) {
        this.almacen.fijarTakeProfit(cuentaId, cambio.simbolo, cambio.lado, cambio.tp);
      }
    }
  }

  private alCaer(
    cuentaId: string,
    ficha: Ficha,
    motivo: MotivoCaida,
    detalle: { codigo: string | null; mensaje: string | null }
  ): void {
    ficha.conexion = null;

    if (motivo === 'cerrado-local') {
      /* Lo cerramos nosotros: ni backoff ni aviso. El hueco ya esta libre. */
      ficha.intentos = 0;
      ficha.proximoIntento = null;
      return;
    }

    if (motivo === 'credencial') {
      /*
       * No se reintenta en toda la sesion. Reconectar con la misma clave
       * rechazada gastaria el presupuesto de conexiones de la IP para recibir
       * el mismo rechazo, y esa clave solo la arregla una persona.
       */
      ficha.invalida = true;
      ficha.proximoIntento = null;
      this.marcarRest(cuentaId, ficha, true);
      this.fuente.alRechazarCredencial?.(cuentaId, detalle);
      return;
    }

    /*
     * Caida transitoria: backoff con jitter, el mismo que el de reconexion de
     * cuentas. Mientras tanto la cuenta cae al barrido REST y el panel pierde
     * inmediatez, no informacion.
     */
    ficha.intentos += 1;
    ficha.proximoIntento = this.ahora() + esperaReconexion(ficha.intentos, this.azar);
    this.marcarRest(cuentaId, ficha, true);
  }

  /** Cierra el socket de una cuenta que ya no lo merece y olvida su ficha. */
  private soltar(cuentaId: string, ficha: Ficha): void {
    ficha.conexion?.cerrar();
    ficha.conexion = null;
    this.marcarRest(cuentaId, ficha, false);
    /*
     * La ficha se borra entera: una cuenta que se enfria y vuelve a calentarse
     * es una cuenta nueva para el pool. Conservar su backoff la haria esperar
     * por caidas de hace media hora que ya no dicen nada de ahora.
     */
    this.fichas.delete(cuentaId);
  }

  private cerrarTodo(): void {
    for (const [cuentaId, ficha] of this.fichas) this.soltar(cuentaId, ficha);
    this.fichas.clear();
  }

  /** Avisa del cambio de modo solo cuando cambia: la pantalla no necesita repeticiones. */
  private marcarRest(cuentaId: string, ficha: Ficha, enModoRest: boolean): void {
    if (ficha.enModoRest === enModoRest) return;
    ficha.enModoRest = enModoRest;
    this.fuente.marcarModoRest(cuentaId, enModoRest);
  }
}
