/**
 * Almacen de posiciones vivas.
 *
 * Es la fuente de verdad de lo que dibuja el Centro de Monitoreo. No hace
 * peticiones y no tiene temporizadores: recibe lo que leen otros -el barrido
 * REST y, mas adelante, el socket- y decide que queda vivo. Por eso se prueba
 * entero sin red y sin relojes reales, igual que `RegistroConexiones`.
 *
 * --------------------------------------------------------------------------
 * Dos mitades por posicion, y solo una la sabe Bitget
 * --------------------------------------------------------------------------
 * Lo que el exchange devuelve -entrada, liquidacion, tamano, margen actual- es
 * `Posicion`, y se sustituye entero cada vez que llega una lectura nueva.
 *
 * Lo que **solo sabe el panel** va aparte, en `AporteDelPanel`: el margen
 * inicial acumulado que el operador aprobo, apertura por apertura. Bitget no
 * lo tiene -su `marginSize` es el margen de ahora, con el adicional dentro y
 * moviendose solo- y por eso no se puede recalcular a partir de una lectura.
 * Vive en un mapa propio, con la misma clave, y sobrevive a las lecturas del
 * exchange precisamente porque no viene de ellas.
 *
 * La consecuencia que hay que tener presente: una posicion abierta antes de
 * este arranque no tiene aporte y nunca lo va a tener. `margenInicial` sale
 * `null` y la pantalla enseña un guion, que es la verdad; inventarlo a partir
 * de `marginSize` seria ensenar como aprobado un numero que nadie aprobo.
 *
 * --------------------------------------------------------------------------
 * Instantanea y actualizacion no son lo mismo
 * --------------------------------------------------------------------------
 * `aplicarInstantanea` sustituye **todo** lo de esa cuenta: lo que no viene, se
 * cerro. Es lo que hace el barrido REST y lo que hara un push con
 * `action: "snapshot"`.
 *
 * `aplicarActualizacion` toca una sola posicion, y un tamano de cero es un
 * cierre, no una posicion vacia. Es lo que hara un push con `action: "update"`.
 *
 * Tratar un `update` como si fuera una foto completa borraria las demas
 * posiciones de la cuenta; tratar una foto como una serie de `update` dejaria
 * vivas las que ya se cerraron. docs/01-stack-tecnologico.md seccion 8.
 */
import Decimal from 'decimal.js';
import { clavePosicion, type Decimal as Cantidad, type Lado, type Posicion, type TakeProfit } from '@shared/types';

/**
 * Lo que el panel sabe de una posicion y el exchange no.
 *
 * `margenInicial` acumula la apertura y cada reposicionamiento, **sin** el
 * margen adicional: son dos cifras distintas y la columna del monitor pregunta
 * por la primera. `margenAdicional` se guarda aparte porque alimenta su propio
 * distintivo.
 */
export interface AporteDelPanel {
  /**
   * Suma de la apertura y los reposicionamientos aprobados en esta sesion.
   *
   * `null` mientras no se sepa. Ocurre en una posicion a la que se le agrego
   * margen pero cuya apertura no anoto nada, que es una combinacion posible
   * porque las dos cifras se registran en momentos distintos.
   */
  margenInicial: Cantidad | null;
  /** Margen adicional agregado por el panel, o `null` si no se agrego ninguno. */
  margenAdicional: Cantidad | null;
  /** Cuando el panel abrio esta punta. ISO 8601. */
  abiertaEn: string;
}

/** Una posicion viva con las dos mitades juntas, lista para proyectarse. */
export interface PosicionViva extends Posicion {
  /** `null` en una posicion que ya estaba abierta cuando arranco el panel. */
  aporte: AporteDelPanel | null;
}

/**
 * Una diferencia entre lo que habia en memoria y lo que dijo la lectura nueva.
 *
 * Se devuelve en vez de tragarse porque es el sintoma de un fallo de mezcla: si
 * aparece a menudo, hay un push que se esta aplicando mal. Quien llama la anota
 * en el log de sesion. docs/01 seccion 8, «incidente de deriva».
 */
export interface Deriva {
  cuentaId: string;
  simbolo: string;
  lado: Lado;
  /** `alta`, `cierre` o el nombre del campo que no coincidia. */
  campo: string;
  enMemoria: string;
  enLectura: string;
}

export interface OpcionesAlmacen {
  /** Reloj. Se inyecta en las pruebas. */
  ahora?: () => number;
}

