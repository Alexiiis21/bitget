/**
 * Estado de conexion por cuenta.
 *
 * Cubre RF-002 -«mostrar el estado de conexion de cada cuenta mediante
 * indicadores visuales»- y RNF-004 -«en caso de perdida de conexion con alguna
 * cuenta, el resto del sistema debera continuar funcionando con normalidad»-.
 *
 * --------------------------------------------------------------------------
 * Por que un fallo no pinta la cuenta en rojo
 * --------------------------------------------------------------------------
 * La tentacion es marcar `desconectada` al primer error. Con 100 cuentas
 * consultandose cada 45 segundos, un microcorte de red pondria las 100 en rojo
 * durante un instante, varias veces al dia. El operador aprenderia en una
 * semana a ignorar el color, y el dia que una cuenta se caiga de verdad no lo
 * vera.
 *
 * Por eso el estado depende de **la clase del error**, no de su existencia:
 *
 *   fallo transitorio (retryable)  -> `conectando`, y se reintenta con backoff
 *   fallo de credencial            -> `desconectada` inmediata, sin reintentos
 *   3 fallos transitorios seguidos -> `desconectada`, ya no es un microcorte
 *
 * La distincion la aporta ErrorBitget, que ya clasifica cada fallo por si es
 * seguro reintentarlo. docs/01-stack-tecnologico.md secciones 8 y 9.
 */
import {
  FALLOS_PARA_DESCONECTAR,
  RECONEXION_BASE_MS,
  RECONEXION_JITTER,
  RECONEXION_TOPE_MS
} from '@shared/constants';
import type { EstadoConexion } from '@shared/types';
import { ErrorBitget } from '../bitget/errors';

export interface EstadoCuenta {
  cuentaId: string;
  estado: EstadoConexion;
  /** Texto para el operador cuando el estado no es `conectada`. */
  motivo: string | null;
  /** Codigo crudo del exchange del ultimo fallo. Va al log, no a la pantalla. */
  codigoBitget: string | null;
  fallosConsecutivos: number;
  /** Marca del ultimo exito, o `null` si nunca conecto. */
  ultimoExito: number | null;
  ultimoIntento: number | null;
  /** Ida y vuelta de la ultima consulta con exito. */
  latenciaMs: number | null;
  /**
   * Instante del proximo reintento, o `null` si no procede reintentar.
   *
   * Es `null` en dos casos opuestos: la cuenta va bien, o su credencial es
   * invalida y reintentar no arreglaria nada.
   */
  proximoIntento: number | null;
}

export interface CambioEstado {
  cuentaId: string;
  anterior: EstadoConexion;
  actual: EstadoConexion;
}

export interface OpcionesRegistro {
  ahora?: () => number;
  /** Aleatoriedad del jitter. Se inyecta para hacer deterministas las pruebas. */
  azar?: () => number;
}

/**
 * Backoff exponencial con jitter.
 *
 * El jitter no es cosmetico: sin el, 100 cuentas que se caen a la vez
 * reintentan a la vez, y Bitget limita las **conexiones por IP** a 300 cada 5
 * minutos. Tres oleadas sincronizadas bloquean la IP y convierten un corte de
 * 10 segundos en 5 minutos de panel ciego. docs/01 seccion 8, Hallazgo 2.
 */
export function esperaReconexion(
  intento: number,
  azar: () => number = Math.random,
  baseMs: number = RECONEXION_BASE_MS,
  topeMs: number = RECONEXION_TOPE_MS
): number {
  const exponencial = Math.min(topeMs, baseMs * 2 ** Math.max(0, intento - 1));
  const desviacion = exponencial * RECONEXION_JITTER;
  /* azar() en [0,1) -> factor en [-1,1) */
  return Math.max(0, Math.round(exponencial + desviacion * (azar() * 2 - 1)));
}

