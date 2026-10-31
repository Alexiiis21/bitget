/**
 * ELITE LAURA, 19/10/2026: el Take Profit embebido que no quedo puesto.
 *
 * ==========================================================================
 * Lo que paso
 * ==========================================================================
 * `account/settings` respondia `accountMode: "classic"` y la deteccion la daba
 * por UTA porque todo lo que no estaba en transicion caia ahi. La cuenta abrio
 * long y short a la vez por V3 con el Take Profit dentro de `place-order`, los
 * dos respondieron `00000`, y el del short no estaba. La sesion lo daba por
 * puesto sin mirar: «Take Profit … puesto con la orden de apertura». El
 * operador lo puso a mano a los 13 minutos.
 *
 * Dos pruebas, una por cada mitad del arreglo:
 *
 *   (a) una cuenta que V3 declara `classic` va por V2, y un `accountMode` que
 *       no se conoce no se trata como UTA
 *   (b) tras abrir en UTA se comprueba cada Take Profit embebido; el que falta
 *       se repone, y la bitacora lo dice con `tp-verificado`, `tp-repuesto` o
 *       `tp-faltante`
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClienteBitget } from '@main/bitget/rest/client';
import { detectarModo } from '@main/bitget/deteccion-modo';
import { detenerBitacora, iniciarBitacora } from '@main/diagnostico/bitacora';
import { LimitadorPeticiones } from '@main/execution/rate-limiter';
import {
  MotorLotes,
  type CuentaEjecutable,
  type FuenteCuentas,
  type ObjetivoApertura
} from '@main/execution/motor-lotes';
import { Sesion } from '@main/ipc/sesion';
import { archivoLogDeHoy } from '@main/storage/paths';
import {
  iniciarExchangeSimulado,
  sobreError,
  sobreOk,
  type ExchangeSimulado,
  type PeticionRecibida,
  type Respuesta
} from '../mock-exchange/servidor';

const KDF_PRUEBAS = { N: 16, r: 1, p: 1 };
const SIMBOLO = 'SBTCSUSDT';

const CONTRATO = {
  symbol: SIMBOLO,
  baseCoin: 'SBTC',
  quoteCoin: 'SUSDT',
  minTradeNum: '0.0001',
  volumePlace: '4',
  pricePlace: '1',
  priceEndStep: '1',
  sizeMultiplier: '0.0001',
  minTradeUSDT: '5',
  minLever: '1',
  maxLever: '125',
  maxMarketOrderQty: '220',
  maxOrderQty: '1200',
  symbolStatus: 'normal'
};

const TICKER = [{ symbol: SIMBOLO, lastPr: '63378', markPrice: '63381.3' }];
const PRECIO_ENTRADA_REAL = '63500.0';

/** Lo que devolvio `account/settings` para ELITE LAURA, salvo el simbolo. */
const AJUSTES_LAURA = {
  uid: '3477205169',
  accountMode: 'classic',
  holdMode: 'hedge_mode',
  symbolConfigList: [
    { category: 'SUSDT-FUTURES', symbol: SIMBOLO, marginMode: 'isolated', leverage: '10' }
  ]
};

const AJUSTES_UNIFICADA = { ...AJUSTES_LAURA, accountMode: 'unified' };

let carpeta: string;
let exchange: ExchangeSimulado;
let cliente: ClienteBitget;

/** Los eventos de la bitacora del dia. La escritura va en cola: se espera a que lleguen. */
const eventos = async (nombre: string, cuantos = 1): Promise<Record<string, unknown>[]> => {
  let encontrados: Record<string, unknown>[] = [];
  for (let i = 0; i < 50; i += 1) {
    try {
      const texto = await readFile(join(carpeta, archivoLogDeHoy()), 'utf8');
      encontrados = texto
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((r) => r['evento'] === nombre);
    } catch {
      encontrados = [];
    }
    if (encontrados.length >= cuantos) return encontrados;
    await new Promise((r) => setTimeout(r, 20));
  }
  return encontrados;
};

beforeEach(async () => {
  carpeta = await mkdtemp(join(tmpdir(), 'pcb-tp-embebido-'));
  await iniciarBitacora(join(carpeta, 'logs'));
  carpeta = join(carpeta, 'logs');
  exchange = await iniciarExchangeSimulado();
  cliente = new ClienteBitget({
    host: exchange.url,
    limitador: new LimitadorPeticiones({ dormir: async () => undefined })
  });
});

afterEach(async () => {
  detenerBitacora();
  await cliente.cerrar();
  await exchange.cerrar();
  await rm(join(carpeta, '..'), { recursive: true, force: true });
});

