/**
 * Historial de posiciones cerradas: normalización de V2 y V3, y paginación.
 *
 * La normalización de V3 se prueba contra la respuesta real capturada en la
 * Fase 1. La de V2 contra la forma de la documentación, porque de Classic no hay
 * captura (docs/00-historial-fase-1.md §1).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { ErrorBitget } from '@main/bitget/errors';
import { esquemaListaV3 } from '@main/bitget/rest/lista-v3';
import {
  esquemaPosicionCerradaV3,
  normalizarV3,
  type ConsultaPaginaHistorial
} from '@main/bitget/rest/endpoints/historial-v3';
import { esquemaPaginaV2, normalizarV2 } from '@main/bitget/rest/endpoints/historial';
import type { PaginaHistorial, PosicionCerrada } from '@main/domain/posicion-cerrada';
import { recorrerHistorial, tramosDe } from '@main/historial/paginador';
import {
  historialSimulado,
  posicionCerrada,
  posicionesSeguidas
} from '../mock-exchange/historial-simulado';

const fixture = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'historial', 'v3-history-position.json'), 'utf8')
) as { datos: unknown; tras_ultima: unknown };

describe('normalización V3 (capturada)', () => {
  const lista = esquemaListaV3(esquemaPosicionCerradaV3)
    .parse(fixture.datos)
    .lista.map(normalizarV3);

  it('lee las cuatro posiciones con sus columnas', () => {
    expect(lista).toHaveLength(4);
    expect(lista[0]).toMatchObject({
      symbol: 'BTCUSDT',
      lado: 'long',
      modoMargen: 'isolated',
      precioEntrada: '84783.1',
      precioSalida: '84783',
      cantidadCierre: '0.0005',
      resultado: '-0.05091983',
      abiertaEnMs: 1791087440933,
      cerradaEnMs: 1791087467053,
      apalancamiento: null,
      porcentaje: null,
      superficie: 'v3'
    });
  });

  it('el resultado es netProfit: precio + comisiones + financiamiento', () => {
    for (const p of lista) {
      const calculado = new Decimal(p.pnlPrecio).plus(p.comisiones).plus(p.financiamiento);
      expect(calculado.minus(p.resultado).abs().toNumber()).toBeLessThan(1e-7);
    }
  });

  it('una operación con el precio a favor puede ser perdedora por las comisiones', () => {
    const p = lista[1] as PosicionCerrada;
    expect(new Decimal(p.pnlPrecio).isPositive()).toBe(true);
    expect(new Decimal(p.resultado).isNegative()).toBe(true);
  });

  it('la página tras la última llega como list y cursor nulos', () => {
    expect(esquemaListaV3(esquemaPosicionCerradaV3).parse(fixture.tras_ultima)).toEqual({
      lista: [],
      cursor: null
    });
  });
});

describe('normalización V2 (según documentación)', () => {
  const cruda = {
    list: [
      {
        positionId: '1',
        symbol: 'ETHUSDT',
        holdSide: 'short',
        marginMode: 'crossed',
        openAvgPrice: '2500',
        closeAvgPrice: '2400',
        openTotalPos: '1',
        closeTotalPos: '1',
        pnl: '100',
        netProfit: '98.5',
        totalFunding: '-0.5',
        openFee: '-0.5',
        closeFee: '-0.5',
        ctime: '1790000000000',
        utime: '1790000600000'
      }
    ],
    endId: '1'
  };

  it('traduce los nombres de Classic a la misma forma que V3', () => {
    const p = esquemaPaginaV2.parse(cruda).list?.map(normalizarV2)[0];
    expect(p).toMatchObject({
      lado: 'short',
      modoMargen: 'crossed',
      precioEntrada: '2500',
      precioSalida: '2400',
      resultado: '98.5',
      pnlPrecio: '100',
      comisiones: '-1',
      financiamiento: '-0.5',
      abiertaEnMs: 1790000000000,
      cerradaEnMs: 1790000600000,
      superficie: 'v2'
    });
  });

  it('sin precio de entrada falla nombrando el campo, no inventa un valor', () => {
    const sinPrecio = { ...cruda.list[0], openAvgPrice: undefined };
    const p = esquemaPaginaV2.parse({ list: [sinPrecio] }).list?.[0];
    expect(() => normalizarV2(p as never)).toThrow(/openAvgPrice/);
  });
});

/* ---------- paginador ---------- */

const sinEspera = (): Promise<void> => Promise.resolve();

async function todas(it: AsyncIterable<PosicionCerrada[]>): Promise<string[]> {
  const ids: string[] = [];
  for await (const pagina of it) ids.push(...pagina.map((p) => p.positionId));
  return ids;
}

describe('tramosDe', () => {
  it('parte un rango largo en tramos de la ventana, del más reciente al más antiguo', () => {
    expect(tramosDe(0, 250, 100)).toEqual([
      [150, 250],
      [50, 150],
      [0, 50]
    ]);
  });

  it('un rango dentro de la ventana es un solo tramo', () => {
    expect(tramosDe(10, 60, 100)).toEqual([[10, 60]]);
  });
});

