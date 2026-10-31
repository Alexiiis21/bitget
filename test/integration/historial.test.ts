/**
 * El historial de punta a punta: `Sesion` real, cliente real y exchange
 * simulado respondiendo al `history-position` de Classic.
 *
 * Lo que se demuestra es la promesa de la Fase 3: lo sincronizado sigue ahí al
 * reabrir el panel **sin volver a preguntar a Bitget**, y desaparece con la
 * baja de la cuenta.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClienteBitget } from '@main/bitget/rest/client';
import { Sesion } from '@main/ipc/sesion';
import { iniciarExchangeSimulado, sobreOk, type ExchangeSimulado } from '../mock-exchange/servidor';

const KDF_PRUEBAS = { N: 16, r: 1, p: 1 };
const MAESTRA = 'contrasena-de-prueba';
const PASO = 'bg1';
const UID = '5476143799';

const ALTA = {
  etiqueta: 'Sub-01',
  grupoNombre: 'A',
  apiKey: 'bg_7Kq82ab3cd4ef19c',
  secretKey: 'secreto-que-no-debe-salir',
  passphrase: 'frase-que-no-debe-salir'
};

const RUTA_V2 = '/api/v2/mix/position/history-position';

/** Una posición cerrada con la forma de la documentación de V2. */
const cerradaV2 = (
  positionId: string,
  utime: number,
  netProfit: string
): Record<string, unknown> => ({
  positionId,
  symbol: 'BTCUSDT',
  holdSide: 'long',
  marginMode: 'isolated',
  openAvgPrice: '84000',
  closeAvgPrice: '84100',
  openTotalPos: '0.001',
  closeTotalPos: '0.001',
  pnl: '0.1',
  netProfit,
  totalFunding: '0',
  openFee: '-0.05',
  closeFee: '-0.05',
  ctime: String(utime - 60_000),
  utime: String(utime)
});

let carpeta: string;
let exchange: ExchangeSimulado;
let cliente: ClienteBitget;
let sesion: Sesion;
let cuentasLeidas = 0;

const rutas = () => ({
  vault: join(carpeta, 'vault.enc'),
  cuentas: join(carpeta, 'cuentas.json'),
  activos: join(carpeta, 'activos.json'),
  historial: join(carpeta, 'historial')
});

const peticionesHistorial = (): number =>
  exchange.peticiones.filter((p) => p.url.startsWith(RUTA_V2)).length;

beforeEach(async () => {
  cuentasLeidas = 0;
  carpeta = await mkdtemp(join(tmpdir(), 'pcb-historial-int-'));
  exchange = await iniciarExchangeSimulado();
  cliente = new ClienteBitget({ host: exchange.url });
  sesion = new Sesion(rutas(), cliente, { parametrosKdf: KDF_PRUEBAS, zonaHoraria: 'UTC' });

  const ahora = Date.now();
  exchange.responderCon((p) => {
    if (p.url.startsWith('/api/v2/mix/account/accounts')) {
      cuentasLeidas++;
      /* Dos monedas: el panel tiene que quedarse con la de su mercado (SUSDT). */
      return {
        cuerpo: sobreOk([
          {
            marginCoin: 'USDT',
            available: '9999',
            accountEquity: '9999',
            usdtEquity: '9999',
            locked: '0'
          },
          {
            marginCoin: 'SUSDT',
            available: '740.25',
            accountEquity: '812.5',
            usdtEquity: '812.5',
            locked: '3'
          }
        ])
      };
    }
    if (!p.url.startsWith(RUTA_V2)) return null;
    /* Dos posiciones: menos que una página, así que una sola petición basta. */
    return {
      cuerpo: sobreOk({
        list: [cerradaV2('p2', ahora - 1_000, '1.5'), cerradaV2('p1', ahora - 5_000, '-0.4')],
        endId: 'p1'
      })
    };
  });
});

afterEach(async () => {
  sesion.cerrar();
  await cliente.cerrar();
  await exchange.cerrar();
  await rm(carpeta, { recursive: true, force: true });
});

async function altaCuenta(): Promise<string> {
  await sesion.crear(MAESTRA);
  await sesion.fijarPaso(PASO);
  exchange.responder({
    cuerpo: sobreOk({ userId: UID, authorities: ['coow', 'cpow'], parentId: 1513226215 })
  });
  exchange.responder({
    cuerpo: sobreOk({
      marginCoin: 'USDT',
      available: '500',
      accountEquity: '500',
      marginMode: 'isolated',
      posMode: 'hedge_mode',
      isolatedLongLever: 10,
      isolatedShortLever: 10,
      crossedMarginLeverage: 10
    })
  });
  const alta = await sesion.agregar(ALTA);
  return alta.cuenta?.id ?? '';
}