/* ========================================================================== */
/* (a) La deteccion ya no etiqueta «classic» como UTA                         */
/* ========================================================================== */

describe('(a) accountMode por V3', () => {
  const CREDENCIAL = { apiKey: 'bg_laura_1395', secretKey: 's', passphrase: 'f' };

  it('una cuenta que V3 declara classic y V2 acepta es clasica, no UTA', async () => {
    exchange.simularUta(AJUSTES_LAURA);
    exchange.responderCon((p) =>
      p.url.startsWith('/api/v2/spot/account/info')
        ? { cuerpo: sobreOk({ userId: '3477205169', authorities: ['coow'], ips: '' }) }
        : null
    );

    const r = await detectarModo(cliente, CREDENCIAL);

    expect(r.modo).toBe('classic');
    expect(r.accountModeCrudo).toBe('classic');
    /* No hay rechazo: V3 contesto, y fue la propia cuenta la que dijo que no es UTA. */
    expect(r.codigoRechazo).toBeNull();

    const [evento] = await eventos('deteccion-modo');
    expect(evento?.['modo']).toBe('classic');
    expect(evento?.['causa']).toBe('v3-declara-classic');
    expect(evento?.['v2']).toBe('acepta');
  });

  it('27/10: V3 declara classic pero V2 la rechaza (40731): se queda en UTA', async () => {
    /*
     * Lo que reporto el cliente: la ELITE UTA no conectaba. V2 contesta 40731 y
     * la cuenta, que si opera por V3, salia como «Credenciales invalidas».
     */
    exchange.simularUta(AJUSTES_LAURA);
    exchange.responderCon((p) =>
      p.url.startsWith('/api/v2/')
        ? { cuerpo: sobreError('40731', 'This account is not supported in V2') }
        : null
    );

    const r = await detectarModo(cliente, CREDENCIAL);

    expect(r.modo).toBe('uta');
    expect(r.accountModeCrudo).toBe('classic');
    expect(r.holdMode).toBe('hedge_mode');
    expect(r.configSimbolos).toHaveLength(1);

    const [evento] = await eventos('deteccion-modo');
    expect(evento?.['causa']).toBe('v3-declara-classic-v2-rechaza');
    expect(evento?.['codigoV2']).toBe('40731');
  });

  it('27/10: el alta de esa cuenta es valida y queda por V3', async () => {
    const sesion = new Sesion(
      {
        vault: join(carpeta, 'vault.enc'),
        cuentas: join(carpeta, 'cuentas.json'),
        activos: join(carpeta, 'activos.json')
      },
      cliente,
      { parametrosKdf: KDF_PRUEBAS }
    );
    await sesion.crear('contrasena-de-prueba');

    exchange.simularUta(AJUSTES_LAURA);
    exchange.responderCon((p) => {
      if (p.url.startsWith('/api/v2/')) {
        return { cuerpo: sobreError('40731', 'This account is not supported in V2') };
      }
      if (p.url.startsWith('/api/v3/account/assets')) {
        return { cuerpo: sobreOk({ accountEquity: '500', assets: [] }) };
      }
      return null;
    });

    const alta = await sesion.agregar({
      etiqueta: 'ELITE',
      grupoNombre: 'A',
      apiKey: 'bg_7Kq82ab3cd4e1395',
      secretKey: 'secreto',
      passphrase: 'frase'
    });

    expect(alta.ok).toBe(true);
    const id = sesion.listar()[0]?.id ?? '';
    expect(sesion.cuentaEjecutable(id)?.credencial.superficie).toBe('v3');

    const [verif] = await eventos('verificacion-credencial');
    expect(verif?.['veredicto']).toBe('valida');
    expect(verif?.['accountMode']).toBe('uta');

    /* Desconectar y volver a conectar la misma cuenta: mismo resultado. */
    await sesion.fijarPaso('bg1');
    expect(await sesion.eliminar(id, 'bg1')).toBe('borrada');
    expect(sesion.listar()).toHaveLength(0);
    const otra = await sesion.agregar({
      etiqueta: 'ELITE',
      grupoNombre: 'A',
      apiKey: 'bg_7Kq82ab3cd4e1395',
      secretKey: 'secreto',
      passphrase: 'frase'
    });
    expect(otra.ok).toBe(true);
    const id2 = sesion.listar()[0]?.id ?? '';
    expect(sesion.cuentaEjecutable(id2)?.credencial.superficie).toBe('v3');
    sesion.cerrar();
  });

  it('un accountMode desconocido no se da por UTA: indeterminado y anotado', async () => {
    exchange.simularUta({ ...AJUSTES_LAURA, accountMode: 'quantum' });

    const r = await detectarModo(cliente, CREDENCIAL);

    expect(r.modo).toBe('indeterminado');
    expect(r.accountModeCrudo).toBe('quantum');

    const [evento] = await eventos('deteccion-modo');
    expect(evento?.['causa']).toBe('account-mode-desconocido');
    expect(evento?.['accountMode']).toBe('quantum');
  });

  it('unified y hybrid siguen siendo UTA', async () => {
    for (const accountMode of ['unified', 'hybrid']) {
      exchange.simularUta({ ...AJUSTES_LAURA, accountMode });
      const r = await detectarModo(cliente, CREDENCIAL);
      expect(r.modo).toBe('uta');
      expect(r.holdMode).toBe('hedge_mode');
    }
  });

  it('una ficha ya guardada como UTA vuelve a V2 al revalidar si V3 dice classic', async () => {
    const sesion = new Sesion(
      {
        vault: join(carpeta, 'vault.enc'),
        cuentas: join(carpeta, 'cuentas.json'),
        activos: join(carpeta, 'activos.json')
      },
      cliente,
      { parametrosKdf: KDF_PRUEBAS }
    );
    await sesion.crear('contrasena-de-prueba');

    exchange.responderCon((p) => {
      if (p.url.startsWith('/api/v2/spot/account/info')) {
        return {
          cuerpo: sobreOk({
            userId: '3477205169',
            authorities: ['coow', 'cpow'],
            ips: '1.2.3.4',
            parentId: 1513226215
          })
        };
      }
      if (p.url.startsWith('/api/v2/mix/account/account')) {
        return {
          cuerpo: sobreOk({
            marginCoin: 'USDT',
            available: '500',
            accountEquity: '500',
            marginMode: 'crossed',
            posMode: 'hedge_mode',
            isolatedLongLever: 50,
            isolatedShortLever: 50,
            crossedMarginLeverage: 50
          })
        };
      }
      return null;
    });

    /* Asi estaba LAURA: guardada como UTA por la deteccion vieja. */
    exchange.simularUta(AJUSTES_UNIFICADA);
    const alta = await sesion.agregar({
      etiqueta: 'ELITE LAURA',
      grupoNombre: 'A',
      apiKey: 'bg_7Kq82ab3cd4e1395',
      secretKey: 'secreto',
      passphrase: 'frase'
    });
    expect(alta.ok).toBe(true);
    const id = sesion.listar()[0]?.id ?? '';
    expect(sesion.cuentaEjecutable(id)?.credencial.superficie).toBe('v3');

    exchange.simularUta(AJUSTES_LAURA);
    await sesion.verificar(id);

    expect(sesion.cuentaEjecutable(id)?.credencial.superficie).toBe('v2');
    sesion.cerrar();
  });
});