/** Campos que se cotejan al aplicar una instantanea. Solo los que se dibujan. */
const CAMPOS_COTEJADOS = [
  ['tamano', (p: Posicion) => p.tamano],
  ['precioEntrada', (p: Posicion) => p.precioEntrada],
  ['precioLiquidacion', (p: Posicion) => p.precioLiquidacion],
  ['margen', (p: Posicion) => p.margen],
  ['apalancamiento', (p: Posicion) => String(p.apalancamiento)]
] as const;

/**
 * Campos que repintan la pantalla pero **no** son deriva.
 *
 * --------------------------------------------------------------------------
 * Por que existe esta segunda lista, y el fallo que arregla
 * --------------------------------------------------------------------------
 * `anunciar` solo dispara si hubo alta, cierre o deriva, y el P&L no estaba en
 * ninguna de las tres. En una posicion abierta y quieta lo unico que cambia
 * entre dos barridos es `unrealizedPL` -tamano, entrada y apalancamiento son
 * constantes, y el margen tambien en modo aislado-, asi que la lectura nueva se
 * guardaba en `vivas` y **no se emitia `monitor:posiciones`**: el dato quedaba
 * fresco en el proceso principal y viejo en pantalla. El operador veia el P&L y
 * el ROE congelados hasta que abria o cerraba algo, que es cuando por fin habia
 * deriva. Reportado por el cliente el 10/09/2026.
 *
 * No se arregla metiendo `pnl` en `CAMPOS_COTEJADOS` porque las dos listas
 * responden a preguntas distintas. Una deriva es el sintoma de un push mal
 * aplicado -memoria y exchange discrepan en algo que no deberia haber cambiado
 * solo- y se escribe en el log de sesion para poder investigarla. El P&L cambia
 * cada 45 segundos porque el precio se mueve: eso es su comportamiento normal, y
 * anotarlo como divergencia llenaria el log de ruido hasta ahogar las derivas de
 * verdad, que son justo lo que ese log existe para hacer visible.
 */
const CAMPOS_VOLATILES = [(p: Posicion) => p.pnl] as const;

/** `true` si el tamano de la posicion es cero: en Bitget eso es un cierre. */
function estaCerrada(tamano: Cantidad): boolean {
  const n = Number.parseFloat(tamano);
  return !Number.isFinite(n) || n <= 0;
}

export class AlmacenPosiciones {
  private readonly vivas = new Map<string, Posicion>();
  private readonly aportes = new Map<string, AporteDelPanel>();
  /**
   * Take Profit que llego antes que su posicion.
   *
   * El precio de disparo viene por un canal distinto al de posiciones -y en el
   * barrido REST, por una peticion distinta-, asi que puede adelantarse. Sin
   * este mapa se perderia y la columna diria «sin Take Profit» sobre una
   * posicion que si lo tiene, que es exactamente el fallo que documenta
   * `tpsl.ts` para el campo `posSide`.
   *
   * No crece sin limite: cada instantanea de una cuenta descarta los pendientes
   * cuya posicion no aparece en la foto, porque la foto es la verdad sobre que
   * existe.
   */
  private readonly tpPendientes = new Map<string, TakeProfit>();
  private readonly oyentes = new Set<() => void>();
  private readonly ahora: () => number;

  constructor(opciones: OpcionesAlmacen = {}) {
    this.ahora = opciones.ahora ?? Date.now;
  }

  /* ---------------- avisos ---------------- */

  /** Avisa cuando cambia algo que el monitor dibuja. Devuelve como cancelar. */
  alCambiar(oyente: () => void): () => void {
    this.oyentes.add(oyente);
    return () => {
      this.oyentes.delete(oyente);
    };
  }

  private anunciar(hubo: boolean): boolean {
    if (hubo) for (const oyente of this.oyentes) oyente();
    return hubo;
  }

  /* ---------------- lo que dice el exchange ---------------- */

