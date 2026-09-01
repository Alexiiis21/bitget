/**
 * Almacen de posiciones vivas.
 *
 * Lo que se prueba aqui son las tres reglas de las que depende que el monitor
 * no mienta:
 *
 *   1. Una instantanea sustituye; una actualizacion toca una sola posicion.
 *   2. Un tamano de cero es un cierre, no una posicion vacia.
 *   3. El margen inicial es del panel y no lo puede tocar ninguna lectura del
 *      exchange -ni al alta, ni al cotejar, ni al reposicionar-.
 */
import { describe, expect, it, vi } from 'vitest';
import { AlmacenPosiciones } from '@main/domain/almacen-posiciones';
import type { Posicion } from '@shared/types';

const posicion = (parcial: Partial<Posicion> & Pick<Posicion, 'cuentaId' | 'simbolo' | 'lado'>): Posicion => ({
  tamano: '0.01',
  precioEntrada: '61250',
  precioLiquidacion: '58420',
  apalancamiento: 20,
  modoMargen: 'aislado',
  margen: '100',
  takeProfit: null,
  origen: 'rest',
  actualizadoEn: '2026-08-27T10:00:00.000Z',
  estado: 'viva',
  ...parcial
});

const tp = (precio: string, planId = 'plan-1'): { precio: string; porcentaje: number; planId: string } => ({
  precio,
  porcentaje: 30,
  planId
});

describe('instantanea', () => {
  it('da de alta lo que llega y lo devuelve como deriva', () => {
    const a = new AlmacenPosiciones();

    const derivas = a.aplicarInstantanea('sub-01', [posicion({ cuentaId: 'sub-01', simbolo: 'BTCUSDT', lado: 'long' })]);

    expect(a.tamano).toBe(1);
    expect(derivas).toHaveLength(1);
    expect(derivas[0]?.campo).toBe('alta');
  });

  it('cierra lo que estaba y ya no viene', () => {
    const a = new AlmacenPosiciones();
    a.aplicarInstantanea('sub-01', [posicion({ cuentaId: 'sub-01', simbolo: 'BTCUSDT', lado: 'long' })]);

    const derivas = a.aplicarInstantanea('sub-01', []);

    expect(a.tamano).toBe(0);
    expect(derivas.map((d) => d.campo)).toEqual(['cierre']);
  });

  it('no toca las posiciones de otra cuenta', () => {
    const a = new AlmacenPosiciones();
    a.aplicarInstantanea('sub-01', [posicion({ cuentaId: 'sub-01', simbolo: 'BTCUSDT', lado: 'long' })]);
    a.aplicarInstantanea('sub-02', [posicion({ cuentaId: 'sub-02', simbolo: 'BTCUSDT', lado: 'long' })]);

    a.aplicarInstantanea('sub-01', []);

    expect(a.cuentasConPosicion()).toEqual(['sub-02']);
  });

  it('long y short del mismo simbolo conviven: son dos posiciones', () => {
    const a = new AlmacenPosiciones();

    a.aplicarInstantanea('sub-01', [
      posicion({ cuentaId: 'sub-01', simbolo: 'BTCUSDT', lado: 'long' }),
      posicion({ cuentaId: 'sub-01', simbolo: 'BTCUSDT', lado: 'short' })
    ]);

    expect(a.tamano).toBe(2);
  });

  it('dos activos de la misma casilla son dos posiciones, no una que pisa a la otra', () => {
    const a = new AlmacenPosiciones();

    a.aplicarInstantanea('sub-01', [
      posicion({ cuentaId: 'sub-01', simbolo: 'BTCUSDT', lado: 'long' }),
      posicion({ cuentaId: 'sub-01', simbolo: 'ETHUSDT', lado: 'long' })
    ]);

    expect(a.deCuenta('sub-01').map((p) => p.simbolo).sort()).toEqual(['BTCUSDT', 'ETHUSDT']);
  });

  it('senala el campo concreto que no coincide', () => {
    const a = new AlmacenPosiciones();
    a.aplicarInstantanea('sub-01', [posicion({ cuentaId: 'sub-01', simbolo: 'BTCUSDT', lado: 'long' })]);

    const derivas = a.aplicarInstantanea('sub-01', [
      posicion({ cuentaId: 'sub-01', simbolo: 'BTCUSDT', lado: 'long', precioLiquidacion: '57000' })
    ]);

    expect(derivas).toHaveLength(1);
    expect(derivas[0]).toMatchObject({ campo: 'precioLiquidacion', enMemoria: '58420', enLectura: '57000' });
  });

  it('una lectura identica no produce deriva ni repinta', () => {
    const a = new AlmacenPosiciones();
    const p = posicion({ cuentaId: 'sub-01', simbolo: 'BTCUSDT', lado: 'long' });
    a.aplicarInstantanea('sub-01', [p]);

    const oyente = vi.fn();
    a.alCambiar(oyente);
    const derivas = a.aplicarInstantanea('sub-01', [p]);

    expect(derivas).toEqual([]);
    expect(oyente).not.toHaveBeenCalled();
  });

  it('descarta de la foto lo que viene con tamano cero', () => {
    const a = new AlmacenPosiciones();

    a.aplicarInstantanea('sub-01', [posicion({ cuentaId: 'sub-01', simbolo: 'BTCUSDT', lado: 'long', tamano: '0' })]);

    expect(a.tamano).toBe(0);
  });
});

