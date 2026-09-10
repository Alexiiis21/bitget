/**
 * Reparto y recogida masiva.
 *
 * La propiedad que se prueba una y otra vez aquí es siempre la misma: **la suma
 * de las partes es exactamente el total**. Ni un céntimo de más —que sería
 * intentar mover dinero que el operador no aprobó— ni uno de menos —que sobre
 * cien subcuentas deja de ser un céntimo—.
 *
 * Y para el modo «igualar», que hace lo que su nombre dice: dejar los saldos al
 * mismo nivel, sin quitarle nada a quien ya está por encima.
 */
import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  ErrorReparto,
  partesIgualando,
  partesIguales,
  planificarRecogida,
  planificarReparto
} from '@main/domain/plan-reparto';
import type { FilaSaldo } from '@main/domain/saldos-subcuentas';

const fila = (parcial: Partial<FilaSaldo> & Pick<FilaSaldo, 'uid'>): FilaSaldo => ({
  cuentaId: `acc_${parcial.uid}`,
  etiqueta: `Sub-${parcial.uid}`,
  disponible: '100',
  maxTransferible: '100',
  equity: '100',
  soloEnBitget: false,
  sinDatos: false,
  ...parcial
});

const base = {
  id: 'plan1',
  uidMadre: '1513226215',
  etiquetaMadre: 'Cuenta Madre',
  moneda: 'USDT',
  ahora: '2026-09-03T10:00:00.000Z'
};

const suma = (xs: readonly { importe: string }[]): string =>
  xs.reduce((s, x) => s.plus(x.importe), new Decimal(0)).toString();

describe('partes iguales', () => {
  it('reparte un total divisible sin resto', () => {
    const p = partesIguales(new Decimal('90'), 3);

    expect(p.map((d) => d.toString())).toEqual(['30', '30', '30']);
  });

  /*
   * El caso que rompe la aritmética ingenua: 100/3 no tiene representación
   * exacta. Si cada parte se redondea por su cuenta, la suma no es 100.
   */
  it('reparte un total indivisible y la suma sigue siendo exacta', () => {
    const total = new Decimal('100');
    const p = partesIguales(total, 3);

    expect(p.reduce((s, d) => s.plus(d), new Decimal(0)).toString()).toBe('100');
    /* El sobrante va a las primeras, de unidad en unidad. */
    expect(p[0]?.gt(p[2] ?? 0)).toBe(true);
  });

  it.each([
    ['100', 3],
    ['0.00000001', 3],
    ['1', 7],
    ['12345.6789', 11],
    ['0.1', 3]
  ])('la suma de repartir %s entre %i es exacta', (total, n) => {
    const p = partesIguales(new Decimal(total), n);

    expect(p.reduce((s, d) => s.plus(d), new Decimal(0)).toString()).toBe(
      new Decimal(total).toString()
    );
  });

  /* Nunca se reparte de más: eso sería mover dinero que no se aprobó. */
  it('ninguna parte hace que la suma supere el total', () => {
    const total = new Decimal('10');
    const p = partesIguales(total, 3);

    expect(p.reduce((s, d) => s.plus(d), new Decimal(0)).lte(total)).toBe(true);
  });

  it('con cero destinos no reparte nada', () => {
    expect(partesIguales(new Decimal('100'), 0)).toEqual([]);
  });
});

describe('igualando saldos', () => {
  const nums = (xs: readonly string[]): Decimal[] => xs.map((x) => new Decimal(x));

  it('deja los saldos al mismo nivel cuando el total alcanza', () => {
    /* [10, 20, 30] + 30 → nivel 30 → reciben 20, 10 y 0. */
    const p = partesIgualando(new Decimal('30'), nums(['10', '20', '30']));

    expect(p.map((d) => d.toString())).toEqual(['20', '10', '0']);

    const finales = ['10', '20', '30'].map((s, i) => new Decimal(s).plus(p[i] ?? 0).toString());
    expect(finales).toEqual(['30', '30', '30']);
  });

  /*
   * Quien ya está por encima del nivel no recibe nada **y tampoco se le quita**:
   * este reparto solo añade. Quitarle saldo sería una operación que el operador
   * no ha pedido.
   */
  it('no le quita nada a la que ya está por encima', () => {
    const p = partesIgualando(new Decimal('20'), nums(['10', '50']));

    expect(p.map((d) => d.toString())).toEqual(['20', '0']);
    /* La segunda se queda en 50: nadie la toca. */
    expect(p[1]?.isZero()).toBe(true);
  });

  it('con el total justo para llenar solo a la más baja, solo llena esa', () => {
    /* [5, 100] + 10 → nivel 15, que no llega a 100. */
    const p = partesIgualando(new Decimal('10'), nums(['5', '100']));

    expect(p.map((d) => d.toString())).toEqual(['10', '0']);
  });

  it('reparte entre todas cuando parten del mismo saldo', () => {
    const p = partesIgualando(new Decimal('90'), nums(['10', '10', '10']));

    expect(p.map((d) => d.toString())).toEqual(['30', '30', '30']);
  });

  it.each([
    ['100', ['10', '20', '30']],
    ['1', ['0', '0', '0']],
    ['0.1', ['1.23456789', '2', '0.5']],
    ['7777.7777', ['0', '1000', '250.5', '3']]
  ])('la suma de repartir %s igualando es exacta', (total, saldos) => {
    const p = partesIgualando(new Decimal(total), nums(saldos));

    expect(p.reduce((s, d) => s.plus(d), new Decimal(0)).toString()).toBe(
      new Decimal(total).toString()
    );
  });

  it('sin saldos no reparte nada', () => {
    expect(partesIgualando(new Decimal('100'), [])).toEqual([]);
  });
});