  /**
   * Sustituye todas las posiciones de una cuenta por las de esta lectura.
   *
   * Lo que estaba y no viene, se cerro: la fila desaparece sin mensaje, tal
   * como pide el pliego. Devuelve las diferencias encontradas para que quien
   * llama las registre; una lista vacia significa que memoria y exchange
   * coincidian.
   */
  aplicarInstantanea(cuentaId: string, posiciones: readonly Posicion[]): Deriva[] {
    const derivas: Deriva[] = [];
    const llegan = new Map<string, Posicion>();
    /*
     * Se cuenta aparte de las derivas: aplicar un Take Profit que estaba
     * esperando cambia lo que la pantalla dibuja y no es ninguna divergencia
     * entre memoria y exchange, asi que no debe ensuciar el log de deriva pero
     * si tiene que repintar.
     */
    let hubo = false;

    for (const p of posiciones) {
      if (estaCerrada(p.tamano)) continue;
      llegan.set(clavePosicion(cuentaId, p.simbolo, p.lado), { ...p, cuentaId });
    }

    /* Lo que habia y ya no esta: cierre. */
    for (const [clave, antes] of this.vivas) {
      if (antes.cuentaId !== cuentaId || llegan.has(clave)) continue;
      derivas.push({
        cuentaId,
        simbolo: antes.simbolo,
        lado: antes.lado,
        campo: 'cierre',
        enMemoria: antes.tamano,
        enLectura: '0'
      });
      this.vivas.delete(clave);
      this.aportes.delete(clave);
      hubo = true;
    }

    /* Lo que llega: alta o cotejo campo a campo. */
    for (const [clave, ahora] of llegan) {
      const antes = this.vivas.get(clave);
      if (antes === undefined) {
        derivas.push({
          cuentaId,
          simbolo: ahora.simbolo,
          lado: ahora.lado,
          campo: 'alta',
          enMemoria: '—',
          enLectura: ahora.tamano
        });
      } else {
        for (const [nombre, leer] of CAMPOS_COTEJADOS) {
          const viejo = leer(antes);
          const nuevo = leer(ahora);
          if (viejo !== nuevo) {
            derivas.push({
              cuentaId,
              simbolo: ahora.simbolo,
              lado: ahora.lado,
              campo: nombre,
              enMemoria: viejo,
              enLectura: nuevo
            });
          }
        }
        /* Cambian solos con el precio: repintan, pero no son divergencia. */
        for (const leer of CAMPOS_VOLATILES) {
          if (leer(antes) !== leer(ahora)) hubo = true;
        }
      }
      /*
       * El Take Profit no viaja con la posicion en ninguna de las dos fuentes,
       * asi que una lectura de posiciones no puede borrarlo: se conserva el que
       * ya se conocia y, si habia uno esperando, se aplica ahora.
       */
      const takeProfit = this.tpPendientes.get(clave) ?? antes?.takeProfit ?? null;
      if (this.tpPendientes.delete(clave)) hubo = true;
      this.vivas.set(clave, { ...ahora, takeProfit });
    }

    /* Un Take Profit pendiente cuya posicion no existe se descarta con la foto. */
    for (const clave of [...this.tpPendientes.keys()]) {
      if (clave.startsWith(`${cuentaId}|`) && !llegan.has(clave)) this.tpPendientes.delete(clave);
    }

    /*
     * Y lo mismo con los aportes: la foto es la verdad sobre que existe.
     *
     * No es solo higiene de memoria. Una orden que quedo `indeterminada` -se
     * envio, no llego respuesta- deja anotado su margen inicial, y si esa orden
     * no llego a entrar, ese aporte queda ahi sin posicion a la que pertenecer.
     * Sin esta poda lo heredaria la siguiente posicion que se abriera sobre la
     * misma casilla, simbolo y lado, y la columna enseñaria como comprometido un
     * margen de una operacion que nunca existio.
     *
     * El precio de la regla es conocido y se acepta: si una foto llega en el
     * segundo que Bitget tarda en publicar una posicion recien abierta, su
     * aporte se pierde y la columna enseña un guion. Falla hacia «no se sabe»,
     * que es la unica direccion aceptable en una cifra de dinero.
     */
    for (const clave of [...this.aportes.keys()]) {
      if (clave.startsWith(`${cuentaId}|`) && !llegan.has(clave)) this.aportes.delete(clave);
    }

    this.anunciar(hubo || derivas.length > 0);
    return derivas;
  }

