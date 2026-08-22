/**
 * Traduccion de «100 USDT a 10x» a una cantidad que Bitget acepta.
 *
 * Es la funcion donde se pierde dinero por redondeo, asi que se prueba sola y
 * al detalle. El contrato de referencia es el **real**: los valores son los que
 * devolvio api.bitget.com para BTCUSDT el 12 de agosto de 2026, no valores
 * inventados que podrian no parecerse a los de produccion.
 */
import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { dimensionarApertura, UNIDAD_OPERACION } from '@main/domain/dimension-orden';
import type { Contrato } from '@main/bitget/rest/endpoints/simbolos';

const BTC: Contrato = {
  symbol: 'BTCUSDT',
  baseCoin: 'BTC',
  quoteCoin: 'USDT',
  minTradeNum: '0.0001',
  volumePlace: '4',
  pricePlace: '1',
  priceEndStep: '1',
  sizeMultiplier: '0.0001',
  minTradeUSDT: '5',
  minLever: '1',
  maxLever: '150',
  maxMarketOrderQty: '220',
  maxOrderQty: '1200',
  symbolStatus: 'normal'
};

const base = {
  contrato: BTC,
  precio: '63378',
  margenInicial: '100',
  apalancamiento: 10,
  saldoDisponible: '3000',
  aMercado: true
};

describe('unidad de operacion: Costo-USDT', () => {
  /*
   * El ejemplo literal que dio el cliente el 13/08/2026, con el que definio
   * como quiere que se interprete lo que teclea:
   *
   *   «10 USDT de margen inicial a 150x -> 10 x 150 = 1.500 USDT de posicion
   *    -> 1.500 / precio de BTC = cantidad de BTC -> se manda esa cantidad»
   *
   * Se prueba tal cual para que, si alguien cambia la formula, falle nombrando
   * la regla de negocio y no un numero suelto.
   */
  it('el panel trabaja en Costo-USDT y no en otra unidad', () => {
    expect(UNIDAD_OPERACION).toBe('costo-usdt');
  });

  it('10 USDT a 150x se convierten en la cantidad de BTC que pide la API', () => {
    const r = dimensionarApertura({ ...base, margenInicial: '10', apalancamiento: 150 });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    /* 10 x 150 = 1.500 ; 1.500 / 63.378 = 0,023667… ; truncado a 4 decimales. */
    expect(r.dimension.nocional).toBe(new Decimal('0.0236').times('63378').toFixed());
    expect(r.dimension.size).toBe('0.0236');
  });

  /* Lo que el operador teclea es margen, nunca el valor de la posicion. */
  it('el numero que se teclea es el margen, no el valor de la posicion', () => {
    const r = dimensionarApertura({ ...base, margenInicial: '10', apalancamiento: 150 });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Number(r.dimension.margenReal)).toBeLessThanOrEqual(10);
    expect(Number(r.dimension.nocional)).toBeGreaterThan(1400);
  });
});

describe('camino normal', () => {
  it('convierte margen y apalancamiento en cantidad', () => {
    const r = dimensionarApertura(base);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    /* 100 x 10 = 1000 USDT / 63.378 = 0,015778… -> truncado a 4 decimales. */
    expect(r.dimension.size).toBe('0.0157');
    expect(Number(r.dimension.nocional)).toBeCloseTo(995.03, 1);
  });

  /*
   * Redondear hacia arriba comprometeria mas margen del que el operador dijo, y
   * con cien cuentas eso es dinero que nadie autorizo. Truncar deja la posicion
   * un pelo por debajo: el error inofensivo de los dos.
   */
  it('trunca, nunca redondea hacia arriba', () => {
    const r = dimensionarApertura(base);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Number(r.dimension.margenReal)).toBeLessThanOrEqual(100);
  });

  it('la cantidad es siempre multiplo del paso del simbolo', () => {
    for (const margen of ['37', '100', '250.75', '999.99']) {
      const r = dimensionarApertura({ ...base, margenInicial: margen });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      const pasos = Number(r.dimension.size) / Number(BTC.sizeMultiplier);
      expect(Math.abs(pasos - Math.round(pasos))).toBeLessThan(1e-6);
    }
  });

  it('devuelve el margen que de verdad se compromete, no el pedido', () => {
    const r = dimensionarApertura(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dimension.margenReal).not.toBe('100');
  });
});

