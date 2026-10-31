/**
 * Fase 1 del historial: lo que `history-position` devuelve de verdad.
 *
 * No prueba código del panel —todavía no existe—, sino el contrato de Bitget
 * sobre el que se va a construir. Las preguntas que responde son las que el
 * presupuesto deja abiertas para esta fase:
 *
 *   1. qué campos trae cada posición cerrada, en V2 (Classic) y en V3 (UTA);
 *   2. si viene el apalancamiento y algún porcentaje, o hay que pedirlo aparte;
 *   3. qué incluye el resultado (`pnl` frente a `netProfit`, comisiones,
 *      financiamiento);
 *   4. cómo pagina: nombre del cursor, orden y cómo se sabe que se acabó;
 *   5. qué ventana admite: hasta dónde llega hacia atrás y qué pasa si el
 *      rango pedido es mayor que el permitido.
 *
 * Solo lee. Las respuestas crudas se vuelcan en `HISTORIAL_CAPTURA_DIR` si se
 * declara, **fuera del repositorio**: llevan operaciones reales de la cuenta, y
 * los fixtures que se versionen se sacan de ahí a mano y anonimizados.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ClienteBitget } from '@main/bitget/rest/client';
import type { Credencial } from '@main/bitget/rest/signer';
import { ErrorBitget } from '@main/bitget/errors';
import './credenciales-reales';
import { credencialUta, hayCredencialUta } from '../fisica/credenciales-uta';

const DIA_MS = 86_400_000;

/*
 * Classic se verifica con la clave de la cuenta madre (`BITGET_MADRE_*`). La de
 * `BITGET_DEMO_*` tiene una lista blanca de IP que no incluye este equipo
 * (`40018`, 12/10/2026). Importar `credenciales-reales` carga el `.env`.
 */
const credencialClassic: Credencial = {
  apiKey: process.env['BITGET_MADRE_API_KEY'] ?? '',
  secretKey: process.env['BITGET_MADRE_SECRET_KEY'] ?? '',
  passphrase: process.env['BITGET_MADRE_PASSPHRASE'] ?? ''
};
const hayClassic =
  credencialClassic.apiKey !== '' &&
  credencialClassic.secretKey !== '' &&
  credencialClassic.passphrase !== '';
const RUTA_V2 = '/api/v2/mix/position/history-position';
const RUTA_V3 = '/api/v3/position/history-position';

const dirCaptura = process.env['HISTORIAL_CAPTURA_DIR'] ?? '';

function capturar(nombre: string, dato: unknown): void {
  if (dirCaptura === '') return;
  mkdirSync(dirCaptura, { recursive: true });
  writeFileSync(join(dirCaptura, `${nombre}.json`), JSON.stringify(dato, null, 2), 'utf8');
}

/** Las claves y el tipo de cada una, que es lo que importa para el esquema. */
function forma(obj: unknown): Record<string, string> {
  if (obj === null || typeof obj !== 'object') return {};
  return Object.fromEntries(
    Object.entries(obj as Record<string, unknown>).map(([k, v]) => [
      k,
      Array.isArray(v) ? `array(${v.length})` : v === null ? 'null' : typeof v
    ])
  );
}

let cliente: ClienteBitget;

beforeAll(() => {
  cliente = new ClienteBitget();
});

afterAll(async () => {
  await cliente.cerrar();
});

async function pedir(
  credencial: Credencial,
  ruta: string,
  consulta: Record<string, string>
): Promise<
  { ok: true; datos: unknown } | { ok: false; codigo: string | null; mensaje: string | null }
> {
  try {
    const r = await cliente.peticionFirmada(
      credencial,
      { metodo: 'GET', ruta, consulta, idempotente: true },
      z.unknown()
    );
    return { ok: true, datos: r.datos };
  } catch (e) {
    if (e instanceof ErrorBitget)
      return { ok: false, codigo: e.codigo, mensaje: e.mensajeOriginal };
    throw e;
  }
}

