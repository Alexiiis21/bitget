/**
 * Fase 7 del historial: validación contra datos reales de Bitget.
 *
 * Recorre el camino completo del panel —`Sesion` real, alta de la cuenta,
 * sincronización contra api.bitget.com, almacén en disco, consulta por
 * periodo— con dos cuentas reales: la madre Classic (`BITGET_MADRE_*`) y la UTA
 * (`BITGET_UTA_*`). Solo lee: el alta verifica la credencial con GETs y el
 * historial y el saldo son GETs.
 *
 * ==========================================================================
 * Contra qué se compara: un oráculo que no comparte código con el panel
 * ==========================================================================
 * Comparar el panel consigo mismo no demuestra nada. El resultado esperado de
 * cada periodo se calcula aparte:
 *
 *   - las operaciones se piden a Bitget en ventanas de 7 días con una sola
 *     página cada una, sin pasar por el paginador del panel;
 *   - los bordes de día se calculan a mano con el desfase fijo de México
 *     (UTC−6, sin horario de verano desde 2022), sin `rangoDePeriodo`;
 *   - la suma se hace con `Decimal` sobre el `netProfit` crudo.
 *
 * Para cada periodo se exige que coincidan las operaciones (una a una, por
 * `positionId`), el número de ganadoras y perdedoras y la suma exacta.
 *
 * Con `HISTORIAL_CAPTURA_DIR` declarado, deja ahí una tabla con los resultados
 * para el documento de entrega.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Decimal from 'decimal.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ClienteBitget } from '@main/bitget/rest/client';
import { Sesion } from '@main/ipc/sesion';
import type { Credencial } from '@main/bitget/rest/signer';
import './credenciales-reales';
import { credencialUta, hayCredencialUta } from '../fisica/credenciales-uta';

const DIA = 86_400_000;
/** México no tiene horario de verano desde 2022: medianoche local = 06:00 UTC. */
const DESFASE_MX = 6 * 3_600_000;
const ZONA = 'America/Mexico_City';
const MAESTRA = 'maestra-de-prueba-fase7';

const credencialMadre: Credencial = {
  apiKey: process.env['BITGET_MADRE_API_KEY'] ?? '',
  secretKey: process.env['BITGET_MADRE_SECRET_KEY'] ?? '',
  passphrase: process.env['BITGET_MADRE_PASSPHRASE'] ?? ''
};
const hayMadre = credencialMadre.apiKey !== '' && credencialMadre.secretKey !== '';

/* ---------------- oráculo ---------------- */

interface Cruda {
  id: string;
  simbolo: string;
  cierre: number;
  neto: string;
}

const esquemaCruda = z
  .object({
    list: z
      .array(
        z.object({
          positionId: z.string(),
          symbol: z.string(),
          netProfit: z.string(),
          utime: z.string().optional(),
          updatedTime: z.string().optional()
        })
      )
      .nullish()
  })
  .passthrough();

/** Todo lo de los últimos 90 días, en ventanas de 7 días y una página cada una. */
async function oraculo(cliente: ClienteBitget, cred: Credencial, v3: boolean): Promise<Cruda[]> {
  const ahora = Date.now();
  const desde = ahora - 89 * DIA;
  const porId = new Map<string, Cruda>();
  for (let fin = ahora; fin > desde; fin -= 7 * DIA) {
    const inicio = Math.max(desde, fin - 7 * DIA);
    const r = await cliente.peticionFirmada(
      cred,
      {
        metodo: 'GET',
        ruta: v3 ? '/api/v3/position/history-position' : '/api/v2/mix/position/history-position',
        consulta: {
          ...(v3 ? { category: 'USDT-FUTURES' } : { productType: 'USDT-FUTURES' }),
          startTime: String(inicio),
          endTime: String(fin),
          limit: '100'
        },
        idempotente: true
      },
      esquemaCruda
    );
    const lista = r.datos.list ?? [];
    /* Si una semana trajera 100, el oráculo podría estar incompleto: se avisa. */
    expect(lista.length, `semana con 100 o más operaciones: el oráculo no basta`).toBeLessThan(100);
    for (const p of lista) {
      porId.set(p.positionId, {
        id: p.positionId,
        simbolo: p.symbol,
        cierre: Number(p.utime ?? p.updatedTime),
        neto: p.netProfit
      });
    }
  }
  return [...porId.values()];
}