/**
 * Registro del estado de conexion de todas las cuentas.
 *
 * Es la fuente de verdad de lo que pinta el panel en la columna de estado. No
 * hace peticiones: recibe los resultados de quien las hace. Asi se prueba
 * entero sin red y sin relojes reales.
 */
export class RegistroConexiones {
  private readonly estados = new Map<string, EstadoCuenta>();
  private readonly oyentes = new Set<(cambio: CambioEstado) => void>();
  private readonly ahora: () => number;
  private readonly azar: () => number;

  constructor(opciones: OpcionesRegistro = {}) {
    this.ahora = opciones.ahora ?? Date.now;
    this.azar = opciones.azar ?? Math.random;
  }

  /** Da de alta una cuenta. Arranca en `desconectada`: aun no ha conectado. */
  registrar(cuentaId: string): void {
    if (this.estados.has(cuentaId)) return;
    this.estados.set(cuentaId, {
      cuentaId,
      estado: 'desconectada',
      motivo: 'Sin verificar todavia.',
      codigoBitget: null,
      fallosConsecutivos: 0,
      ultimoExito: null,
      ultimoIntento: null,
      latenciaMs: null,
      proximoIntento: this.ahora()
    });
  }

  olvidar(cuentaId: string): void {
    this.estados.delete(cuentaId);
  }

  /** Suscripcion a los cambios. Devuelve la funcion para cancelarla. */
  alCambiar(oyente: (cambio: CambioEstado) => void): () => void {
    this.oyentes.add(oyente);
    return () => this.oyentes.delete(oyente);
  }

  private emitir(cuentaId: string, anterior: EstadoConexion, actual: EstadoConexion): void {
    if (anterior === actual) return;
    for (const o of this.oyentes) o({ cuentaId, anterior, actual });
  }

  private obtener(cuentaId: string): EstadoCuenta {
    let e = this.estados.get(cuentaId);
    if (e === undefined) {
      this.registrar(cuentaId);
      e = this.estados.get(cuentaId);
      if (e === undefined) throw new Error(`No se pudo registrar la cuenta ${cuentaId}`);
    }
    return e;
  }

  /** La cuenta tiene una peticion en curso. */
  marcarConectando(cuentaId: string): void {
    const e = this.obtener(cuentaId);
    const anterior = e.estado;
    e.estado = 'conectando';
    e.ultimoIntento = this.ahora();
    this.emitir(cuentaId, anterior, 'conectando');
  }

  /** Una consulta salio bien: la cuenta esta viva. */
  registrarExito(cuentaId: string, latenciaMs: number): void {
    const e = this.obtener(cuentaId);
    const anterior = e.estado;
    const t = this.ahora();

    e.estado = 'conectada';
    e.motivo = null;
    e.codigoBitget = null;
    e.fallosConsecutivos = 0;
    e.ultimoExito = t;
    e.ultimoIntento = t;
    e.latenciaMs = latenciaMs;
    e.proximoIntento = null;

    this.emitir(cuentaId, anterior, 'conectada');
  }

  /**
   * Una consulta fallo.
   *
   * El estado resultante lo decide la clase del error, no el hecho de fallar.
   * Devuelve el estado en que queda la cuenta.
   */
  registrarFallo(cuentaId: string, error: unknown): EstadoConexion {
    const e = this.obtener(cuentaId);
    const anterior = e.estado;
    const t = this.ahora();

    e.ultimoIntento = t;
    e.fallosConsecutivos += 1;

    const esBitget = error instanceof ErrorBitget;
    e.motivo = error instanceof Error ? error.message : String(error);
    e.codigoBitget = esBitget ? error.codigo : null;

    /*
     * Credencial invalida, sin permiso o IP no autorizada: reintentar no lo
     * arregla y solo gasta cupo. La cuenta queda fuera hasta que el operador
     * corrija la credencial.
     */
    const transitorio = esBitget ? error.reintentable : true;

    if (!transitorio) {
      e.estado = 'desconectada';
      e.proximoIntento = null;
      this.emitir(cuentaId, anterior, 'desconectada');
      return e.estado;
    }

    e.estado = e.fallosConsecutivos >= FALLOS_PARA_DESCONECTAR ? 'desconectada' : 'conectando';
    e.proximoIntento = t + esperaReconexion(e.fallosConsecutivos, this.azar);

    this.emitir(cuentaId, anterior, e.estado);
    return e.estado;
  }

