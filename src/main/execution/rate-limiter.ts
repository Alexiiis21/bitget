/**
 * Control de limites de peticiones.
 *
 * Bitget impone dos techos a la vez y el panel tiene que respetar los dos:
 *
 *   por UID   10 req/s   -- cada subcuenta es un UID distinto
 *   por IP    ~100 req/s -- compartido por las 100 cuentas de una instancia
 *
 * Al excederlos responde 429 y **bloquea 5 minutos**. Con 100 cuentas operando
 * desde una sola maquina, el que revienta primero es el global de IP: por eso
 * el presupuesto propio va deliberadamente por debajo (40/s global, 8/s por
 * cuenta). docs/01-stack-tecnologico.md seccion 9.
 *
 * --------------------------------------------------------------------------
 * Las dos decisiones que hacen que esto funcione
 * --------------------------------------------------------------------------
 *
 * 1. **Se consultan los dos buckets antes de gastar ninguno.** Consumir el
 *    token global y descubrir despues que la cuenta no tiene el suyo
 *    desperdicia cupo global que nadie usa. El token se retira de ambos a la
 *    vez o de ninguno.
 *
 * 2. **La cola es FIFO estricta.** Sin orden, la cuenta con mas trabajo
 *    acapara el cupo global y las ultimas del lote esperan indefinidamente.
 *    Con FIFO, un lote de 100 cuentas termina en un tiempo acotado y las 100
 *    avanzan a la vez.
 *
 * Se escribe a medida en lugar de usar p-queue o Bottleneck porque ninguno
 * soporta buckets jerarquicos -por clave y global- con pausa selectiva ante un
 * 429. Es el corazon del producto y conviene tenerlo testeado por nosotros.
 */
import {
  CONCURRENCIA_MAXIMA,
  LIMITE_CUENTA_POR_SEGUNDO,
  LIMITE_GLOBAL_POR_SEGUNDO,
  PENALIZACION_429_MS,
  RAFAGA_CUENTA,
  RAFAGA_GLOBAL
} from '@shared/constants';

/**
 * Bucket de tokens que se rellena solo.
 *
 * Se rellena por tiempo transcurrido en lugar de con un temporizador: sin
 * `setInterval` corriendo, el estado es una funcion pura del reloj y las
 * pruebas no dependen de esperas reales.
 */
export class BucketTokens {
  private tokens: number;
  private ultimoRelleno: number;
  /** Instante hasta el que el bucket esta penalizado por un 429. */
  private pausadoHasta = 0;

  private readonly capacidad: number;
  private readonly tasaPorSegundo: number;
  private readonly ahora: () => number;

  constructor(capacidad: number, tasaPorSegundo: number, ahora: () => number) {
    this.capacidad = capacidad;
    this.tasaPorSegundo = tasaPorSegundo;
    this.ahora = ahora;
    this.tokens = capacidad;
    this.ultimoRelleno = ahora();
  }

  /**
   * Acumula tokens por el tiempo transcurrido.
   *
   * El reloj de relleno arranca en `pausadoHasta`, no en el ultimo relleno: si
   * el bucket acumulara durante la penalizacion, al terminar los 5 segundos de
   * un 429 estaria lleno y soltaria una rafaga de 40 peticiones de golpe, que
   * es exactamente lo que provoco el 429. La penalizacion tiene que costar el
   * cupo, no solo la espera.
   */
  private rellenar(): void {
    const t = this.ahora();
    const desde = Math.max(this.ultimoRelleno, this.pausadoHasta);
    const transcurrido = t - desde;
    if (transcurrido <= 0) return;
    this.tokens = Math.min(
      this.capacidad,
      this.tokens + (transcurrido / 1_000) * this.tasaPorSegundo
    );
    this.ultimoRelleno = t;
  }

  /** `true` si hay token disponible y el bucket no esta penalizado. */
  hayToken(): boolean {
    if (this.ahora() < this.pausadoHasta) return false;
    this.rellenar();
    return this.tokens >= 1;
  }

