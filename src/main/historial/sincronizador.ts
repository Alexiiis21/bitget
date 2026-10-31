/**
 * Trae de Bitget las posiciones cerradas de una cuenta y las guarda.
 *
 * ==========================================================================
 * Una sincronización por cuenta, nunca dos
 * ==========================================================================
 * Si llega una segunda petición para una cuenta que ya se está sincronizando
 * —doble clic, la pantalla que se abre mientras sigue la anterior—, recibe **la
 * misma promesa**. No se lanza otra. Dos recorridos en paralelo gastarían el
 * doble de cupo y se pisarían la cobertura al terminar. Es el patrón de
 * `corregirReloj` en `client.ts`.
 *
 * Cuentas distintas sí van en paralelo. El cupo lo reparte el limitador del
 * cliente, que ya separa por cuenta y por IP.
 *
 * ==========================================================================
 * Incremental
 * ==========================================================================
 * Con cobertura previa se pide solo desde su final menos `SOLAPE_MS`. El solape
 * cubre las posiciones cerradas justo en el borde; las que se repiten las
 * absorbe la fusión por `positionId`. Sin cobertura se pide todo lo que Bitget
 * guarda: 90 días.
 *
 * ==========================================================================
 * Una cuenta que se borra a mitad
 * ==========================================================================
 * Antes de guardar cada página se comprueba que la cuenta sigue en el panel y
 * con el mismo UID. Si no, se deja de pedir y no se guarda nada. `olvidar`
 * marca la cuenta y **espera** a que la sincronización en curso termine antes
 * de borrar: así no hay una escritura en vuelo que recree lo recién borrado.
 */
import { ErrorHistorial } from '../domain/posicion-cerrada';
import { HISTORIAL_VENTANA_MS } from '@shared/constants';
import {
  ampliarCobertura,
  contarNuevas,
  fusionarPosiciones,
  historialVacio,
  type Cobertura,
  type HistorialCuenta
} from './historial-cuenta';
import { recorrerHistorial, type FuentePaginas } from './paginador';
import { takeProfitDe, type PlanTp } from './take-profit';

/** Solape entre sincronizaciones. Más que de sobra para lo que tarda Bitget en publicar un cierre. */
export const SOLAPE_MS = 10 * 60_000;

/** Bitget no entrega planes de más de 90 días. Lo abierto antes ya no tiene TP que buscar. */
const VENTANA_PLANES_MS = 89 * 24 * 60 * 60 * 1000;

/** Dónde vive el historial. En memoria en la Fase 2; en disco desde la Fase 3. */
export interface AlmacenHistorial {
  /** El historial de la cuenta, o `null` si no hay o es de otro UID. */
  leer(cuentaId: string, uid: string): Promise<HistorialCuenta | null>;
  guardar(historial: HistorialCuenta): Promise<void>;
  borrar(cuentaId: string): Promise<void>;
}

export class AlmacenHistorialMemoria implements AlmacenHistorial {
  private readonly datos = new Map<string, HistorialCuenta>();

  leer(cuentaId: string, uid: string): Promise<HistorialCuenta | null> {
    const h = this.datos.get(cuentaId);
    return Promise.resolve(h !== undefined && h.uid === uid ? h : null);
  }

  guardar(historial: HistorialCuenta): Promise<void> {
    this.datos.set(historial.cuentaId, historial);
    return Promise.resolve();
  }

  borrar(cuentaId: string): Promise<void> {
    this.datos.delete(cuentaId);
    return Promise.resolve();
  }
}

/** Lo que el sincronizador necesita saber de una cuenta para leerla. */
export interface CuentaHistorial {
  uid: string;
  /** Trae una página de la superficie que le toque a la cuenta. */
  fuente: FuentePaginas;
  /** Los planes TP terminados creados en el rango. Sin ella, no se busca el TP. */
  planesTp?: (desdeMs: number, hastaMs: number) => Promise<PlanTp[]>;
}

export interface ProgresoHistorial {
  cuentaId: string;
  paginas: number;
  recibidas: number;
}

export interface ResumenSincronizacion {
  cuentaId: string;
  /** Posiciones que no estaban guardadas. */
  nuevas: number;
  /** Posiciones guardadas en total tras sincronizar. */
  total: number;
  cobertura: Cobertura;
  /**
   * Quedó un tramo sin traer entre la cobertura anterior y la nueva, porque la
   * cuenta pasó más de 90 días sin sincronizar. Lo de ese hueco no se recupera.
   */
  hueco: boolean;
  sincronizadoEn: number;
}

export interface DependenciasSincronizador {
  almacen: AlmacenHistorial;
  /** La cuenta tal como está **ahora** en el panel, o `null` si ya no está. */
  cuenta: (cuentaId: string) => CuentaHistorial | null;
  /** Hora de Bitget: la del equipo corregida con el desfase medido. */
  ahoraMs: () => number;
  dormir?: (ms: number) => Promise<void>;
  alProgresar?: (p: ProgresoHistorial) => void;
}

export class SincronizadorHistorial {
  private readonly enCurso = new Map<string, Promise<ResumenSincronizacion>>();
  /** Cuentas dadas de baja mientras se sincronizaban. */
  private readonly olvidadas = new Set<string>();

  private readonly deps: DependenciasSincronizador;

  constructor(deps: DependenciasSincronizador) {
    this.deps = deps;
  }