  /**
   * Aplica el cambio de una sola posicion.
   *
   * Un tamano de cero **es un cierre**, no una posicion de tamano cero: asi lo
   * empuja Bitget y asi hay que leerlo. Devuelve `true` si algo cambio.
   */
  aplicarActualizacion(posicion: Posicion): boolean {
    const clave = clavePosicion(posicion.cuentaId, posicion.simbolo, posicion.lado);

    if (estaCerrada(posicion.tamano)) return this.cerrar(posicion.cuentaId, posicion.simbolo, posicion.lado);

    const antes = this.vivas.get(clave);
    this.vivas.set(clave, {
      ...posicion,
      takeProfit: this.tpPendientes.get(clave) ?? antes?.takeProfit ?? null
    });
    this.tpPendientes.delete(clave);
    return this.anunciar(true);
  }

  /** Quita una posicion y su aporte. `true` si habia algo que quitar. */
  cerrar(cuentaId: string, simbolo: string, lado: Lado): boolean {
    const clave = clavePosicion(cuentaId, simbolo, lado);
    const habia = this.vivas.delete(clave);
    this.aportes.delete(clave);
    this.tpPendientes.delete(clave);
    return this.anunciar(habia);
  }

  /**
   * Fija el Take Profit de una punta.
   *
   * Si la posicion todavia no ha llegado, se guarda a la espera en lugar de
   * descartarse: las dos fuentes son independientes y el orden no esta
   * garantizado.
   *
   * --------------------------------------------------------------------------
   * El porcentaje es del panel, como el margen inicial
   * --------------------------------------------------------------------------
   * Bitget solo conoce el precio de disparo. El porcentaje con el que el
   * operador aprobo el Take Profit se escribio en un formulario y no vuelve en
   * ninguna respuesta, asi que **una relectura no puede borrarlo**: mientras el
   * precio sea el mismo, sigue siendo el mismo Take Profit y su porcentaje sigue
   * valiendo. Sin esta regla, el primer barrido despues de abrir convertiria el
   * distintivo «30 %» en un guion sin que nada hubiera cambiado.
   *
   * Si el precio cambia, el porcentaje que se sabia ya no describe este plan y
   * se descarta: es otro Take Profit.
   */
  fijarTakeProfit(cuentaId: string, simbolo: string, lado: Lado, tp: TakeProfit | null): boolean {
    const clave = clavePosicion(cuentaId, simbolo, lado);
    const viva = this.vivas.get(clave);

    if (viva === undefined) {
      if (tp === null) return this.anunciar(this.tpPendientes.delete(clave));
      this.tpPendientes.set(clave, tp);
      return this.anunciar(false);
    }

    const anterior = viva.takeProfit;
    const nuevo =
      tp === null
        ? null
        : {
            ...tp,
            porcentaje:
              tp.porcentaje ?? (anterior !== null && anterior.precio === tp.precio ? anterior.porcentaje : null)
          };

    if (
      anterior?.precio === nuevo?.precio &&
      anterior?.planId === nuevo?.planId &&
      anterior?.porcentaje === nuevo?.porcentaje
    ) {
      return false;
    }

    this.vivas.set(clave, { ...viva, takeProfit: nuevo });
    return this.anunciar(true);
  }

  /* ---------------- lo que solo sabe el panel ---------------- */

  /**
   * Anota lo que el operador acaba de aprobar sobre una punta.
   *
   * Se llama al terminar un lote de apertura, con el margen real de esa
   * casilla. El margen inicial **se acumula**: reposicionar una punta abierta
   * suma al que ya habia, que es justo lo que la columna del monitor promete.
   *
   * `abiertaEn` se fija en la primera anotacion y no se toca despues: es cuando
   * se abrio la posicion, no cuando se reposiciono por ultima vez.
   *
   * --------------------------------------------------------------------------
   * Se acumula tambien hacia abajo, pero nunca por debajo de cero
   * --------------------------------------------------------------------------
   * `margenAdicional` llega negativo cuando el operador **retira** margen de una
   * posicion abierta, y ahi sumar es exactamente lo correcto: agregar 5 y
   * retirar 2 deja 3 comprometidos. Lo que no puede quedar es un negativo, y sin
   * el tope quedaria: si la posicion ya estaba abierta cuando arranco el panel,
   * el aporte conocido es `null` -un guion en pantalla- y la primera retirada lo
   * convertiria en «-2 USDT de margen adicional», que no es un dato menos exacto
   * sino uno imposible. Con el tope se lee cero: no consta ninguno.
   */
  anotarAporte(
    cuentaId: string,
    simbolo: string,
    lado: Lado,
    aporte: { margenInicial?: Cantidad | null; margenAdicional?: Cantidad | null }
  ): void {
    const clave = clavePosicion(cuentaId, simbolo, lado);
    const antes = this.aportes.get(clave);

    this.aportes.set(clave, {
      margenInicial: sinNegativos(
        acumular(antes?.margenInicial ?? null, aporte.margenInicial ?? null)
      ),
      margenAdicional: sinNegativos(
        acumular(antes?.margenAdicional ?? null, aporte.margenAdicional ?? null)
      ),
      abiertaEn: antes?.abiertaEn ?? new Date(this.ahora()).toISOString()
    });

    this.anunciar(true);
  }

