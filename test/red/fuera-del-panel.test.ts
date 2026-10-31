/**
 * Alertas, Fase 1: qué deja Bitget registrado de cada acción, y si se puede
 * distinguir lo que hizo el panel de lo que hizo el cliente por su cuenta.
 *
 * Solo lee. Las respuestas crudas se vuelcan en `HISTORIAL_CAPTURA_DIR`, fuera
 * del repositorio: llevan operaciones reales de la cuenta.
 *
 * Preguntas que responde (docs/00-alertas-fase-1.md):
 *   1. Historial de órdenes: ¿trae `clientOid`? ¿Qué campo dice el origen
 *      (web, app, API, sistema) y distingue un TP disparado o una liquidación?
 *   2. Historial de planes TP/SL: ¿conserva `clientOid` y las cancelaciones?
 *   3. Movimientos de cuenta: ¿registran agregar/quitar margen?
 *   4. Traspasos: ¿conservan `clientOid`?
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

const DIA = 86_400_000;
const dir = process.env['HISTORIAL_CAPTURA_DIR'] ?? '';

const credencialMadre: Credencial = {
  apiKey: process.env['BITGET_MADRE_API_KEY'] ?? '',
  secretKey: process.env['BITGET_MADRE_SECRET_KEY'] ?? '',
  passphrase: process.env['BITGET_MADRE_PASSPHRASE'] ?? ''
};
const hayMadre = credencialMadre.apiKey !== '';

let cliente: ClienteBitget;
beforeAll(() => {
  cliente = new ClienteBitget();
});
afterAll(async () => {
  await cliente.cerrar();
});

function capturar(nombre: string, dato: unknown): void {
  if (dir === '') return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `alertas-${nombre}.json`), JSON.stringify(dato, null, 2), 'utf8');
}

/** Las listas de Bitget vienen sueltas o dentro de `list`, `entrustedList`, `bills`… */
function lista(datos: unknown): Record<string, unknown>[] {
  if (Array.isArray(datos)) return datos as Record<string, unknown>[];
  if (datos !== null && typeof datos === 'object') {
    for (const v of Object.values(datos as Record<string, unknown>)) {
      if (Array.isArray(v)) return v as Record<string, unknown>[];
    }
  }
  return [];
}

/** Claves de un elemento y, para los campos que interesan, los valores distintos. */
function resumen(elems: Record<string, unknown>[], campos: string[]): string {
  const claves = elems[0] ? Object.keys(elems[0]).join(', ') : '(vacío)';
  const valores = campos
    .map((c) => `${c}=[${[...new Set(elems.map((e) => String(e[c])))].slice(0, 12).join(' | ')}]`)
    .join('  ');
  return `${elems.length} elementos\n      claves: ${claves}\n      ${valores}`;
}

async function sondear(
  nombre: string,
  cred: Credencial,
  ruta: string,
  consulta: Record<string, string>,
  campos: string[]
): Promise<void> {
  try {
    const r = await cliente.peticionFirmada(
      cred,
      { metodo: 'GET', ruta, consulta, idempotente: true },
      z.unknown()
    );
    capturar(nombre, r.datos);
    console.log(`  ${nombre}: ${resumen(lista(r.datos), campos)}`);
  } catch (e) {
    const m = e instanceof ErrorBitget ? `${e.codigo} ${e.mensajeOriginal}` : String(e);
    capturar(nombre, { error: m });
    console.log(`  ${nombre}: ERROR ${m}`);
  }
}

const ORIGEN = [
  'clientOid',
  'orderSource',
  'enterPointSource',
  'tradeSide',
  'side',
  'posSide',
  'status'
];

describe.skipIf(!hayMadre)('Classic (V2): qué registra Bitget', () => {
  const fin = Date.now();
  const desde = String(fin - 89 * DIA);
  const hasta = String(fin);

  it('historial de órdenes', async () => {
    await sondear(
      'v2-orders-history',
      credencialMadre,
      '/api/v2/mix/order/orders-history',
      { productType: 'USDT-FUTURES', startTime: desde, endTime: hasta, limit: '100' },
      ORIGEN
    );
  });

  it('historial de planes TP/SL', async () => {
    for (const planType of ['profit_loss', 'normal_plan']) {
      await sondear(
        `v2-plan-history-${planType}`,
        credencialMadre,
        '/api/v2/mix/order/orders-plan-history',
        { productType: 'USDT-FUTURES', planType, startTime: desde, endTime: hasta, limit: '100' },
        ['clientOid', 'planType', 'planStatus', 'enterPointSource', 'orderSource', 'triggerType']
      );
    }
  });

  it('movimientos de cuenta', async () => {
    await sondear(
      'v2-bill',
      credencialMadre,
      '/api/v2/mix/account/bill',
      {
        productType: 'USDT-FUTURES',
        startTime: String(fin - 29 * DIA),
        endTime: hasta,
        limit: '100'
      },
      ['businessType', 'symbol', 'coin']
    );
  });

  it('traspasos de la cuenta madre', async () => {
    await sondear(
      'v2-sub-main-trans-record',
      credencialMadre,
      '/api/v2/spot/account/sub-main-trans-record',
      { startTime: String(fin - 89 * DIA), endTime: hasta, limit: '100' },
      ['clientOid', 'fromType', 'toType', 'status']
    );
  });
});

