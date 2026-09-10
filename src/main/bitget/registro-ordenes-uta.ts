/**
 * Lo que el socket de UTA ha visto sobre cada orden.
 *
 * ==========================================================================
 * Para qué existe: el tri-estado en cuentas UTA
 * ==========================================================================
 * Cuando la conexión se corta **después** de enviar una apertura, no se sabe si
 * la orden entró. Reintentar a ciegas duplica la posición; descartarla deja una
 * posición abierta que nadie vigila. La única salida correcta es preguntar por
 * el `clientOid`.
 *
 * En V2 la responde `GET /api/v2/mix/order/detail`. En V3 **no hay endpoint
 * equivalente conocido** —el hueco 2.1 de `docs/00-uta-fase-1-equivalencias.md`,
 * el más caro del inventario—, así que desde la Fase C `consultarOrdenV3` lanza
 * y toda apertura interrumpida en una cuenta UTA queda `indeterminada`.
 *
 * El tema `order` del socket V3 trae `clientOid` y estado. Si el socket anunció
 * esa orden, **Bitget la conoce**: entró. Eso es una respuesta, y es la que
 * faltaba.
 *
 * ==========================================================================
 * Solo responde que sí. Nunca que no, y esa asimetría es todo el diseño
 * ==========================================================================
 * `buscar` devuelve la orden o `null`, y `null` significa aquí **«no consta»**,
 * jamás «no entró». La diferencia es la regla dura nº 2:
 *
 *   consta      el socket la anunció → la orden entró. Es prueba positiva.
 *   no consta   puede que no entrara, o que el socket estuviera caído, o que la
 *               cuenta estuviera fría —sin socket, por cupo—, o que el empujón
 *               llegue un segundo más tarde. **No se sabe.**
 *
 * Por eso `consultarOrdenV3` sigue lanzando cuando no consta, en vez de
 * devolver `null`: en el contrato de `consultarOrden`, `null` significa «no
 * entró» y quien lo recibe ofrece reintentar. Convertir un «no consta» en un
 * «no entró» sería exactamente cómo se abren dos posiciones con dinero real.
 *
 * Lo que este registro hace, entonces, es estrictamente convertir algunas
 * casillas `indeterminada` en `exito`. Ninguna en `fallo`. No puede empeorar
 * ningún desenlace.
 *
 * ==========================================================================
 * Por qué se compara además el símbolo
 * ==========================================================================
 * El `clientOid` que emite el panel es único por plan, objetivo y lado
 * —`clientOidDe`, en `motor-lotes.ts`—, así que hoy no puede repetirse entre dos
 * cuentas. Aun así `buscar` exige que el símbolo coincida: si algún día ese
 * generador cambiara, un choque de identificadores daría por buena en una cuenta
 * una orden que entró en otra. Cuesta una comparación y cierra la única forma
 * conocida de falso positivo.
 */

/** Lo que el socket contó de una orden. Los nombres son los de V2, ya traducidos. */
export interface OrdenVista {
  orderId: string;
  clientOid: string;
  symbol: string;
  /** `live` | `partially_filled` | `filled` | `canceled`, o lo que mande V3. */
  state: string;
  size: string | null;
  baseVolume: string | null;
  priceAvg: string | null;
}

/**
 * Cuántas órdenes se recuerdan como mucho.
 *
 * Un lote grande son ~300 objetivos, y lo que interesa resolver es siempre de
 * los últimos minutos: cuando el motor pregunta, lo hace inmediatamente después
 * del envío fallido. Mil entradas cubren varios lotes seguidos de sobra y
 * acotan la memoria pase lo que pase —el socket empuja cada cambio de estado de
 * cada orden, así que sin tope esto crecería toda la sesión—.
 */
const MAXIMO = 1_000;

/**
 * Cuánto se recuerda una orden.
 *
 * Diez minutos. Más allá, una respuesta positiva ya no ayuda a nadie: el lote
 * terminó hace rato y el operador tiene el informe. Y una entrada vieja que
 * sobreviviera a un reinicio del plan podría responder por un `clientOid`
 * reutilizado, que es justo lo que no se quiere.
 */
const VIGENCIA_MS = 600_000;

interface Anotacion {
  vista: OrdenVista;
  en: number;
}

export class RegistroOrdenesUta {
  private readonly porOid = new Map<string, Anotacion>();
  private readonly ahora: () => number;

  constructor(ahora: () => number = Date.now) {
    this.ahora = ahora;
  }

  /** Órdenes recordadas ahora mismo. Para pruebas y diagnóstico. */
  get tamano(): number {
    return this.porOid.size;
  }

  /**
   * Anota lo que el socket contó.
   *
   * Se sobrescribe la anotación anterior del mismo `clientOid` a propósito: una
   * orden pasa de `live` a `filled` y lo que interesa conservar es lo último que
   * dijo el exchange. Lo que no cambia nunca por sobrescribir es la respuesta a
   * la pregunta que importa —si entró—, porque cualquier estado la contesta.
   */
  registrar(vista: OrdenVista): void {
    if (vista.clientOid === '') return;

    /*
     * El tope se aplica por inserción y no con un barrido periódico: `Map`
     * conserva el orden de inserción, así que la primera clave es siempre la
     * más antigua. Sin temporizador que mantener.
     */
    if (this.porOid.size >= MAXIMO && !this.porOid.has(vista.clientOid)) {
      const masVieja = this.porOid.keys().next().value;
      if (masVieja !== undefined) this.porOid.delete(masVieja);
    }

    this.porOid.delete(vista.clientOid);
    this.porOid.set(vista.clientOid, { vista, en: this.ahora() });
  }

  /**
   * La orden, si consta y es la del símbolo indicado.
   *
   * `null` es **«no consta»**, nunca «no entró». Ver la cabecera.
   */
  buscar(clientOid: string, simbolo: string): OrdenVista | null {
    const anotacion = this.porOid.get(clientOid);
    if (anotacion === undefined) return null;

    if (this.ahora() - anotacion.en > VIGENCIA_MS) {
      this.porOid.delete(clientOid);
      return null;
    }

    /* Ver «Por qué se compara además el símbolo». */
    if (anotacion.vista.symbol !== simbolo) return null;

    return anotacion.vista;
  }

  /** Olvida todo. La usa el bloqueo del panel y las pruebas. */
  vaciar(): void {
    this.porOid.clear();
  }
}

/**
 * El registro del proceso.
 *
 * Es una instancia única y compartida, y conviene decir por qué en vez de
 * disimularlo: quien escribe es el pool de sockets y quien lee es una función de
 * endpoint, y entre las dos hay cinco capas —motor de lotes incluido— que no
 * tienen nada que ver con esto. Pasarlo como parámetro obligaría a atravesar
 * `motor-lotes.ts` con un argumento que ese archivo no usa para nada.
 *
 * El panel es un proceso con un pool y un cliente, así que «uno por proceso» es
 * la verdad del dominio, no un atajo. La clase se exporta aparte para que las
 * pruebas construyan la suya con su propio reloj.
 */
export const registroOrdenesUta = new RegistroOrdenesUta();