  /* ---------------- lectura ---------------- */

  /** Todas las posiciones vivas, con su aporte si lo tienen. */
  instantanea(): PosicionViva[] {
    const salida: PosicionViva[] = [];
    for (const [clave, posicion] of this.vivas) {
      salida.push({ ...posicion, aporte: this.aportes.get(clave) ?? null });
    }
    return salida;
  }

  /** Las posiciones vivas de una cuenta. */
  deCuenta(cuentaId: string): PosicionViva[] {
    return this.instantanea().filter((p) => p.cuentaId === cuentaId);
  }

  /**
   * Cuentas con al menos una posicion abierta.
   *
   * Es lo que decide el nivel de servicio: una cuenta que aparece aqui merece
   * socket -es caliente-, y una que no, se refresca por REST sin que se pierda
   * nada visible, porque no aporta ninguna fila al panel. docs/01 seccion 8.
   */
  cuentasConPosicion(): string[] {
    const cuentas = new Set<string>();
    for (const p of this.vivas.values()) cuentas.add(p.cuentaId);
    return [...cuentas];
  }

  get tamano(): number {
    return this.vivas.size;
  }

  /** Olvida una cuenta entera. Se usa al dar de baja una subcuenta. */
  olvidarCuenta(cuentaId: string): boolean {
    let hubo = false;
    for (const [clave, p] of this.vivas) {
      if (p.cuentaId !== cuentaId) continue;
      this.vivas.delete(clave);
      this.aportes.delete(clave);
      hubo = true;
    }
    for (const clave of [...this.tpPendientes.keys()]) {
      if (clave.startsWith(`${cuentaId}|`)) this.tpPendientes.delete(clave);
    }
    return this.anunciar(hubo);
  }

  /**
   * Tira todo lo sabido.
   *
   * Se llama al bloquear el panel, por lo mismo que se tira el registro de
   * conexiones: con el panel bloqueado no se consulta a Bitget, asi que estas
   * posiciones envejecen. Volver a ensenarlas al desbloquear seria dar por
   * abierta una posicion que pudo cerrarse hace horas.
   */
  limpiar(): void {
    const habia = this.vivas.size > 0 || this.aportes.size > 0 || this.tpPendientes.size > 0;
    this.vivas.clear();
    this.aportes.clear();
    this.tpPendientes.clear();
    this.anunciar(habia);
  }
}

/**
 * Suma de dos cantidades monetarias.
 *
 * Por `decimal.js` y no por coma flotante, como toda la aritmetica de dinero
 * del proceso principal: este acumulado se suma una vez por reposicionamiento y
 * se ensena como el margen que el operador comprometio. docs/03 seccion 14.
 */
function sumar(a: Cantidad, b: Cantidad): Cantidad {
  return new Decimal(a || '0').plus(b || '0').toFixed();
}

/**
 * Acumula lo nuevo sobre lo que ya habia, conservando el «no se sabe».
 *
 * `null` y `'0'` son cosas distintas aqui y no se pueden colapsar: `null` es
 * que el panel no puso nada -y la pantalla enseña un guion-, mientras que `'0'`
 * seria afirmar que se comprometieron cero. Por eso anotar solo el margen
 * adicional no convierte el margen inicial desconocido en un cero.
 */
function acumular(antes: Cantidad | null, nuevo: Cantidad | null): Cantidad | null {
  if (nuevo === null) return antes;
  return antes === null ? nuevo : sumar(antes, nuevo);
}

/**
 * Un acumulado de dinero comprometido no puede ser negativo.
 *
 * Conserva el `null` -«no se sabe» sigue sin saberse- y solo toca el caso que no
 * puede existir. Ver `anotarAporte`.
 */
function sinNegativos(valor: Cantidad | null): Cantidad | null {
  if (valor === null) return null;
  return new Decimal(valor || '0').isNegative() ? '0' : valor;
}