describe.skipIf(!hayCredencialUta)('UTA (V3): qué registra Bitget', () => {
  const fin = Date.now();
  const desde = String(fin - 89 * DIA);
  const hasta = String(fin);

  it('historial de órdenes', async () => {
    await sondear(
      'v3-history-orders',
      credencialUta,
      '/api/v3/trade/history-orders',
      { category: 'USDT-FUTURES', startTime: desde, endTime: hasta, limit: '100' },
      ORIGEN
    );
  });

  it('historial de planes TP/SL', async () => {
    await sondear(
      'v3-history-strategy-orders',
      credencialUta,
      '/api/v3/trade/history-strategy-orders',
      { category: 'USDT-FUTURES', startTime: desde, endTime: hasta, limit: '100' },
      ['clientOid', 'type', 'status', 'enterPointSource', 'orderSource', 'tpslType']
    );
  });

  it('movimientos de cuenta', async () => {
    await sondear(
      'v3-financial-records',
      credencialUta,
      '/api/v3/account/financial-records',
      { category: 'USDT-FUTURES', startTime: String(fin - 29 * DIA), endTime: hasta, limit: '100' },
      ['type', 'businessType', 'symbol', 'coin']
    );
  });

  it('traspasos', async () => {
    await sondear(
      'v3-sub-transfer-record',
      credencialUta,
      '/api/v3/account/sub-transfer-record',
      { startTime: String(fin - 89 * DIA), endTime: hasta, limit: '100' },
      ['clientOid', 'fromType', 'toType', 'status']
    );
  });
});

/*
 * Los lectores del panel contra las respuestas reales: que entiendan todo lo
 * que Bitget devuelve y cuánto saldría como «externo». Con la bitácora vacía
 * —estas operaciones son de antes de que existiera—, los cierres del panel y
 * de los scripts de prueba salen como externos: es lo esperado. Lo que se
 * comprueba es que lo automático y lo `pcb…` no.
 */
describe('lectores del panel contra Bitget real', () => {
  const revisar = async (etiqueta: string, cred: Credencial): Promise<void> => {
    const { fuentesBitget } = await import('@main/alertas/fuentes');
    const { clasificar } = await import('@main/alertas/clasificador');
    const { MERCADO_REAL } = await import('@main/bitget/mercado');

    const fin = Date.now();
    const f = fuentesBitget(cliente, cred, MERCADO_REAL);
    const eventos = await f.eventos(fin - 30 * DIA, fin);
    const externos = clasificar(eventos, { bitacora: [], traspasos: [], uid: '' });
    const ajustes = await f.ajustes(['BTCUSDT', 'ETHUSDT']);

    const porTipo = (lista: typeof eventos) =>
      lista.reduce<Record<string, number>>(
        (m, e) => ({ ...m, [e.tipo]: (m[e.tipo] ?? 0) + 1 }),
        {}
      );
    console.log(`  ${etiqueta}: ${eventos.length} eventos`, porTipo(eventos));
    console.log(
      `  ${etiqueta}: automáticos ${eventos.filter((e) => e.automatico).length}, con pcb ${eventos.filter((e) => e.clientOid?.startsWith('pcb')).length}`
    );
    console.log(`  ${etiqueta}: externos con bitácora vacía`, porTipo(externos));
    console.log(`  ${etiqueta}: ajustes`, ajustes);

    expect(externos.some((e) => e.automatico)).toBe(false);
    expect(externos.some((e) => e.clientOid?.startsWith('pcb'))).toBe(false);
    expect(Object.keys(ajustes).length).toBeGreaterThan(0);
  };

  it.skipIf(!hayMadre)(
    'Classic (cuenta madre)',
    async () => {
      await revisar('Classic', credencialMadre);
    },
    60_000
  );

  it.skipIf(!hayCredencialUta)(
    'UTA',
    async () => {
      await revisar('UTA', { ...credencialUta, superficie: 'v3' });
    },
    60_000
  );

  /*
   * El caso de `bg…1395` en el log del cliente (17-19/10/2026): una cuenta
   * Classic a la que V3 contesta, con `accountMode: "classic"`, y que el panel
   * sella como `v3`. El vigía la lee entonces por V3; tiene que ver lo mismo.
   */
  it.skipIf(!hayMadre)(
    'Classic sellada como V3 (accountMode "classic" por V3)',
    async (ctx) => {
      const cred: Credencial = { ...credencialMadre, superficie: 'v3' };
      let accountMode: string | undefined;
      try {
        const ajustes = await cliente.peticionFirmada(
          cred,
          { metodo: 'GET', ruta: '/api/v3/account/settings', idempotente: true },
          z.object({ accountMode: z.string().optional() }).passthrough()
        );
        accountMode = ajustes.datos.accountMode;
      } catch (e) {
        /* 40084: Classic de las que V3 rechaza —como bg…88a2—. No es el caso que se busca. */
        if (e instanceof ErrorBitget && e.codigo === '40084') {
          ctx.skip('La madre es Classic sin acceso a V3 (40084): hace falta una clave como bg…1395.');
        }
        throw e;
      }
      console.log('  Classic por V3: accountMode', accountMode);
      await revisar('Classic por V3', cred);
    },
    60_000
  );
});
