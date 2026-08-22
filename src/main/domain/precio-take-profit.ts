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
  | 'sin-recorrido';

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
 * Precio de disparo del Take Profit.
 *
 * El redondeo va **hacia el precio de entrada**, nunca en contra: un objetivo
 * un paso mas cerca se ejecuta con una ganancia despreciablemente menor, y uno
 * un paso mas lejos puede quedarse sin saltar. De los dos errores posibles, el
 * inofensivo es cobrar un céntimo menos.
 */
export function precioTakeProfit(p: PeticionTakeProfit): ResultadoTakeProfit {
  const porcentaje = new Decimal(p.porcentaje || '0');
  const entrada = new Decimal(p.precioEntrada || '0');

  if (!porcentaje.isFinite() || porcentaje.lessThanOrEqualTo(0)) {
    return rechazo('porcentaje-invalido', 'El Take Profit debe ser un porcentaje mayor que cero.');
  }
  if (!Number.isFinite(p.apalancamiento) || p.apalancamiento <= 0) {
    return rechazo(
      'apalancamiento-invalido',
      'No se conoce el apalancamiento de la cuenta, y sin él el porcentaje no define ningún precio.'
    );
  }
  if (!entrada.isFinite() || entrada.lessThanOrEqualTo(0)) {
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
