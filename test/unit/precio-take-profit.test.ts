/**
 * El precio del Take Profit, contra una operacion real del cliente.
 *
 * El caso de referencia no es inventado: es una captura de su pantalla de
 * Bitget del 13 de agosto de 2026, con PEPEUSDT a 75x. Si alguien cambia la
 * formula, lo que falla nombra su operacion y no un numero de laboratorio.
 */
import { describe, expect, it } from 'vitest';
import {
  ladoEquivocadoTakeProfit,
  precioTakeProfit,
  resultadoNetoEstimado,
  takeProfitConPerdida
} from '@main/domain/precio-take-profit';
import type { Contrato } from '@main/bitget/rest/endpoints/simbolos';

/** Contrato real de PEPEUSDT, capturado de api.bitget.com el 13/08/2026. */
const PEPE: Contrato = {
  symbol: 'PEPEUSDT',
  baseCoin: 'PEPE',
  quoteCoin: 'USDT',
  minTradeNum: '1000',
  volumePlace: '0',
  pricePlace: '10',
  priceEndStep: '1',
  sizeMultiplier: '1000',
  minTradeUSDT: '5',
  minLever: '1',
  maxLever: '75',
  maxMarketOrderQty: '190000000000',
  maxOrderQty: '1500000000000',
  symbolStatus: 'normal'
};

const BTC: Contrato = {
  ...PEPE,
  symbol: 'BTCUSDT',
  baseCoin: 'BTC',
  minTradeNum: '0.0001',
  volumePlace: '4',
  pricePlace: '1',
  priceEndStep: '1',
  sizeMultiplier: '0.0001',
  maxLever: '150',
  maxMarketOrderQty: '220',
  maxOrderQty: '1200'
};