/* ========================================================================== */
/* (b) Apertura simultanea: el Take Profit que no queda se repone             */
/* ========================================================================== */

/** Una sola cuenta UTA en cobertura, como la ve el motor. */
class CuentaUta implements FuenteCuentas {
  readonly cuenta: CuentaEjecutable = {
    cuentaId: 'cta_laura',
    etiqueta: 'ELITE LAURA',
    credencial: {
      apiKey: 'bg_7Kq82ab3cd4e1395',
      secretKey: 's',
      passphrase: 'f',
      superficie: 'v3',
      holdMode: 'hedge_mode'
    },
    saldoDisponible: '3000',
    modoMargen: 'isolated'
  };

  cuentaEjecutable(cuentaId: string): CuentaEjecutable | null {
    return cuentaId === this.cuenta.cuentaId ? this.cuenta : null;
  }
}

const AMBOS_LADOS: ObjetivoApertura[] = [
  { cuentaId: 'cta_laura', lado: 'long' },
  { cuentaId: 'cta_laura', lado: 'short' }
];

interface EstrategiaSimulada {
  orderId: string;
  clientOid: string;
  symbol: string;
  posSide: string;
  status: string;
  takeProfit: string;
  qty: string;
}

/**
 * Bitget en UTA, con las estrategias `tpsl` en memoria.
 *
 * `soltarEmbebido` es el fallo del 19/10/2026: `place-order` entra con `00000`
 * y el Take Profit de ese lado no aparece. `tpSeparado` decide que hace
 * `place-strategy-order`: aceptarlo -lo que hizo LAURA a las 16:14- o el
 * `31008` de una cuenta unificada.
 */