  sincronizar(cuentaId: string): Promise<ResumenSincronizacion> {
    const vigente = this.enCurso.get(cuentaId);
    if (vigente !== undefined) return vigente;

    const promesa = this.recorrer(cuentaId).finally(() => {
      this.enCurso.delete(cuentaId);
    });
    this.enCurso.set(cuentaId, promesa);
    return promesa;
  }

  /** Lo guardado, sin salir a la red. */
  async leer(cuentaId: string): Promise<HistorialCuenta | null> {
    const cuenta = this.deps.cuenta(cuentaId);
    if (cuenta === null) {
      throw new ErrorHistorial('cuenta-desconocida', 'La cuenta ya no está en el panel.');
    }
    return this.deps.almacen.leer(cuentaId, cuenta.uid);
  }

  /**
   * Borra el historial de una cuenta dada de baja.
   *
   * Espera a la sincronización en curso, si la hay: borrar antes dejaría que su
   * siguiente página volviera a crear lo borrado.
   */
  async olvidar(cuentaId: string): Promise<void> {
    this.olvidadas.add(cuentaId);
    try {
      await this.enCurso.get(cuentaId)?.catch(() => undefined);
      await this.deps.almacen.borrar(cuentaId);
    } finally {
      this.olvidadas.delete(cuentaId);
    }
  }

  private sigueVigente(cuentaId: string, uid: string): boolean {
    return !this.olvidadas.has(cuentaId) && this.deps.cuenta(cuentaId)?.uid === uid;
  }

  private async recorrer(cuentaId: string): Promise<ResumenSincronizacion> {
    const cuenta = this.deps.cuenta(cuentaId);
    if (cuenta === null) {
      throw new ErrorHistorial('cuenta-desconocida', 'La cuenta ya no está en el panel.');
    }
    const { uid, fuente } = cuenta;

    const hastaMs = this.deps.ahoraMs();
    const limiteBitget = hastaMs - HISTORIAL_VENTANA_MS;

    let historial = (await this.deps.almacen.leer(cuentaId, uid)) ?? historialVacio(cuentaId, uid);
    const anterior = historial.cobertura;
    const desdeMs =
      anterior === null ? limiteBitget : Math.max(limiteBitget, anterior.hastaMs - SOLAPE_MS);

    let nuevas = 0;
    let paginas = 0;
    let recibidas = 0;

    for await (const pagina of recorrerHistorial(fuente, {
      desdeMs,
      hastaMs,
      ...(this.deps.dormir === undefined ? {} : { dormir: this.deps.dormir })
    })) {
      if (!this.sigueVigente(cuentaId, uid)) {
        throw new ErrorHistorial(
          'cuenta-desconocida',
          'La cuenta se dio de baja durante la consulta.'
        );
      }

      nuevas += contarNuevas(historial, pagina);
      historial = fusionarPosiciones(historial, pagina);
      /* Cada página se guarda al llegar: si la siguiente falla, esta ya no se pierde. */
      await this.deps.almacen.guardar(historial);

      paginas++;
      recibidas += pagina.length;
      this.deps.alProgresar?.({ cuentaId, paginas, recibidas });
    }

    if (!this.sigueVigente(cuentaId, uid)) {
      throw new ErrorHistorial(
        'cuenta-desconocida',
        'La cuenta se dio de baja durante la consulta.'
      );
    }

    historial = await this.completarTakeProfit(historial, cuenta, hastaMs);

    if (!this.sigueVigente(cuentaId, uid)) {
      throw new ErrorHistorial(
        'cuenta-desconocida',
        'La cuenta se dio de baja durante la consulta.'
      );
    }

    const tramo: Cobertura = { desdeMs, hastaMs };
    const cobertura = ampliarCobertura(anterior, tramo);
    historial = { ...historial, cobertura, sincronizadoEn: hastaMs };
    await this.deps.almacen.guardar(historial);

    return {
      cuentaId,
      nuevas,
      total: Object.keys(historial.posiciones).length,
      cobertura,
      hueco: anterior !== null && cobertura.desdeMs > anterior.desdeMs,
      sincronizadoEn: hastaMs
    };
  }

  /**
   * Pone el TP a las posiciones que aún no lo tienen buscado.
   *
   * Es un dato accesorio: si los planes no se pueden leer, el historial se
   * guarda igual y se vuelve a intentar en la siguiente sincronización. Una
   * posición recién cerrada sin TP encontrado tampoco se da por buscada: Bitget
   * puede tardar en pasar el plan a su historial.
   */
  private async completarTakeProfit(
    historial: HistorialCuenta,
    cuenta: CuentaHistorial,
    hastaMs: number
  ): Promise<HistorialCuenta> {
    if (cuenta.planesTp === undefined) return historial;
    const pendientes = Object.values(historial.posiciones).filter(
      (p) => p.tp === undefined && p.abiertaEnMs >= hastaMs - VENTANA_PLANES_MS
    );
    if (pendientes.length === 0) return historial;

    let planes: PlanTp[];
    try {
      const desde = Math.min(...pendientes.map((p) => p.abiertaEnMs)) - 60_000;
      planes = await cuenta.planesTp(Math.max(desde, hastaMs - VENTANA_PLANES_MS), hastaMs);
    } catch {
      return historial;
    }

    const posiciones = { ...historial.posiciones };
    for (const p of pendientes) {
      const tp = takeProfitDe(p, planes);
      if (tp !== null) posiciones[p.positionId] = { ...p, tp };
      else if (p.cerradaEnMs < hastaMs - SOLAPE_MS) posiciones[p.positionId] = { ...p, tp: null };
    }
    return { ...historial, posiciones };
  }
}