describe('la operacion real del cliente', () => {
  /*
   * Su captura, literal:
   *   PEPEUSDT · Aislado · Long · 75x
   *   precio de entrada  0,0000026184
   *   Take Profit 35%    0,0000026306
   *   ganancia estimada  3,0448 USDT (34,94%)
   */
  it('35% a 75x sobre PEPE da exactamente el precio que enseña Bitget', () => {
    const r = precioTakeProfit({
      contrato: PEPE,
      precioEntrada: '0.0000026184',
      lado: 'long',
      apalancamiento: 75,
      porcentaje: '35'
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.disparo.precioDisparo).toBe('0.0000026306');
  });

  it('el precio solo se mueve un 0,47%: lo demas lo pone el apalancamiento', () => {
    const r = precioTakeProfit({
      contrato: PEPE,
      precioEntrada: '0.0000026184',
      lado: 'long',
      apalancamiento: 75,
      porcentaje: '35'
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Number(r.disparo.movimientoPorcentaje)).toBeCloseTo(0.4659, 3);
  });

  /*
   * La lectura alternativa -35% de movimiento del precio- daria 0,0000035348.
   * A 75x la liquidacion llega mucho antes, asi que ese objetivo no saltaria
   * nunca. Se deja escrito para que la diferencia quede a la vista.
   */
  it('no interpreta el porcentaje como movimiento del precio', () => {
    const r = precioTakeProfit({
      contrato: PEPE,
      precioEntrada: '0.0000026184',
      lado: 'long',
      apalancamiento: 75,
      porcentaje: '35'
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.disparo.precioDisparo).not.toBe('0.0000035348');
  });
});

describe('el apalancamiento manda', () => {
  it('el mismo porcentaje da precios distintos segun el apalancamiento', () => {
    const a = precioTakeProfit({
      contrato: BTC,
      precioEntrada: '63378',
      lado: 'long',
      apalancamiento: 150,
      porcentaje: '35'
    });
    const b = precioTakeProfit({
      contrato: BTC,
      precioEntrada: '63378',
      lado: 'long',
      apalancamiento: 75,
      porcentaje: '35'
    });

    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    /* A 150x basta con la mitad de recorrido que a 75x. */
    expect(a.disparo.precioDisparo).toBe('63525.8');
    expect(b.disparo.precioDisparo).toBe('63673.7');
  });

  it('sin apalancamiento conocido no inventa un precio', () => {
    const r = precioTakeProfit({
      contrato: BTC,
      precioEntrada: '63378',
      lado: 'long',
      apalancamiento: 0,
      porcentaje: '35'
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe('apalancamiento-invalido');
  });
});

describe('el lado invierte la direccion', () => {
  it('en short el objetivo esta por debajo de la entrada', () => {
    const r = precioTakeProfit({
      contrato: BTC,
      precioEntrada: '63378',
      lado: 'short',
      apalancamiento: 150,
      porcentaje: '35'
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Number(r.disparo.precioDisparo)).toBeLessThan(63378);
    expect(r.disparo.precioDisparo).toBe('63230.2');
  });
});

describe('redondeo', () => {
  /*
   * Hacia la entrada, nunca en contra: un objetivo un paso mas cerca se ejecuta
   * con una ganancia despreciablemente menor; uno un paso mas lejos puede
   * quedarse sin saltar.
   */
  it('en long redondea hacia abajo y en short hacia arriba', () => {
    const largo = precioTakeProfit({
      contrato: BTC,
      precioEntrada: '63378',
      lado: 'long',
      apalancamiento: 150,
      porcentaje: '35'
    });
    const corto = precioTakeProfit({
      contrato: BTC,
      precioEntrada: '63378',
      lado: 'short',
      apalancamiento: 150,
      porcentaje: '35'
    });

    expect(largo.ok && corto.ok).toBe(true);
    if (!largo.ok || !corto.ok) return;
    /* El exacto es 63525,882 -> baja a 63525,8 ; y 63230,118 -> sube a 63230,2. */
    expect(largo.disparo.precioDisparo).toBe('63525.8');
    expect(corto.disparo.precioDisparo).toBe('63230.2');
  });

  it('el precio cae siempre en un paso que Bitget acepta', () => {
    for (const porcentaje of ['5', '17.5', '35', '120']) {
      const r = precioTakeProfit({
        contrato: BTC,
        precioEntrada: '63378',
        lado: 'long',
        apalancamiento: 150,
        porcentaje
      });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      /* pricePlace 1: como mucho un decimal. */
      expect(r.disparo.precioDisparo).toMatch(/^\d+(\.\d)?$/);
    }
  });

  /*
   * Con un porcentaje diminuto el objetivo caeria dentro del propio paso de
   * precio. Enviarlo seria colocar un Take Profit que se dispara al instante.
   */
  it('rechaza un porcentaje que no llega ni a un paso de precio', () => {
    const r = precioTakeProfit({
      contrato: BTC,
      precioEntrada: '63378',
      lado: 'long',
      apalancamiento: 150,
      porcentaje: '0.01'
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe('sin-recorrido');
  });

  it('rechaza un porcentaje vacio o negativo', () => {
    for (const porcentaje of ['', '0', '-5']) {
      const r = precioTakeProfit({
        contrato: BTC,
        precioEntrada: '63378',
        lado: 'long',
        apalancamiento: 150,
        porcentaje
      });
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.motivo).toBe('porcentaje-invalido');
    }
  });

  /* El porcentaje viaja con la apertura: si lanza, se lleva el lote entero. */
  it('lo que no es un numero se rechaza, no revienta', () => {
    for (const porcentaje of ['.', '1.2.3', 'abc']) {
      const r = precioTakeProfit({
        contrato: BTC,
        precioEntrada: '63378',
        lado: 'long',
        apalancamiento: 150,
        porcentaje
      });
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.motivo).toBe('porcentaje-invalido');
    }
  });

  it('un precio de entrada ilegible se rechaza como precio', () => {
    const r = precioTakeProfit({
      contrato: BTC,
      precioEntrada: '.',
      lado: 'long',
      apalancamiento: 150,
      porcentaje: '35'
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe('precio-invalido');
  });
});

/**
 * ELITE LAURA, 19-20/10/2026, PEPEUSDT en cobertura: short y long con entrada
 * 0,0000041092. Los precios son los que el panel envio de verdad.
 */
describe('ladoEquivocadoTakeProfit', () => {
  const ENTRADA = '0.0000041092';

  it('acepta los Take Profit que el panel envio al short, todos por debajo', () => {
    for (const tp of ['0.0000040805', '0.0000039217', '0.0000039256']) {
      expect(ladoEquivocadoTakeProfit('short', tp, [{ nombre: 'la entrada', precio: ENTRADA }])).toBeNull();
    }
  });

  it('rechaza en un short el precio del Take Profit del long: seria un Stop Loss', () => {
    const r = ladoEquivocadoTakeProfit('short', '0.0000041409', [{ nombre: 'la entrada', precio: ENTRADA }]);
    expect(r).toMatch(/por debajo de la entrada/);
  });

  it('rechaza en un long un precio por debajo de la entrada', () => {
    const r = ladoEquivocadoTakeProfit('long', '0.0000039256', [{ nombre: 'la entrada', precio: ENTRADA }]);
    expect(r).toMatch(/por encima de la entrada/);
  });

  it('rechaza un Take Profit que el precio actual ya paso', () => {
    const r = ladoEquivocadoTakeProfit('long', '0.0000041603', [
      { nombre: 'la entrada', precio: '0.0000041334' },
      { nombre: 'el precio actual', precio: '0.000004195' }
    ]);
    expect(r).toMatch(/precio actual/);
  });

  it('coincidir con la referencia tambien es rechazo', () => {
    expect(ladoEquivocadoTakeProfit('short', ENTRADA, [{ nombre: 'la entrada', precio: ENTRADA }])).not.toBeNull();
  });

  it('una referencia que no se conoce no se comprueba; un disparo ilegible si', () => {
    expect(ladoEquivocadoTakeProfit('short', '0.000004', [{ nombre: 'el precio actual', precio: null }])).toBeNull();
    expect(ladoEquivocadoTakeProfit('short', '.', [])).not.toBeNull();
  });
});

describe('takeProfitConPerdida: ELITE QLC, 28/10/2026', () => {
  /* Entrada promedio del short tras agregar. */
  const ENTRADA = '0.0000048531';

  it('rechaza el Take Profit de lo agregado, que cerraba en perdida', () => {
    const r = takeProfitConPerdida('short', '0.0000051223', [
      { nombre: 'la entrada promedio de la posición', precio: ENTRADA }
    ]);
    expect(r).toContain('pérdida');
    expect(r).toContain('No se envía');
  });

  it('deja pasar el de la posicion, que cerraba en positivo', () => {
    expect(
      takeProfitConPerdida('short', '0.000004828', [{ nombre: 'la entrada', precio: ENTRADA }])
    ).toBeNull();
  });

  it('rechaza el que gana en precio pero no cubre las comisiones', () => {
    /* Un 0,05 % por debajo: menos que el 0,12 % de abrir y cerrar. */
    expect(takeProfitConPerdida('long', '100.05', [{ nombre: 'la entrada', precio: '100' }])).not.toBeNull();
    expect(takeProfitConPerdida('long', '100.2', [{ nombre: 'la entrada', precio: '100' }])).toBeNull();
  });

  it('una referencia ilegible no se comprueba; un disparo ilegible siempre se rechaza', () => {
    expect(takeProfitConPerdida('long', '100.2', [{ nombre: 'la entrada', precio: null }])).toBeNull();
    expect(takeProfitConPerdida('long', 'abc', [{ nombre: 'la entrada', precio: '100' }])).not.toBeNull();
  });
});

describe('resultadoNetoEstimado', () => {
  it('cuadra con el historial de Bitget para los dos tramos del 28/10/2026', () => {
    const parcial = resultadoNetoEstimado('short', '0.0000048531', '0.0000051223', '4856000');
    const principal = resultadoNetoEstimado('short', '0.0000048531', '0.000004828', '6156000');
    /* Precio -1,307 y +0,155; con comisiones, un poco peor cada uno. */
    expect(Number(parcial)).toBeLessThan(-1.3);
    expect(Number(principal)).toBeGreaterThan(0.1);
    expect(Number(principal)).toBeLessThan(0.155);
  });

  it('null si falta un dato', () => {
    expect(resultadoNetoEstimado('long', null, '1', '1')).toBeNull();
  });
});