describe('actualizacion suelta', () => {
  it('no borra las demas posiciones de la cuenta', () => {
    const a = new AlmacenPosiciones();
    a.aplicarInstantanea('sub-01', [
      posicion({ cuentaId: 'sub-01', simbolo: 'BTCUSDT', lado: 'long' }),
      posicion({ cuentaId: 'sub-01', simbolo: 'ETHUSDT', lado: 'long' })
    ]);

    a.aplicarActualizacion(posicion({ cuentaId: 'sub-01', simbolo: 'BTCUSDT', lado: 'long', tamano: '0.02' }));

    expect(a.tamano).toBe(2);
    expect(a.deCuenta('sub-01').find((p) => p.simbolo === 'BTCUSDT')?.tamano).toBe('0.02');
  });

  it('tamano cero es un cierre, no una posicion de tamano cero', () => {
    const a = new AlmacenPosiciones();
    a.aplicarInstantanea('sub-01', [posicion({ cuentaId: 'sub-01', simbolo: 'BTCUSDT', lado: 'long' })]);

    a.aplicarActualizacion(posicion({ cuentaId: 'sub-01', simbolo: 'BTCUSDT', lado: 'long', tamano: '0' }));

    expect(a.tamano).toBe(0);
  });
});

describe('take profit', () => {
  it('no lo borra una lectura de posiciones, que no lo trae', () => {
    const a = new AlmacenPosiciones();
    a.aplicarInstantanea('sub-01', [posicion({ cuentaId: 'sub-01', simbolo: 'BTCUSDT', lado: 'long' })]);
    a.fijarTakeProfit('sub-01', 'BTCUSDT', 'long', tp('63100'));

    a.aplicarInstantanea('sub-01', [
      posicion({ cuentaId: 'sub-01', simbolo: 'BTCUSDT', lado: 'long', tamano: '0.02' })
    ]);

    expect(a.deCuenta('sub-01')[0]?.takeProfit?.precio).toBe('63100');
  });

  it('el que llega antes que su posicion espera y se aplica al llegar', () => {
    const a = new AlmacenPosiciones();

    a.fijarTakeProfit('sub-01', 'BTCUSDT', 'long', tp('63100'));
    expect(a.tamano).toBe(0);

    a.aplicarInstantanea('sub-01', [posicion({ cuentaId: 'sub-01', simbolo: 'BTCUSDT', lado: 'long' })]);

    expect(a.deCuenta('sub-01')[0]?.takeProfit?.precio).toBe('63100');
  });

  it('el que espera a una posicion que la foto no trae se descarta', () => {
    const a = new AlmacenPosiciones();
    a.fijarTakeProfit('sub-01', 'BTCUSDT', 'long', tp('63100'));

    /* La foto dice que esa punta no existe: el plan pendiente era de una cerrada. */
    a.aplicarInstantanea('sub-01', []);
    a.aplicarInstantanea('sub-01', [posicion({ cuentaId: 'sub-01', simbolo: 'BTCUSDT', lado: 'long' })]);

    expect(a.deCuenta('sub-01')[0]?.takeProfit).toBeNull();
  });

  it('una relectura sin porcentaje no borra el que puso el panel', () => {
    const a = new AlmacenPosiciones();
    a.aplicarInstantanea('sub-01', [posicion({ cuentaId: 'sub-01', simbolo: 'BTCUSDT', lado: 'long' })]);
    a.fijarTakeProfit('sub-01', 'BTCUSDT', 'long', tp('63100'));

    /* Lo que devuelve el exchange: precio de disparo y nada mas. */
    a.fijarTakeProfit('sub-01', 'BTCUSDT', 'long', { precio: '63100', porcentaje: null, planId: 'plan-1' });

    expect(a.deCuenta('sub-01')[0]?.takeProfit?.porcentaje).toBe(30);
  });

  it('si el precio cambia, el porcentaje que se sabia ya no describe este plan', () => {
    const a = new AlmacenPosiciones();
    a.aplicarInstantanea('sub-01', [posicion({ cuentaId: 'sub-01', simbolo: 'BTCUSDT', lado: 'long' })]);
    a.fijarTakeProfit('sub-01', 'BTCUSDT', 'long', tp('63100'));

    a.fijarTakeProfit('sub-01', 'BTCUSDT', 'long', { precio: '64000', porcentaje: null, planId: 'plan-2' });

    expect(a.deCuenta('sub-01')[0]?.takeProfit?.porcentaje).toBeNull();
  });

  it('quitarlo lo deja en null', () => {
    const a = new AlmacenPosiciones();
    a.aplicarInstantanea('sub-01', [posicion({ cuentaId: 'sub-01', simbolo: 'BTCUSDT', lado: 'long' })]);
    a.fijarTakeProfit('sub-01', 'BTCUSDT', 'long', tp('63100'));

    a.fijarTakeProfit('sub-01', 'BTCUSDT', 'long', null);

    expect(a.deCuenta('sub-01')[0]?.takeProfit).toBeNull();
  });
});

