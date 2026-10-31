/**
 * La pantalla de historial frente a respuestas que llegan tarde.
 *
 * El operador cambia de subcuenta o de fechas más rápido de lo que contesta
 * Bitget. Lo que se prueba aquí es lo que no puede pasar nunca: que la suma o
 * el saldo de una subcuenta aparezcan con otra elegida. El servicio es de
 * mentira y cada respuesta se suelta a mano, en el orden que interesa.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ExportResult,
  HistoryFilter,
  HistoryPeriod,
  HistorySyncProgress,
  HistorySyncResult,
  LiveBalance,
  TradeHistory
} from '@shared/domain/panel-view';

/** Una promesa que se resuelve o rechaza desde fuera. */
function pendiente<T>() {
  let resolver!: (v: T) => void;
  let rechazar!: (e: unknown) => void;
  const promesa = new Promise<T>((res, rej) => {
    resolver = res;
    rechazar = rej;
  });
  return { promesa, resolver, rechazar };
}

type Pendiente<T> = ReturnType<typeof pendiente<T>>;

const consultas: {
  sub: string;
  periodo: HistoryPeriod | undefined;
  filtro: HistoryFilter | undefined;
  p: Pendiente<TradeHistory>;
}[] = [];
const exportaciones: {
  sub: string;
  filtro: HistoryFilter | undefined;
  p: Pendiente<ExportResult>;
}[] = [];
const sincronizaciones: { sub: string; p: Pendiente<HistorySyncResult> }[] = [];
const saldos: { sub: string; p: Pendiente<LiveBalance> }[] = [];
let oyenteProgreso: ((p: HistorySyncProgress) => void) | null = null;

vi.mock('@/services/panel-service', () => ({
  panelService: {
    queryHistory: (sub: string, periodo?: HistoryPeriod, filtro?: HistoryFilter) => {
      const p = pendiente<TradeHistory>();
      consultas.push({ sub, periodo, filtro, p });
      return p.promesa;
    },
    exportHistory: (sub: string, _periodo?: HistoryPeriod, filtro?: HistoryFilter) => {
      const p = pendiente<ExportResult>();
      exportaciones.push({ sub, filtro, p });
      return p.promesa;
    },
    syncHistory: (sub: string) => {
      const p = pendiente<HistorySyncResult>();
      sincronizaciones.push({ sub, p });
      return p.promesa;
    },
    getLiveBalance: (sub: string) => {
      const p = pendiente<LiveBalance>();
      saldos.push({ sub, p });
      return p.promesa;
    },
    subscribeHistorySync: (cb: (p: HistorySyncProgress) => void) => {
      oyenteProgreso = cb;
      return () => {
        oyenteProgreso = null;
      };
    }
  }
}));

const { usarHistorial, problemaDelPeriodo, periodoPorDefecto } = await import('@/store/historial');

const historial = (sub: string, neto: string): TradeHistory => ({
  subAccountId: sub,
  symbols: [],
  filtered: false,
  period: null,
  trades: [],
  summary: { total: 1, winners: 1, losers: 0, breakeven: 0, netPnl: neto },
  completeness: { complete: true, missingBefore: false, missingAfter: false },
  coverage: { fromMs: 1, toMs: 2 },
  syncedAt: 2
});

const sync = (sub: string): HistorySyncResult => ({
  subAccountId: sub,
  added: 1,
  total: 1,
  coverage: { fromMs: 1, toMs: 2 },
  gap: false,
  syncedAt: 2
});

const saldo = (sub: string, equity: string): LiveBalance => ({
  subAccountId: sub,
  currency: 'USDT',
  equity,
  available: equity,
  locked: '0',
  readAt: 1
});

/** Deja correr las promesas ya resueltas. */
const vaciar = () => new Promise((r) => setTimeout(r, 0));

const ultima = <T>(lista: T[]): T => {
  const x = lista[lista.length - 1];
  if (x === undefined) throw new Error('sin elementos');
  return x;
};

beforeEach(() => {
  consultas.length = 0;
  exportaciones.length = 0;
  sincronizaciones.length = 0;
  saldos.length = 0;
  usarHistorial.getState().reiniciar();
});

