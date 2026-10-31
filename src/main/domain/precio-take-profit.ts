/**
 * De «Take Profit al 35%» al precio que exige la API de Bitget.
 *
 * --------------------------------------------------------------------------
 * Por que el panel tiene que calcularlo
 * --------------------------------------------------------------------------
 * En la web de Bitget se teclea un porcentaje y la pantalla enseña el precio.
 * **La API no**: `place-tpsl-order` exige `triggerPrice` y rechaza la peticion
 * sin el. Verificado el 13/08/2026: enviando `triggerPercent` sigue
 * respondiendo «The trigger price cannot be empty». Es el mismo caso que la
 * unidad Costo-USDT — una comodidad de la web que no viaja en la peticion.
 *
 * --------------------------------------------------------------------------
 * Que significa el porcentaje, con numeros reales del cliente
 * --------------------------------------------------------------------------
 * Es **ganancia sobre el margen inicial** (ROE), no movimiento del precio. Se
 * dedujo de una operacion suya en PEPEUSDT a 75x:
 *
 *   entrada          0,0000026184
 *   Take Profit 35%  0,0000026306   <- lo que muestra Bitget
 *   ganancia est.    3,0448 USDT (34,94%)
 *
 * Y encaja al decimal: 0,0000026184 x (1 + 0,35/75) = 0,00000263062.
 * El precio solo tiene que moverse un 0,4667% porque el apalancamiento
 * multiplica por 75. Con «35% de movimiento del precio» el objetivo estaria a
 * 0,0000035348 y no saltaria jamas: la liquidacion a 75x llega mucho antes.
 *
 * De ahi la formula, que depende del apalancamiento y no solo del precio:
 *
 *   long   precio = entrada x (1 + porcentaje / apalancamiento)
 *   short  precio = entrada x (1 - porcentaje / apalancamiento)
 *
 * --------------------------------------------------------------------------
 * Sobre que margen se calcula el ROE
 * --------------------------------------------------------------------------
 * Sobre el **margen inicial** -cantidad x precio de entrada / apalancamiento-,
 * no sobre el margen que haya en la posicion. Se comprobo con la misma captura:
 * la posicion tenia 1.008,71 USDT de margen tras anadirle margen adicional, y
 * aun asi Bitget mostraba el ROE sobre 8,71. Consecuencia practica: **agregar
 * margen no mueve el Take Profit**, ni hace falta recalcularlo.
 */
import Decimal from 'decimal.js';
import type { Lado } from '@shared/types';
import type { Contrato } from '../bitget/rest/endpoints/simbolos';

export type MotivoRechazoTp =
  | 'porcentaje-invalido'
  | 'apalancamiento-invalido'
  | 'precio-invalido'
  | 'sin-recorrido'
  /** Del lado de un Stop Loss respecto a la entrada o al precio actual. Ver `ladoEquivocadoTakeProfit`. */
  | 'tp-lado-equivocado'
  /** Cerraria en negativo frente a la entrada promedio, comisiones incluidas. Ver `takeProfitConPerdida`. */
  | 'tp-con-perdida';

export interface DisparoTakeProfit {
  /** Precio al que Bitget cerrara la posicion. Es lo que se envia. */
  precioDisparo: string;
  /** Cuanto tiene que moverse el precio, en %. Para enseñarlo al operador. */
  movimientoPorcentaje: string;
}

export type ResultadoTakeProfit =
  | { ok: true; disparo: DisparoTakeProfit }
  | { ok: false; motivo: MotivoRechazoTp; mensaje: string };

export interface PeticionTakeProfit {
  contrato: Contrato;
  /** Precio medio de entrada de la posicion. */
  precioEntrada: string;
  lado: Lado;
  /** El de la cuenta. El porcentaje no significa nada sin el. */
  apalancamiento: number;
  /** Ganancia sobre el margen inicial, en porcentaje. P. ej. `35`. */
  porcentaje: string;
}

const rechazo = (motivo: MotivoRechazoTp, mensaje: string): ResultadoTakeProfit => ({
  ok: false,
  motivo,
  mensaje
});

/**
 * Cantidad valida, o `null` si eso no es un numero.
 *
 * Misma razon que en `dimension-orden.ts`: `new Decimal('.')` lanza, y el
 * porcentaje viaja con la apertura, asi que un punto suelto en ese campo se
 * llevaba por delante el lote entero. Ver la incidencia del 05/09/2026.
 */