describe.skipIf(!hayClassic)('history-position V2 (Classic)', () => {
  it('primera página sin rango: forma del sobre y de cada posición', async () => {
    const r = await pedir(credencialClassic, RUTA_V2, {
      productType: 'USDT-FUTURES',
      limit: '100'
    });
    capturar('v2-sin-rango', r);
    console.log('  v2 sin rango:', r.ok ? forma(r.datos) : r);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const lista = (r.datos as { list?: unknown[] }).list ?? [];
    console.log(
      `  v2: ${lista.length} posiciones, endId=${String((r.datos as { endId?: unknown }).endId)}`
    );
    if (lista.length > 0) console.log('  v2 campos de una posición:', forma(lista[0]));
  });

  it('rango de 90 días explícito', async () => {
    const fin = Date.now();
    const r = await pedir(credencialClassic, RUTA_V2, {
      productType: 'USDT-FUTURES',
      startTime: String(fin - 90 * DIA_MS),
      endTime: String(fin),
      limit: '100'
    });
    capturar('v2-90-dias', r);
    console.log('  v2 90 días:', r.ok ? forma(r.datos) : r);
  });

  it('rango de 120 días: ¿lo rechaza o lo recorta?', async () => {
    const fin = Date.now();
    const r = await pedir(credencialClassic, RUTA_V2, {
      productType: 'USDT-FUTURES',
      startTime: String(fin - 120 * DIA_MS),
      endTime: String(fin),
      limit: '100'
    });
    capturar('v2-120-dias', r);
    console.log('  v2 120 días:', r.ok ? forma(r.datos) : r);
  });

  it('segunda página con limit=1 e idLessThan', async () => {
    const p1 = await pedir(credencialClassic, RUTA_V2, { productType: 'USDT-FUTURES', limit: '1' });
    if (!p1.ok) return;
    const endId = (p1.datos as { endId?: string }).endId;
    console.log(`  v2 p1 endId=${String(endId)}`);
    if (!endId) return;

    const p2 = await pedir(credencialClassic, RUTA_V2, {
      productType: 'USDT-FUTURES',
      limit: '1',
      idLessThan: endId
    });
    capturar('v2-paginas', { p1, p2 });
    console.log('  v2 p2:', p2.ok ? forma(p2.datos) : p2);
  });
});

describe.skipIf(!hayCredencialUta)('history-position V3 (UTA)', () => {
  it('primera página sin rango: forma del sobre y de cada posición', async () => {
    const r = await pedir(credencialUta, RUTA_V3, { category: 'USDT-FUTURES', limit: '100' });
    capturar('v3-sin-rango', r);
    console.log('  v3 sin rango:', r.ok ? forma(r.datos) : r);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const lista = (r.datos as { list?: unknown[] }).list ?? [];
    console.log(
      `  v3: ${lista.length} posiciones, cursor=${String((r.datos as { cursor?: unknown }).cursor)}`
    );
    if (lista.length > 0) console.log('  v3 campos de una posición:', forma(lista[0]));
  });

  it('rango de 90 y de 120 días', async () => {
    const fin = Date.now();
    for (const dias of [90, 120]) {
      const r = await pedir(credencialUta, RUTA_V3, {
        category: 'USDT-FUTURES',
        startTime: String(fin - dias * DIA_MS),
        endTime: String(fin),
        limit: '100'
      });
      capturar(`v3-${dias}-dias`, r);
      console.log(`  v3 ${dias} días:`, r.ok ? forma(r.datos) : r);
    }
  });

  it('segunda página con limit=1 y cursor', async () => {
    const p1 = await pedir(credencialUta, RUTA_V3, { category: 'USDT-FUTURES', limit: '1' });
    if (!p1.ok) return;
    const cursor = (p1.datos as { cursor?: string }).cursor;
    console.log(`  v3 p1 cursor=${String(cursor)}`);
    if (!cursor) return;

    const p2 = await pedir(credencialUta, RUTA_V3, {
      category: 'USDT-FUTURES',
      limit: '1',
      cursor
    });
    capturar('v3-paginas', { p1, p2 });
    console.log('  v3 p2:', p2.ok ? forma(p2.datos) : p2);
  });

  it('cómo se sabe que se acabó: la página siguiente a la última', async () => {
    const p1 = await pedir(credencialUta, RUTA_V3, { category: 'USDT-FUTURES', limit: '100' });
    if (!p1.ok) return;
    const cursor = (p1.datos as { cursor?: string }).cursor;
    if (!cursor) return;

    const p2 = await pedir(credencialUta, RUTA_V3, {
      category: 'USDT-FUTURES',
      limit: '100',
      cursor
    });
    capturar('v3-tras-ultima', p2);
    console.log('  v3 tras la última página:', p2.ok ? p2.datos : p2);
  });

  it('ventana anterior a los últimos 90 días', async () => {
    const fin = Date.now() - 90 * DIA_MS;
    const r = await pedir(credencialUta, RUTA_V3, {
      category: 'USDT-FUTURES',
      startTime: String(fin - 89 * DIA_MS),
      endTime: String(fin),
      limit: '100'
    });
    capturar('v3-ventana-antigua', r);
    console.log('  v3 de 180 a 90 días atrás:', r.ok ? forma(r.datos) : r);
  });
});