describe('elegir una subcuenta', () => {
  it('pide lo guardado, sincroniza y lee el saldo; al sincronizar, vuelve a consultar', async () => {
    usarHistorial.getState().elegirSubcuenta('s1');

    expect(consultas.map((c) => c.sub)).toEqual(['s1']);
    expect(sincronizaciones.map((c) => c.sub)).toEqual(['s1']);
    expect(saldos.map((c) => c.sub)).toEqual(['s1']);
    expect(usarHistorial.getState().sincronizando).toBe('s1');

    ultima(consultas).p.resolver(historial('s1', '10'));
    ultima(sincronizaciones).p.resolver(sync('s1'));
    await vaciar();

    expect(consultas).toHaveLength(2);
    ultima(consultas).p.resolver(historial('s1', '12'));
    await vaciar();

    const e = usarHistorial.getState();
    expect(e.datos?.summary.netPnl).toBe('12');
    expect(e.sincronizando).toBeNull();
  });

  it('la consulta de la subcuenta anterior que llega tarde no se pinta', async () => {
    usarHistorial.getState().elegirSubcuenta('s1');
    const deS1 = ultima(consultas);
    usarHistorial.getState().elegirSubcuenta('s2');
    const deS2 = ultima(consultas);

    deS2.p.resolver(historial('s2', '20'));
    await vaciar();
    deS1.p.resolver(historial('s1', '10'));
    await vaciar();

    expect(usarHistorial.getState().datos?.subAccountId).toBe('s2');
    expect(usarHistorial.getState().datos?.summary.netPnl).toBe('20');
  });

  it('el saldo de la subcuenta anterior que llega tarde no se pinta', async () => {
    usarHistorial.getState().elegirSubcuenta('s1');
    const deS1 = ultima(saldos);
    usarHistorial.getState().elegirSubcuenta('s2');
    const deS2 = ultima(saldos);

    deS2.p.resolver(saldo('s2', '200'));
    await vaciar();
    deS1.p.resolver(saldo('s1', '100'));
    await vaciar();

    expect(usarHistorial.getState().saldo?.subAccountId).toBe('s2');
  });

  it('al cambiar de subcuenta, lo de la anterior desaparece antes de que llegue lo nuevo', async () => {
    usarHistorial.getState().elegirSubcuenta('s1');
    ultima(consultas).p.resolver(historial('s1', '10'));
    ultima(saldos).p.resolver(saldo('s1', '100'));
    await vaciar();

    usarHistorial.getState().elegirSubcuenta('s2');

    expect(usarHistorial.getState().datos).toBeNull();
    expect(usarHistorial.getState().saldo).toBeNull();
  });

  it('la sincronización de la anterior que termina después no toca la de la nueva', async () => {
    usarHistorial.getState().elegirSubcuenta('s1');
    const syncS1 = ultima(sincronizaciones);
    usarHistorial.getState().elegirSubcuenta('s2');

    syncS1.p.resolver(sync('s1'));
    await vaciar();

    const e = usarHistorial.getState();
    expect(e.sincronizando).toBe('s2');
    expect(e.ultimaSync).toBeNull();
    /* Y no relanzó una consulta de s1. */
    expect(consultas.filter((c) => c.sub === 's1')).toHaveLength(1);
  });

  it('elegir la misma subcuenta otra vez no repite nada', () => {
    usarHistorial.getState().elegirSubcuenta('s1');
    usarHistorial.getState().elegirSubcuenta('s1');

    expect(consultas).toHaveLength(1);
    expect(sincronizaciones).toHaveLength(1);
  });
});

describe('periodo', () => {
  it('cambiar las fechas consulta lo guardado, sin volver a Bitget', () => {
    usarHistorial.getState().elegirSubcuenta('s1');
    usarHistorial.getState().fijarPeriodo({ from: '2026-08-01', to: '2026-08-07' });

    expect(ultima(consultas).periodo).toEqual({ from: '2026-08-01', to: '2026-08-07' });
    expect(sincronizaciones).toHaveLength(1);
  });

  it('un periodo invertido no se consulta y dice por qué', () => {
    usarHistorial.getState().elegirSubcuenta('s1');
    const antes = consultas.length;
    usarHistorial.getState().fijarPeriodo({ from: '2026-08-07', to: '2026-08-01' });

    expect(consultas).toHaveLength(antes);
    expect(usarHistorial.getState().problemaPeriodo).toMatch(/posterior/);
  });

  it('la consulta de unas fechas anteriores que llega tarde no pisa la de las nuevas', async () => {
    usarHistorial.getState().elegirSubcuenta('s1');
    usarHistorial.getState().fijarPeriodo({ from: '2026-08-01', to: '2026-08-07' });
    const vieja = ultima(consultas);
    usarHistorial.getState().fijarPeriodo({ from: '2026-08-01', to: '2026-08-31' });
    const nueva = ultima(consultas);

    nueva.p.resolver(historial('s1', '31'));
    await vaciar();
    vieja.p.resolver(historial('s1', '7'));
    await vaciar();

    expect(usarHistorial.getState().datos?.summary.netPnl).toBe('31');
  });

  it('por defecto, los últimos siete días con hoy incluido', () => {
    expect(periodoPorDefecto(new Date(2026, 9, 13))).toEqual({
      from: '2026-10-07',
      to: '2026-10-13'
    });
  });

  it('problemaDelPeriodo pide las dos fechas', () => {
    expect(problemaDelPeriodo({ from: '', to: '2026-10-13' })).toMatch(/fecha/);
    expect(problemaDelPeriodo({ from: '2026-10-01', to: '2026-10-13' })).toBeNull();
  });
});