  /** Retira un token. Solo debe llamarse tras comprobar `hayToken()`. */
  consumir(): void {
    this.rellenar();
    this.tokens -= 1;
  }

  /** Milisegundos hasta que haya token. `0` si ya lo hay. */
  esperaMs(): number {
    const t = this.ahora();
    const porPausa = Math.max(0, this.pausadoHasta - t);
    this.rellenar();
    const porTokens =
      this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.tasaPorSegundo) * 1_000);
    return Math.max(porPausa, porTokens);
  }

  /**
   * Penaliza el bucket tras un 429.
   *
   * Ademas de esperar, se vacia: si el exchange dice que vamos rapido, seguir
   * con los tokens acumulados es insistir en el error.
   */
  penalizar(ms: number): void {
    this.pausadoHasta = Math.max(this.pausadoHasta, this.ahora() + ms);
    this.tokens = 0;
    this.ultimoRelleno = this.ahora();
  }

  get penalizado(): boolean {
    return this.ahora() < this.pausadoHasta;
  }

  get disponibles(): number {
    this.rellenar();
    return Math.floor(this.tokens);
  }
}

export interface OpcionesLimitador {
  limiteGlobalPorSegundo?: number;
  limiteCuentaPorSegundo?: number;
  rafagaGlobal?: number;
  rafagaCuenta?: number;
  concurrenciaMaxima?: number;
  /** Reloj. Se inyecta en las pruebas. */
  ahora?: () => number;
  /** Espera. Se inyecta en las pruebas para no depender de tiempo real. */
  dormir?: (ms: number) => Promise<void>;
}

export interface DiagnosticoLimitador {
  enCola: number;
  enVuelo: number;
  tokensGlobales: number;
  globalPenalizado: boolean;
  cuentasPenalizadas: string[];
}

interface Esperando {
  clave: string;
  resolver: () => void;
}

const dormirReal = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

/**
 * Limitador jerarquico: un bucket global de IP y uno por cuenta.
 *
 * Uso normal:
 *
 * ```ts
 * const resultado = await limitador.ejecutar(uid, () => cliente.peticionFirmada(...));
 * ```
 *
 * `ejecutar` libera el hueco de concurrencia aunque la peticion falle, y
 * traduce un 429 en penalizacion de los buckets implicados.
 */
export class LimitadorPeticiones {
  private readonly global: BucketTokens;
  private readonly porCuenta = new Map<string, BucketTokens>();
  private readonly cola: Esperando[] = [];
  private enVuelo = 0;
  private bombeando = false;

  private readonly limiteCuenta: number;
  private readonly rafagaCuenta: number;
  private readonly concurrencia: number;
  private readonly ahora: () => number;
  private readonly dormir: (ms: number) => Promise<void>;

  constructor(opciones: OpcionesLimitador = {}) {
    this.ahora = opciones.ahora ?? Date.now;
    this.dormir = opciones.dormir ?? dormirReal;
    this.limiteCuenta = opciones.limiteCuentaPorSegundo ?? LIMITE_CUENTA_POR_SEGUNDO;
    this.rafagaCuenta = opciones.rafagaCuenta ?? RAFAGA_CUENTA;
    this.concurrencia = opciones.concurrenciaMaxima ?? CONCURRENCIA_MAXIMA;
    this.global = new BucketTokens(
      opciones.rafagaGlobal ?? RAFAGA_GLOBAL,
      opciones.limiteGlobalPorSegundo ?? LIMITE_GLOBAL_POR_SEGUNDO,
      this.ahora
    );
  }

  private bucketDe(clave: string): BucketTokens {
    let b = this.porCuenta.get(clave);
    if (b === undefined) {
      b = new BucketTokens(this.rafagaCuenta, this.limiteCuenta, this.ahora);
      this.porCuenta.set(clave, b);
    }
    return b;
  }

  /**
   * Espera hasta tener permiso para lanzar una peticion de esa cuenta.
   *
   * Hay que llamar a `liberar()` cuando la peticion termine, pase lo que pase.
   * `ejecutar()` lo hace por su cuenta y es la forma recomendada.
   */
  adquirir(clave: string): Promise<void> {
    return new Promise<void>((resolver) => {
      this.cola.push({ clave, resolver });
      void this.bombear();
    });
  }