describe('aporte del panel', () => {
  it('una posicion que ya estaba abierta al arrancar no tiene margen inicial', () => {
    const a = new AlmacenPosiciones();

    a.aplicarInstantanea('sub-01', [posicion({ cuentaId: 'sub-01', simbolo: 'BTCUSDT', lado: 'long' })]);

    expect(a.deCuenta('sub-01')[0]?.aporte).toBeNull();
  });

  it('sobrevive a las lecturas del exchange', () => {
    const a = new AlmacenPosiciones();
    a.aplicarInstantanea('sub-01', [posicion({ cuentaId: 'sub-01', simbolo: 'BTCUSDT', lado: 'long' })]);
    a.anotarAporte('sub-01', 'BTCUSDT', 'long', { margenInicial: '100' });

    a.aplicarInstantanea('sub-01', [
      posicion({ cuentaId: 'sub-01', simbolo: 'BTCUSDT', lado: 'long', margen: '250' })
    ]);

    const viva = a.deCuenta('sub-01')[0];
    expect(viva?.margen).toBe('250');
    expect(viva?.aporte?.margenInicial).toBe('100');
  });

  it('reposicionar suma, no sustituye', () => {
    const a = new AlmacenPosiciones();
    a.anotarAporte('sub-01', 'BTCUSDT', 'long', { margenInicial: '100' });
    a.anotarAporte('sub-01', 'BTCUSDT', 'long', { margenInicial: '50.5' });

    a.aplicarInstantanea('sub-01', [posicion({ cuentaId: 'sub-01', simbolo: 'BTCUSDT', lado: 'long' })]);

    expect(a.deCuenta('sub-01')[0]?.aporte?.margenInicial).toBe('150.5');
  });

  it('conserva el instante de la primera apertura al reposicionar', () => {
    const reloj = vi.fn<() => number>().mockReturnValue(Date.parse('2026-08-27T10:00:00.000Z'));
    const a = new AlmacenPosiciones({ ahora: reloj });

    a.anotarAporte('sub-01', 'BTCUSDT', 'long', { margenInicial: '100' });
    reloj.mockReturnValue(Date.parse('2026-08-27T12:00:00.000Z'));
    a.anotarAporte('sub-01', 'BTCUSDT', 'long', { margenInicial: '100' });

    a.aplicarInstantanea('sub-01', [posicion({ cuentaId: 'sub-01', simbolo: 'BTCUSDT', lado: 'long' })]);

    expect(a.deCuenta('sub-01')[0]?.aporte?.abiertaEn).toBe('2026-08-27T10:00:00.000Z');
  });

  it('anotar solo el margen adicional no inventa un margen inicial de cero', () => {
    const a = new AlmacenPosiciones();
    a.aplicarInstantanea('sub-01', [posicion({ cuentaId: 'sub-01', simbolo: 'BTCUSDT', lado: 'long' })]);

    a.anotarAporte('sub-01', 'BTCUSDT', 'long', { margenAdicional: '50' });

    const aporte = a.deCuenta('sub-01')[0]?.aporte;
    expect(aporte?.margenAdicional).toBe('50');
    expect(aporte?.margenInicial).toBeNull();
  });

  it('un aporte sin posicion no lo hereda una apertura posterior', () => {
    const a = new AlmacenPosiciones();

    /*
     * Una orden que quedo indeterminada anota su margen y no llega a abrir
     * nada. La primera foto que no la trae tiene que llevarselo por delante.
     */
    a.anotarAporte('sub-01', 'BTCUSDT', 'long', { margenInicial: '100' });
    a.aplicarInstantanea('sub-01', []);
    a.aplicarInstantanea('sub-01', [posicion({ cuentaId: 'sub-01', simbolo: 'BTCUSDT', lado: 'long' })]);

    expect(a.deCuenta('sub-01')[0]?.aporte).toBeNull();
  });

  it('se descarta al cerrarse la posicion: no lo hereda la siguiente', () => {
    const a = new AlmacenPosiciones();
    a.aplicarInstantanea('sub-01', [posicion({ cuentaId: 'sub-01', simbolo: 'BTCUSDT', lado: 'long' })]);
    a.anotarAporte('sub-01', 'BTCUSDT', 'long', { margenInicial: '100' });

    a.aplicarInstantanea('sub-01', []);
    a.aplicarInstantanea('sub-01', [posicion({ cuentaId: 'sub-01', simbolo: 'BTCUSDT', lado: 'long' })]);

    expect(a.deCuenta('sub-01')[0]?.aporte).toBeNull();
  });
});