/** `YYYY-MM-DD` de un instante, en hora de México. */
const diaMx = (ms: number): string => new Date(ms - DESFASE_MX).toISOString().slice(0, 10);
const medianocheMx = (dia: string): number => Date.parse(`${dia}T00:00:00.000Z`) + DESFASE_MX;

function esperado(crudas: Cruda[], desde: string, hasta: string) {
  const inicio = medianocheMx(desde);
  const fin = medianocheMx(hasta) + DIA;
  const dentro = crudas.filter((c) => c.cierre >= inicio && c.cierre < fin);
  let neto = new Decimal(0);
  let ganadoras = 0;
  let perdedoras = 0;
  for (const c of dentro) {
    const n = new Decimal(c.neto);
    neto = neto.plus(n);
    if (n.isPositive() && !n.isZero()) ganadoras++;
    else if (n.isNegative()) perdedoras++;
  }
  return { ids: dentro.map((c) => c.id).sort(), ganadoras, perdedoras, neto: neto.toString() };
}

/* ---------------- periodos ---------------- */

function periodosDe(crudas: Cruda[]): { nombre: string; desde: string; hasta: string }[] {
  const hoy = diaMx(Date.now());
  const hace = (n: number): string => diaMx(Date.now() - n * DIA);

  /* El día con más operaciones, y el mes natural en el que cae. */
  const porDia = new Map<string, number>();
  for (const c of crudas) porDia.set(diaMx(c.cierre), (porDia.get(diaMx(c.cierre)) ?? 0) + 1);
  const masActivo = [...porDia.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? hoy;
  const mes = masActivo.slice(0, 7);
  const ultimoDia = new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)), 0))
    .toISOString()
    .slice(0, 10);

  return [
    { nombre: 'Hoy', desde: hoy, hasta: hoy },
    { nombre: 'Últimos 7 días', desde: hace(6), hasta: hoy },
    { nombre: 'Últimos 30 días', desde: hace(29), hasta: hoy },
    { nombre: 'Últimos 90 días', desde: hace(88), hasta: hoy },
    { nombre: `Día con más operaciones (${masActivo})`, desde: masActivo, hasta: masActivo },
    { nombre: `Mes natural (${mes})`, desde: `${mes}-01`, hasta: ultimoDia },
    /* Los dos bordes de ese mes: según la cuenta, los datos caen en uno o en otro. */
    {
      nombre: 'Cruce de fin de mes',
      desde: diaMx(Date.parse(`${ultimoDia}T12:00:00Z`) - 4 * DIA),
      hasta: diaMx(Date.parse(`${ultimoDia}T12:00:00Z`) + 5 * DIA)
    },
    {
      nombre: 'Cruce de inicio de mes',
      desde: diaMx(Date.parse(`${mes}-01T12:00:00Z`) - 5 * DIA),
      hasta: diaMx(Date.parse(`${mes}-01T12:00:00Z`) + 4 * DIA)
    }
  ];
}

/* ---------------- montaje ---------------- */

let carpeta: string;
let cliente: ClienteBitget;
const filas: string[] = [];

const rutas = () => ({
  vault: join(carpeta, 'vault.enc'),
  cuentas: join(carpeta, 'cuentas.json'),
  activos: join(carpeta, 'activos.json'),
  historial: join(carpeta, 'historial')
});

const nuevaSesion = () =>
  new Sesion(rutas(), cliente, {
    mercado: 'real',
    parametrosKdf: { N: 16, r: 1, p: 1 },
    zonaHoraria: ZONA
  });

beforeAll(async () => {
  carpeta = await mkdtemp(join(tmpdir(), 'pcb-fase7-'));
  cliente = new ClienteBitget();
});

afterAll(async () => {
  await cliente.cerrar();
  await rm(carpeta, { recursive: true, force: true });
  const dir = process.env['HISTORIAL_CAPTURA_DIR'] ?? '';
  if (dir !== '' && filas.length > 0) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'fase7-resultados.md'),
      [
        '| Cuenta | Periodo | Desde | Hasta | Operaciones | Ganadoras | Perdedoras | Resultado neto (USDT) | Activos | Coincide |',
        '|---|---|---|---|---|---|---|---|---|---|',
        ...filas
      ].join('\n') + '\n',
      'utf8'
    );
  }
});

