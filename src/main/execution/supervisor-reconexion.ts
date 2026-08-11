/**
 * Supervisor de reconexion: lo que convierte el backoff en reintentos de verdad.
 *
 * `RegistroConexiones` sabe **cuando** habria que reintentar cada cuenta
 * -`proximoIntento`, con backoff exponencial y jitter-, pero no reintenta nada:
 * es un registro, no hace peticiones, y por eso se prueba entero sin red. Sin
 * alguien que lea ese calculo y actue, una cuenta que pierde conexion se queda
 * esperando un reintento que no llega nunca y solo vuelve si el operador le da
 * al boton. Esta clase es ese alguien.
 *
 * --------------------------------------------------------------------------
 * Por que un temporizador que se reprograma y no un `setInterval`
 * --------------------------------------------------------------------------
 * Con `setInterval`, un ciclo que tarde mas que el intervalo -100 cuentas
 * esperando turno en el limitador- se solapa con el siguiente, y las mismas
 * cuentas se reintentan dos veces en paralelo. Aqui cada ciclo programa el
 * siguiente **al terminar**: no hay solapamiento posible, y el ritmo se degrada
 * solo cuando el exchange va lento, que es justo cuando conviene bajar el ritmo.
 *
 * --------------------------------------------------------------------------
 * Que NO hace
 * --------------------------------------------------------------------------
 * No decide si una cuenta esta viva ni cuanto esperar: eso es de
 * `RegistroConexiones`. No conoce el vault ni las credenciales. Solo pregunta
 * «¿quien vence?», llama a quien sabe verificar, y se aparta. RNF-004.
 */
import { REINTENTO_CONCURRENCIA, REINTENTO_TICK_MS } from '@shared/constants';

/**
 * Lo que el supervisor necesita del resto del sistema.
 *
 * Es deliberadamente estrecho: tres metodos, ningun secreto y ningun tipo de
 * Bitget. `Sesion` lo implementa, y una prueba puede implementarlo con tres
 * funciones sin montar vault, cliente ni exchange.
 */
export interface FuenteReintentos {
  /** Cuentas cuyo `proximoIntento` ya vencio. Las invalidas nunca salen aqui. */
  pendientesDeReintento(): string[];
  /** Vuelve a preguntar a Bitget por una credencial ya guardada. */
  verificar(cuentaId: string): Promise<unknown>;
  /**
   * `false` con el panel bloqueado.
   *
   * Sin vault abierto no hay credenciales que probar, y llamar a `verificar`
   * lanzaria. El supervisor sigue latiendo -no se detiene al bloquear- pero no
   * toca nada hasta que se vuelve a abrir.
   */
  operativa(): boolean;
}

export interface OpcionesSupervisor {
  intervaloMs?: number;
  concurrenciaMaxima?: number;
  /** Se inyectan en las pruebas para no depender de relojes reales. */
  programar?: (fn: () => void, ms: number) => unknown;
  cancelar?: (id: unknown) => void;
  /**
   * Aviso de que un reintento reventó por una via que no es un veredicto.
   *
   * `verificar` ya devuelve el fallo de credencial como resultado, asi que aqui
   * solo llega lo inesperado: el panel se bloqueo a mitad del reintento, o el
   * proceso se esta cerrando. Se notifica en vez de tragarselo en silencio,
   * pero nunca detiene el supervisor: una cuenta rota no puede parar las otras
   * 99.
   */
  alFallar?: (cuentaId: string, error: unknown) => void;
}

export class SupervisorReconexion {
  private readonly fuente: FuenteReintentos;
  private readonly intervaloMs: number;
  private readonly concurrenciaMaxima: number;
  private readonly programar: (fn: () => void, ms: number) => unknown;
  private readonly cancelar: (id: unknown) => void;
  private readonly alFallar: (cuentaId: string, error: unknown) => void;

  /**
   * Cuentas con un reintento en curso.
   *
   * `marcarConectando` no borra `proximoIntento`, asi que una cuenta sigue
   * apareciendo como vencida mientras se la esta verificando. Sin este conjunto,
   * un ciclo que tarde mas que el intervalo lanzaria un segundo reintento sobre
   * una cuenta que ya tiene uno en vuelo, y ambos gastarian cupo para responder
   * lo mismo.
   */
  private readonly enVuelo = new Set<string>();
  private temporizador: unknown = null;
  private encendido = false;

  constructor(fuente: FuenteReintentos, opciones: OpcionesSupervisor = {}) {
    this.fuente = fuente;
    this.intervaloMs = opciones.intervaloMs ?? REINTENTO_TICK_MS;
    this.concurrenciaMaxima = opciones.concurrenciaMaxima ?? REINTENTO_CONCURRENCIA;
    this.programar = opciones.programar ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancelar = opciones.cancelar ?? ((id) => clearTimeout(id as NodeJS.Timeout));
    this.alFallar = opciones.alFallar ?? (() => undefined);
  }

  get estaEncendido(): boolean {
    return this.encendido;
  }

  /** Cuentas con un reintento en vuelo ahora mismo. Para pruebas y diagnostico. */
  get enCurso(): string[] {
    return [...this.enVuelo];
  }

  /** Arranca el latido. Llamarlo dos veces no crea dos temporizadores. */
  iniciar(): void {
    if (this.encendido) return;
    this.encendido = true;
    this.dormir();
  }

  /**
   * Para el latido.
   *
   * No espera a los reintentos en vuelo: sus promesas ya estan protegidas y, al
   * cerrarse el proceso, lo que devuelvan da igual. Lo que si garantiza es que
   * no se programa ningun ciclo mas.
   */
  detener(): void {
    this.encendido = false;
    if (this.temporizador !== null) {
      this.cancelar(this.temporizador);
      this.temporizador = null;
    }
  }

  private dormir(): void {
    if (!this.encendido) return;
    this.temporizador = this.programar(() => {
      this.temporizador = null;
      void this.ciclo().finally(() => this.dormir());
    }, this.intervaloMs);
  }

  /**
   * Un ciclo: mira quien vence y reintenta hasta el tope de concurrencia.
   *
   * Es publico a proposito. Las pruebas lo llaman directamente y comprueban el
   * comportamiento sin temporizadores de por medio; el latido solo decide
   * cuando se invoca, no que hace.
   */
  async ciclo(): Promise<void> {
    if (!this.fuente.operativa()) return;

    const vencidas = this.fuente
      .pendientesDeReintento()
      .filter((id) => !this.enVuelo.has(id))
      .slice(0, Math.max(0, this.concurrenciaMaxima - this.enVuelo.size));

    if (vencidas.length === 0) return;

    await Promise.all(vencidas.map((id) => this.reintentar(id)));
  }

  private async reintentar(cuentaId: string): Promise<void> {
    this.enVuelo.add(cuentaId);
    try {
      await this.fuente.verificar(cuentaId);
    } catch (e) {
      this.alFallar(cuentaId, e);
    } finally {
      this.enVuelo.delete(cuentaId);
    }
  }
}
