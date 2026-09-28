/**
 * Formato de cifras del monitor.
 *
 * Lo que se prueba es el fallo que reporto el cliente el 26/09/2026: con PEPE
 * -diez decimales de precio- la entrada, la liquidacion y el Take Profit salian
 * «0,00». La cifra llegaba bien del exchange; la pantalla la redondeaba a dos
 * decimales.
 */
import { describe, expect, it } from 'vitest';
import { decimalesDe, importe, precio, precioConSigno } from '@/lib/formato';
import { margenDe } from '@/features/panel/margen';
import type { Position } from '@shared/domain/panel-view';

describe('precio', () => {
  it('usa los decimales del activo cuando se conocen', () => {
    expect(precio('0.0000043575', 10)).toBe('0,0000043575');
    expect(precio('84398.08', 2)).toBe('84.398,08');
  });

  it('sin decimales del activo respeta los que trae la cadena', () => {
    expect(precio('0.0000068382')).toBe('0,0000068382');
    expect(precio('84594.9')).toBe('84.594,9');
  });

  it('un precio ausente sigue siendo un guion', () => {
    expect(precio('')).toBe('—');
    expect(precio(null, 10)).toBe('—');
  });

  it('la distancia L/S lleva signo y los decimales del activo', () => {
    expect(precioConSigno(0.0000000012, 10)).toBe('+0,0000000012');
  });

  it('cuenta los decimales de la cadena', () => {
    expect(decimalesDe('0.0000043575')).toBe(10);
    expect(decimalesDe('84398')).toBe(0);
    expect(decimalesDe(undefined)).toBe(2);
  });
});

describe('importe', () => {
  it('un margen pequeño no se lee como cero', () => {
    expect(importe('0.001')).toBe('0,001');
  });

  it('a partir de 1 USDT, dos decimales', () => {
    expect(importe('4.349')).toBe('4,35');
    expect(importe('1008.71')).toBe('1.008,71');
  });

  it('nunca menos de dos decimales', () => {
    expect(importe('0.06')).toBe('0,06');
    expect(importe('0')).toBe('0,00');
  });
});

describe('margenDe', () => {
  const punta = (initialMarginAccum: string | null, currentMargin: string | null) =>
    ({ initialMarginAccum, currentMargin }) as Position;

  it('prefiere el margen inicial que anoto el panel', () => {
    expect(margenDe(punta('0.06', '0.16'))).toMatchObject({ valor: '0,06', deBitget: false });
  });

  it('sin anotacion del panel, enseña el margen de Bitget y lo dice', () => {
    expect(margenDe(punta(null, '4.349'))).toMatchObject({ valor: '4,35', deBitget: true });
  });

  it('un guion solo si ninguno de los dos lo sabe', () => {
    expect(margenDe(punta(null, null))).toMatchObject({ valor: '—', deBitget: false });
  });
});