  /**
   * Anota el resultado de una verificacion de credencial.
   *
   * Existe para cerrar una costura peligrosa. `verificarCredencial` devuelve un
   * veredicto en lugar de lanzar -para que un alta de 100 cuentas siga con las
   * 99 restantes-, y quien lo recibia tenia que acordarse de convertirlo en un
   * `ErrorBitget` antes de pasarlo a `registrarFallo`. Envolverlo en un `Error`
   * corriente lo hacia pasar por transitorio, y una API Key definitivamente
   * rechazada quedaba en `conectando`: el panel la reintentaria para siempre,
   * gastando cupo en una credencial que no va a funcionar nunca.
   *
   * Tanto `invalida` -Bitget la rechaza- como `rechazada` -no pasa nuestras
   * reglas de permisos- son definitivas: solo se arreglan corrigiendo la
   * credencial, asi que no se programa reintento.
   */
  registrarVerificacion(
    cuentaId: string,
    resultado: {
      veredicto: 'valida' | 'rechazada' | 'invalida';
      motivo: string | null;
      codigoBitget: string | null;
      latenciaMs: number;
    }
  ): EstadoConexion {
    if (resultado.veredicto === 'valida') {
      this.registrarExito(cuentaId, resultado.latenciaMs);
      return 'conectada';
    }

    const e = this.obtener(cuentaId);
    const anterior = e.estado;

    e.estado = 'desconectada';
    e.motivo = resultado.motivo;
    e.codigoBitget = resultado.codigoBitget;
    e.fallosConsecutivos += 1;
    e.ultimoIntento = this.ahora();
    e.proximoIntento = null;

    this.emitir(cuentaId, anterior, 'desconectada');
    return 'desconectada';
  }

  /**
   * La cuenta pasa a refrescarse por REST porque no cupo en el presupuesto de
   * sockets. Los datos siguen siendo correctos, solo llegan mas espaciados; el
   * panel lo muestra para no degradar en silencio. docs/01 seccion 8.
   */
  marcarModoRest(cuentaId: string, enModoRest: boolean): void {
    const e = this.obtener(cuentaId);
    if (e.estado !== 'conectada' && e.estado !== 'modo-rest') return;
    const anterior = e.estado;
    e.estado = enModoRest ? 'modo-rest' : 'conectada';
    this.emitir(cuentaId, anterior, e.estado);
  }

  estado(cuentaId: string): EstadoCuenta | undefined {
    const e = this.estados.get(cuentaId);
    return e === undefined ? undefined : { ...e };
  }

  /** Foto de todas las cuentas, para pintar el panel. */
  instantanea(): EstadoCuenta[] {
    return [...this.estados.values()].map((e) => ({ ...e }));
  }

  /** Cuentas cuyo reintento ya toca. Las invalidas nunca aparecen aqui. */
  pendientesDeReintento(): string[] {
    const t = this.ahora();
    return [...this.estados.values()]
      .filter((e) => e.proximoIntento !== null && e.proximoIntento <= t)
      .map((e) => e.cuentaId);
  }

  /** Recuento por estado, para la barra superior del panel. */
  resumen(): Record<EstadoConexion, number> {
    const r: Record<EstadoConexion, number> = {
      conectada: 0,
      conectando: 0,
      desconectada: 0,
      'modo-rest': 0
    };
    for (const e of this.estados.values()) r[e.estado] += 1;
    return r;
  }
}
