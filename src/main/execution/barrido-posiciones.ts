/**
 * Barrido REST de posiciones y saldos: lo que llena el Centro de Monitoreo.
 *
 * Cada cuenta se relee cada `RECONCILIACION_MS` con jitter, y lo leido se
 * aplica al `AlmacenPosiciones`. Es la fuente de datos del monitor hasta que
 * exista el socket, y despues sigue siendo la red de seguridad que lo corrige:
 * ante una divergencia **gana REST**, y la divergencia se anota.
 * docs/01-stack-tecnologico.md seccion 8.
 *
 * --------------------------------------------------------------------------
 * Por que el saldo se lee aqui y no por el socket
 * --------------------------------------------------------------------------
 * Hasta el 29/08/2026 el saldo solo se refrescaba al verificar la credencial
 * -al reconectar o al pulsar «Probar»-, tal como se entrego en la Fase 3. Eso
 * dejaba la matriz enseñando un saldo viejo indefinidamente: mover dinero entre
 * cuentas desde la web de Bitget no cambiaba nada en pantalla hasta que alguien
 * pulsaba un boton.
 *
 * Podria parecer trabajo del socket, y no lo es: el pool se suscribe a
 * `positions` y `orders-algo` -ver ws/conexion.ts- y **no** al canal `account`,
 * que es por donde Bitget empuja los cambios de saldo. El saldo es REST, y este
 * barrido ya pasa por cada cuenta con su credencial en la mano.
 *
 * --------------------------------------------------------------------------
 * Por que se empieza por aqui y no por el socket
 * --------------------------------------------------------------------------
 * El barrido hay que escribirlo de todos modos -sin el, un evento perdido deja
 * una posicion fantasma en pantalla para siempre- y da la foto completa desde
 * el primer dia. Con el puesto, el socket solo tiene que bajar la latencia de
 * 45 segundos a instantanea, y llega teniendo contra que contrastar cada campo:
 * si el push dice una cosa y el barrido otra, se sabe en el mismo minuto y no
 * con dinero de por medio.
 *
 * --------------------------------------------------------------------------
 * El coste, en peticiones
 * --------------------------------------------------------------------------
 * Cien cuentas cada 45 s son ~2,2 barridos por segundo. Cada uno gasta **dos**
 * peticiones -posiciones y saldo-, y tres cuando la cuenta tiene posiciones: el
 * Take Profit se consulta aparte -no viaja con la posicion- y preguntarlo para
 * una cuenta vacia seria gastar cupo en una lista que se sabe vacia. En el peor
 * caso son 6,6 req/s contra un presupuesto de 40.
 *
 * El techo del panel son 300 subcuentas -quince cuentas madre por veinte-, y
 * ahi la cuenta sale a 13,3-20 req/s: cabe, pero se come la mitad del
 * presupuesto. La salida barata esta anotada y no se toma todavia porque le
 * falta un requisito: la clave de la cuenta madre lee el saldo de **todas** sus
 * subcuentas en una sola peticion -verificado, ver
 * docs/cotizacion-traspasos-entre-subcuentas.md seccion 3-, lo que dejaria las
 * 300 peticiones por ciclo en 15. Hoy el panel no tiene alta para esa clave: el
 * formulario solo admite subcuentas.
 *
 * Nada de esto necesita tocar el limitador: `ClienteBitget` ya mete cada
 * peticion firmada en el bucket de su credencial.
 *
 * --------------------------------------------------------------------------
 * Que NO hace
 * --------------------------------------------------------------------------
 * No sabe de vault ni de registro de cuentas: pide a `FuenteBarrido` quien hay
 * que barrer y le devuelve el desenlace. No decide si una cuenta esta viva
 * -eso es de `RegistroConexiones`- ni que se dibuja -eso es del almacen-.
 */
