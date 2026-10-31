/**
 * El lector del saldo vigente: una lectura por cuenta, caché de cinco segundos,
 * y nada de lo leído sobrevive a bloquear el panel o a dar de baja la cuenta.
 */
import { describe, expect, it } from 'vitest';
import { LectorSaldo, SALDO_VIGENCIA_MS, type SaldoCuenta } from '@main/historial/lector-saldo';

const saldo = (cuentaId: string, leidoEn: number, disponible = '100'): SaldoCuenta => ({
  cuentaId,
  moneda: 'USDT',
  equity: disponible,
  disponible,
  bloqueado: '0',
  leidoEn,
  superficie: 'v2'
});

function montar() {
  let ahora = 1_000_000;
  let lecturas = 0;
  let soltar: (() => void) | null = null;
  let frenar = false;
  const lector = new LectorSaldo({
    ahoraMs: () => ahora,
    leer: async (cuentaId) => {
      lecturas++;
      const leidoEn = ahora;
      if (frenar) {
        await new Promise<void>((r) => {
          soltar = r;
        });
      }
      return saldo(cuentaId, leidoEn, String(lecturas));
    }
  });
  return {
    lector,
    lecturas: () => lecturas,
    avanzar: (ms: number) => {
      ahora += ms;
    },
    frenar: () => {
      frenar = true;
    },
    soltar: () => {
      frenar = false;
      soltar?.();
    }
  };
}

describe('LectorSaldo', () => {
  it('dentro de la vigencia devuelve lo leído sin volver a Bitget', async () => {
    const m = montar();
    await m.lector.leer('c1');
    m.avanzar(SALDO_VIGENCIA_MS - 1);
    await m.lector.leer('c1');

    expect(m.lecturas()).toBe(1);
  });

  it('pasada la vigencia vuelve a leer', async () => {
    const m = montar();
    await m.lector.leer('c1');
    m.avanzar(SALDO_VIGENCIA_MS);
    const r = await m.lector.leer('c1');

    expect(m.lecturas()).toBe(2);
    expect(r.disponible).toBe('2');
  });

  it('dos peticiones simultáneas de la misma cuenta comparten una lectura', async () => {
    const m = montar();
    m.frenar();
    const p1 = m.lector.leer('c1');
    const p2 = m.lector.leer('c1');
    expect(p2).toBe(p1);
    m.soltar();
    await Promise.all([p1, p2]);

    expect(m.lecturas()).toBe(1);
  });

  it('cuentas distintas no comparten nada', async () => {
    const m = montar();
    await m.lector.leer('c1');
    await m.lector.leer('c2');

    expect(m.lecturas()).toBe(2);
  });

  it('una lectura que termina después de bloquear el panel no queda en la caché', async () => {
    const m = montar();
    m.frenar();
    const enCurso = m.lector.leer('c1');
    m.lector.limpiar();
    m.soltar();
    await enCurso;

    await m.lector.leer('c1');
    expect(m.lecturas()).toBe(2);
  });

  it('olvidar una cuenta tira su saldo', async () => {
    const m = montar();
    await m.lector.leer('c1');
    m.lector.olvidar('c1');
    await m.lector.leer('c1');

    expect(m.lecturas()).toBe(2);
  });

  it('una lectura fallida no se guarda: la siguiente vuelve a intentarlo', async () => {
    let n = 0;
    const lector = new LectorSaldo({
      ahoraMs: () => 0,
      leer: (cuentaId) => {
        n++;
        return n === 1
          ? Promise.reject(new Error('red caída'))
          : Promise.resolve(saldo(cuentaId, 0));
      }
    });

    await expect(lector.leer('c1')).rejects.toThrow('red caída');
    await expect(lector.leer('c1')).resolves.toMatchObject({ disponible: '100' });
  });
});