describe('recorrerHistorial', () => {
  it('una página con menos del límite cierra el tramo: una sola petición', async () => {
    const { fuente, consultas } = historialSimulado(posicionesSeguidas('p', 3, 10_000));

    expect(
      await todas(recorrerHistorial(fuente, { desdeMs: 0, hastaMs: 20_000, dormir: sinEspera }))
    ).toEqual(['p0', 'p1', 'p2']);
    expect(consultas).toHaveLength(1);
  });

  it('avanza por fecha de cierre: cada página pide hasta la más antigua de la anterior', async () => {
    const { fuente, consultas } = historialSimulado(posicionesSeguidas('p', 5, 10_000));

    const ids = await todas(
      recorrerHistorial(fuente, { desdeMs: 0, hastaMs: 20_000, limitePagina: 2, dormir: sinEspera })
    );

    expect(ids).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
    /* El extremo es inclusivo: cada página repite la del borde, que se descarta. */
    expect(consultas.map((c) => c.hastaMs)).toEqual([20_000, 9_000, 8_000, 7_000, 6_000]);
  });

  /*
   * El caso real del 13/10/2026: con el cursor de Bitget, la posición que cerró
   * 1 ms antes que la última de una página se perdía. Aquí la frontera cae justo
   * entre las dos.
   */
  it('no pierde la posición que cierra 1 ms después de la frontera de página', async () => {
    const datos = [
      posicionCerrada('a', 10_000),
      posicionCerrada('b', 9_000),
      posicionCerrada('c', 8_001),
      posicionCerrada('d', 8_000),
      posicionCerrada('e', 7_000)
    ];
    const { fuente } = historialSimulado(datos);

    const ids = await todas(
      recorrerHistorial(fuente, { desdeMs: 0, hastaMs: 20_000, limitePagina: 3, dormir: sinEspera })
    );
    expect(ids.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('las que cierran en el mismo milisegundo que la frontera llegan una sola vez', async () => {
    const datos = [
      posicionCerrada('a', 10_000),
      posicionCerrada('b', 9_000),
      posicionCerrada('c', 9_000),
      posicionCerrada('d', 8_000),
      posicionCerrada('e', 7_000)
    ];
    const { fuente } = historialSimulado(datos);

    /* La primera página acaba en `c`; `b` y `c` vuelven en la segunda y se descartan. */
    const ids = await todas(
      recorrerHistorial(fuente, { desdeMs: 0, hastaMs: 20_000, limitePagina: 3, dormir: sinEspera })
    );
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
  });

  it('pagina cada tramo por separado, y lo que cae en el borde de dos tramos llega una vez', async () => {
    const { fuente, consultas } = historialSimulado([
      posicionCerrada('x', 200),
      posicionCerrada('borde', 150),
      posicionCerrada('y', 20)
    ]);

    const ids = await todas(
      recorrerHistorial(fuente, { desdeMs: 0, hastaMs: 250, ventanaMs: 100, dormir: sinEspera })
    );
    expect(ids).toEqual(['x', 'borde', 'y']);
    expect(consultas.map((c) => [c.desdeMs, c.hastaMs])).toEqual([
      [150, 250],
      [50, 150],
      [0, 50]
    ]);
  });

  it('reintenta la misma página, con el mismo rango, ante un fallo transitorio', async () => {
    const simulado = historialSimulado(posicionesSeguidas('p', 3, 10_000));
    let fallos = 0;
    const rangos: number[] = [];
    const fuente = (c: ConsultaPaginaHistorial): Promise<PaginaHistorial> => {
      rangos.push(c.hastaMs);
      if (c.hastaMs !== 20_000 && fallos < 2) {
        fallos++;
        return Promise.reject(
          new ErrorBitget('limitado', {
            clase: 'retryable',
            codigo: '429',
            mensajeOriginal: null,
            httpStatus: 429,
            reintentarEnMs: null
          })
        );
      }
      return simulado.fuente(c);
    };

    const esperas: number[] = [];
    const ids = await todas(
      recorrerHistorial(fuente, {
        desdeMs: 0,
        hastaMs: 20_000,
        limitePagina: 2,
        dormir: (ms) => {
          esperas.push(ms);
          return Promise.resolve();
        }
      })
    );

    expect(ids).toEqual(['p0', 'p1', 'p2']);
    expect(rangos).toEqual([20_000, 9_000, 9_000, 9_000, 8_000]);
    expect(esperas).toEqual([300, 900]);
  });

  it('no reintenta un rechazo de credencial', async () => {
    let llamadas = 0;
    const fuente = (): Promise<PaginaHistorial> => {
      llamadas++;
      return Promise.reject(
        new ErrorBitget('IP no autorizada', {
          clase: 'fatal-cuenta',
          codigo: '40018',
          mensajeOriginal: 'Invalid IP',
          httpStatus: 400,
          reintentarEnMs: null
        })
      );
    };

    await expect(
      todas(recorrerHistorial(fuente, { desdeMs: 0, hastaMs: 10, dormir: sinEspera }))
    ).rejects.toThrow('IP no autorizada');
    expect(llamadas).toBe(1);
  });

  it('más posiciones que el límite en el mismo milisegundo: corta, no salta ninguna', async () => {
    const { fuente } = historialSimulado([
      posicionCerrada('a', 5_000),
      posicionCerrada('b', 5_000),
      posicionCerrada('c', 5_000),
      posicionCerrada('d', 1_000)
    ]);

    await expect(
      todas(
        recorrerHistorial(fuente, {
          desdeMs: 0,
          hastaMs: 10_000,
          limitePagina: 2,
          dormir: sinEspera
        })
      )
    ).rejects.toMatchObject({ motivo: 'paginacion-estancada' });
  });

  it('corta al pasar del tope de páginas', async () => {
    const { fuente, consultas } = historialSimulado(posicionesSeguidas('p', 50, 100_000));

    await expect(
      todas(
        recorrerHistorial(fuente, {
          desdeMs: 0,
          hastaMs: 200_000,
          limitePagina: 2,
          maxPaginas: 5,
          dormir: sinEspera
        })
      )
    ).rejects.toMatchObject({ motivo: 'demasiadas-paginas' });
    expect(consultas).toHaveLength(5);
  });
});