import {
  RECONCILIACION_CONCURRENCIA,
  RECONCILIACION_JITTER,
  RECONCILIACION_MS,
  RECONCILIACION_TICK_MS
} from '@shared/constants';
import type { ModoMargen, Posicion } from '@shared/types';
import type { Mercado } from '../bitget/mercado';
import type { ClienteBitget } from '../bitget/rest/client';
import type { Credencial } from '../bitget/rest/signer';
import { obtenerCuentasFuturos } from '../bitget/rest/endpoints/cuenta';
import { obtenerPosiciones, type PosicionBitget } from '../bitget/rest/endpoints/posiciones';
import { buscarTakeProfit, planesPendientes } from '../bitget/rest/endpoints/tpsl';
import type { AlmacenPosiciones, Deriva } from '../domain/almacen-posiciones';

/** Una cuenta que se puede consultar ahora mismo. */
export interface CuentaBarrible {
  cuentaId: string;
  credencial: Credencial;
}

export type ResultadoLectura =
  | { ok: true; latenciaMs: number }
  | { ok: false; error: unknown };

/**
 * Lo que el barrido necesita del resto del sistema.
 *
 * Deliberadamente estrecho, como `FuenteReintentos`: tres metodos, ningun tipo
 * de Bitget salvo la credencial que hay que firmar, y una prueba lo implementa
 * con tres funciones sin montar vault ni registro.
 */
export interface FuenteBarrido {
  /**
   * Las cuentas que merece la pena consultar, con su credencial.
   *
   * Quien lo implementa deja fuera las que no tienen credencial y las que
   * Bitget rechazo definitivamente: releerlas cada 45 segundos gastaria cupo
   * para recibir el mismo rechazo hasta que alguien corrija la clave.
   */
  cuentasBarribles(): CuentaBarrible[];
  /** `false` con el panel bloqueado. Sin vault no hay credenciales que usar. */
  operativa(): boolean;
  /** Desenlace de la lectura, para el estado de conexion de esa cuenta. */
  registrarLectura(cuentaId: string, resultado: ResultadoLectura): void;
  /**
   * El disponible que acaba de leer el barrido, ya en la moneda del mercado.
   *
   * Se pasa como cadena y no como numero a proposito: es lo que devuelve
   * Bitget, es lo que guarda la sesion y es lo que pinta la matriz. Convertirlo
   * a `number` aqui para volver a formatearlo despues solo añadiria una ocasion
   * de perder precision en un importe.
   */
  registrarSaldo(cuentaId: string, disponible: string): void;
  /**
   * Divergencias entre lo que habia en memoria y lo que dijo el exchange.
   *
   * Opcional porque el barrido funciona igual sin escucharlas. Deja de serlo
   * cuando exista el socket: entonces cada deriva es el sintoma de un push mal
   * aplicado, y sin registrarlas el fallo es invisible.
   */
  registrarDeriva?(derivas: readonly Deriva[]): void;
}

export interface OpcionesBarrido {
  intervaloMs?: number;
  tickMs?: number;
  concurrenciaMaxima?: number;
  ahora?: () => number;
  /** Aleatoriedad del jitter. Se inyecta para hacer deterministas las pruebas. */
  azar?: () => number;
  programar?: (fn: () => void, ms: number) => unknown;
  cancelar?: (id: unknown) => void;
}

/** `isolated`/`crossed` de Bitget al vocabulario del dominio. */
function modoMargenDe(valor: string | null | undefined): ModoMargen {
  return valor === 'crossed' ? 'cruzado' : 'aislado';
}

/**
 * Una posicion de Bitget en la del dominio.
 *
 * Los campos que Bitget declara opcionales salen como cadena vacia y no como
 * cero: la pantalla enseña un guion ante una cadena que no es un numero, y esa
 * es la lectura correcta. Un cero en el precio de liquidacion se leeria como
 * «liquida en 0», que es justo lo contrario de «no se sabe».
 *
 * El Take Profit sale `null` a proposito aunque la posicion lo tenga: no viaja
 * en esta respuesta, y lo pone `leerTakeProfit` un instante despues.
 */
function aPosicionDominio(cuentaId: string, cruda: PosicionBitget, instante: string): Posicion {
  return {
    cuentaId,
    simbolo: cruda.symbol,
    lado: cruda.holdSide.toLowerCase() === 'short' ? 'short' : 'long',
    tamano: cruda.total,
    precioEntrada: cruda.openPriceAvg ?? '',
    precioLiquidacion: cruda.liquidationPrice ?? '',
    apalancamiento: Number(cruda.leverage ?? 0),
    modoMargen: modoMargenDe(cruda.marginMode),
    margen: cruda.marginSize ?? '',
    pnl: cruda.unrealizedPL ?? '',
    takeProfit: null,
    origen: 'rest',
    actualizadoEn: instante,
    estado: 'viva'
  };
}

