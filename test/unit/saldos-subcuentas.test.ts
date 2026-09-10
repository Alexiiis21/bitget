/**
 * La pantalla de saldos.
 *
 * Lo que se prueba aqui es que ninguna de las dos listas que se cruzan -las
 * subcuentas que reporta Bitget y las que el panel tiene dadas de alta- puede
 * hacer desaparecer a la otra. Una fila que falta en esta pantalla es dinero
 * que el operador no ve, y es el unico error grave que puede cometer.
 *
 * Y una regla aparte, que es la razon de ser de la funcion: el disponible y el
 * maximo transferible no son el mismo numero, y confundirlos propone traspasos
 * que Bitget rechaza.
 */
import { describe, expect, it } from 'vitest';
import { resumirSaldos } from '@main/domain/saldos-subcuentas';
import type { SaldosSubcuentas } from '@main/bitget/rest/endpoints/subcuentas';
import type { Cuenta } from '@shared/types';

const cuenta = (uid: string, etiqueta: string, id = `acc_${uid}`): Cuenta => ({
  id,
  grupoId: 'grp_1',
  etiqueta,
  uid,
  uidPadre: '1513226215',
  credencialId: `cred_${uid}`,
  apiKeyEnmascarada: 'bg••••4f2a',
  slot: 1,
  activa: true,
  modoPosicion: 'cobertura',
  modoMargen: 'aislado',
  accountMode: 'classic',
  holdMode: null,
  altaEn: '2026-09-03T00:00:00.000Z'
});

const reporte = (
  userId: string,
  available: string,
  maxTransferOut: string = available
): SaldosSubcuentas[number] => ({
  userId,
  assetList: [
    {
      marginCoin: 'USDT',
      available,
      maxTransferOut,
      accountEquity: available,
      usdtEquity: available,
      locked: '0',
      unrealizedPL: '0'
    }
  ]
});

describe('cruce de las dos listas', () => {
  it('mantiene el orden del panel y anade despues lo que solo esta en Bitget', () => {
    const r = resumirSaldos(
      [reporte('222', '20'), reporte('111', '10'), reporte('999', '90')],
      [cuenta('111', 'Sub 01'), cuenta('222', 'Sub 02')]
    );

    expect(r.filas.map((f) => f.etiqueta)).toEqual(['Sub 01', 'Sub 02', '999']);
    expect(r.filas[2]?.soloEnBitget).toBe(true);
    expect(r.filas[0]?.soloEnBitget).toBe(false);
  });

  it('una subcuenta que Bitget reporta y el panel no conoce se muestra, no se descarta', () => {
    const r = resumirSaldos([reporte('999', '90')], []);

    expect(r.filas).toHaveLength(1);
    expect(r.filas[0]).toMatchObject({
      uid: '999',
      cuentaId: null,
      soloEnBitget: true,
      disponible: '90'
    });
  });

  it('una cuenta del panel que la madre no reporta se marca sin datos, y no como cero', () => {
    const r = resumirSaldos([], [cuenta('111', 'Sub 01')]);

    expect(r.filas[0]).toMatchObject({
      etiqueta: 'Sub 01',
      sinDatos: true,
      disponible: null,
      maxTransferible: null
    });
    /* Cero diria «no tiene nada». null dice «no se sabe». No son lo mismo. */
    expect(r.filas[0]?.disponible).not.toBe('0');
  });

  it('no cuenta como dato una subcuenta sin la moneda que se opera', () => {
    const soloBtc: SaldosSubcuentas = [
      {
        userId: '111',
        assetList: [
          {
            marginCoin: 'BTC',
            available: '1',
            maxTransferOut: '1',
            accountEquity: '1',
            usdtEquity: '1',
            locked: '0',
            unrealizedPL: '0'
          }
        ]
      }
    ];

    const r = resumirSaldos(soloBtc, [cuenta('111', 'Sub 01')]);

    expect(r.filas[0]?.sinDatos).toBe(true);
    expect(r.conDatos).toBe(0);
  });
});

describe('disponible y maximo transferible', () => {
  it('no los confunde: el transferible puede ser menor que el disponible', () => {
    /* Una cuenta con posicion abierta: tiene 100, pero solo 40 pueden salir. */
    const r = resumirSaldos([reporte('111', '100', '40')], [cuenta('111', 'Sub 01')]);

    expect(r.filas[0]?.disponible).toBe('100');
    expect(r.filas[0]?.maxTransferible).toBe('40');
    expect(r.totalDisponible).toBe('100');
    expect(r.totalTransferible).toBe('40');
  });

  it('suma sin errores de coma flotante', () => {
    const r = resumirSaldos(
      [reporte('111', '0.1'), reporte('222', '0.2')],
      [cuenta('111', 'Sub 01'), cuenta('222', 'Sub 02')]
    );

    /* 0.1 + 0.2 con float daria 0.30000000000000004. */
    expect(r.totalDisponible).toBe('0.3');
  });

  /*
   * Desde la captura real del 04/09/2026, `maxTransferOut` es obligatorio en el
   * esquema: Bitget lo manda siempre. El unico camino que deja el transferible
   * en `null` es que la subcuenta no traiga la moneda que se opera, y por eso el
   * caso se construye asi y no quitando el campo.
   */
  it('trata el transferible desconocido como tal y no lo suma', () => {
    const otraMoneda: SaldosSubcuentas = [
      {
        userId: '111',
        assetList: [
          {
            marginCoin: 'BTC',
            available: '1',
            maxTransferOut: '1',
            accountEquity: '1',
            usdtEquity: '1',
            locked: '0',
            unrealizedPL: '0'
          }
        ]
      }
    ];

    const r = resumirSaldos(otraMoneda, [cuenta('111', 'Sub 01')]);

    expect(r.filas[0]?.maxTransferible).toBeNull();
    expect(r.totalTransferible).toBe('0');
  });
});

describe('identidad de la subcuenta', () => {
  it('cruza por UID aunque Bitget lo mande como numero', () => {
    /* El esquema normaliza a cadena; aqui se comprueba que el cruce lo aprovecha. */
    const r = resumirSaldos([reporte('5476143713', '50')], [cuenta('5476143713', 'Sub 01')]);

    expect(r.filas).toHaveLength(1);
    expect(r.filas[0]?.cuentaId).toBe('acc_5476143713');
    expect(r.filas[0]?.soloEnBitget).toBe(false);
  });
});