async function validarCuenta(etiqueta: string, cred: Credencial, v3: boolean): Promise<void> {
  const sesion = nuevaSesion();
  if ((await sesion.estadoVault()) === 'sin-inicializar') await sesion.crear(MAESTRA);
  else await sesion.abrir(MAESTRA);

  const alta = await sesion.agregar({
    etiqueta,
    grupoNombre: 'A',
    apiKey: cred.apiKey,
    secretKey: cred.secretKey,
    passphrase: cred.passphrase
  });
  expect(alta.ok, alta.motivo ?? '').toBe(true);
  const id = alta.cuenta?.id ?? '';

  const sync = await sesion.sincronizarHistorial(id);
  console.log(`  ${etiqueta}: ${sync.total} operaciones sincronizadas`);

  const crudas = await oraculo(cliente, cred, v3);
  expect(sync.total).toBe(crudas.length);

  for (const p of periodosDe(crudas)) {
    const h = await sesion.consultarHistorial(id, { desde: p.desde, hasta: p.hasta });
    const e = esperado(crudas, p.desde, p.hasta);

    const ids = h.posiciones.map((x) => x.positionId).sort();
    const coincide =
      JSON.stringify(ids) === JSON.stringify(e.ids) &&
      h.resumen.ganadoras === e.ganadoras &&
      h.resumen.perdedoras === e.perdedoras &&
      new Decimal(h.resumen.resultadoNeto).equals(e.neto);

    const activos = [...new Set(h.posiciones.map((x) => x.symbol))].sort().join(', ') || '—';
    filas.push(
      `| ${etiqueta} | ${p.nombre} | ${p.desde} | ${p.hasta} | ${h.resumen.total} | ${h.resumen.ganadoras} | ` +
        `${h.resumen.perdedoras} | ${h.resumen.resultadoNeto} | ${activos} | ${coincide ? 'Sí' : 'NO'} |`
    );
    console.log(
      `  ${etiqueta} · ${p.nombre}: ${h.resumen.total} ops, ${h.resumen.ganadoras}G/${h.resumen.perdedoras}P, ` +
        `neto ${h.resumen.resultadoNeto} — ${coincide ? 'coincide' : 'NO COINCIDE'}`
    );

    expect(ids, p.nombre).toEqual(e.ids);
    expect(h.resumen.ganadoras, p.nombre).toBe(e.ganadoras);
    expect(h.resumen.perdedoras, p.nombre).toBe(e.perdedoras);
    expect(new Decimal(h.resumen.resultadoNeto).equals(e.neto), p.nombre).toBe(true);
  }

  /* Saldo vigente, de la propia cuenta. */
  const saldo = await sesion.saldoCuenta(id);
  expect(saldo.moneda).toBe('USDT');
  expect(saldo.disponible).toMatch(/^-?\d+(\.\d+)?$/);
  console.log(`  ${etiqueta}: saldo leído (${saldo.superficie})`);

  /* Reabrir el panel: lo guardado se enseña igual, sin volver a Bitget. */
  sesion.cerrar();
  const reabierta = nuevaSesion();
  await reabierta.abrir(MAESTRA);
  const p90 = periodosDe(crudas)[3];
  if (p90 !== undefined) {
    const h = await reabierta.consultarHistorial(id, { desde: p90.desde, hasta: p90.hasta });
    expect(h.resumen.total).toBe(esperado(crudas, p90.desde, p90.hasta).ids.length);
  }
  reabierta.cerrar();
}

describe('Fase 7 · historial contra Bitget real', () => {
  it.skipIf(!hayMadre)(
    'Classic (V2): cuenta madre',
    async () => {
      await validarCuenta('Classic', credencialMadre, false);
    },
    120_000
  );

  it.skipIf(!hayCredencialUta)(
    'UTA (V3)',
    async () => {
      await validarCuenta('UTA', credencialUta, true);
    },
    120_000
  );
});