export class BarridoPosiciones {
  private readonly cliente: ClienteBitget;
  private readonly mercado: Mercado;
  private readonly almacen: AlmacenPosiciones;
  private readonly fuente: FuenteBarrido;

  private readonly intervaloMs: number;
  private readonly tickMs: number;
  private readonly concurrencia: number;
  private readonly ahora: () => number;
  private readonly azar: () => number;
  private readonly programar: (fn: () => void, ms: number) => unknown;
  private readonly cancelar: (id: unknown) => void;

  /** Instante en que a cada cuenta le toca la proxima lectura. */
  private readonly proximaLectura = new Map<string, number>();
  /** Cuentas con un barrido en curso. Impide que una cuenta lenta se solape consigo misma. */
  private readonly enVuelo = new Set<string>();
  private temporizador: unknown = null;
  private encendido = false;

  constructor(
    cliente: ClienteBitget,
    mercado: Mercado,
    almacen: AlmacenPosiciones,
    fuente: FuenteBarrido,
    opciones: OpcionesBarrido = {}
  ) {
    this.cliente = cliente;
    this.mercado = mercado;
    this.almacen = almacen;
    this.fuente = fuente;
    this.intervaloMs = opciones.intervaloMs ?? RECONCILIACION_MS;
    this.tickMs = opciones.tickMs ?? RECONCILIACION_TICK_MS;
    this.concurrencia = opciones.concurrenciaMaxima ?? RECONCILIACION_CONCURRENCIA;
    this.ahora = opciones.ahora ?? Date.now;
    this.azar = opciones.azar ?? Math.random;
    this.programar = opciones.programar ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancelar = opciones.cancelar ?? ((id) => clearTimeout(id as NodeJS.Timeout));
  }

  get estaEncendido(): boolean {
    return this.encendido;
  }

  /** Cuentas con un barrido en vuelo ahora mismo. Para pruebas y diagnostico. */
  get enCurso(): string[] {
    return [...this.enVuelo];
  }

  iniciar(): void {
    if (this.encendido) return;
    this.encendido = true;
    this.dormir();
    this.bombear();
  }

  /**
   * Para el latido.
   *
   * No espera a los barridos en vuelo: sus promesas ya estan protegidas y lo
   * que devuelvan al cerrarse el proceso da igual. Lo que si garantiza es que
   * no se programa ningun ciclo mas.
   */
  detener(): void {
    this.encendido = false;
    if (this.temporizador !== null) {
      this.cancelar(this.temporizador);
      this.temporizador = null;
    }
  }

  /**
   * Adelanta la proxima lectura de unas cuentas concretas.
   *
   * --------------------------------------------------------------------------
   * Para que existe
   * --------------------------------------------------------------------------
   * Un lote acaba de mover dinero y posiciones en esas cuentas, y esperar a que
   * les toque su turno dejaria la matriz enseñando el saldo de antes de abrir
   * durante casi un minuto -justo cuando el operador esta mirando el informe
   * para comprobar que salio bien-. Se les vence la cita y el siguiente tick,
   * como mucho un segundo despues, las coge.
   *
   * No lee nada por su cuenta ni salta la cola: pasa por `bombear`, con su tope
   * de concurrencia y su limitador. Cien cuentas adelantadas no son cien
   * peticiones de golpe, son la misma cola de siempre servida antes.
   */
  adelantar(cuentaIds: readonly string[]): void {
    for (const id of cuentaIds) this.proximaLectura.delete(id);
    this.bombear();
  }

  private dormir(): void {
    if (!this.encendido) return;
    this.temporizador = this.programar(() => {
      this.temporizador = null;
      this.bombear();
      this.dormir();
    }, this.tickMs);
  }