describe('progreso y bloqueo', () => {
  it('el avance de otra subcuenta no se enseña', () => {
    const dejar = usarHistorial.getState().escucharProgreso();
    usarHistorial.getState().elegirSubcuenta('s2');

    oyenteProgreso?.({ subAccountId: 's1', pages: 1, received: 100 });
    expect(usarHistorial.getState().progreso).toBeNull();

    oyenteProgreso?.({ subAccountId: 's2', pages: 1, received: 50 });
    expect(usarHistorial.getState().progreso?.received).toBe(50);
    dejar();
  });

  it('lo que llega después de bloquear el panel se descarta', async () => {
    usarHistorial.getState().elegirSubcuenta('s1');
    const c = ultima(consultas);
    const s = ultima(saldos);
    const y = ultima(sincronizaciones);

    usarHistorial.getState().reiniciar();
    c.p.resolver(historial('s1', '10'));
    s.p.resolver(saldo('s1', '100'));
    y.p.resolver(sync('s1'));
    await vaciar();

    const e = usarHistorial.getState();
    expect(e.subcuenta).toBeNull();
    expect(e.datos).toBeNull();
    expect(e.saldo).toBeNull();
    expect(e.ultimaSync).toBeNull();
  });

  it('un fallo de Bitget al sincronizar se dice sin perder lo guardado', async () => {
    usarHistorial.getState().elegirSubcuenta('s1');
    ultima(consultas).p.resolver(historial('s1', '10'));
    ultima(sincronizaciones).p.rechazar(
      new Error(
        "Error invoking remote method 'historial:sincronizar': ErrorBitget: Esta IP no esta autorizada."
      )
    );
    await vaciar();

    const e = usarHistorial.getState();
    expect(e.errorSync).toBe('Esta IP no esta autorizada.');
    expect(e.datos?.summary.netPnl).toBe('10');
    expect(e.sincronizando).toBeNull();
  });
});

describe('filtros y exportación', () => {
  const ganadorasBtc: HistoryFilter = { symbol: 'BTCUSDT', side: null, outcome: 'winners' };

  it('el filtro viaja con la consulta, sin volver a Bitget', () => {
    usarHistorial.getState().elegirSubcuenta('s1');
    usarHistorial.getState().fijarFiltro(ganadorasBtc);

    expect(ultima(consultas).filtro).toEqual(ganadorasBtc);
    expect(sincronizaciones).toHaveLength(1);
  });

  it('al cambiar de subcuenta se suelta el par, pero no el lado ni el resultado', () => {
    usarHistorial.getState().elegirSubcuenta('s1');
    usarHistorial.getState().fijarFiltro({ symbol: 'BTCUSDT', side: 'short', outcome: 'losers' });
    usarHistorial.getState().elegirSubcuenta('s2');

    expect(usarHistorial.getState().filtro).toEqual({
      symbol: null,
      side: 'short',
      outcome: 'losers'
    });
  });

  it('exporta con la subcuenta, el periodo y el filtro de la pantalla', async () => {
    usarHistorial.getState().elegirSubcuenta('s1');
    usarHistorial.getState().fijarFiltro(ganadorasBtc);

    const exportando = usarHistorial.getState().exportar();
    expect(usarHistorial.getState().exportando).toBe(true);
    expect(exportaciones).toHaveLength(1);
    expect(exportaciones[0]).toMatchObject({ sub: 's1', filtro: ganadorasBtc });

    ultima(exportaciones).p.resolver({
      cancelled: false,
      ok: true,
      path: 'C:\\Users\\op\\Documents\\historial.csv',
      rows: 3,
      message: '3 operaciones exportadas.'
    });
    await exportando;

    const e = usarHistorial.getState();
    expect(e.exportando).toBe(false);
    expect(e.ultimaExportacion?.rows).toBe(3);
  });

  it('cerrar el diálogo sin guardar no deja aviso', async () => {
    usarHistorial.getState().elegirSubcuenta('s1');
    const exportando = usarHistorial.getState().exportar();
    ultima(exportaciones).p.resolver({
      cancelled: true,
      ok: false,
      path: null,
      rows: 3,
      message: ''
    });
    await exportando;

    expect(usarHistorial.getState().ultimaExportacion).toBeNull();
    expect(usarHistorial.getState().errorExportacion).toBeNull();
  });

  it('con un periodo inválido no se exporta', async () => {
    usarHistorial.getState().elegirSubcuenta('s1');
    usarHistorial.getState().fijarPeriodo({ from: '2026-08-07', to: '2026-08-01' });
    await usarHistorial.getState().exportar();

    expect(exportaciones).toHaveLength(0);
  });

  it('un segundo clic mientras se exporta no abre otro diálogo', () => {
    usarHistorial.getState().elegirSubcuenta('s1');
    void usarHistorial.getState().exportar();
    void usarHistorial.getState().exportar();

    expect(exportaciones).toHaveLength(1);
  });
});
