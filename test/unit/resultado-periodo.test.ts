/**
 * El resultado de un periodo, sin red ni disco: qué días abarca, qué
 * operaciones entran y cuánto suman.
 */
import { describe, expect, it } from 'vitest';
import {
  completitud,
  filtrarPorCierre,
  rangoDePeriodo,
  resumir
} from '@shared/resultado-periodo';

const iso = (ms: number): string => new Date(ms).toISOString();

describe('rangoDePeriodo', () => {
  it('del 1 al 7 de agosto en México: de las 00:00 del 1 a las 00:00 del 8, hora local', () => {
    const r = rangoDePeriodo({ desde: '2026-08-01', hasta: '2026-08-07' }, 'America/Mexico_City');
    expect(iso(r.inicioMs)).toBe('2026-08-01T06:00:00.000Z');
    expect(iso(r.finMs)).toBe('2026-08-08T06:00:00.000Z');
  });

  it('un solo día es el día completo', () => {
    const r = rangoDePeriodo({ desde: '2026-10-13', hasta: '2026-10-13' }, 'UTC');
    expect(iso(r.inicioMs)).toBe('2026-10-13T00:00:00.000Z');
    expect(iso(r.finMs)).toBe('2026-10-14T00:00:00.000Z');
  });

  it('cruza fin de mes y de año', () => {
    const r = rangoDePeriodo({ desde: '2026-12-31', hasta: '2026-12-31' }, 'UTC');
    expect(iso(r.finMs)).toBe('2027-01-01T00:00:00.000Z');
  });

  it('respeta el cambio de horario: el día del cambio dura 23 horas', () => {
    const r = rangoDePeriodo({ desde: '2026-03-08', hasta: '2026-03-08' }, 'America/New_York');
    expect(iso(r.inicioMs)).toBe('2026-03-08T05:00:00.000Z');
    expect(iso(r.finMs)).toBe('2026-03-09T04:00:00.000Z');
  });

  it('rechaza una fecha que no existe', () => {
    expect(() => rangoDePeriodo({ desde: '2026-02-30', hasta: '2026-03-01' }, 'UTC')).toThrow(
      expect.objectContaining({ motivo: 'fecha-invalida' })
    );
    expect(() => rangoDePeriodo({ desde: '1/8/2026', hasta: '2026-08-07' }, 'UTC')).toThrow(
      expect.objectContaining({ motivo: 'fecha-invalida' })
    );
  });

  it('rechaza un periodo invertido', () => {
    expect(() => rangoDePeriodo({ desde: '2026-08-07', hasta: '2026-08-01' }, 'UTC')).toThrow(
      expect.objectContaining({ motivo: 'orden-invertido' })
    );
  });
});

describe('filtrarPorCierre', () => {
  const rango = rangoDePeriodo({ desde: '2026-08-01', hasta: '2026-08-07' }, 'UTC');
  const en = (id: string, cuando: string) => ({ id, cerradaEnMs: Date.parse(cuando) });

  it('entra lo que cierra desde las 00:00 del primer día; no lo que cierra a las 00:00 del siguiente al último', () => {
    const posiciones = [
      en('antes', '2026-07-31T23:59:59.999Z'),
      en('primera', '2026-08-01T00:00:00.000Z'),
      en('medio', '2026-08-04T12:00:00.000Z'),
      en('ultima', '2026-08-07T23:59:59.999Z'),
      en('despues', '2026-08-08T00:00:00.000Z')
    ];
    expect(filtrarPorCierre(posiciones, rango).map((p) => p.id)).toEqual([
      'ultima',
      'medio',
      'primera'
    ]);
  });

  it('sin rango devuelve todo, de la más reciente a la más antigua', () => {
    const posiciones = [en('a', '2026-01-01T00:00:00Z'), en('b', '2026-06-01T00:00:00Z')];
    expect(filtrarPorCierre(posiciones, null).map((p) => p.id)).toEqual(['b', 'a']);
  });
});

describe('resumir', () => {
  it('el ejemplo del presupuesto: 8 operaciones, 5 ganadoras, 3 perdedoras, +61.60', () => {
    const resultados = ['25.10', '18.40', '-12.30', '9.75', '30.00', '-4.15', '-15.20', '10.00'];
    const r = resumir(resultados.map((resultado) => ({ resultado })));
    expect(r).toEqual({
      total: 8,
      ganadoras: 5,
      perdedoras: 3,
      enCero: 0,
      resultadoNeto: '61.6'
    });
  });

  it('suma exacta, sin error de coma flotante', () => {
    const r = resumir(Array.from({ length: 10 }, () => ({ resultado: '0.1' })));
    expect(r.resultadoNeto).toBe('1');
    expect(resumir([{ resultado: '0.1' }, { resultado: '0.2' }]).resultadoNeto).toBe('0.3');
  });

  it('las de resultado cero se cuentan aparte y el total cuadra', () => {
    const r = resumir([{ resultado: '0' }, { resultado: '1' }, { resultado: '-0.00000001' }]);
    expect(r).toMatchObject({ total: 3, ganadoras: 1, perdedoras: 1, enCero: 1 });
    expect(r.ganadoras + r.perdedoras + r.enCero).toBe(r.total);
  });

  it('con los resultados reales capturados en la Fase 1', () => {
    /* netProfit de cuatro posiciones UTA reales del 12/10/2026. */
    const r = resumir([
      { resultado: '-0.05091983' },
      { resultado: '-0.01692183' },
      { resultado: '-0.19276962' },
      { resultado: '0.01830735' }
    ]);
    expect(r).toMatchObject({ ganadoras: 1, perdedoras: 3, resultadoNeto: '-0.24230393' });
  });

  it('sin operaciones, todo a cero', () => {
    expect(resumir([])).toEqual({
      total: 0,
      ganadoras: 0,
      perdedoras: 0,
      enCero: 0,
      resultadoNeto: '0'
    });
  });
});

describe('completitud', () => {
  const rango = { inicioMs: 1_000, finMs: 2_000 };

  it('nunca sincronizada: incompleto por los dos lados', () => {
    expect(completitud(rango, null, 5_000)).toEqual({
      completo: false,
      faltaAntes: true,
      faltaDespues: true
    });
  });

  it('cobertura que abarca el periodo: completo', () => {
    expect(completitud(rango, { desdeMs: 500, hastaMs: 3_000 }, 5_000).completo).toBe(true);
  });

  it('el periodo empieza antes de lo sincronizado', () => {
    expect(completitud(rango, { desdeMs: 1_500, hastaMs: 3_000 }, 5_000)).toMatchObject({
      completo: false,
      faltaAntes: true,
      faltaDespues: false
    });
  });

  it('el periodo sigue después de la última sincronización', () => {
    expect(completitud(rango, { desdeMs: 500, hastaMs: 1_800 }, 5_000)).toMatchObject({
      completo: false,
      faltaAntes: false,
      faltaDespues: true
    });
  });

  it('un periodo que acaba en el futuro está completo si lo está hasta ahora', () => {
    expect(completitud(rango, { desdeMs: 500, hastaMs: 1_600 }, 1_600).completo).toBe(true);
  });
});