  /** Devuelve el hueco de concurrencia. */
  liberar(): void {
    this.enVuelo = Math.max(0, this.enVuelo - 1);
    void this.bombear();
  }

  /**
   * Bombea la cola.
   *
   * FIFO **entre los que pueden salir**, no FIFO ciega. La diferencia importa:
   * si la cuenta que va primera acaba de comerse un 429, su bucket queda
   * penalizado 5 segundos; con FIFO estricta esas 99 cuentas que si tienen
   * cupo se quedarian paradas detras de ella. Se recorre la cola en orden y
   * sale la primera que puede, que en el caso normal -nadie penalizado- es
   * exactamente la cabeza.
   */
  private async bombear(): Promise<void> {
    if (this.bombeando) return;
    this.bombeando = true;

    try {
      while (this.cola.length > 0 && this.enVuelo < this.concurrencia) {
        /* Sin cupo global no sale nadie, sea cual sea su cuenta. */
        if (!this.global.hayToken()) {
          await this.dormir(Math.max(1, this.global.esperaMs()));
          continue;
        }

        const indice = this.cola.findIndex((e) => this.bucketDe(e.clave).hayToken());

        if (indice === -1) {
          /* Hay cupo global, pero ninguna cuenta lo tiene. Espera la mas proxima. */
          const esperas = this.cola.map((e) => this.bucketDe(e.clave).esperaMs());
          await this.dormir(Math.max(1, Math.min(...esperas)));
          continue;
        }

        const elegido = this.cola[indice];
        if (elegido === undefined) continue;

        /* Los dos, o ninguno: consumir uno solo desperdiciaria cupo. */
        this.global.consumir();
        this.bucketDe(elegido.clave).consumir();
        this.cola.splice(indice, 1);
        this.enVuelo += 1;
        elegido.resolver();
      }
    } finally {
      this.bombeando = false;
    }
  }

  /**
   * Ejecuta una peticion respetando los limites.
   *
   * Ante un 429 penaliza los buckets implicados y propaga el error: decidir si
   * se reintenta no es competencia del limitador, sino de la politica de
   * reintento del lote. docs/01 seccion 9.
   */
  async ejecutar<T>(clave: string, tarea: () => Promise<T>): Promise<T> {
    await this.adquirir(clave);
    try {
      return await tarea();
    } catch (e) {
      if (esError429(e)) this.registrar429(clave, extraerRetryAfterMs(e));
      throw e;
    } finally {
      this.liberar();
    }
  }

  /**
   * Aplica la penalizacion de un 429.
   *
   * Penaliza los dos buckets: no se puede saber cual de los dos techos se
   * cruzo, y equivocarse hacia el lado permisivo cuesta cinco minutos de
   * bloqueo del exchange.
   */
  registrar429(clave: string, retryAfterMs: number | null): void {
    const ms = retryAfterMs ?? PENALIZACION_429_MS;
    this.global.penalizar(ms);
    this.bucketDe(clave).penalizar(ms);
  }

  diagnostico(): DiagnosticoLimitador {
    const penalizadas: string[] = [];
    for (const [clave, bucket] of this.porCuenta) {
      if (bucket.penalizado) penalizadas.push(clave);
    }
    return {
      enCola: this.cola.length,
      enVuelo: this.enVuelo,
      tokensGlobales: this.global.disponibles,
      globalPenalizado: this.global.penalizado,
      cuentasPenalizadas: penalizadas
    };
  }
}

/* ---------- ayudas ---------- */

function esError429(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const codigo = (e as { codigo?: unknown }).codigo;
  const http = (e as { httpStatus?: unknown }).httpStatus;
  return codigo === '429' || http === 429;
}

function extraerRetryAfterMs(e: unknown): number | null {
  if (typeof e !== 'object' || e === null) return null;
  const ms = (e as { reintentarEnMs?: unknown }).reintentarEnMs;
  return typeof ms === 'number' && Number.isFinite(ms) ? ms : null;
}
