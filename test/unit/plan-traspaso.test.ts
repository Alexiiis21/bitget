/**
 * El plan de un traspaso: lo que el operador aprueba antes de mover dinero.
 *
 * Lo que se prueba aquí es la frontera que impide enviar un movimiento que
 * Bitget rechazaría, y que los saldos resultantes que se enseñan en la
 * confirmación sean los de verdad. Es la última pantalla que alguien mira antes
 * de que salga el dinero: un número mal calculado aquí se aprueba sin más.
 */
import { describe, expect, it } from 'vitest';
import { ErrorTraspaso, planificarTraspaso } from '@main/domain/plan-traspaso';
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
  uidMadre: '1513226215',
  etiquetaMadre: 'Madre',
  moneda: 'USDT',
  clientOid: 'pcb-tr-001',
  id: 'plan-1',
  ahora: '2026-09-03T10:00:00.000Z'
};

const planificar = (importe: string, filas: FilaSaldo[], origen = '111', destino = '222') =>
  planificarTraspaso({ ...base, uidOrigen: origen, uidDestino: destino, importe }, filas);

const dos = (o: Partial<FilaSaldo> = {}, d: Partial<FilaSaldo> = {}): FilaSaldo[] => [
  fila({ uid: '111', ...o }),
  fila({ uid: '222', ...d })
];

describe('saldos resultantes', () => {
  it('resta del origen y suma al destino', () => {
    const p = planificar('30', dos({ disponible: '100' }, { disponible: '50' }));

    expect(p.origen).toMatchObject({ antes: '100', despues: '70' });
    expect(p.destino).toMatchObject({ antes: '50', despues: '80' });
    expect(p.importe).toBe('30');
  });

  it('no arrastra errores de coma flotante', () => {
    const p = planificar('0.1', dos({ disponible: '0.3' }, { disponible: '0.2' }));

    /* Con float, 0.3 - 0.1 daría 0.19999999999999998. */
    expect(p.origen.despues).toBe('0.2');
    expect(p.destino.despues).toBe('0.3');
  });

  /*
   * El dinero llega igual a un destino del que no se sabe el saldo, pero no se
   * puede decir cómo queda. Inventarlo sumando sobre un cero no confirmado sería
   * enseñar una cifra falsa en la pantalla de confirmación.
   */
  it('deja vacío el saldo del destino cuando no se conoce, en vez de inventarlo', () => {
    const p = planificar('30', dos({}, { disponible: null, sinDatos: true }));

    expect(p.destino.antes).toBe('');
    expect(p.destino.despues).toBe('');
    /* Y aun así el traspaso se planifica: el dinero sí puede llegar. */
    expect(p.importe).toBe('30');
  });
});

describe('el máximo transferible manda', () => {
  it('deja pasar un importe igual al máximo', () => {
    const p = planificar('40', dos({ disponible: '100', maxTransferible: '40' }));

    expect(p.importe).toBe('40');
    expect(p.maxTransferible).toBe('40');
  });

  /*
   * El caso que justifica toda la pantalla: hay saldo de sobra, pero está
   * comprometido en posiciones abiertas y no puede salir.
   */
  it('rechaza lo que supera el transferible aunque haya saldo', () => {
    expect(() => planificar('80', dos({ disponible: '100', maxTransferible: '40' }))).toThrow(
      ErrorTraspaso
    );

    try {
      planificar('80', dos({ disponible: '100', maxTransferible: '40' }));
    } catch (e) {
      expect((e as ErrorTraspaso).motivo).toBe('supera-transferible');
      /* El mensaje dice el número y por qué, no solo que no se puede. */
      expect((e as ErrorTraspaso).message).toContain('40');
      expect((e as ErrorTraspaso).message).toMatch(/posiciones abiertas/);
    }
  });

  it('no planifica si Bitget no informa del transferible', () => {
    try {
      planificar('10', dos({ maxTransferible: null }));
      throw new Error('debió rechazar');
    } catch (e) {
      expect((e as ErrorTraspaso).motivo).toBe('sin-transferible');
    }
  });

  it('no planifica desde una subcuenta sin datos', () => {
    try {
      planificar('10', dos({ disponible: null, sinDatos: true }));
      throw new Error('debió rechazar');
    } catch (e) {
      expect((e as ErrorTraspaso).motivo).toBe('origen-sin-datos');
    }
  });
});

describe('importes que no son importes', () => {
  it.each([
    ['texto', 'abc', 'importe-invalido'],
    ['vacío', '', 'importe-invalido'],
    ['negativo', '-10', 'importe-invalido'],
    ['cero', '0', 'importe-cero']
  ])('rechaza un importe %s', (_caso, importe, motivo) => {
    try {
      planificar(importe, dos());
      throw new Error('debió rechazar');
    } catch (e) {
      expect((e as ErrorTraspaso).motivo).toBe(motivo);
    }
  });

  /* NaN e Infinity llegarían hasta la resta y pintarían un saldo absurdo. */
  it.each([['NaN'], ['Infinity'], ['-Infinity']])('rechaza %s', (importe) => {
    try {
      planificar(importe, dos());
      throw new Error('debió rechazar');
    } catch (e) {
      expect((e as ErrorTraspaso).motivo).toBe('importe-invalido');
    }
  });
});

