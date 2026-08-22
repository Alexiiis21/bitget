/**
 * De «100 USDT a 10x» a una cantidad que Bitget acepta.
 *
 * --------------------------------------------------------------------------
 * Por que esto vive aparte y se prueba solo
 * --------------------------------------------------------------------------
 * El operador piensa en margen: «abre 100 USDT en cada cuenta». Bitget piensa
 * en cantidad de moneda base, con un paso minimo, un numero exacto de decimales
 * y un nocional minimo por simbolo. La traduccion entre ambos es donde se
 * pierde el dinero por redondeo, y por eso es una funcion pura, sin red, con
 * sus propias pruebas: se puede razonar sobre ella sin levantar nada.
 *
 * Tres decisiones que no son evidentes:
 *
 * **Se trunca, nunca se redondea.** Redondear hacia arriba pide mas margen del
 * que el operador dijo, y con 100 cuentas eso es dinero comprometido que nadie
 * autorizo. Truncar deja la posicion un pelo por debajo de lo pedido, que es el
 * error inofensivo de los dos.
 *
 * **Se usa el precio de marca, no el ultimo negociado.** El ultimo puede venir
 * de una operacion suelta fuera de mercado; el de marca es el que Bitget usa
 * para liquidar. Con apalancamiento, esa diferencia se multiplica.
 *
 * **El margen se comprueba antes que nada.** Es la peticion explicita del
 * cliente y tambien lo correcto: de todos los motivos por los que una apertura
 * puede fallar, quedarse sin margen es el unico que ademas pone en riesgo lo
 * que ya estaba abierto. Si falta margen, se dice eso y no un fallo de
 * redondeo que llegaria despues.
 */
import Decimal from 'decimal.js';
import type { Contrato } from '../bitget/rest/endpoints/simbolos';

/**
 * Las tres formas en que Bitget deja expresar el tamano de una operacion.
 *
 * En su web son las tres opciones de «Configuración de la unidad de futuros»:
 *
 *   cantidad-base   cantidad en la moneda del activo (0,0236 BTC)
 *   costo-usdt      el margen que se compromete       (10 USDT)
 *   valor-usdt      el valor de la posicion           (1.500 USDT)
 *
 * **La API no tiene esa opcion.** `place-order` acepta el tamano siempre en
 * moneda base, asi que ese ajuste de la web solo cambia lo que el operador ve
 * cuando opera a mano en bitget.com; no viaja en ninguna peticion y no hay que
 * configurarlo en cada subcuenta para que el panel funcione.
 */
export type UnidadOperacion = 'cantidad-base' | 'costo-usdt' | 'valor-usdt';

/**
 * El panel trabaja siempre en **Costo-USDT**, y no es configurable.
 *
 * Es una decision del cliente, confirmada el 13 de agosto de 2026: el operador
 * escribe el margen que quiere comprometer y el panel hace la conversion. Se
 * deja nombrada y en un solo sitio -en vez de escondida dentro de la formula-
 * para que un cambio futuro sea una linea y no una reescritura; pero no se
 * expone como interruptor, porque un modo que nadie usa es un modo que nadie
 * prueba, y aqui lo que no se prueba se paga con dinero real.
 */
export const UNIDAD_OPERACION: UnidadOperacion = 'costo-usdt';

export type MotivoRechazo =
  | 'margen-invalido'
  | 'margen-insuficiente'
  | 'apalancamiento-fuera-de-rango'
  | 'precio-invalido'
  | 'simbolo-no-operable'
  | 'nocional-minimo'
  | 'cantidad-minima'
  | 'cantidad-maxima';

export interface Dimension {
  /** Cantidad en moneda base, ya ajustada al paso del simbolo. */
  size: string;
  /** Valor de la posicion en moneda de margen: size x precio. */
  nocional: string;
  /**
   * Margen que se compromete de verdad, tras truncar la cantidad.
   *
   * Es menor o igual al pedido, nunca mayor. Se devuelve para poder ensenarlo
   * en la confirmacion: el operador aprueba lo que va a pasar, no lo que pidio.
   */
  margenReal: string;
}

export type ResultadoDimension =
  | { ok: true; dimension: Dimension }
  | { ok: false; motivo: MotivoRechazo; mensaje: string };

export interface PeticionDimension {
  contrato: Contrato;
  /** Precio de marca del simbolo. */
  precio: string;
  /** Margen que el operador quiere comprometer, en moneda de margen. */
  margenInicial: string;
  apalancamiento: number;
  /** Saldo disponible de la subcuenta. Se comprueba el primero. */
  saldoDisponible: string;
  /** `true` si la orden va a mercado; cambia el tope de cantidad aplicable. */
  aMercado: boolean;
}

const rechazo = (motivo: MotivoRechazo, mensaje: string): ResultadoDimension => ({
  ok: false,
  motivo,
  mensaje
});

/** Trunca hacia abajo al numero de decimales indicado. */
const truncar = (valor: Decimal, decimales: number): Decimal =>
  valor.toDecimalPlaces(decimales, Decimal.ROUND_DOWN);

