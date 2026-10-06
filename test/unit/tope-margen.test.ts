/**
 * El tope de margen inicial, sin red ni disco.
 *
 * Es la regla que separa «escribi 5 queriendo 0,5» de una posicion diez veces
 * mas grande en cien casillas. Se prueba aparte porque se puede razonar sobre
 * ella sin levantar nada: la hora se le pasa, no la lee.
 */
import { describe, expect, it } from 'vitest';
import {
  comprobarContraTope,
  estadoTope,
  validarValorTope,
  type EstadoTope
} from '@main/domain/tope-margen';

const FIJADO = Date.parse('2026-10-06T09:00:00.000Z');
const DIA = 24 * 60 * 60 * 1000;
const TOPE = { valor: '1', fijadoEn: new Date(FIJADO).toISOString() };

describe('estadoTope', () => {
  it('sin tope guardado no hay tope', () => {
    expect(estadoTope(null, FIJADO)).toEqual({ estado: 'sin-tope' });
  });

  it('vigente hasta el ultimo milisegundo de las 24 horas', () => {
    const e = estadoTope(TOPE, FIJADO + DIA - 1);
    expect(e).toMatchObject({ estado: 'vigente', valor: '1' });
    if (e.estado !== 'sin-tope') expect(e.venceEn).toBe('2026-10-07T09:00:00.000Z');
  });

  it('vencido justo a las 24 horas', () => {
    expect(estadoTope(TOPE, FIJADO + DIA).estado).toBe('vencido');
  });

  it('un reloj atrasado lo deja vigente, que es el sentido seguro', () => {
    expect(estadoTope(TOPE, FIJADO - 7 * DIA).estado).toBe('vigente');
  });

  it('una fecha ilegible se trata como vencido: se pide otro', () => {
    expect(estadoTope({ valor: '1', fijadoEn: 'basura' }, FIJADO).estado).toBe('vencido');
  });
});

describe('validarValorTope', () => {
  it.each([
    ['0.5', '0.5'],
    ['10', '10'],
    [' 1.50 ', '1.5'],
    ['0.10', '0.1']
  ])('acepta %j como %j', (texto, valor) => {
    expect(validarValorTope(texto)).toEqual({ ok: true, valor });
  });

  it.each(['', '0', '0.0', '-1', 'abc', '1e3', '0,5', '1.000.000', '.5', '0.123456789'])(
    'rechaza %j',
    (texto) => {
      expect(validarValorTope(texto).ok).toBe(false);
    }
  );
});

describe('comprobarContraTope', () => {
  const vigente = estadoTope(TOPE, FIJADO + 1);

  it('sin tope no deja abrir', () => {
    expect(comprobarContraTope('0.1', { estado: 'sin-tope' })).toMatchObject({
      ok: false,
      motivo: 'sin-tope'
    });
  });

  it('vencido no deja abrir, ni por debajo del tope', () => {
    const vencido: EstadoTope = estadoTope(TOPE, FIJADO + DIA);
    expect(comprobarContraTope('0.1', vencido)).toMatchObject({
      ok: false,
      motivo: 'tope-vencido'
    });
  });

  it('el caso del dedo gordo: tope 1, escribe 5', () => {
    expect(comprobarContraTope('5', vigente)).toMatchObject({ ok: false, motivo: 'sobre-tope' });
  });

  it('igual o por debajo del tope, si', () => {
    expect(comprobarContraTope('1', vigente)).toEqual({ ok: true });
    expect(comprobarContraTope('0.5', vigente)).toEqual({ ok: true });
  });

  it('compara en decimal exacto, no en coma flotante', () => {
    const fino = estadoTope({ valor: '0.3', fijadoEn: TOPE.fijadoEn }, FIJADO + 1);
    expect(comprobarContraTope('0.30000000000000001', fino)).toMatchObject({
      ok: false,
      motivo: 'sobre-tope'
    });
    expect(comprobarContraTope('0.3', fino)).toEqual({ ok: true });
  });

  it('un margen ilegible no pasa', () => {
    expect(comprobarContraTope('abc', vigente)).toMatchObject({
      ok: false,
      motivo: 'margen-invalido'
    });
  });
});