  /**
   * Arranca los barridos que toquen, hasta el tope de concurrencia.
   *
   * Se llama desde el latido **y** al terminar cada barrido. Lo segundo es lo
   * que hace que la primera pasada no tarde una eternidad: con cien cuentas
   * vencidas a la vez, esperar al siguiente tick para lanzar las dos siguientes
   * convertiria un arranque de quince segundos en uno de cincuenta. Al
   * encadenarlos, el tope de concurrencia se comporta como el escalonado que
   * pide docs/01 seccion 8, sin un segundo temporizador que lo reparta.
   */
  private bombear(): void {
    if (!this.encendido) return;

    if (!this.fuente.operativa()) {
      /*
       * Con el panel bloqueado el calendario deja de valer, y se tira aqui en
       * vez de en un metodo que alguien tenga que acordarse de llamar.
       *
       * Conservarlo tendria un efecto raro de explicar: una cuenta barrida un
       * segundo antes de bloquear esperaria 44 segundos despues de desbloquear,
       * con su fila ausente del monitor mientras tanto, y otra barrida 44
       * segundos antes apareceria enseguida. El operador veria el monitor
       * llenarse a trozos sin ningun motivo visible.
       */
      this.proximaLectura.clear();
      return;
    }

    /*
     * La lista se pide una vez, no una por hueco: quien la implementa recorre
     * el registro de cuentas entero y consulta el vault por cada una.
     */
    const candidatas = this.fuente.cuentasBarribles();

    while (this.enVuelo.size < this.concurrencia) {
      const cuenta = this.siguienteVencida(candidatas);
      if (cuenta === null) return;
      void this.barrerCuenta(cuenta);
    }
  }

  /**
   * La cuenta que lleva mas tiempo vencida, o `null` si no vence ninguna.
   *
   * Se elige la mas antigua y no la primera de la lista para que ninguna se
   * quede atras: con cien cuentas y dos huecos, recorrer siempre en orden de
   * registro haria que las ultimas esperasen detras de las primeras en cada
   * pasada. Una cuenta nueva vence de inmediato -no tiene fecha- y por eso
   * entra en la siguiente ronda sin esperar el intervalo entero.
   */
  private siguienteVencida(candidatas: readonly CuentaBarrible[]): CuentaBarrible | null {
    const t = this.ahora();
    let elegida: CuentaBarrible | null = null;
    let masAntigua = Number.POSITIVE_INFINITY;

    for (const cuenta of candidatas) {
      if (this.enVuelo.has(cuenta.cuentaId)) continue;
      const vence = this.proximaLectura.get(cuenta.cuentaId) ?? 0;
      if (vence > t || vence >= masAntigua) continue;
      masAntigua = vence;
      elegida = cuenta;
    }

    /* Reservar el hueco ya: `bombear` gira otra vez antes de que arranque. */
    if (elegida !== null) this.enVuelo.add(elegida.cuentaId);
    return elegida;
  }

  /** Intervalo con jitter, para que las cuentas no se vuelvan a sincronizar. */
  private proximoIntervalo(): number {
    const desviacion = this.intervaloMs * RECONCILIACION_JITTER;
    return Math.max(this.tickMs, Math.round(this.intervaloMs + desviacion * (this.azar() * 2 - 1)));
  }

  /**
   * Lee una cuenta y aplica lo leido.
   *
   * Publico a proposito, como `SupervisorReconexion.ciclo`: las pruebas lo
   * llaman directamente y comprueban el comportamiento sin temporizadores de
   * por medio. El latido solo decide cuando se invoca, no que hace.
   */
  async barrerCuenta(cuenta: CuentaBarrible): Promise<void> {
    this.enVuelo.add(cuenta.cuentaId);
    const inicio = this.ahora();

    try {
      const respuesta = await obtenerPosiciones(this.cliente, cuenta.credencial, this.mercado);
      const instante = new Date(this.ahora()).toISOString();
      const posiciones = respuesta.datos.map((cruda) =>
        aPosicionDominio(cuenta.cuentaId, cruda, instante)
      );

      /*
       * La foto se aplica **solo si la lectura salio bien**.
       *
       * Es la trampa de este modulo: `aplicarInstantanea` con una lista vacia
       * significa «esta cuenta no tiene nada abierto», asi que aplicarla
       * despues de un fallo de red borraria del monitor posiciones que siguen
       * abiertas. Por eso el catch no toca el almacen: una cuenta que no
       * responde conserva sus ultimos datos y se marca sin conexion, que es lo
       * que el operador necesita distinguir.
       */
      const derivas = this.almacen.aplicarInstantanea(cuenta.cuentaId, posiciones);
      if (derivas.length > 0) this.fuente.registrarDeriva?.(derivas);

      if (posiciones.length > 0) await this.leerTakeProfit(cuenta, posiciones);
      await this.leerSaldo(cuenta);

      this.fuente.registrarLectura(cuenta.cuentaId, { ok: true, latenciaMs: this.ahora() - inicio });
    } catch (error) {
      this.fuente.registrarLectura(cuenta.cuentaId, { ok: false, error });
    } finally {
      this.enVuelo.delete(cuenta.cuentaId);
      this.proximaLectura.set(cuenta.cuentaId, this.ahora() + this.proximoIntervalo());
      this.bombear();
    }
  }