describe('ciclo de vida', () => {
  it('bloquear el panel tira todo lo sabido', () => {
    const a = new AlmacenPosiciones();
    a.aplicarInstantanea('sub-01', [posicion({ cuentaId: 'sub-01', simbolo: 'BTCUSDT', lado: 'long' })]);
    a.anotarAporte('sub-01', 'BTCUSDT', 'long', { margenInicial: '100' });

    a.limpiar();

    expect(a.instantanea()).toEqual([]);
    expect(a.cuentasConPosicion()).toEqual([]);
  });

  it('dar de baja una subcuenta se lleva sus posiciones y deja las demas', () => {
    const a = new AlmacenPosiciones();
    a.aplicarInstantanea('sub-01', [posicion({ cuentaId: 'sub-01', simbolo: 'BTCUSDT', lado: 'long' })]);
    a.aplicarInstantanea('sub-02', [posicion({ cuentaId: 'sub-02', simbolo: 'BTCUSDT', lado: 'long' })]);

    a.olvidarCuenta('sub-01');

    expect(a.cuentasConPosicion()).toEqual(['sub-02']);
  });

  it('avisa una sola vez por cambio, y no cuando no hay ninguno', () => {
    const a = new AlmacenPosiciones();
    const oyente = vi.fn();
    a.alCambiar(oyente);

    a.aplicarInstantanea('sub-01', [posicion({ cuentaId: 'sub-01', simbolo: 'BTCUSDT', lado: 'long' })]);
    expect(oyente).toHaveBeenCalledTimes(1);

    a.cerrar('sub-01', 'ETHUSDT', 'long');
    expect(oyente).toHaveBeenCalledTimes(1);
  });
});