describe('historial de una cuenta Classic', () => {
  it('sincroniza, y al reabrir el panel lo enseña sin volver a Bitget', async () => {
    const id = await altaCuenta();

    const r = await sesion.sincronizarHistorial(id);
    expect(r).toMatchObject({ cuentaId: id, nuevas: 2, total: 2, hueco: false });
    expect(peticionesHistorial()).toBe(1);

    const h = await sesion.consultarHistorial(id);
    expect(h.posiciones.map((p) => p.positionId)).toEqual(['p2', 'p1']);
    expect(h.posiciones[0]).toMatchObject({
      resultado: '1.5',
      comisiones: '-0.1',
      superficie: 'v2'
    });

    /* Panel cerrado y vuelto a abrir: otra Sesion sobre la misma carpeta. */
    sesion.cerrar();
    sesion = new Sesion(rutas(), cliente, { parametrosKdf: KDF_PRUEBAS, zonaHoraria: 'UTC' });
    await sesion.abrir(MAESTRA);

    const reabierto = await sesion.consultarHistorial(id);
    expect(reabierto.posiciones.map((p) => p.positionId)).toEqual(['p2', 'p1']);
    expect(reabierto.cobertura).toEqual(r.cobertura);
    expect(peticionesHistorial()).toBe(1);
  });

  it('una cuenta nunca sincronizada devuelve la lista vacía y cobertura nula', async () => {
    const id = await altaCuenta();
    expect(await sesion.consultarHistorial(id)).toMatchObject({
      cuentaId: id,
      periodo: null,
      posiciones: [],
      resumen: { total: 0, resultadoNeto: '0' },
      cobertura: null,
      sincronizadoEn: null
    });
  });

  it('la baja de la cuenta borra su historial del disco', async () => {
    const id = await altaCuenta();
    await sesion.sincronizarHistorial(id);
    expect(await readdir(join(carpeta, 'historial'))).toEqual([`${id}.json`]);

    expect(await sesion.eliminar(id, PASO)).toBe('borrada');

    expect(await readdir(join(carpeta, 'historial'))).toEqual([]);
    await expect(sesion.consultarHistorial(id)).rejects.toMatchObject({
      motivo: 'cuenta-desconocida'
    });
  });

  it('con el panel bloqueado no se lee ni se sincroniza', async () => {
    const id = await altaCuenta();
    sesion.cerrar();

    await expect(sesion.consultarHistorial(id)).rejects.toThrow('bloqueado');
    await expect(sesion.sincronizarHistorial(id)).rejects.toThrow('bloqueado');
  });
});

describe('saldo vigente de una cuenta', () => {
  it('lee el saldo de la moneda del mercado con la credencial de la propia cuenta', async () => {
    const id = await altaCuenta();

    const s = await sesion.saldoCuenta(id);

    expect(s).toMatchObject({
      cuentaId: id,
      moneda: 'SUSDT',
      equity: '812.5',
      disponible: '740.25',
      bloqueado: '3',
      superficie: 'v2'
    });
    expect(s.leidoEn).toBeGreaterThan(0);
  });

  it('dos consultas seguidas cuestan una sola petición', async () => {
    const id = await altaCuenta();

    await Promise.all([sesion.saldoCuenta(id), sesion.saldoCuenta(id)]);
    await sesion.saldoCuenta(id);

    expect(cuentasLeidas).toBe(1);
  });

  it('refresca de paso el disponible de la matriz', async () => {
    const id = await altaCuenta();
    await sesion.saldoCuenta(id);

    const fila = sesion
      .cuentasPanel()
      .flatMap((c) => c.subcuentas)
      .find((c) => c.id === id);
    expect(fila?.saldo).toBe('740.25');
  });

  it('con el panel bloqueado no se lee', async () => {
    const id = await altaCuenta();
    sesion.cerrar();

    await expect(sesion.saldoCuenta(id)).rejects.toThrow('bloqueado');
  });

  it('una cuenta que no está en el panel se rechaza sin salir a la red', async () => {
    await altaCuenta();

    await expect(sesion.saldoCuenta('cta_inexistente')).rejects.toMatchObject({
      motivo: 'cuenta-desconocida'
    });
    expect(cuentasLeidas).toBe(0);
  });
});

