/**
 * ROE del Centro de Monitoreo.
 *
 * La prueba que manda es la primera: reproduce la captura del cliente con la que
 * se dedujo sobre que margen calcula Bitget el ROE -la misma que documenta
 * `domain/precio-take-profit.ts`-, y es la que habria cazado el fallo del
 * 10/09/2026, cuando el divisor era el margen de ahora y el panel enseñaba un
 * numero que no coincidia con la app en cuanto se agregaba margen.
 *
 * El resto cubre las formas de «no se sabe»: ninguna puede salir como cero, que
 * en una columna de rentabilidad se lee como «no gana nada».
 */
import { describe, expect, it } from 'vitest';
import { margenInicialDe, roeDe } from '@main/domain/roe';

describe('margenInicialDe', () => {
  it('es cantidad x entrada / apalancamiento', () => {
    /* 0,01 BTC a 61.250 con 20x = 612,50 de nocional / 20 = 30,625. */
    expect(margenInicialDe('0.01', '61250', 20)?.toFixed()).toBe('30.625');
  });

  it('no lo forma sin apalancamiento utilizable', () => {
    expect(margenInicialDe('0.01', '61250', 0)).toBeNull();
    expect(margenInicialDe('0.01', '61250', -20)).toBeNull();
    expect(margenInicialDe('0.01', '61250', Number.NaN)).toBeNull();
  });

  it('no lo forma con un factor ausente o que no es un numero', () => {
    expect(margenInicialDe('', '61250', 20)).toBeNull();
    expect(margenInicialDe('0.01', '', 20)).toBeNull();
    /* `new Decimal('.')` lanza: la incidencia del 05/09/2026. */
    expect(margenInicialDe('.', '61250', 20)).toBeNull();
    expect(margenInicialDe('0.01', 'abc', 20)).toBeNull();
  });
});

describe('roeDe', () => {
  /*
   * La captura del cliente, en PEPEUSDT a 75x: el Take Profit al 35 % se situa
   * con el margen inicial, asi que la columna ROE tiene que llegar justo al 35
   * cuando el precio toca ese disparo. Con el divisor viejo -el margen de ahora,
   * 1.008,71 tras el aporte adicional- salia 0,30 %.
   */
  it('mide sobre el margen inicial, no sobre el margen de ahora', () => {
    const margenInicial = 8.71;
    const pnl = String(margenInicial * 0.35);

    /* Cantidad y entrada que producen ese margen inicial a 75x. */
    const roe = roeDe(pnl, String((margenInicial * 75) / 0.0000026184), '0.0000026184', 75);

    expect(roe).toBeCloseTo(35, 6);
  });

  it('no lo mueve el margen que la posicion tenga ahora', () => {
    /*
     * Agregar margen adicional no cambia ninguno de los tres factores, asi que
     * el ROE es el mismo antes y despues. Es lo que hace la app, y lo que el
     * divisor viejo rompia: ahi el mismo P&L caia al ritmo del margen añadido.
     */
    const conMargenAgregado = roeDe('10', '0.01', '61250', 20);
    expect(conMargenAgregado).toBeCloseTo((10 / 30.625) * 100, 9);
  });

  it('sale negativo en perdidas', () => {
    expect(roeDe('-15.3125', '0.01', '61250', 20)).toBeCloseTo(-50, 9);
  });

  it('es cero solo cuando el P&L es cero de verdad', () => {
    expect(roeDe('0', '0.01', '61250', 20)).toBe(0);
  });

  it('es null sin P&L: Bitget no lo mando en esta lectura', () => {
    expect(roeDe('', '0.01', '61250', 20)).toBeNull();
  });

  it('es null cuando no se puede formar el divisor, nunca cero', () => {
    expect(roeDe('12.5', '0.01', '61250', 0)).toBeNull();
    expect(roeDe('12.5', '', '61250', 20)).toBeNull();
    expect(roeDe('12.5', '0.01', '', 20)).toBeNull();
  });

  /*
   * Una cuenta UTA sin `marginSize`. Antes daba un guion permanente porque el
   * divisor era ese campo ausente; ahora se deriva de lo que V3 si manda.
   */
  it('lo calcula en una posicion UTA que no trae el margen', () => {
    expect(roeDe('12.5', '0.01', '61250', 20)).toBeCloseTo((12.5 / 30.625) * 100, 9);
  });
});