describe('plan de reparto', () => {
  const tres = [
    fila({ uid: '1', disponible: '10' }),
    fila({ uid: '2', disponible: '20' }),
    fila({ uid: '3', disponible: '30' })
  ];

  it('reparte desde la madre a cada subcuenta elegida', () => {
    const plan = planificarReparto(
      { ...base, destinos: ['1', '2', '3'], total: '90', modo: 'iguales' },
      tres
    );

    expect(plan.tipo).toBe('reparto');
    expect(plan.movimientos).toHaveLength(3);
    expect(plan.total).toBe('90');
    expect(suma(plan.movimientos)).toBe('90');

    for (const m of plan.movimientos) {
      expect(m.uidOrigen).toBe('1513226215');
      expect(m.importe).toBe('30');
    }
  });

  it('calcula el saldo resultante de cada subcuenta', () => {
    const plan = planificarReparto(
      { ...base, destinos: ['1', '2'], total: '20', modo: 'iguales' },
      tres
    );

    expect(plan.movimientos[0]).toMatchObject({ antes: '10', importe: '10', despues: '20' });
    expect(plan.movimientos[1]).toMatchObject({ antes: '20', importe: '10', despues: '30' });
  });

  it('igualando, deja fuera a la que ya está por encima y lo dice', () => {
    const plan = planificarReparto(
      { ...base, destinos: ['1', '2', '3'], total: '30', modo: 'igualar' },
      tres
    );

    expect(plan.movimientos.map((m) => m.etiquetaDestino)).toEqual(['Sub-1', 'Sub-2']);
    expect(plan.descartes).toHaveLength(1);
    expect(plan.descartes[0]).toMatchObject({ etiqueta: 'Sub-3', motivo: 'ya-por-encima' });
    expect(suma(plan.movimientos)).toBe('30');
  });

  it('cada movimiento lleva su propio identificador, y no se repiten', () => {
    const plan = planificarReparto(
      { ...base, destinos: ['1', '2', '3'], total: '90', modo: 'iguales' },
      tres
    );

    const oids = plan.movimientos.map((m) => m.clientOid);
    expect(new Set(oids).size).toBe(oids.length);
    for (const oid of oids) expect(oid).toContain('plan1');
  });

  it('descarta la subcuenta sin datos en vez de meterle dinero a ciegas', () => {
    const conHueco = [tres[0]!, fila({ uid: '2', disponible: null, sinDatos: true })];
    const plan = planificarReparto(
      { ...base, destinos: ['1', '2'], total: '10', modo: 'iguales' },
      conHueco
    );

    expect(plan.movimientos).toHaveLength(1);
    expect(plan.descartes[0]).toMatchObject({ etiqueta: 'Sub-2', motivo: 'sin-datos' });
    /* Y el total se reparte entero entre las que quedan. */
    expect(suma(plan.movimientos)).toBe('10');
  });

  it.each([
    ['un importe de cero', '0'],
    ['un importe negativo', '-50'],
    ['texto', 'abc']
  ])('rechaza %s', (_caso, total) => {
    expect(() =>
      planificarReparto({ ...base, destinos: ['1'], total, modo: 'iguales' }, tres)
    ).toThrow(ErrorReparto);
  });

  it('rechaza un reparto sin destinos', () => {
    expect(() =>
      planificarReparto({ ...base, destinos: [], total: '10', modo: 'iguales' }, tres)
    ).toThrow(ErrorReparto);
  });
});

describe('plan de recogida', () => {
  it('recoge el maximo transferible de cada subcuenta, no su saldo', () => {
    /* Sub-2 tiene 100 pero solo 40 pueden salir: el resto está en posiciones. */
    const filas = [
      fila({ uid: '1', disponible: '50', maxTransferible: '50' }),
      fila({ uid: '2', disponible: '100', maxTransferible: '40' })
    ];

    const plan = planificarRecogida({ ...base, origenes: ['1', '2'] }, filas);

    expect(plan.tipo).toBe('recogida');
    expect(plan.movimientos.map((m) => m.importe)).toEqual(['50', '40']);
    expect(plan.total).toBe('90');
    for (const m of plan.movimientos) expect(m.uidDestino).toBe('1513226215');
  });

  it('descarta la que no tiene nada que mover, con el motivo', () => {
    const filas = [
      fila({ uid: '1', maxTransferible: '10' }),
      fila({ uid: '2', disponible: '80', maxTransferible: '0' })
    ];

    const plan = planificarRecogida({ ...base, origenes: ['1', '2'] }, filas);

    expect(plan.movimientos).toHaveLength(1);
    expect(plan.descartes[0]).toMatchObject({ etiqueta: 'Sub-2', motivo: 'importe-cero' });
  });

  it('descarta la que no informa de su transferible', () => {
    const filas = [fila({ uid: '1', maxTransferible: null })];

    expect(() => planificarRecogida({ ...base, origenes: ['1'] }, filas)).toThrow(ErrorReparto);
  });

  it('no planifica una recogida sin subcuentas', () => {
    expect(() => planificarRecogida({ ...base, origenes: [] }, [])).toThrow(ErrorReparto);
  });
});