describe('origen y destino', () => {
  it('rechaza traspasar una subcuenta a sí misma', () => {
    try {
      planificar('10', dos(), '111', '111');
      throw new Error('debió rechazar');
    } catch (e) {
      expect((e as ErrorTraspaso).motivo).toBe('mismo-origen-y-destino');
    }
  });

  it('rechaza un origen que la cuenta principal no reporta', () => {
    try {
      planificar('10', dos(), '999', '222');
      throw new Error('debió rechazar');
    } catch (e) {
      expect((e as ErrorTraspaso).motivo).toBe('origen-desconocido');
    }
  });

  it('rechaza un destino que la cuenta principal no reporta', () => {
    try {
      planificar('10', dos(), '111', '999');
      throw new Error('debió rechazar');
    } catch (e) {
      expect((e as ErrorTraspaso).motivo).toBe('destino-desconocido');
    }
  });

  /*
   * Una subcuenta que Bitget reporta pero el panel no tiene dada de alta sirve
   * igual: el traspaso se firma con la clave de la madre, no con la suya.
   */
  it('admite una subcuenta que no está dada de alta en el panel', () => {
    const p = planificar('10', dos({}, { soloEnBitget: true, cuentaId: null }));

    expect(p.destino.uid).toBe('222');
  });
});

/*
 * La cuenta principal es una punta más, en los dos sentidos. Estaba fuera de los
 * dos desplegables y meter dinero en una subcuenta concreta solo se podía hacer
 * por el reparto masivo. Pedido por el operador el 05/09/2026.
 */
describe('la cuenta principal como punta', () => {
  it('reparte de la madre a una subcuenta y enseña cómo queda la subcuenta', () => {
    const p = planificar('30', dos({}, { disponible: '50' }), base.uidMadre, '222');

    expect(p.origen.uid).toBe(base.uidMadre);
    expect(p.origen.etiqueta).toBe('Madre');
    expect(p.destino).toMatchObject({ antes: '50', despues: '80' });
  });

  /*
   * Sin el saldo de la madre -no viene con el de las subcuentas- su antes y su
   * después van vacíos en vez de inventados, igual que un destino sin datos. Y
   * sin `maxTransferOut` no hay máximo que comprobar: eso lo valida Bitget.
   */
  it('el saldo de la madre va vacío, no inventado, y no hay máximo que comprobar', () => {
    const p = planificar('999999', dos(), base.uidMadre, '222');

    expect(p.origen.antes).toBe('');
    expect(p.origen.despues).toBe('');
    expect(p.maxTransferible).toBe('');
    expect(p.importe).toBe('999999');
  });

  /*
   * Cuando sí se conoce -se lee aparte, de `mix/account/accounts`- se enseña su
   * antes y su después. Sigue sin haber máximo transferible: son dos datos
   * distintos y Bitget solo informa del segundo para las subcuentas.
   */
  it('con el saldo de la madre conocido, se enseña su antes y su después', () => {
    const p = planificarTraspaso(
      {
        ...base,
        uidOrigen: base.uidMadre,
        uidDestino: '222',
        importe: '30',
        disponibleMadre: '500'
      },
      dos({}, { disponible: '50' })
    );

    expect(p.origen).toMatchObject({ antes: '500', despues: '470' });
    expect(p.destino).toMatchObject({ antes: '50', despues: '80' });
    /* Conocer el saldo no es conocer el tope: eso lo sigue validando Bitget. */
    expect(p.maxTransferible).toBe('');
  });

  it('recogiendo hacia la madre, su saldo conocido también se enseña', () => {
    const p = planificarTraspaso(
      {
        ...base,
        uidOrigen: '111',
        uidDestino: base.uidMadre,
        importe: '40',
        disponibleMadre: '500'
      },
      dos({ disponible: '100', maxTransferible: '40' })
    );

    expect(p.destino).toMatchObject({ antes: '500', despues: '540' });
  });

  it('recoge de una subcuenta a la madre, y ahí sí manda el máximo transferible', () => {
    const p = planificar('40', dos({ disponible: '100', maxTransferible: '40' }), '111', base.uidMadre);

    expect(p.destino.uid).toBe(base.uidMadre);
    expect(p.origen).toMatchObject({ antes: '100', despues: '60' });
    expect(p.destino.antes).toBe('');

    try {
      planificar('41', dos({ disponible: '100', maxTransferible: '40' }), '111', base.uidMadre);
      throw new Error('debió rechazar');
    } catch (e) {
      expect((e as ErrorTraspaso).motivo).toBe('supera-transferible');
    }
  });

  it('rechaza la madre contra sí misma', () => {
    try {
      planificar('10', dos(), base.uidMadre, base.uidMadre);
      throw new Error('debió rechazar');
    } catch (e) {
      expect((e as ErrorTraspaso).motivo).toBe('mismo-origen-y-destino');
    }
  });
});