describe.skipIf(!hayCredencialUta)('historial del panel contra UTA real (Fase 2)', () => {
  it('el despachador manda la cuenta UTA a V3 y el paginador la recorre entera', async () => {
    const { obtenerHistorialPosiciones } = await import('@main/bitget/rest/endpoints/historial');
    const { recorrerHistorial } = await import('@main/historial/paginador');
    const { MERCADO_REAL } = await import('@main/bitget/mercado');
    const { HISTORIAL_VENTANA_MS } = await import('@shared/constants');

    const fin = Date.now();
    const ids: string[] = [];
    let paginas = 0;
    for await (const pagina of recorrerHistorial(
      async (c) =>
        (await obtenerHistorialPosiciones(cliente, credencialUta, MERCADO_REAL, c)).datos,
      { desdeMs: fin - HISTORIAL_VENTANA_MS, hastaMs: fin, limitePagina: 5 }
    )) {
      paginas++;
      ids.push(...pagina.map((p) => p.positionId));
    }

    console.log(`  panel: ${ids.length} posiciones en ${paginas} páginas de 5`);
    expect(ids.length).toBeGreaterThan(0);
    /* Paginando de cinco en cinco no puede aparecer ninguna dos veces. */
    expect(new Set(ids).size).toBe(ids.length);

    const unica = await obtenerHistorialPosiciones(cliente, credencialUta, MERCADO_REAL, {
      desdeMs: fin - HISTORIAL_VENTANA_MS,
      hastaMs: fin,
      limite: 100
    });
    expect(ids.sort()).toEqual(unica.datos.posiciones.map((p) => p.positionId).sort());
  });
});

describe.skipIf(!hayClassic)('historial del panel contra Classic real (Fase 2)', () => {
  it('el despachador manda la cuenta Classic a V2 y el paginador la recorre entera', async () => {
    const { obtenerHistorialPosiciones } = await import('@main/bitget/rest/endpoints/historial');
    const { recorrerHistorial } = await import('@main/historial/paginador');
    const { MERCADO_REAL } = await import('@main/bitget/mercado');
    const { HISTORIAL_VENTANA_MS } = await import('@shared/constants');

    const fin = Date.now();
    const ids: string[] = [];
    let paginas = 0;
    for await (const pagina of recorrerHistorial(
      async (c) =>
        (await obtenerHistorialPosiciones(cliente, credencialClassic, MERCADO_REAL, c)).datos,
      { desdeMs: fin - HISTORIAL_VENTANA_MS, hastaMs: fin, limitePagina: 5 }
    )) {
      paginas++;
      ids.push(...pagina.map((p) => p.positionId));
    }

    console.log(`  panel V2: ${ids.length} posiciones en ${paginas} páginas de 5`);
    expect(new Set(ids).size).toBe(ids.length);

    /* Paginar de cinco en cinco tiene que dar lo mismo que una sola página de 100. */
    const unica = await obtenerHistorialPosiciones(cliente, credencialClassic, MERCADO_REAL, {
      desdeMs: fin - HISTORIAL_VENTANA_MS,
      hastaMs: fin,
      limite: 100
    });
    const todas = unica.datos.posiciones.map((p) => p.positionId);
    const faltan = unica.datos.posiciones.filter((p) => !ids.includes(p.positionId));
    console.log(
      '  faltan al paginar:',
      faltan.map((p) => [p.positionId, p.cerradaEnMs])
    );
    capturar('v2-paginado-vs-unica', { paginado: ids, unica: todas });
    expect(ids.sort()).toEqual([...todas].sort());
  });
});