  /**
   * El saldo disponible de la cuenta, en la moneda de margen del mercado.
   *
   * --------------------------------------------------------------------------
   * Se traga su propio error, y es deliberado
   * --------------------------------------------------------------------------
   * Es la unica lectura del ciclo que no puede tumbarlo. Las posiciones y el
   * Take Profit dicen que se dibuja en el monitor; el saldo es un numero de la
   * matriz que, si falla, se queda en el ultimo conocido durante 45 segundos
   * mas. Dejar que su fallo saliera al `catch` de `barrerCuenta` haria dos
   * cosas peores: descartaria la foto de posiciones que ya se habia leido bien
   * -no se aplica, porque el catch no toca el almacen- y sumaria un fallo hacia
   * `FALLOS_PARA_DESCONECTAR`, pintando en rojo una cuenta que responde.
   *
   * `/api/v2/mix/account/accounts` devuelve una entrada por moneda de margen y
   * se filtra por la del mercado: en el simulado el margen es `SUSDT`, y coger
   * la primera entrada guardaria el saldo de otra moneda como si fuera este.
   * Si la moneda no aparece no se escribe nada, que es distinto de escribir 0.
   */
  private async leerSaldo(cuenta: CuentaBarrible): Promise<void> {
    try {
      const respuesta = await obtenerCuentasFuturos(
        this.cliente,
        cuenta.credencial,
        this.mercado.productType
      );
      const propia = respuesta.datos.find((c) => c.marginCoin === this.mercado.marginCoin);
      if (propia !== undefined) this.fuente.registrarSaldo(cuenta.cuentaId, propia.available);
    } catch {
      /* El saldo viejo sigue siendo mejor dato que ninguno. Se reintenta solo. */
    }
  }

  /**
   * El Take Profit de cada punta viva de la cuenta.
   *
   * Una sola peticion trae los planes de todos los simbolos, asi que cuesta lo
   * mismo una posicion que ocho.
   *
   * Se fija tambien cuando **no** hay plan, con `null`: si el operador quito el
   * Take Profit desde la app de Bitget, no llega ningun aviso y la unica forma
   * de enterarse es que deje de aparecer en esta lista. Sin ese `null`, el
   * panel seguiria enseñando un precio de disparo que ya no protege nada.
   */
  private async leerTakeProfit(cuenta: CuentaBarrible, posiciones: readonly Posicion[]): Promise<void> {
    const planes = await planesPendientes(this.cliente, cuenta.credencial, this.mercado);

    for (const posicion of posiciones) {
      const plan = buscarTakeProfit(planes, posicion.simbolo, posicion.lado);
      const precio = plan?.triggerPrice ?? null;

      this.almacen.fijarTakeProfit(
        cuenta.cuentaId,
        posicion.simbolo,
        posicion.lado,
        precio === null
          ? null
          : {
              precio,
              /*
               * El exchange no sabe con que porcentaje se aprobo: solo tiene el
               * precio de disparo. El almacen conserva el porcentaje que ya
               * supiera para este mismo precio, que es como sobrevive el dato
               * del formulario a la primera relectura.
               */
              porcentaje: null,
              planId: plan?.orderId ?? ''
            }
      );
    }
  }
}