function enrutarUta(opciones: {
  soltarEmbebido: ReadonlySet<string>;
  tpSeparado: 'acepta' | '31008';
  listadoFalla?: boolean;
}): EstrategiaSimulada[] {
  const estrategias: EstrategiaSimulada[] = [];
  /* Antes de la primera orden no hay posicion: la apertura con Take Profit lo lee al planificar. */
  let ordenada = false;

  exchange.responderCon((p: PeticionRecibida): Respuesta | null => {
    if (p.url.startsWith('/api/v2/public/time'))
      return { cuerpo: sobreOk({ serverTime: String(Date.now()) }) };
    if (p.url.startsWith('/api/v2/mix/market/contracts')) return { cuerpo: sobreOk([CONTRATO]) };
    if (p.url.startsWith('/api/v2/mix/market/ticker')) return { cuerpo: sobreOk(TICKER) };

    if (p.url.startsWith('/api/v3/trade/place-order')) {
      ordenada = true;
      const cuerpo = JSON.parse(p.cuerpo) as Record<string, string>;
      const lado = cuerpo['posSide'] ?? '';
      if (cuerpo['takeProfit'] !== undefined && !opciones.soltarEmbebido.has(lado)) {
        estrategias.push({
          orderId: `tp_${cuerpo['clientOid'] ?? ''}`,
          clientOid: `tp_${cuerpo['clientOid'] ?? ''}`,
          symbol: SIMBOLO,
          posSide: lado,
          status: 'pending',
          takeProfit: cuerpo['takeProfit'],
          qty: cuerpo['qty'] ?? ''
        });
      }
      return {
        cuerpo: sobreOk({
          orderId: `ord_${cuerpo['clientOid'] ?? ''}`,
          clientOid: cuerpo['clientOid']
        })
      };
    }

    if (p.url.startsWith('/api/v3/trade/place-strategy-order')) {
      if (opciones.tpSeparado === '31008') {
        return { cuerpo: sobreError('31008', 'There is no position in this position') };
      }
      const cuerpo = JSON.parse(p.cuerpo) as Record<string, string>;
      estrategias.push({
        orderId: `sep_${cuerpo['clientOid'] ?? ''}`,
        clientOid: cuerpo['clientOid'] ?? '',
        symbol: SIMBOLO,
        posSide: cuerpo['posSide'] ?? '',
        status: 'pending',
        takeProfit: cuerpo['takeProfit'] ?? '',
        qty: ''
      });
      return {
        cuerpo: sobreOk({
          orderId: `sep_${cuerpo['clientOid'] ?? ''}`,
          clientOid: cuerpo['clientOid']
        })
      };
    }

    if (p.url.startsWith('/api/v3/trade/unfilled-strategy-orders')) {
      if (opciones.listadoFalla === true) return { cuerpo: sobreError('40725', 'service error') };
      return { cuerpo: sobreOk(estrategias) };
    }

    if (p.url.startsWith('/api/v3/position/current-position')) {
      return {
        cuerpo: sobreOk({
          list: (ordenada ? ['long', 'short'] : []).map((posSide) => ({
            symbol: SIMBOLO,
            posSide,
            total: '0.0157',
            marginMode: 'isolated',
            avgPrice: PRECIO_ENTRADA_REAL,
            liquidationPrice: '0',
            leverage: '10',
            marginSize: '100'
          }))
        })
      };
    }
    return null;
  });

  return estrategias;
}