describe.skipIf(!hayClassic)('qué fecha filtran startTime y endTime (V2)', () => {
  it('endTime entre la apertura y el cierre de una posición larga', async () => {
    const p = await pedir(credencialClassic, RUTA_V2, {
      productType: 'USDT-FUTURES',
      limit: '100'
    });
    if (!p.ok) return;
    const lista = (p.datos as { list: { positionId: string; ctime: string; utime: string }[] })
      .list;
    /* La que más tiempo estuvo abierta: la que mejor separa las dos fechas. */
    const larga = [...lista].sort(
      (a, b) => Number(b.utime) - Number(b.ctime) - (Number(a.utime) - Number(a.ctime))
    )[0];
    if (larga === undefined) return;
    const medio = Math.floor((Number(larga.ctime) + Number(larga.utime)) / 2);

    const r = await pedir(credencialClassic, RUTA_V2, {
      productType: 'USDT-FUTURES',
      startTime: String(Math.max(medio - 89 * 86_400_000, Date.now() - 89 * 86_400_000)),
      endTime: String(medio),
      limit: '100'
    });
    const ids = r.ok
      ? ((r.datos as { list?: { positionId: string }[] }).list?.map((x) => x.positionId) ?? [])
      : [];
    console.log(
      `  V2 endTime en mitad de ${larga.positionId}: ${ids.includes(larga.positionId) ? 'APARECE → filtra por apertura' : 'NO aparece → filtra por cierre'}`
    );

    const igual = await pedir(credencialClassic, RUTA_V2, {
      productType: 'USDT-FUTURES',
      startTime: String(Number(larga.utime) - 86_400_000),
      endTime: larga.utime,
      limit: '100'
    });
    const idsIgual = igual.ok
      ? ((igual.datos as { list?: { positionId: string }[] }).list?.map((x) => x.positionId) ?? [])
      : [];
    console.log(
      `  V2 endTime == utime: ${idsIgual.includes(larga.positionId) ? 'inclusivo' : 'exclusivo'}`
    );
  });
});

describe.skipIf(!hayCredencialUta)('qué fecha filtran startTime y endTime (V3)', () => {
  it('endTime entre la apertura y el cierre de una posición larga', async () => {
    const p = await pedir(credencialUta, RUTA_V3, { category: 'USDT-FUTURES', limit: '100' });
    if (!p.ok) return;
    const lista = (
      p.datos as { list: { positionId: string; createdTime: string; updatedTime: string }[] }
    ).list;
    const larga = [...lista].sort(
      (a, b) =>
        Number(b.updatedTime) -
        Number(b.createdTime) -
        (Number(a.updatedTime) - Number(a.createdTime))
    )[0];
    if (larga === undefined) return;
    const medio = Math.floor((Number(larga.createdTime) + Number(larga.updatedTime)) / 2);

    const r = await pedir(credencialUta, RUTA_V3, {
      category: 'USDT-FUTURES',
      /* Nunca más atrás de 90 días desde hoy: Bitget lo rechaza con 25200. */
      startTime: String(Math.max(medio - 89 * 86_400_000, Date.now() - 89 * 86_400_000)),
      endTime: String(medio),
      limit: '100'
    });
    const ids = r.ok
      ? ((r.datos as { list?: { positionId: string }[] | null }).list?.map((x) => x.positionId) ??
        [])
      : [];
    console.log(
      `  V3 endTime en mitad de ${larga.positionId}: ${ids.includes(larga.positionId) ? 'APARECE → filtra por apertura' : 'NO aparece → filtra por cierre'}`,
      r.ok ? '' : r
    );

    const igual = await pedir(credencialUta, RUTA_V3, {
      category: 'USDT-FUTURES',
      startTime: String(Number(larga.updatedTime) - 86_400_000),
      endTime: larga.updatedTime,
      limit: '100'
    });
    const idsIgual = igual.ok
      ? ((igual.datos as { list?: { positionId: string }[] | null }).list?.map(
          (x) => x.positionId
        ) ?? [])
      : [];
    console.log(
      `  V3 endTime == updatedTime: ${idsIgual.includes(larga.positionId) ? 'inclusivo' : 'exclusivo'}`
    );
  });
});

describe('saldo vigente contra Bitget real (Fase 4)', () => {
  it.skipIf(!hayClassic)('Classic: la fila USDT de /api/v2/mix/account/accounts', async () => {
    const { obtenerCuentasFuturos } = await import('@main/bitget/rest/endpoints/cuenta');
    const r = await obtenerCuentasFuturos(cliente, credencialClassic, 'USDT-FUTURES', 'USDT');
    const fila = r.datos.find((c) => c.marginCoin === 'USDT');
    console.log('  saldo Classic:', fila ? Object.keys(fila) : 'sin fila USDT');
    expect(fila?.available).toMatch(/^\d+(\.\d+)?$/);
  });

  it.skipIf(!hayCredencialUta)('UTA: la fila USDT de /api/v3/account/assets', async () => {
    const { obtenerCuentasFuturos } = await import('@main/bitget/rest/endpoints/cuenta');
    const r = await obtenerCuentasFuturos(cliente, credencialUta, 'USDT-FUTURES', 'USDT');
    const fila = r.datos.find((c) => c.marginCoin === 'USDT');
    console.log('  saldo UTA:', fila ? Object.keys(fila) : 'sin fila USDT');
    expect(fila?.available).toMatch(/^\d+(\.\d+)?$/);
  });
});