/**
 * Calcula la cantidad de una apertura, o explica por que no se puede.
 *
 * No lanza: devolver el motivo permite que un lote de 100 cuentas siga con las
 * 99 restantes y le diga al operador exactamente cual fallo y por que.
 */
export function dimensionarApertura(p: PeticionDimension): ResultadoDimension {
  const margen = new Decimal(p.margenInicial || '0');
  const saldo = new Decimal(p.saldoDisponible || '0');
  const precio = new Decimal(p.precio || '0');

  /* ---- 1. el margen, siempre lo primero ---- */

  if (!margen.isFinite() || margen.lessThanOrEqualTo(0)) {
    return rechazo('margen-invalido', 'El margen inicial debe ser un número mayor que cero.');
  }

  if (saldo.lessThan(margen)) {
    return rechazo(
      'margen-insuficiente',
      `Saldo insuficiente: hacen falta ${margen.toString()} y hay ${saldo.toString()}.`
    );
  }

  /* ---- 2. lo que impone el simbolo ---- */

  if (p.contrato.symbolStatus !== 'normal') {
    return rechazo(
      'simbolo-no-operable',
      `Bitget tiene ${p.contrato.symbol} en estado «${p.contrato.symbolStatus}»: no admite órdenes ahora.`
    );
  }

  const minLever = new Decimal(p.contrato.minLever);
  const maxLever = new Decimal(p.contrato.maxLever);
  if (
    !Number.isFinite(p.apalancamiento) ||
    minLever.greaterThan(p.apalancamiento) ||
    maxLever.lessThan(p.apalancamiento)
  ) {
    return rechazo(
      'apalancamiento-fuera-de-rango',
      `El apalancamiento debe estar entre ${p.contrato.minLever}x y ${p.contrato.maxLever}x para ${p.contrato.symbol}.`
    );
  }

  if (!precio.isFinite() || precio.lessThanOrEqualTo(0)) {
    return rechazo('precio-invalido', 'No hay un precio válido para calcular la cantidad.');
  }

  /* ---- 3. nocional y cantidad ---- */

  /*
   * Aqui esta la conversion de Costo-USDT a lo que pide la API:
   *
   *   margen x apalancamiento = valor de la posicion
   *   valor / precio          = cantidad en moneda base
   *
   * Con el ejemplo del cliente: 10 USDT a 150x son 1.500 USDT de posicion, y a
   * 63.378 el BTC salen 0,0236 BTC, que es lo que se envia.
   */
  const nocionalPedido = margen.times(p.apalancamiento);
  const minNocional = new Decimal(p.contrato.minTradeUSDT);
  if (nocionalPedido.lessThan(minNocional)) {
    return rechazo(
      'nocional-minimo',
      `Con ${margen.toString()} a ${p.apalancamiento}x la posición sería de ${nocionalPedido.toString()}, ` +
        `y Bitget exige al menos ${p.contrato.minTradeUSDT} para ${p.contrato.symbol}.`
    );
  }

  const decimales = Number.parseInt(p.contrato.volumePlace, 10);
  const paso = new Decimal(p.contrato.sizeMultiplier);
  const bruto = nocionalPedido.dividedBy(precio);

  /*
   * Dos ajustes seguidos, los dos hacia abajo: primero al paso del simbolo y
   * despues al numero de decimales. El segundo no suele mover nada -el paso ya
   * suele caer en la rejilla de decimales-, pero si el simbolo declarara un
   * paso con mas precision que sus decimales, Bitget rechazaria la cantidad.
   */
  const alPaso = paso.greaterThan(0) ? bruto.dividedBy(paso).floor().times(paso) : bruto;
  const size = truncar(alPaso, Number.isFinite(decimales) ? decimales : 8);

  const minimo = new Decimal(p.contrato.minTradeNum);
  if (size.lessThan(minimo)) {
    return rechazo(
      'cantidad-minima',
      `La cantidad resultante (${size.toString()}) queda por debajo del mínimo de ${p.contrato.minTradeNum} ` +
        `${p.contrato.baseCoin}. Suba el margen o el apalancamiento.`
    );
  }

  const tope = new Decimal(p.aMercado ? p.contrato.maxMarketOrderQty : p.contrato.maxOrderQty);
  if (size.greaterThan(tope)) {
    return rechazo(
      'cantidad-maxima',
      `La cantidad resultante (${size.toString()}) supera el máximo de ${tope.toString()} ` +
        `${p.contrato.baseCoin} por orden. Baje el margen o el apalancamiento.`
    );
  }

  /*
   * Truncar pudo dejar el nocional por debajo del minimo aunque el pedido lo
   * superara. Se comprueba sobre la cantidad final, que es la que se envia.
   */
  const nocionalReal = size.times(precio);
  if (nocionalReal.lessThan(minNocional)) {
    return rechazo(
      'nocional-minimo',
      `Tras ajustar la cantidad al paso de ${p.contrato.symbol}, la posición queda en ` +
        `${nocionalReal.toString()} y Bitget exige al menos ${p.contrato.minTradeUSDT}.`
    );
  }

  return {
    ok: true,
    dimension: {
      size: size.toFixed(),
      nocional: nocionalReal.toFixed(),
      margenReal: nocionalReal.dividedBy(p.apalancamiento).toFixed()
    }
  };
}