function cantidad(v: string | null | undefined): Decimal | null {
  if (v == null || v.trim() === '') return null;
  try {
    const d = new Decimal(v);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/**
 * Precio de disparo del Take Profit.
 *
 * El redondeo va **hacia el precio de entrada**, nunca en contra: un objetivo
 * un paso mas cerca se ejecuta con una ganancia despreciablemente menor, y uno
 * un paso mas lejos puede quedarse sin saltar. De los dos errores posibles, el
 * inofensivo es cobrar un céntimo menos.
 */
export function precioTakeProfit(p: PeticionTakeProfit): ResultadoTakeProfit {
  const porcentaje = cantidad(p.porcentaje);
  const entrada = cantidad(p.precioEntrada);

  if (porcentaje === null || porcentaje.lessThanOrEqualTo(0)) {
    return rechazo('porcentaje-invalido', 'El Take Profit debe ser un porcentaje mayor que cero.');
  }
  if (!Number.isFinite(p.apalancamiento) || p.apalancamiento <= 0) {
    return rechazo(
      'apalancamiento-invalido',
      'No se conoce el apalancamiento de la cuenta, y sin él el porcentaje no define ningún precio.'
    );
  }
  if (entrada === null || entrada.lessThanOrEqualTo(0)) {
    return rechazo('precio-invalido', 'La posición no tiene un precio de entrada válido.');
  }

  /* El apalancamiento multiplica la ganancia: el precio se mueve esa fraccion. */
  const movimiento = porcentaje.dividedBy(100).dividedBy(p.apalancamiento);
  const bruto =
    p.lado === 'long' ? entrada.times(movimiento.plus(1)) : entrada.times(new Decimal(1).minus(movimiento));

  const decimales = Number.parseInt(p.contrato.pricePlace, 10);
  const paso = new Decimal(p.contrato.priceEndStep).dividedBy(
    new Decimal(10).toPower(Number.isFinite(decimales) ? decimales : 8)
  );

  /* Hacia la entrada: abajo en un long, arriba en un short. */
  const enPaso = paso.greaterThan(0)
    ? p.lado === 'long'
      ? bruto.dividedBy(paso).floor().times(paso)
      : bruto.dividedBy(paso).ceil().times(paso)
    : bruto;
  const precio = enPaso.toDecimalPlaces(
    Number.isFinite(decimales) ? decimales : 8,
    p.lado === 'long' ? Decimal.ROUND_DOWN : Decimal.ROUND_UP
  );

  /*
   * Con un porcentaje diminuto o un activo de paso grueso, el redondeo puede
   * dejar el objetivo en el propio precio de entrada -o del lado equivocado-.
   * Enviarlo asi seria colocar un Take Profit que se dispara al instante.
   */
  const sinRecorrido = p.lado === 'long' ? precio.lessThanOrEqualTo(entrada) : precio.greaterThanOrEqualTo(entrada);
  if (sinRecorrido) {
    return rechazo(
      'sin-recorrido',
      `Un ${porcentaje.toString()}% a ${p.apalancamiento}x no llega ni a un paso de precio de ` +
        `${p.contrato.symbol}: el objetivo coincidiría con la entrada. Suba el porcentaje.`
    );
  }

  return {
    ok: true,
    disparo: {
      precioDisparo: precio.toFixed(),
      movimientoPorcentaje: precio.minus(entrada).abs().dividedBy(entrada).times(100).toFixed(4)
    }
  };
}

export interface ReferenciaTakeProfit {
  /** Como se le dice al operador: «la entrada», «el precio actual». */
  nombre: string;
  /** `null` o ilegible: esa referencia no se comprueba. */
  precio: string | null | undefined;
}

/**
 * Por que se comprueba el lado justo antes de enviar.
 *
 * ELITE LAURA, 19/10/2026: cuenta en cobertura con long y short abiertos a la vez
 * en PEPEUSDT. La operadora vio en Bitget un Take Profit «del short» por encima
 * de la entrada, que es donde estaría un Stop Loss. En la bitácora todos los
 * precios que el panel mandó para el short estaban por debajo, pero
 * `modify-strategy-order` no lleva `posSide`: el lado lo pone el `orderId`, y un
 * `orderId` del otro lado aplicaría un precio de short sobre el long o al
 * revés, sin que Bitget se queje. `precioTakeProfit` ya calcula hacia el lado
 * bueno; esta es la última puerta y no depende de cómo se llegó al precio.
 *
 *   long   el Take Profit queda por ENCIMA de cada referencia
 *   short  el Take Profit queda por DEBAJO de cada referencia
 *
 * Contra el precio actual también: un Take Profit que el precio ya pasó se
 * dispara al instante o Bitget lo deja puesto sin ejecutar.
 *
 * Devuelve el mensaje para el operador, o `null` si está del lado correcto.
 * Un precio de disparo ilegible siempre es rechazo.
 */
export function ladoEquivocadoTakeProfit(
  lado: Lado,
  precioDisparo: string,
  referencias: readonly ReferenciaTakeProfit[]
): string | null {
  const disparo = cantidad(precioDisparo);
  if (disparo === null || disparo.lessThanOrEqualTo(0)) {
    return `El Take Profit ${precioDisparo} no es un precio válido: no se envía.`;
  }

  for (const r of referencias) {
    const ref = cantidad(r.precio ?? null);
    if (ref === null || ref.lessThanOrEqualTo(0)) continue;
    const bien = lado === 'long' ? disparo.greaterThan(ref) : disparo.lessThan(ref);
    if (!bien) {
      return (
        `El Take Profit ${precioDisparo} de un ${lado} tiene que quedar ` +
        `${lado === 'long' ? 'por encima' : 'por debajo'} de ${r.nombre} (${r.precio}); ` +
        `así funcionaría como un Stop Loss. No se envía.`
      );
    }
  }
  return null;
}

/**
 * Comision taker de futuros USDT de Bitget, por lado: 0,06 %.
 *
 * Es la que se paga al abrir a mercado y al cerrar con un Take Profit a
 * mercado, que son las dos ordenes que salen del panel. Se usa para decidir si
 * un cierre queda en negativo **despues de comisiones**, no para calcular el
 * Take Profit: el porcentaje del operador sigue siendo el de la web de Bitget.
 */
export const COMISION_TAKER = '0.0006';

const comision = new Decimal(COMISION_TAKER);

/**
 * Resultado neto estimado de cerrar `tamano` a `salida`, con las dos
 * comisiones -la de apertura y la de cierre- ya restadas. `null` si algun dato
 * no es un numero.
 *
 *   long   (salida - entrada) x tamano - (entrada + salida) x tamano x comision
 *   short  (entrada - salida) x tamano - (entrada + salida) x tamano x comision
 */
export function resultadoNetoEstimado(
  lado: Lado,
  entrada: string | null | undefined,
  salida: string | null | undefined,
  tamano: string | null | undefined
): Decimal | null {
  const e = cantidad(entrada ?? null);
  const s = cantidad(salida ?? null);
  const t = cantidad(tamano ?? null);
  if (e === null || s === null || t === null || e.lessThanOrEqualTo(0) || s.lessThanOrEqualTo(0)) {
    return null;
  }
  const bruto = lado === 'long' ? s.minus(e) : e.minus(s);
  return bruto.times(t).minus(e.plus(s).times(t).times(comision));
}

/**
 * El Take Profit mas cercano a la entrada que todavia cierra sin perdida
 * despues de comisiones.
 *
 *   long   entrada x (1 + comision) / (1 - comision)
 *   short  entrada x (1 - comision) / (1 + comision)
 */
function limiteSinPerdida(lado: Lado, entrada: Decimal): Decimal {
  const uno = new Decimal(1);
  return lado === 'long'
    ? entrada.times(uno.plus(comision)).dividedBy(uno.minus(comision))
    : entrada.times(uno.minus(comision)).dividedBy(uno.plus(comision));
}

/**
 * Por que ningun Take Profit sale si cierra en perdida.
 *
 * ELITE QLC, 28/10/2026: se agrego un short de 4.856.000 PEPE a 0,000005148
 * sobre uno de 6.156.000, y la orden UTA llevo dentro su propio Take Profit,
 * calculado desde el precio de **esa** orden: 0,0000051223. Bitget lo creo como
 * un Take Profit aparte para esos 4.856.000, y la entrada promedio de la
 * posicion ya era 0,0000048531. Se disparo al minuto y cerro esa parte con
 * -1,31 USDT. `ladoEquivocadoTakeProfit` no lo paro porque solo miraba el
 * precio de la orden, no la entrada de la posicion.
 *
 * Esta puerta compara con la **entrada promedio de la posicion consolidada** y
 * con las comisiones de abrir y cerrar: un Take Profit que, ejecutado a su
 * precio, deja el resultado en negativo no se envia, venga de una apertura, de
 * un promedio o de un ajuste a mano. No tiene excepcion ni contraseña que la
 * salte: es lo que pidio el cliente el 29/10/2026.
 *
 * Devuelve el mensaje para el operador, o `null` si cierra en positivo.
 */
export function takeProfitConPerdida(
  lado: Lado,
  precioDisparo: string,
  referencias: readonly ReferenciaTakeProfit[]
): string | null {
  const disparo = cantidad(precioDisparo);
  if (disparo === null || disparo.lessThanOrEqualTo(0)) {
    return `El Take Profit ${precioDisparo} no es un precio válido: no se envía.`;
  }

  for (const r of referencias) {
    const ref = cantidad(r.precio ?? null);
    if (ref === null || ref.lessThanOrEqualTo(0)) continue;
    const limite = limiteSinPerdida(lado, ref);
    const bien = lado === 'long' ? disparo.greaterThan(limite) : disparo.lessThan(limite);
    if (!bien) {
      return (
        `El Take Profit ${precioDisparo} de un ${lado} cerraría con pérdida respecto a ` +
        `${r.nombre} (${r.precio}): con las comisiones de abrir y cerrar tiene que quedar ` +
        `${lado === 'long' ? 'por encima' : 'por debajo'} de ${limite.toSignificantDigits(8).toFixed()}. ` +
        'No se envía.'
      );
    }
  }
  return null;
}