describe('periodo y resultado neto', () => {
  const dia = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

  it('filtra por fecha de cierre, cuenta ganadoras y perdedoras y suma el resultado', async () => {
    const id = await altaCuenta();
    await sesion.sincronizarHistorial(id);

    /* Ayer y hoy: cubre las dos aunque la prueba corra justo a medianoche. */
    const hoy = Date.now();
    const h = await sesion.consultarHistorial(id, {
      desde: dia(hoy - 86_400_000),
      hasta: dia(hoy)
    });

    expect(h.posiciones.map((p) => p.positionId)).toEqual(['p2', 'p1']);
    expect(h.resumen).toEqual({
      total: 2,
      ganadoras: 1,
      perdedoras: 1,
      enCero: 0,
      resultadoNeto: '1.1'
    });
    expect(h.periodo).toMatchObject({ zonaHoraria: 'UTC', desde: dia(hoy - 86_400_000) });
    /*
     * El periodo incluye hoy y la consulta llega después de sincronizar: lo que
     * haya cerrado desde entonces aún no se sabe. Es `faltaDespues`, que se
     * arregla sincronizando; lo anterior sí está completo.
     */
    expect(h.completitud).toEqual({ completo: false, faltaAntes: false, faltaDespues: true });
  });

  it('un periodo sin operaciones da cero, y avisa si es anterior a lo sincronizado', async () => {
    const id = await altaCuenta();
    await sesion.sincronizarHistorial(id);

    const h = await sesion.consultarHistorial(id, { desde: '2026-01-01', hasta: '2026-01-07' });

    expect(h.posiciones).toEqual([]);
    expect(h.resumen).toMatchObject({ total: 0, resultadoNeto: '0' });
    expect(h.completitud).toMatchObject({ completo: false, faltaAntes: true });
  });

  it('un periodo ya pasado y dentro de lo sincronizado está completo', async () => {
    const id = await altaCuenta();
    await sesion.sincronizarHistorial(id);

    /* Hace 30 días: dentro de los 90 que trae la primera sincronización. */
    const hace30 = dia(Date.now() - 30 * 86_400_000);
    const h = await sesion.consultarHistorial(id, { desde: hace30, hasta: hace30 });
    expect(h.completitud).toEqual({ completo: true, faltaAntes: false, faltaDespues: false });
  });

  it('sin sincronizar, el periodo no se da por completo', async () => {
    const id = await altaCuenta();
    const hoy = Date.now();

    const h = await sesion.consultarHistorial(id, { desde: dia(hoy), hasta: dia(hoy) });
    expect(h.completitud.completo).toBe(false);
    expect(h.cobertura).toBeNull();
  });

  it('un periodo invertido o con una fecha que no existe se rechaza con motivo', async () => {
    const id = await altaCuenta();

    await expect(
      sesion.consultarHistorial(id, { desde: '2026-08-07', hasta: '2026-08-01' })
    ).rejects.toMatchObject({ motivo: 'orden-invertido' });
    await expect(
      sesion.consultarHistorial(id, { desde: '2026-02-30', hasta: '2026-03-01' })
    ).rejects.toMatchObject({ motivo: 'fecha-invalida' });
  });
});

describe('filtros y exportación', () => {
  it('el filtro reduce la tabla y el resumen, y la lista de pares no se encoge', async () => {
    const id = await altaCuenta();
    await sesion.sincronizarHistorial(id);

    const h = await sesion.consultarHistorial(id, undefined, {
      simbolo: null,
      lado: null,
      resultado: 'ganadoras'
    });

    expect(h.filtrado).toBe(true);
    expect(h.posiciones.map((p) => p.positionId)).toEqual(['p2']);
    expect(h.resumen).toMatchObject({
      total: 1,
      ganadoras: 1,
      perdedoras: 0,
      resultadoNeto: '1.5'
    });
    expect(h.simbolos).toEqual(['BTCUSDT']);
  });

  it('exporta exactamente lo que enseña la consulta con el mismo filtro', async () => {
    const id = await altaCuenta();
    await sesion.sincronizarHistorial(id);

    const filtro = { simbolo: 'BTCUSDT', lado: 'long' as const, resultado: 'perdedoras' as const };
    const vista = await sesion.consultarHistorial(id, undefined, filtro);
    const datos = await sesion.datosExportacion(id, undefined, filtro, 7);

    const lineas = datos.csv.replace(/^\uFEFF/, '').trimEnd().split('\r\n');
    expect(datos.filas).toBe(vista.posiciones.length);
    expect(lineas).toHaveLength(1 + vista.posiciones.length);
    expect(lineas[1]).toContain(',p1');
    expect(lineas[1]).toContain(',-0.4,');
    /* Panel 7, cuenta A, casilla 1: el mismo identificador que enseña la pantalla. */
    expect(lineas[1]?.startsWith('PCB-7-A-1,A,Sub-01,BTCUSDT,Long,')).toBe(true);
    expect(datos.nombre).toBe('historial_PCB-7-A-1_completo.csv');
  });

  it('un periodo inválido se rechaza antes de pedir dónde guardar', async () => {
    const id = await altaCuenta();
    await expect(
      sesion.datosExportacion(
        id,
        { desde: '2026-08-07', hasta: '2026-08-01' },
        {
          simbolo: null,
          lado: null,
          resultado: 'todas'
        },
        1
      )
    ).rejects.toMatchObject({ motivo: 'orden-invertido' });
  });
});