describe('(b) apertura long + short simultanea en UTA', () => {
  let fuente: CuentaUta;
  let sesion: Sesion;

  beforeEach(async () => {
    exchange.simularUta(AJUSTES_UNIFICADA);
    fuente = new CuentaUta();
    const motor = new MotorLotes(cliente, fuente, { dormir: async () => undefined });
    sesion = new Sesion(
      {
        vault: join(carpeta, 'vault.enc'),
        cuentas: join(carpeta, 'cuentas.json'),
        activos: join(carpeta, 'activos.json')
      },
      cliente,
      { parametrosKdf: KDF_PRUEBAS, mercado: 'simulado', motor, dormir: async () => undefined }
    );
    await sesion.crear('contrasena-de-prueba');
    /* La sesion resuelve la cuenta con la misma fuente que el motor. */
    vi.spyOn(sesion, 'cuentaEjecutable').mockImplementation((id) => fuente.cuentaEjecutable(id));
    enrutarUta({ soltarEmbebido: new Set(), tpSeparado: 'acepta' });
    await sesion.fijarTopeMargen('1000');
  });

  afterEach(() => {
    sesion.cerrar();
  });

  const abrirAmbos = async (): Promise<Awaited<ReturnType<Sesion['ejecutarApertura']>>> => {
    const plan = await sesion.planificarApertura({
      simbolo: SIMBOLO,
      objetivos: AMBOS_LADOS,
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null,
      modoMargen: 'isolated',
      takeProfitPorcentaje: '35'
    });
    return sesion.ejecutarApertura(plan.id);
  };

  it('con los dos embebidos puestos, los comprueba y no coloca nada aparte', async () => {
    enrutarUta({ soltarEmbebido: new Set(), tpSeparado: 'acepta' });

    const lote = await abrirAmbos();

    const tps = lote.jobs.filter((j) => j.etiqueta === 'ELITE LAURA · TP');
    expect(tps).toHaveLength(2);
    expect(tps.every((j) => j.estado === 'exito')).toBe(true);
    expect(tps.every((j) => (j.mensaje ?? '').includes('comprobado en Bitget'))).toBe(true);
    expect(
      exchange.peticiones.some((p) => p.url.startsWith('/api/v3/trade/place-strategy-order'))
    ).toBe(false);

    const verificados = await eventos('tp-verificado', 2);
    expect(verificados.map((e) => e['lado']).sort()).toEqual(['long', 'short']);
  });

  it('si el del short no queda, lo repone con place-strategy-order y lo anota', async () => {
    const estrategias = enrutarUta({ soltarEmbebido: new Set(['short']), tpSeparado: 'acepta' });

    const lote = await abrirAmbos();

    /* El long se verifico; el short se repuso aparte, sobre su posSide. */
    const separados = exchange.peticiones
      .filter((p) => p.url.startsWith('/api/v3/trade/place-strategy-order'))
      .map((p) => JSON.parse(p.cuerpo) as Record<string, unknown>);
    expect(separados).toHaveLength(1);
    expect(separados[0]?.['posSide']).toBe('short');
    /* Desde la entrada real: 63500 x (1 - 0,35/10) = 61277,5. */
    expect(separados[0]?.['takeProfit']).toBe('61277.5');

    /* Los dos lados acaban con Take Profit, y uno solo por lado. */
    expect(estrategias.filter((e) => e.posSide === 'long')).toHaveLength(1);
    expect(estrategias.filter((e) => e.posSide === 'short')).toHaveLength(1);

    const tps = lote.jobs.filter((j) => j.etiqueta === 'ELITE LAURA · TP');
    expect(tps).toHaveLength(2);
    expect(tps.every((j) => j.estado === 'exito')).toBe(true);
    expect(tps.find((j) => j.lado === 'short')?.mensaje).toContain('no quedó puesto');

    const [verificado] = await eventos('tp-verificado');
    expect(verificado?.['lado']).toBe('long');
    const [repuesto] = await eventos('tp-repuesto');
    expect(repuesto?.['lado']).toBe('short');
    expect(repuesto?.['precio']).toBe('61277.5');
    expect(await eventos('tp-faltante', 0)).toHaveLength(0);
  });

  it('si Bitget no deja reponerlo (31008 en unificada), la fila dice SIN Take Profit y se anota tp-faltante', async () => {
    enrutarUta({ soltarEmbebido: new Set(['short']), tpSeparado: '31008' });

    const lote = await abrirAmbos();

    const short = lote.jobs.find((j) => j.etiqueta === 'ELITE LAURA · TP' && j.lado === 'short');
    expect(short?.estado).toBe('fallo');
    expect(short?.mensaje).toContain('SIN Take Profit');

    const [faltante] = await eventos('tp-faltante');
    expect(faltante?.['lado']).toBe('short');
    expect(faltante?.['causa']).toBe('embebido-ausente');
  });

  it('si el listado no se puede leer no repone a ciegas: lo dice y lo anota', async () => {
    enrutarUta({ soltarEmbebido: new Set(['short']), tpSeparado: 'acepta', listadoFalla: true });

    const lote = await abrirAmbos();

    expect(
      exchange.peticiones.some((p) => p.url.startsWith('/api/v3/trade/place-strategy-order'))
    ).toBe(false);
    const tps = lote.jobs.filter((j) => j.etiqueta === 'ELITE LAURA · TP');
    expect(tps.every((j) => j.estado === 'fallo')).toBe(true);
    expect(tps[0]?.mensaje).toContain('No se pudo comprobar');

    const faltantes = await eventos('tp-faltante', 2);
    expect(faltantes.every((e) => e['causa'] === 'ilegible')).toBe(true);
  });
});