describe('el margen se comprueba antes que nada', () => {
  /*
   * Peticion explicita del cliente: de todos los motivos por los que una
   * apertura puede fallar, quedarse sin margen es el unico que ademas pone en
   * riesgo lo que ya estaba abierto.
   */
  it('sin saldo suficiente lo dice el margen, no otro motivo', () => {
    const r = dimensionarApertura({ ...base, saldoDisponible: '50' });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe('margen-insuficiente');
    expect(r.mensaje).toContain('50');
  });

  it('el margen manda incluso cuando tambien falla el apalancamiento', () => {
    const r = dimensionarApertura({ ...base, saldoDisponible: '0', apalancamiento: 999 });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe('margen-insuficiente');
  });

  it('rechaza un margen vacio o negativo', () => {
    for (const margen of ['', '0', '-10']) {
      const r = dimensionarApertura({ ...base, margenInicial: margen });
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.motivo).toBe('margen-invalido');
    }
  });
});

describe('lo que impone el simbolo', () => {
  it('rechaza un apalancamiento fuera del rango del contrato', () => {
    const r = dimensionarApertura({ ...base, apalancamiento: 200 });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe('apalancamiento-fuera-de-rango');
    expect(r.mensaje).toContain('150x');
  });

  it('no opera un simbolo que Bitget tiene suspendido', () => {
    const r = dimensionarApertura({ ...base, contrato: { ...BTC, symbolStatus: 'maintain' } });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe('simbolo-no-operable');
  });

  it('rechaza por debajo del nocional minimo', () => {
    /* 0,4 x 10 = 4 USDT, y Bitget exige 5. */
    const r = dimensionarApertura({ ...base, margenInicial: '0.4', saldoDisponible: '100' });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe('nocional-minimo');
  });

  /*
   * El caso traicionero: el nocional pedido supera el minimo, pero al truncar
   * la cantidad al paso del simbolo se queda por debajo. Sin esta comprobacion
   * la orden saldria y Bitget la rechazaria con un codigo generico.
   */
  it('vuelve a comprobar el nocional despues de truncar', () => {
    const caro: Contrato = { ...BTC, minTradeNum: '0.001', sizeMultiplier: '0.001', volumePlace: '3' };
    const r = dimensionarApertura({
      ...base,
      contrato: caro,
      margenInicial: '6',
      apalancamiento: 1,
      saldoDisponible: '1000'
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(['nocional-minimo', 'cantidad-minima']).toContain(r.motivo);
  });

  it('rechaza una cantidad por encima del maximo por orden', () => {
    const r = dimensionarApertura({
      ...base,
      margenInicial: '5000000',
      saldoDisponible: '9000000',
      apalancamiento: 10
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe('cantidad-maxima');
  });

  it('el tope depende de si la orden va a mercado o a limite', () => {
    /* 220 a mercado, 1200 a limite: una cantidad intermedia distingue los dos. */
    const peticion = {
      ...base,
      margenInicial: '3000000',
      saldoDisponible: '9000000',
      apalancamiento: 10
    };

    expect(dimensionarApertura({ ...peticion, aMercado: true }).ok).toBe(false);
    expect(dimensionarApertura({ ...peticion, aMercado: false }).ok).toBe(true);
  });

  it('rechaza un precio invalido en vez de dividir por cero', () => {
    for (const precio of ['', '0', '-1']) {
      const r = dimensionarApertura({ ...base, precio });
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.motivo).toBe('precio-invalido');
    }
  });
});

describe('precision', () => {
  /*
   * La aritmetica pasa por decimal.js y no por coma flotante. docs/03 §14: en
   * un precio de liquidacion, 0.1 + 0.2 !== 0.3 es un error que se descubre con
   * dinero real.
   */
  it('no arrastra error de coma flotante en el nocional', () => {
    const r = dimensionarApertura({
      ...base,
      contrato: {
        ...BTC,
        sizeMultiplier: '0.1',
        minTradeNum: '0.1',
        volumePlace: '1',
        minTradeUSDT: '0.1'
      },
      precio: '0.3',
      margenInicial: '0.1',
      apalancamiento: 3,
      saldoDisponible: '10'
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dimension.size).toBe('1');
    /* 1 x 0,3 exacto. Con coma flotante saldria 0.30000000000000004. */
    expect(r.dimension.nocional).toBe('0.3');
  });

  /*
   * Un activo barato produce cantidades de nueve cifras. Con `number` el
   * resultado empieza a perder unidades enteras; con decimal.js, no.
   */
  it('un activo de precio muy bajo no pierde unidades', () => {
    const pepe: Contrato = {
      ...BTC,
      symbol: 'PEPEUSDT',
      baseCoin: 'PEPE',
      minTradeNum: '1',
      sizeMultiplier: '1',
      volumePlace: '0',
      maxMarketOrderQty: '999999999999',
      maxOrderQty: '999999999999'
    };

    const r = dimensionarApertura({
      contrato: pepe,
      precio: '0.00000842',
      margenInicial: '100',
      apalancamiento: 10,
      saldoDisponible: '1000',
      aMercado: true
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dimension.size).toBe('118764845');
  });
});
