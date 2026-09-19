import { describe, expect, it } from 'vitest';
import { archivoLogDeHoy, carpetaRespaldos } from '@main/storage/paths';
import { clavePosicion } from '@shared/types';
import {
  MONITOR_REFRESCO_MS_DEFECTO,
  MONITOR_REFRESCO_MS_MAX,
  MONITOR_REFRESCO_MS_MIN,
  PIN_ESPERAS_MS,
  PIN_MAX_INTENTOS,
  WS_MAX_CONCURRENTES,
  WS_MAX_POR_IP
} from '@shared/constants';

describe('rotacion del log de sesion', () => {
  it('nombra el archivo por dia local, con ceros a la izquierda', () => {
    expect(archivoLogDeHoy(new Date(2026, 6, 5))).toBe('session-20260705.jsonl');
    expect(archivoLogDeHoy(new Date(2026, 11, 31))).toBe('session-20261231.jsonl');
  });
});

describe('carpeta de respaldos', () => {
  /*
   * En Documentos y no junto al `.exe`. El respaldo existe justamente para
   * sobrevivir a que el operador borre la carpeta del panel viejo; guardarlo
   * dentro de ella sería guardarlo en el sitio que se va a borrar.
   */
  it('cuelga de Documentos, no de la carpeta de datos', () => {
    /* El doble de `electron` devuelve `/stub/<nombre>` para cada ruta del sistema. */
    expect(carpetaRespaldos().replace(/\\/g, '/')).toContain('/stub/documents');
    expect(carpetaRespaldos()).toContain('respaldos');
  });

  /*
   * Las pruebas corren en entorno `dev` (ver `vitest.config.ts`). En staging la
   * carpeta lleva sufijo: sin él, el panel de staging —que guarda credenciales
   * reales— reescribiría el respaldo del panel de producción y la detección
   * automática ofrecería restaurar el juego de claves equivocado.
   */
  it('no comparte carpeta con el otro entorno', () => {
    expect(carpetaRespaldos()).toContain('Panel de Control Bitget');
    expect(carpetaRespaldos()).not.toContain('-staging');
  });
});

describe('clave de posicion', () => {
  /*
   * El lado forma parte de la clave porque el panel opera en modo cobertura.
   * Si esta prueba se cae, es que alguien indexo por (cuenta, simbolo) y el
   * panel perderia una de las dos posiciones en silencio. docs/03 seccion 1.
   */
  it('distingue LONG de SHORT en la misma cuenta y simbolo', () => {
    const l = clavePosicion('acc_1', 'BTCUSDT', 'long');
    const s = clavePosicion('acc_1', 'BTCUSDT', 'short');
    expect(l).not.toBe(s);
  });

  it('es estable para la misma terna', () => {
    expect(clavePosicion('acc_1', 'BTCUSDT', 'long')).toBe(
      clavePosicion('acc_1', 'BTCUSDT', 'long')
    );
  });
});

describe('presupuestos declarados', () => {
  it('deja margen bajo el techo de sockets de Bitget', () => {
    expect(WS_MAX_CONCURRENTES).toBeLessThan(WS_MAX_POR_IP);
    expect(WS_MAX_POR_IP - WS_MAX_CONCURRENTES).toBeGreaterThanOrEqual(20);
  });

  it('mantiene el refresco del monitor dentro del rango contratado', () => {
    expect(MONITOR_REFRESCO_MS_MIN).toBe(2_000);
    expect(MONITOR_REFRESCO_MS_MAX).toBe(5_000);
    expect(MONITOR_REFRESCO_MS_DEFECTO).toBeGreaterThanOrEqual(MONITOR_REFRESCO_MS_MIN);
    expect(MONITOR_REFRESCO_MS_DEFECTO).toBeLessThanOrEqual(MONITOR_REFRESCO_MS_MAX);
  });

  it('define una espera por cada intento de PIN permitido', () => {
    expect(PIN_ESPERAS_MS).toHaveLength(PIN_MAX_INTENTOS);
  });
});
