/**
 * Traduccion de parametros entre V2 y V3.
 *
 * Son funciones triviales y aun asi tienen prueba, por una razon concreta: en
 * V3 un parametro mal puesto **no falla de forma ruidosa**. Bitget acepta la
 * peticion y hace otra cosa —el mismo patron del `planType` en `cancel-plan-order`
 * o del `holdSide` en `set-leverage`, que costaron dos incidencias—. Lo que aqui
 * se fija es la correspondencia, para que un renombre futuro rompa una prueba en
 * vez de una posicion.
 */
import { describe, expect, it } from 'vitest';
import { MERCADO_REAL, MERCADO_SIMULADO } from '@main/bitget/mercado';
import {
  CAMPOS_POSICION_V2_A_V3,
  CATEGORIAS_V3,
  categoriaDe,
  mercadoSoportadoEnV3,
  posSideDe
} from '@main/bitget/superficie';

describe('categoria', () => {
  it('el productType del mercado real es una categoria valida de V3', () => {
    expect(categoriaDe(MERCADO_REAL)).toBe('USDT-FUTURES');
    expect(CATEGORIAS_V3.has(categoriaDe(MERCADO_REAL))).toBe(true);
    expect(mercadoSoportadoEnV3(MERCADO_REAL)).toBe(true);
  });

  it('el mercado simulado NO existe en V3, y esa es la pregunta abierta cara', () => {
    /*
     * Es el riesgo 9.1 del Paquete A escrito como prueba. Toda la suite
     * `test/fisica/` se apoya en que `SUSDT-FUTURES` es un mercado aparte donde
     * una orden no puede tocar dinero real; V3 no lo lista entre sus
     * categorias. Si algun dia la sonda demuestra que si responde, esta prueba
     * se cae y hay que actualizar `CATEGORIAS_V3` —que es exactamente el aviso
     * que se quiere—.
     */
    expect(categoriaDe(MERCADO_SIMULADO)).toBe('SUSDT-FUTURES');
    expect(mercadoSoportadoEnV3(MERCADO_SIMULADO)).toBe(false);
  });
});

describe('posSide', () => {
  it('en hedge mode se envia, porque sin el Bitget elige el lado', () => {
    expect(posSideDe('long', 'hedge_mode')).toEqual({ posSide: 'long' });
    expect(posSideDe('short', 'hedge_mode')).toEqual({ posSide: 'short' });
  });

  it('en one-way se omite: hay una sola posicion por simbolo', () => {
    expect(posSideDe('long', 'one_way_mode')).toEqual({});
  });

  it('sin holdMode conocido se envia, que es el error barato de los dos', () => {
    /*
     * Mandarlo de mas en una cuenta unilateral es un parametro ignorado o un
     * rechazo explicito. Omitirlo en una de cobertura deja que Bitget elija el
     * lado, y el panel opera en cobertura. De los dos errores, solo uno cuesta
     * dinero.
     */
    expect(posSideDe('short', null)).toEqual({ posSide: 'short' });
  });
});

describe('campos de la posicion', () => {
  it('el unico renombre documentado es openPriceAvg -> avgPrice', () => {
    expect(CAMPOS_POSICION_V2_A_V3['openPriceAvg']).toBe('avgPrice');
    expect(CAMPOS_POSICION_V2_A_V3['liquidationPrice']).toBe('liquidationPrice');
    expect(CAMPOS_POSICION_V2_A_V3['holdSide']).toBe('posSide');
  });

  it('margen y PnL siguen sin equivalente conocido', () => {
    /*
     * De estos dos dependen la columna de margen y el ROE del Centro de
     * Monitoreo. Quedan en `null` hasta que la sonda diga como se llaman en V3;
     * cuando alguien los rellene, esta prueba le recordara que hay una pantalla
     * esperando el dato.
     */
    expect(CAMPOS_POSICION_V2_A_V3['marginSize']).toBeNull();
    expect(CAMPOS_POSICION_V2_A_V3['unrealizedPL']).toBeNull();
  });
});
