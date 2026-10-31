/**
 * Implementación de demostración de `PanelService`.
 *
 * Todo lo que devuelve es sintético, generado de forma determinista (mismo
 * resultado en cada arranque, útil para revisar y aprobar la pantalla) y con
 * latencia simulada para que los estados de carga se vean tal como se verán
 * con el backend real. Incluye a propósito los casos difíciles: fallos
 * parciales de lote, cuentas sin margen adicional, cuentas sin Take Profit,
 * credenciales rechazadas.
 *
 * Nada de aquí importa nada del proceso principal ni de Bitget: es el único
 * archivo del proyecto que puede inventar datos con esta libertad, porque
 * declara serlo en su propio nombre.
 *
 * Por esa misma razón no existe en staging. El constructor lo comprueba: es la
 * red de seguridad por si algún día alguien llega hasta aquí por un camino que
 * la eliminación de código muerto no pudo podar. Ver `src/shared/entorno.ts`.
 */
import type {
  Account,
  ActionState,
  ApiKeyInput,
  ApiKeyRow,
  ApiKeyStatus,
  Asset,
  Balance,
  BalanceSheet,
  BatchFailure,
  BatchPlan,
  BatchResult,
  BatchTarget,
  ClosedTrade,
  AlertsActionResult,
  AlertsCheck,
  AlertsStatus,
  ExportResult,
  TelegramLookup,
  HistoryFilter,
  HistoryPeriod,
  HistorySyncProgress,
  HistorySyncResult,
  LiveBalance,
  SubAccount,
  TradeHistory,
  CloseRequest,
  DeleteOutcome,
  LeverageRequest,
  MarginCap,
  MarginRequest,
  OpenRequest,
  ParentAccount,
  ParentAccountInput,
  ParentValidationResult,
  PlanDiscard,
  PlanEntry,
  PlanKind,
  Position,
  PositionSnapshot,
  Side,
  SubAccountBalance,
  SpreadMode,
  SpreadMove,
  SpreadMoveResult,
  SpreadPlan,
  SpreadResult,
  SpreadSkip,
  TransferPlan,
  TransferRecord,
  TransferResult,
  ImportResult,
  BackupInfo,
  BackupResult,
  RestoreResult,
  SystemInfo,
  TpRequest,
  UnlockResult,
  ValidationResult
} from '@shared/domain/panel-view';
import type { Decimal } from '@shared/types';
import type { PanelService, Unsubscribe } from '@shared/ports/panel-service';
import { prohibidoEnStaging } from '@shared/entorno';
import { TOPE_MARGEN_VIGENCIA_MS } from '@shared/constants';
import { esperaTrasFallos, textoEspera } from '@shared/espera-maestra';
import { CASILLAS_POR_CUENTA } from '@/lib/tokens';
import { completitud, filtrarPorCierre, rangoDePeriodo, resumir } from '@shared/resultado-periodo';
import {
  construirCsv,
  cumpleFiltro,
  identificadorCuenta,
  nombreArchivoCsv
} from '@shared/historial-csv';

/**
 * El catálogo del mercado, para el buscador. Topes verificados el 18/08/2026.
 *
 * En el panel real son los 754 contratos que devuelve Bitget; aquí bastan unos
 * cuantos para que el buscador tenga algo que filtrar y para que se vea el caso
 * que importa: elegir un activo que **no** está en las ocho casillas.
 */
const CATALOGO: Asset[] = [
  {
    id: 'BTC',
    symbol: 'BTCUSDT',
    label: 'BTC/USDT',
    priceDecimals: 1,
    maxLeverage: 150,
    minLeverage: 1,
    tradable: true
  },
  {
    id: 'ETH',
    symbol: 'ETHUSDT',
    label: 'ETH/USDT',
    priceDecimals: 2,
    maxLeverage: 150,
    minLeverage: 1,
    tradable: true
  },
  {
    id: 'SOL',
    symbol: 'SOLUSDT',
    label: 'SOL/USDT',
    priceDecimals: 3,
    maxLeverage: 100,
    minLeverage: 1,
    tradable: true
  },
  {
    id: 'PEPE',
    symbol: 'PEPEUSDT',
    label: 'PEPE/USDT',
    priceDecimals: 8,
    maxLeverage: 75,
    minLeverage: 1,
    tradable: true
  },
  {
    id: 'PAXG',
    symbol: 'PAXGUSDT',
    label: 'PAXG/USDT',
    priceDecimals: 2,
    maxLeverage: 50,
    minLeverage: 1,
    tradable: true
  },
  {
    id: 'ADA',
    symbol: 'ADAUSDT',
    label: 'ADA/USDT',
    priceDecimals: 4,
    maxLeverage: 75,
    minLeverage: 1,
    tradable: true
  },
  {
    id: 'AVAX',
    symbol: 'AVAXUSDT',
    label: 'AVAX/USDT',
    priceDecimals: 3,
    maxLeverage: 75,
    minLeverage: 1,
    tradable: true
  },
  {
    id: 'BNB',
    symbol: 'BNBUSDT',
    label: 'BNB/USDT',
    priceDecimals: 2,
    maxLeverage: 100,
    minLeverage: 1,
    tradable: true
  },
  {
    id: 'DOGE',
    symbol: 'DOGEUSDT',
    label: 'DOGE/USDT',
    priceDecimals: 5,
    maxLeverage: 75,
    minLeverage: 1,
    tradable: true
  },
  {
    id: 'LINK',
    symbol: 'LINKUSDT',
    label: 'LINK/USDT',
    priceDecimals: 3,
    maxLeverage: 75,
    minLeverage: 1,
    tradable: true
  },
  {
    id: 'SUI',
    symbol: 'SUIUSDT',
    label: 'SUI/USDT',
    priceDecimals: 4,
    maxLeverage: 75,
    minLeverage: 1,
    tradable: true
  },
  {
    id: 'TRX',
    symbol: 'TRXUSDT',
    label: 'TRX/USDT',
    priceDecimals: 5,
    maxLeverage: 50,
    minLeverage: 1,
    tradable: true
  },
  {
    id: 'WIF',
    symbol: 'WIFUSDT',
    label: 'WIF/USDT',
    priceDecimals: 4,
    maxLeverage: 50,
    minLeverage: 1,
    tradable: false
  },
  {
    id: 'XRP',
    symbol: 'XRPUSDT',
    label: 'XRP/USDT',
    priceDecimals: 4,
    maxLeverage: 125,
    minLeverage: 1,
    tradable: true
  }
];

/**
 * Las ocho casillas de partida de la demostración.
 *
 * Cinco llenas y tres vacías a propósito: los dos estados que la pantalla tiene
 * que saber dibujar. En el panel real salen de `activos.json`.
 */
const RANURAS_INICIALES: (string | null)[] = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'PEPEUSDT',
  'PAXGUSDT',
  null,
  null,
  null
];

const PRECIO_BASE: Record<string, number> = {
  BTC: 102450,
  ETH: 3624.8,
  SOL: 168.42,
  PEPE: 0.00001238,
  PAXG: 3486.5,
  ADA: 0.8642,
  AVAX: 41.28,
  BNB: 712.4,
  DOGE: 0.3184,
  LINK: 22.71,
  SUI: 4.128,
  TRX: 0.2842,
  WIF: 1.842,
  XRP: 2.4128
};

const MOTIVOS_ERROR = [
  'Margen insuficiente en la subcuenta.',
  'Sin conexión con la cuenta.',
  'API key inválida o sin permisos de futuros.'
] as const;

/** Generador determinista: mismo resultado en cada arranque, sin dependencias. */
function pseudoAleatorio(semilla: number): () => number {
  let s = semilla >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const latencia = (base = 180, variacion = 220): Promise<void> =>
  dormir(base + Math.random() * variacion);

const dec = (n: number, decimales = 4): Decimal => n.toFixed(decimales);

/** El filtro del puerto (inglés) en la forma de la regla compartida (español). */
const aFiltro = (f: HistoryFilter | undefined) => ({
  simbolo: f?.symbol ?? null,
  lado: f?.side ?? null,
  resultado:
    f?.outcome === 'winners'
      ? ('ganadoras' as const)
      : f?.outcome === 'losers'
        ? ('perdedoras' as const)
        : ('todas' as const)
});

/** La subcuenta que trae el ejemplo del presupuesto (cuenta A, casilla 1). */
const SUBCUENTA_EJEMPLO = 'a1-s01';

/**
 * «Del 1 al 7 de agosto de 2026: 8 operaciones, 5 ganadoras, 3 perdedoras,
 * +61.60 USDT». Resultado neto de cada una, ya con comisiones.
 */
const EJEMPLO_PRESUPUESTO: readonly {
  dia: number;
  hora: number;
  activo: string;
  side: Side;
  entrada: number;
  salida: number;
  cantidad: number;
  neto: number;
  modo: 'isolated' | 'crossed';
}[] = [
  {
    dia: 1,
    hora: 10,
    activo: 'BTC',
    side: 'long',
    entrada: 114820.5,
    salida: 115412.1,
    cantidad: 0.043,
    neto: 25.1,
    modo: 'isolated'
  },
  {
    dia: 2,
    hora: 15,
    activo: 'ETH',
    side: 'short',
    entrada: 3712.4,
    salida: 3668.9,
    cantidad: 0.43,
    neto: 18.4,
    modo: 'isolated'
  },
  {
    dia: 3,
    hora: 9,
    activo: 'SOL',
    side: 'long',
    entrada: 171.82,
    salida: 169.95,
    cantidad: 6.4,
    neto: -12.3,
    modo: 'isolated'
  },
  {
    dia: 4,
    hora: 12,
    activo: 'BTC',
    side: 'short',
    entrada: 115930.0,
    salida: 115701.2,
    cantidad: 0.044,
    neto: 9.75,
    modo: 'crossed'
  },
  {
    dia: 5,
    hora: 18,
    activo: 'ETH',
    side: 'long',
    entrada: 3640.15,
    salida: 3712.8,
    cantidad: 0.42,
    neto: 30.0,
    modo: 'isolated'
  },
  {
    dia: 6,
    hora: 11,
    activo: 'LINK',
    side: 'short',
    entrada: 22.48,
    salida: 22.61,
    cantidad: 30.0,
    neto: -4.15,
    modo: 'isolated'
  },
  {
    dia: 6,
    hora: 20,
    activo: 'SOL',
    side: 'short',
    entrada: 168.3,
    salida: 170.4,
    cantidad: 7.1,
    neto: -15.2,
    modo: 'isolated'
  },
  {
    dia: 7,
    hora: 16,
    activo: 'DOGE',
    side: 'long',
    entrada: 0.31842,
    salida: 0.32161,
    cantidad: 3300,
    neto: 10.0,
    modo: 'crossed'
  }
];

function operacionDeEjemplo(e: (typeof EJEMPLO_PRESUPUESTO)[number], i: number): ClosedTrade {
  const cierre = new Date(2026, 7, e.dia, e.hora, 12, 30).getTime();
  /* Comisión de apertura y cierre, como en Bitget: 0,06 % del nocional en cada lado. */
  const comisiones = -0.0006 * (e.entrada + e.salida) * e.cantidad;
  return {
    id: `${SUBCUENTA_EJEMPLO}-ago${i}`,
    symbol: `${e.activo}USDT`,
    side: e.side,
    marginMode: e.modo,
    leverage: null,
    openedAt: cierre - (3 + i) * 3_600_000,
    closedAt: cierre,
    entryPrice: e.entrada.toFixed(e.entrada < 1 ? 5 : 2),
    exitPrice: e.salida.toFixed(e.salida < 1 ? 5 : 2),
    takeProfit:
      e.neto > 0
        ? {
            price: e.salida.toFixed(e.salida < 1 ? 5 : 2),
            placedAt: cierre - (3 + i) * 3_600_000 + 4_000,
            triggeredAt: cierre
          }
        : null,
    closedSize: String(e.cantidad),
    pnl: e.neto.toFixed(2),
    pnlPercent: null,
    pricePnl: (e.neto - comisiones).toFixed(4),
    fees: comisiones.toFixed(4),
    funding: '0'
  };
}
const claveObjetivo = (subAccountId: string, side: Side): string => `${subAccountId}:${side}`;

interface EstadoInterno {
  cuentaId: string;
  slot: number;
  subAccountId: string;
  tieneLong: boolean;
  tieneShort: boolean;
  errorLong: boolean;
  errorShort: boolean;
  mgFailLong: boolean;
  mgFailShort: boolean;
}

function accionesVacias(): ActionState {
  return {
    tp: false,
    mg: false,
    ap: false,
    oe: false,
    tpDisplay: '',
    mgDisplay: '',
    apDisplay: ''
  };
}

export class MockPanelService implements PanelService {
  private readonly cuentas: Account[];
  private readonly plantillas = new Map<string, EstadoInterno>();
  private readonly posiciones = new Map<string, Position>();
  /**
   * Operaciones cerradas de cada subcuenta, como si ya estuvieran en Bitget.
   *
   * Cubren 120 días: más de los 90 que Bitget entrega, para que la demostración
   * enseñe qué pasa al pedir un periodo anterior a lo sincronizado.
   */
  private readonly historial = new Map<string, ClosedTrade[]>();
  /** Lo «sincronizado» de cada subcuenta: lo que `queryHistory` puede enseñar. */
  private readonly sincronizado = new Map<
    string,
    { fromMs: number; toMs: number; ids: Set<string> }
  >();
  private readonly oyentesSincronizacion = new Set<(p: HistorySyncProgress) => void>();
  /** El bot de la demostración. No sale a Telegram: solo lo finge. */
  private alertas: { chatId: string; chatTitle: string | null; enabledAt: string } | null = null;
  private ultimaRevision: AlertsCheck | null = null;
  private readonly oyentesAlertas = new Set<(c: AlertsCheck) => void>();
  private readonly apiKeys = new Map<string, ApiKeyRow>();
  /** Cuentas principales dadas de alta, por UID. Vacío hasta que se registre una. */
  private readonly madres = new Map<string, ParentAccount>();
  /** Traspasos calculados y sin enviar. Un plan se envía una sola vez. */
  private readonly planesTraspaso = new Map<string, TransferPlan>();
  /** Repartos y recogidas calculados y sin enviar. */
  private readonly planesReparto = new Map<string, SpreadPlan>();
  /** Historial, lo más reciente primero. */
  private readonly traspasos: TransferRecord[] = [];
  private readonly precios: Record<string, number> = { ...PRECIO_BASE };
  /** Qué símbolo hay en cada una de las ocho casillas. El operador las edita. */
  private readonly ranuras: (string | null)[] = [...RANURAS_INICIALES];

  private panelNumero = 1;
  private pasoActual = 'bg1';
  private readonly maestra = 'demo1234';
  /**
   * Tope de margen inicial de la demostración. Arranca sin tope, como un panel
   * recién instalado, para que la demostración enseñe el diálogo que lo pide.
   */
  private tope: { valor: string; fijadoEnMs: number } | null = null;

  private readonly oyentesCuentas = new Set<(c: Account[]) => void>();
  private readonly oyentesPosiciones = new Set<(s: PositionSnapshot) => void>();
  private readonly oyentesPrecios = new Set<(p: Readonly<Record<string, Decimal>>) => void>();
  private temporizadorPrecios: ReturnType<typeof setInterval> | undefined;

  constructor() {
    prohibidoEnStaging('El servicio de demostración del panel');
    this.cuentas = this.generarCuentas();
    this.generarApiKeys();
  }

  /* ---------------- generación de datos ---------------- */

  private generarCuentas(): Account[] {
    /*
     * Se llaman «A» y «B» a secas desde el 28/08/2026, como en el panel real:
     * las cuentas principales son las quince del abecedario -de la A a la O- y
     * el formulario de alta las ofrece por ese nombre. Antes eran «Cuenta
     * principal - A», que ya no coincide con nada.
     */
    const nombres = [
      { id: 'a1', nombre: 'A', semilla: 11 },
      { id: 'a2', nombre: 'B', semilla: 29 },
      { id: 'a3', nombre: 'C', semilla: 47 }
    ];

    return nombres.map(({ id, nombre, semilla }) => {
      const azar = pseudoAleatorio(semilla);
      const subAccounts = Array.from({ length: CASILLAS_POR_CUENTA }, (_, i) => {
        const slot = i + 1;
        const subAccountId = `${id}-s${String(slot).padStart(2, '0')}`;
        const saldo = 900 + azar() * 21000;

        /* Casi todas las casillas operadas: es como se ve el panel en un día normal. */
        const tieneLong = azar() < 0.88;
        const tieneShort = azar() < 0.7;
        const errorLong = tieneLong && azar() < 0.08;
        const errorShort = tieneShort && azar() < 0.08;
        const mgFailLong = tieneLong && !errorLong && azar() < 0.1;
        const mgFailShort = tieneShort && !errorShort && azar() < 0.1;

        this.plantillas.set(subAccountId, {
          cuentaId: id,
          slot,
          subAccountId,
          tieneLong,
          tieneShort,
          errorLong,
          errorShort,
          mgFailLong,
          mgFailShort
        });

        if (tieneLong) this.crearPosicion(subAccountId, 'long', azar, errorLong, mgFailLong);
        if (tieneShort) this.crearPosicion(subAccountId, 'short', azar, errorShort, mgFailShort);
        this.historial.set(subAccountId, this.generarHistorial(subAccountId, semilla * 100 + slot));

        /* Una de cada doce sin conexión: la pantalla tiene que saber pintar ese caso. */
        const caida = azar() < 0.08;

        return {
          id: subAccountId,
          accountId: id,
          label: `Sub-${String(slot).padStart(2, '0')}`,
          slot,
          balance: dec(saldo, 2),
          status: caida ? ('error' as const) : ('ok' as const),
          statusReason: caida ? 'La credencial no responde.' : null
        };
      });

      return { id, name: nombre, subAccounts };
    });
  }

  private crearPosicion(
    subAccountId: string,
    side: Side,
    azar: () => number,
    conError: boolean,
    sinMargenAdicional: boolean
  ): void {
    /*
     * Anclada al precio real del activo -no a un «alrededor de 1» suelto-
     * porque desde que el P&L se deriva contra `this.precios`, una entrada
     * fuera de escala se traduce en una ganancia de varios millones sobre 150
     * USDT de margen. Antes no se notaba: nada comparaba esta cifra con nada.
     */
    const base = (PRECIO_BASE.BTC ?? 1) * (1 + (azar() - 0.5) / 25);
    const dir = side === 'long' ? 1 : -1;
    const entrada = base;
    const liquidacion = base * (1 - dir * 0.061);
    const conTp = azar() < 0.82;
    const takeProfit = conTp ? base * (1 + dir * (0.02 + azar() * 0.03)) : null;

    const acciones: ActionState = {
      tp: conTp,
      mg: !sinMargenAdicional && azar() < 0.5,
      ap: true,
      oe: true,
      tpDisplay: conTp ? '1.5%' : '',
      mgDisplay: sinMargenAdicional ? '' : '50',
      apDisplay: '10x'
    };

    this.posiciones.set(claveObjetivo(subAccountId, side), {
      subAccountId,
      side,
      assetId: 'BTC',
      entryPrice: dec(entrada, 6),
      liquidationPrice: dec(liquidacion, 6),
      takeProfitPrice: takeProfit === null ? null : dec(takeProfit, 6),
      initialMarginAccum: dec(100 + Math.floor(azar() * 3) * 50, 2),
      currentMargin: null,
      marginMode: 'isolated',
      /* `recalcularPnl` los sustituye antes de la primera publicación. */
      pnl: '0',
      roe: null,
      leverage: 10,
      actions: acciones,
      marginCritical: sinMargenAdicional,
      hasError: conError,
      errorReason: conError
        ? (MOTIVOS_ERROR[Math.floor(azar() * MOTIVOS_ERROR.length)] ?? null)
        : null,
      openedAt: new Date(Date.now() - Math.floor(azar() * 6) * 3_600_000).toISOString()
    });
  }

  /**
   * Operaciones cerradas de demostración, con su propio generador por subcuenta.
   *
   * No consume del generador de la cuenta: el historial no debe decidir qué
   * casillas salen caídas o con error en la matriz.
   */
  private generarHistorial(subAccountId: string, semilla: number): ClosedTrade[] {
    const azar = pseudoAleatorio(semilla);
    const activos = ['BTC', 'ETH', 'SOL', 'DOGE', 'LINK'] as const;
    const ahora = Date.now();
    /* De 60 a 200 en 120 días: varias páginas por sincronización, como una subcuenta activa. */
    const cantidad = 60 + Math.floor(azar() * 140);

    const aleatorias = Array.from({ length: cantidad }, (_, i): ClosedTrade => {
      const activo = activos[Math.floor(azar() * activos.length)] ?? 'BTC';
      const base = PRECIO_BASE[activo] ?? 1;
      const side: Side = azar() < 0.5 ? 'long' : 'short';
      const dir = side === 'long' ? 1 : -1;
      const entrada = base * (1 + (azar() - 0.5) / 10);
      const movimiento = (azar() - 0.45) * 0.03;
      const salida = entrada * (1 + dir * movimiento);
      const cantidadCierre = 250 / entrada;
      const pnlPrecio = dir * (salida - entrada) * cantidadCierre;
      const comisiones = -0.0006 * (entrada + salida) * cantidadCierre;
      const financiamiento = (azar() - 0.5) * 0.02;
      const cerradaEnMs = ahora - Math.floor(azar() * 120 * 86_400_000);
      const duracion = 60_000 + Math.floor(azar() * 2 * 86_400_000);
      const decimales = base < 1 ? 6 : 2;

      return {
        id: `${subAccountId}-op${i}`,
        symbol: `${activo}USDT`,
        side,
        marginMode: azar() < 0.8 ? 'isolated' : 'crossed',
        leverage: null,
        openedAt: cerradaEnMs - duracion,
        closedAt: cerradaEnMs,
        entryPrice: dec(entrada, decimales),
        exitPrice: dec(salida, decimales),
        /* Las ganadoras cerraron en su TP; las perdedoras, a mano y sin TP. */
        takeProfit:
          pnlPrecio > 0
            ? {
                price: dec(salida, decimales),
                placedAt: cerradaEnMs - duracion + 3_000,
                triggeredAt: cerradaEnMs
              }
            : null,
        closedSize: dec(cantidadCierre, 4),
        pnl: dec(pnlPrecio + comisiones + financiamiento, 8),
        pnlPercent: null,
        pricePnl: dec(pnlPrecio, 8),
        fees: dec(comisiones, 8),
        funding: dec(financiamiento, 8)
      };
    });

    if (subAccountId !== SUBCUENTA_EJEMPLO) return aleatorias;

    /*
     * La Sub-01 de la cuenta A trae, además, el ejemplo del presupuesto: del 1
     * al 7 de agosto de 2026, ocho operaciones, cinco ganadoras, tres perdedoras
     * y +61.60 USDT. Lo aleatorio de esa semana se aparta para que la suma sea
     * exactamente la del documento.
     */
    const inicio = new Date(2026, 7, 1).getTime();
    const fin = new Date(2026, 7, 8).getTime();
    return [
      ...aleatorias.filter((o) => o.closedAt < inicio || o.closedAt >= fin),
      ...EJEMPLO_PRESUPUESTO.map((e, i) => operacionDeEjemplo(e, i))
    ];
  }

  /** Planes calculados y aún sin enviar, igual que en el proceso principal. */
  private readonly planes = new Map<string, (solo?: BatchTarget[]) => Promise<BatchResult>>();

  /** UID de la cuenta principal en el modo demostracion. Formato real de Bitget. */
  private static readonly UID_PADRE_DEMO = '1513226215';

  private generarApiKeys(): void {
    const estados: ApiKeyStatus[] = [
      'ok',
      'ok',
      'error',
      'ok',
      'ok',
      'ok',
      'conectando',
      'sin-api'
    ];
    let n = 0;
    for (const cuenta of this.cuentas) {
      for (const sub of cuenta.subAccounts.slice(0, 4)) {
        const estado = estados[n % estados.length] ?? 'ok';
        n += 1;
        this.apiKeys.set(sub.id, {
          id: sub.id,
          subAccountLabel: sub.label,
          accountName: cuenta.name.replace('Cuenta principal - ', ''),
          maskedKey: estado === 'sin-api' ? '' : `bg_${sub.id.slice(-4)}••••••••f2a`,
          /* Sin credencial no hay UID: el panel lo obtiene al validar. */
          uid: estado === 'sin-api' ? '' : `54761437${String(n).padStart(2, '0')}`,
          parentUid: estado === 'sin-api' ? '' : MockPanelService.UID_PADRE_DEMO,
          status: estado,
          reason:
            estado === 'error' ? 'Bitget rechazó la firma: revise Secret Key y Passphrase.' : null,
          /*
           * Una de cada cuatro sale como UTA, y una como en transición, para que
           * los datos de demostración enseñen los tres casos: sin al menos una
           * fila de cada, el distintivo no se puede revisar sin cuentas reales.
           */
          accountMode: n % 4 === 3 ? 'uta' : 'classic',
          inTransition: n % 8 === 5
        });
      }
    }
  }

  /* ---------------- sistema ---------------- */

  async getSystemInfo(): Promise<SystemInfo> {
    await latencia(60, 60);
    /* El servicio de demostración no habla con ningún mercado; se anuncia como simulado. */
    return {
      appVersion: '0.1.0-demo',
      panelNumber: this.panelNumero,
      portable: true,
      market: 'simulado'
    };
  }

  async setPanelNumber(numeroPanel: number): Promise<void> {
    await latencia(40, 40);
    this.panelNumero = numeroPanel;
  }

  /* ---------------- activos ---------------- */

  async listAssetSlots(): Promise<(Asset | null)[]> {
    await latencia(60, 60);
    return this.ranurasResueltas();
  }

  async listAssetCatalog(): Promise<Asset[]> {
    await latencia(80, 80);
    return CATALOGO;
  }

  /**
   * Pone un activo en una casilla, con las mismas dos negativas que el backend.
   *
   * Se repiten aquí y no se dan por buenas porque la demostración existe para
   * revisar la pantalla: si el mock aceptara lo que el proceso principal
   * rechaza, el aviso de «ya está en la casilla 3» no se vería hasta operar
   * contra Bitget de verdad.
   */
  async setAssetSlot(index: number, symbol: string | null): Promise<(Asset | null)[]> {
    await latencia(90, 90);

    if (index < 0 || index >= this.ranuras.length) {
      throw new Error(`La casilla ${index + 1} no existe: el panel tiene ${this.ranuras.length}.`);
    }

    if (symbol !== null) {
      const activo = CATALOGO.find((a) => a.symbol === symbol);
      if (activo === undefined) {
        throw new Error(
          `Bitget no ofrece ${symbol} en este mercado. No se cambió ninguna casilla.`
        );
      }
      const ocupada = this.ranuras.findIndex((s, i) => s === symbol && i !== index);
      if (ocupada !== -1) {
        throw new Error(
          `${activo.label} ya está en la casilla ${ocupada + 1}. ` +
            'Vacíe esa casilla primero si quiere moverlo.'
        );
      }
    }

    this.ranuras[index] = symbol;
    this.publicarPrecios();
    return this.ranurasResueltas();
  }

  /** Los símbolos guardados, traducidos a activos. `null` es casilla vacía. */
  private ranurasResueltas(): (Asset | null)[] {
    return this.ranuras.map((s) =>
      s === null ? null : (CATALOGO.find((a) => a.symbol === s) ?? null)
    );
  }

  /** Los activos que hay ahora en las casillas, sin los huecos. */
  private activosEnRanuras(): Asset[] {
    return this.ranurasResueltas().filter((a): a is Asset => a !== null);
  }

  subscribeAssetPrices(cb: (precios: Readonly<Record<string, Decimal>>) => void): Unsubscribe {
    this.oyentesPrecios.add(cb);
    this.publicarPrecios();

    if (this.temporizadorPrecios === undefined) {
      this.temporizadorPrecios = setInterval(() => {
        for (const activo of this.activosEnRanuras()) {
          const base = PRECIO_BASE[activo.id] ?? 1;
          const deriva = (Math.random() - 0.5) * base * 0.0015;
          this.precios[activo.id] = (this.precios[activo.id] ?? base) + deriva;
        }
        this.publicarPrecios();
        /* El P&L y el ROE se mueven con el precio, igual que en Bitget. */
        this.publicarPosiciones();
      }, 2_000);
    }

    return () => {
      this.oyentesPrecios.delete(cb);
      if (this.oyentesPrecios.size === 0 && this.temporizadorPrecios !== undefined) {
        clearInterval(this.temporizadorPrecios);
        this.temporizadorPrecios = undefined;
      }
    };
  }

  private publicarPrecios(): void {
    const instantanea: Record<string, Decimal> = {};
    for (const activo of this.activosEnRanuras()) {
      instantanea[activo.id] = dec(
        this.precios[activo.id] ?? PRECIO_BASE[activo.id] ?? 0,
        activo.priceDecimals
      );
    }
    for (const cb of this.oyentesPrecios) cb(instantanea);
  }

  /* ---------------- lectura ---------------- */

  async getAccounts(): Promise<Account[]> {
    await latencia();
    return this.cuentas.map((c) => ({ ...c, subAccounts: c.subAccounts.map((s) => ({ ...s })) }));
  }

  /**
   * En la demostración las cuentas no cambian nunca.
   *
   * Se registra el oyente igual, para que la pantalla siga el mismo camino que
   * con el proceso principal real y no haya una rama distinta según el entorno.
   */
  subscribeAccounts(cb: (accounts: Account[]) => void): Unsubscribe {
    this.oyentesCuentas.add(cb);
    return () => {
      this.oyentesCuentas.delete(cb);
    };
  }

  async getBalance(subAccountId: string): Promise<Balance> {
    await latencia(100, 100);
    for (const cuenta of this.cuentas) {
      const sub = cuenta.subAccounts.find((s) => s.id === subAccountId);
      if (sub) return { subAccountId, total: sub.balance };
    }
    throw new Error(`Subcuenta desconocida: ${subAccountId}`);
  }

  /* ---- historial por periodo ---- */

  private exigirSubcuenta(subAccountId: string): SubAccount {
    for (const cuenta of this.cuentas) {
      const sub = cuenta.subAccounts.find((s) => s.id === subAccountId);
      if (sub) return sub;
    }
    throw new Error('La cuenta ya no está en el panel.');
  }

  /**
   * Como el real: trae lo que Bitget conserva —90 días— por páginas de 100, y
   * avisa del avance. La primera vez tarda más, como la primera de verdad.
   */
  async syncHistory(subAccountId: string): Promise<HistorySyncResult> {
    this.exigirSubcuenta(subAccountId);
    const ahora = Date.now();
    const desde = ahora - 90 * 86_400_000;
    const previo = this.sincronizado.get(subAccountId);
    const disponibles = (this.historial.get(subAccountId) ?? []).filter((o) => o.closedAt >= desde);

    const paginas = Math.max(1, Math.ceil(disponibles.length / 100));
    for (let n = 1; n <= paginas; n++) {
      await latencia(previo === undefined ? 350 : 120, 200);
      const recibidas = Math.min(n * 100, disponibles.length);
      for (const cb of this.oyentesSincronizacion)
        cb({ subAccountId, pages: n, received: recibidas });
    }

    const ids = previo?.ids ?? new Set<string>();
    const antes = ids.size;
    for (const o of disponibles) ids.add(o.id);
    const cobertura = { fromMs: previo?.fromMs ?? desde, toMs: ahora };
    this.sincronizado.set(subAccountId, { ...cobertura, ids });

    return {
      subAccountId,
      added: ids.size - antes,
      total: ids.size,
      coverage: cobertura,
      gap: false,
      syncedAt: ahora
    };
  }

  async queryHistory(
    subAccountId: string,
    period?: HistoryPeriod,
    filter?: HistoryFilter
  ): Promise<TradeHistory> {
    this.exigirSubcuenta(subAccountId);
    await latencia(20, 30);
    const zona = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const rango =
      period === undefined ? null : rangoDePeriodo({ desde: period.from, hasta: period.to }, zona);
    const sync = this.sincronizado.get(subAccountId);
    const guardadas = (this.historial.get(subAccountId) ?? []).filter(
      (o) => sync?.ids.has(o.id) ?? false
    );
    const porId = new Map(guardadas.map((o) => [o.id, o]));
    const delPeriodo = filtrarPorCierre(
      guardadas.map((o) => ({ id: o.id, cerradaEnMs: o.closedAt })),
      rango
    ).flatMap((o) => porId.get(o.id) ?? []);
    /* La misma regla que el proceso principal: `shared/historial-csv.ts`. */
    const filtro = aFiltro(filter);
    const trades = delPeriodo.filter((o) =>
      cumpleFiltro(filtro, { symbol: o.symbol, lado: o.side, resultado: o.pnl })
    );
    const r = resumir(trades.map((o) => ({ resultado: o.pnl })));
    const c = completitud(
      rango,
      sync === undefined ? null : { desdeMs: sync.fromMs, hastaMs: sync.toMs },
      Date.now()
    );

    return {
      subAccountId,
      symbols: [...new Set(delPeriodo.map((o) => o.symbol))].sort(),
      filtered:
        filter !== undefined &&
        (filter.symbol !== null || filter.side !== null || filter.outcome !== 'all'),
      period:
        period === undefined || rango === null
          ? null
          : { ...period, startMs: rango.inicioMs, endMs: rango.finMs, timeZone: zona },
      trades,
      summary: {
        total: r.total,
        winners: r.ganadoras,
        losers: r.perdedoras,
        breakeven: r.enCero,
        netPnl: r.resultadoNeto
      },
      completeness: {
        complete: c.completo,
        missingBefore: c.faltaAntes,
        missingAfter: c.faltaDespues
      },
      coverage: sync === undefined ? null : { fromMs: sync.fromMs, toMs: sync.toMs },
      syncedAt: sync?.toMs ?? null
    };
  }

  /**
   * En la demostración no hay proceso principal que abra el diálogo: el CSV se
   * arma con el mismo código y se descarga, y Electron pregunta dónde guardarlo.
   */
  async exportHistory(
    subAccountId: string,
    period?: HistoryPeriod,
    filter?: HistoryFilter
  ): Promise<ExportResult> {
    const sub = this.exigirSubcuenta(subAccountId);
    const h = await this.queryHistory(subAccountId, period, filter);
    const cuenta = this.cuentas.find((c) => c.id === sub.accountId)?.name ?? '';
    const csv = construirCsv(
      h.trades.map((o) => ({
        positionId: o.id,
        symbol: o.symbol,
        lado: o.side,
        modoMargen: o.marginMode,
        apalancamiento: o.leverage,
        abiertaEnMs: o.openedAt,
        cerradaEnMs: o.closedAt,
        precioEntrada: o.entryPrice,
        precioSalida: o.exitPrice,
        takeProfit:
          o.takeProfit === null
            ? null
            : {
                precio: o.takeProfit.price,
                colocadoEnMs: o.takeProfit.placedAt,
                disparadoEnMs: o.takeProfit.triggeredAt
              },
        cantidadCierre: o.closedSize,
        resultado: o.pnl,
        porcentaje: o.pnlPercent,
        pnlPrecio: o.pricePnl,
        comisiones: o.fees,
        financiamiento: o.funding
      })),
      {
        identificador: identificadorCuenta(this.panelNumero, cuenta, sub.slot),
        cuenta,
        subcuenta: sub.label,
        zona: Intl.DateTimeFormat().resolvedOptions().timeZone
      }
    );

    const nombre = nombreArchivoCsv(
      identificadorCuenta(this.panelNumero, cuenta, sub.slot),
      period?.from ?? null,
      period?.to ?? null
    );
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const enlace = document.createElement('a');
    enlace.href = url;
    enlace.download = nombre;
    enlace.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);

    const n = h.trades.length;
    return {
      cancelled: false,
      ok: true,
      path: nombre,
      rows: n,
      message: `${n} ${n === 1 ? 'operación exportada' : 'operaciones exportadas'}.`
    };
  }

  subscribeHistorySync(cb: (progress: HistorySyncProgress) => void): Unsubscribe {
    this.oyentesSincronizacion.add(cb);
    return () => {
      this.oyentesSincronizacion.delete(cb);
    };
  }

  /* ---- alertas: la demostración finge el bot y una revisión con hallazgos ---- */

  private estadoAlertasDemo(): AlertsStatus {
    return {
      configured: this.alertas !== null,
      chatId: this.alertas?.chatId ?? null,
      chatTitle: this.alertas?.chatTitle ?? null,
      enabledAt: this.alertas?.enabledAt ?? null,
      checking: false,
      pending: 0,
      lastCheck: this.ultimaRevision,
      panelNumber: this.panelNumero
    };
  }

  async getAlertsStatus(): Promise<AlertsStatus> {
    await latencia(40, 40);
    return this.estadoAlertasDemo();
  }

  async findTelegramChats(token: string): Promise<TelegramLookup> {
    await latencia(400, 300);
    if (!/^\d{5,15}:[A-Za-z0-9_-]{30,60}$/.test(token.trim())) {
      return {
        ok: false,
        bot: null,
        chats: [],
        message:
          'Eso no tiene forma de token de bot. Es la línea larga que da @BotFather, del tipo 123456789:AAF…'
      };
    }
    return {
      ok: true,
      bot: { username: 'pcb_alertas_bot', name: 'PCB Alertas' },
      chats: [
        { id: '-1002233445566', title: 'Alertas PCB', type: 'supergroup' },
        { id: '551122334', title: 'Daniel Montero', type: 'private' }
      ],
      message: null
    };
  }

  async configureAlerts(
    input: { token: string; chatId: string; chatTitle: string | null },
    stepPassword: string
  ): Promise<AlertsActionResult> {
    await latencia(500, 300);
    const resultado = (
      ok: boolean,
      reason: string | null,
      message: string
    ): AlertsActionResult => ({
      ok,
      reason,
      message,
      status: this.estadoAlertasDemo()
    });
    if (stepPassword !== this.pasoActual) {
      return resultado(false, 'paso-incorrecto', 'La contraseña de paso no es correcta.');
    }
    if (input.chatId.trim() === '') {
      return resultado(false, 'sin-chat', 'Elija el grupo o chat donde llegarán los avisos.');
    }
    this.alertas = {
      chatId: input.chatId,
      chatTitle: input.chatTitle,
      enabledAt: new Date().toISOString()
    };
    return resultado(
      true,
      null,
      'Listo: el mensaje de prueba ya está en el chat (en la demostración no se envía de verdad).'
    );
  }

  async testAlerts(): Promise<AlertsActionResult> {
    await latencia(300, 200);
    return {
      ok: this.alertas !== null,
      reason: this.alertas === null ? 'sin-configurar' : null,
      message: this.alertas === null ? 'No hay un bot configurado.' : 'Mensaje de prueba enviado.',
      status: this.estadoAlertasDemo()
    };
  }

  async disableAlerts(stepPassword: string): Promise<AlertsActionResult> {
    await latencia(200, 100);
    if (stepPassword !== this.pasoActual) {
      return {
        ok: false,
        reason: 'paso-incorrecto',
        message: 'La contraseña de paso no es correcta.',
        status: this.estadoAlertasDemo()
      };
    }
    this.alertas = null;
    this.ultimaRevision = null;
    return {
      ok: true,
      reason: null,
      message: 'Alertas desactivadas.',
      status: this.estadoAlertasDemo()
    };
  }

  async checkAlertsNow(): Promise<AlertsCheck> {
    await latencia(1200, 600);
    const ahora = Date.now();
    const total = this.cuentas.reduce((n, c) => n + c.subAccounts.length, 0);
    const r: AlertsCheck = {
      startedAt: ahora - 1500,
      finishedAt: ahora,
      accounts: total,
      reviewed: total,
      firstSeen: 0,
      detected: this.alertas === null ? 0 : 3,
      sent: this.alertas === null ? 0 : 3,
      pending: 0,
      errors: [],
      delivery: this.alertas === null ? 'not-configured' : 'ok',
      deliveryMessage: this.alertas === null ? 'No hay un bot de Telegram configurado.' : null
    };
    this.ultimaRevision = r;
    for (const cb of this.oyentesAlertas) cb(r);
    return r;
  }

  subscribeAlertsChecks(cb: (check: AlertsCheck) => void): Unsubscribe {
    this.oyentesAlertas.add(cb);
    return () => {
      this.oyentesAlertas.delete(cb);
    };
  }

  async getLiveBalance(subAccountId: string): Promise<LiveBalance> {
    const sub = this.exigirSubcuenta(subAccountId);
    await latencia(150, 200);
    const disponible = Number.parseFloat(sub.balance);
    return {
      subAccountId,
      currency: 'USDT',
      equity: dec(disponible * 1.04, 2),
      available: sub.balance,
      locked: '0',
      readAt: Date.now()
    };
  }

  subscribePositions(cb: (snapshot: PositionSnapshot) => void): Unsubscribe {
    this.oyentesPosiciones.add(cb);
    this.recalcularPnl();
    cb({ positions: [...this.posiciones.values()] });
    return () => {
      this.oyentesPosiciones.delete(cb);
    };
  }

  private publicarPosiciones(): void {
    this.recalcularPnl();
    const instantanea: PositionSnapshot = { positions: [...this.posiciones.values()] };
    for (const cb of this.oyentesPosiciones) cb(instantanea);
  }

  /**
   * P&L y ROE de cada posición viva, contra el precio simulado de ahora.
   *
   * En Bitget el P&L no lo calcula el panel: lo informa el propio exchange
   * (`unrealizedPL`) en cada lectura. Aquí no hay exchange, así que se deriva
   * del precio simulado con la misma fórmula que usa `cerrar` al liquidar una
   * posición -precio actual menos entrada, sobre el tamaño que ese margen y
   * ese apalancamiento sostienen-, para que abrir y cerrar cuenten la misma
   * historia. El ROE sí es cálculo del panel también contra Bitget real: no
   * hay campo `roe` en la API, y aquí se deriva igual, contra el margen
   * inicial que es el único que existe en esta demostración.
   */
  private recalcularPnl(): void {
    for (const [clave, p] of this.posiciones) {
      const entrada = Number.parseFloat(p.entryPrice);
      const margen = Number.parseFloat(p.initialMarginAccum ?? '0');
      const actual = this.precios[p.assetId] ?? entrada;

      if (!Number.isFinite(entrada) || entrada <= 0 || !Number.isFinite(margen) || margen <= 0) {
        this.posiciones.set(clave, { ...p, pnl: '', roe: null });
        continue;
      }

      const dir = p.side === 'long' ? 1 : -1;
      const pnl = dir * (actual - entrada) * ((margen * p.leverage) / entrada);
      const roe = (pnl / margen) * 100;
      this.posiciones.set(clave, { ...p, pnl: dec(pnl, 2), roe: Number(roe.toFixed(2)) });
    }
  }

  /* ---------------- escritura ---------------- */

  private resolverFallo(subAccountId: string, side: Side): string | null {
    const plantilla = this.plantillas.get(subAccountId);
    if (!plantilla) return 'La subcuenta ya no está registrada en este panel.';
    const conError = side === 'long' ? plantilla.errorLong : plantilla.errorShort;
    if (!conError) return null;
    const posicion = this.posiciones.get(claveObjetivo(subAccountId, side));
    return posicion?.errorReason ?? MOTIVOS_ERROR[0];
  }

  private async abrir(req: OpenRequest): Promise<BatchResult> {
    await latencia(260, 340);
    const fails: BatchFailure[] = [];
    let ok = 0;
    let omitidas = 0;

    for (const objetivo of req.targets) {
      const plantilla = this.plantillas.get(objetivo.subAccountId);
      if (!plantilla) {
        omitidas += 1;
        continue;
      }
      const motivo = this.resolverFallo(objetivo.subAccountId, objetivo.side);
      if (motivo) {
        fails.push({ ...objetivo, reason: motivo, retryable: true });
        continue;
      }

      const precio =
        req.orderType === 'limit' && req.limitPrice
          ? Number.parseFloat(req.limitPrice)
          : (this.precios[req.assetId] ?? PRECIO_BASE[req.assetId] ?? 1);
      const dir = objetivo.side === 'long' ? 1 : -1;

      /*
       * El Take Profit sale con la misma orden, como en el panel real: si no
       * quedara puesto aquí, la demostración enseñaría una posición sin él
       * después de haber confirmado un diálogo que dice «sale con esta orden».
       */
      const pct = req.takeProfitPercent === null ? null : Number.parseFloat(req.takeProfitPercent);
      const tp =
        pct === null || !Number.isFinite(pct) || pct <= 0
          ? null
          : dec(precio * (1 + dir * (pct / 100 / 10)), 6);

      /*
       * El margen adicional también sale con la misma orden. En la demostración
       * solo se ve en el distintivo MGA de la casilla, que es lo que el operador
       * mira para saber si esa posición lo lleva: sin esto, confirmaría un
       * diálogo que lo anuncia y la casilla no lo enseñaría.
       *
       * No entra en `initialMarginAccum`: ese acumulador es del margen inicial,
       * y el Take Profit se calcula sobre él. Ver `panel-view.ts`.
       */
      const extra = req.additionalMargin;

      this.posiciones.set(claveObjetivo(objetivo.subAccountId, objetivo.side), {
        subAccountId: objetivo.subAccountId,
        side: objetivo.side,
        assetId: req.assetId,
        entryPrice: dec(precio, 6),
        liquidationPrice: dec(precio * (1 - dir * 0.061), 6),
        takeProfitPrice: tp,
        initialMarginAccum: req.initialMargin,
        currentMargin: null,
        marginMode: req.marginMode,
        /* `recalcularPnl` los sustituye antes de la primera publicación. */
        pnl: '0',
        roe: null,
        leverage: 10,
        actions: {
          ...accionesVacias(),
          oe: true,
          ap: true,
          apDisplay: '10x',
          ...(tp === null ? {} : { tp: true, tpDisplay: `${req.takeProfitPercent ?? ''}%` }),
          ...(extra === null ? {} : { mg: true, mgDisplay: extra })
        },
        marginCritical: false,
        hasError: false,
        errorReason: null,
        openedAt: new Date().toISOString()
      });
      ok += 1;
    }

    this.publicarPosiciones();
    return { label: 'Abrir posiciones', ok, skipped: omitidas, failures: fails, undetermined: [] };
  }

  private async cerrar(req: CloseRequest): Promise<BatchResult> {
    await latencia(220, 280);
    const fails: BatchFailure[] = [];
    let ok = 0;
    let omitidas = 0;

    for (const objetivo of req.targets) {
      const clave = claveObjetivo(objetivo.subAccountId, objetivo.side);
      const posicion = this.posiciones.get(clave);
      if (!posicion) {
        omitidas += 1;
        continue;
      }
      const motivo = this.resolverFallo(objetivo.subAccountId, objetivo.side);
      if (motivo) {
        fails.push({ ...objetivo, reason: motivo, retryable: true });
        continue;
      }

      const salida = this.precios[posicion.assetId] ?? Number.parseFloat(posicion.entryPrice);
      const entrada = Number.parseFloat(posicion.entryPrice);
      const dir = objetivo.side === 'long' ? 1 : -1;
      /*
       * En la demostración el margen inicial nunca falta: todas las posiciones
       * las abre este mismo servicio. El respaldo está porque el tipo admite
       * `null` —una posición ya abierta al arrancar el panel real no lo tiene— y
       * un P&L calculado sobre un margen desconocido sería un número inventado.
       */
      const margenInicial = posicion.initialMarginAccum ?? '0';
      const pnl = dir * (salida - entrada) * (Number.parseFloat(margenInicial) / entrada) * 10;

      /* Lo cerrado pasa al historial «de Bitget»; aparece al sincronizar. */
      const lista = this.historial.get(objetivo.subAccountId) ?? [];
      const ahora = Date.now();
      lista.push({
        id: `${objetivo.subAccountId}-c${ahora}${objetivo.side}`,
        symbol: `${posicion.assetId}USDT`,
        side: objetivo.side,
        marginMode: posicion.marginMode,
        leverage: null,
        openedAt: posicion.openedAt === null ? ahora : Date.parse(posicion.openedAt),
        closedAt: ahora,
        entryPrice: posicion.entryPrice,
        exitPrice: dec(salida, 6),
        takeProfit: null,
        closedSize: dec((Number.parseFloat(margenInicial) * 10) / entrada, 4),
        pnl: dec(pnl, 8),
        pnlPercent: null,
        pricePnl: dec(pnl, 8),
        fees: '0',
        funding: '0'
      });
      this.historial.set(objetivo.subAccountId, lista);

      this.posiciones.delete(clave);
      ok += 1;
    }

    this.publicarPosiciones();
    return { label: 'Cerrar posiciones', ok, skipped: omitidas, failures: fails, undetermined: [] };
  }

  private async aplicarSobrePosicion(
    etiqueta: string,
    targets: { subAccountId: string; side: Side }[],
    mutar: (p: Position) => Position
  ): Promise<BatchResult> {
    await latencia(200, 260);
    const fails: BatchFailure[] = [];
    let ok = 0;
    let omitidas = 0;

    for (const objetivo of targets) {
      const clave = claveObjetivo(objetivo.subAccountId, objetivo.side);
      const posicion = this.posiciones.get(clave);
      if (!posicion) {
        omitidas += 1;
        continue;
      }
      const motivo = this.resolverFallo(objetivo.subAccountId, objetivo.side);
      if (motivo) {
        fails.push({ ...objetivo, reason: motivo, retryable: true });
        continue;
      }
      this.posiciones.set(clave, mutar(posicion));
      ok += 1;
    }

    this.publicarPosiciones();
    return { label: etiqueta, ok, skipped: omitidas, failures: fails, undetermined: [] };
  }

  /** Sustituye el Take Profit de la posición, como hace el proceso principal. */
  private async ponerTp(req: TpRequest): Promise<BatchResult> {
    return this.aplicarSobrePosicion('Poner Take Profit', req.targets, (p) => {
      const dir = p.side === 'long' ? 1 : -1;
      const entrada = Number.parseFloat(p.entryPrice);
      const objetivo = entrada * (1 + (dir * Number.parseFloat(req.percent)) / 100 / p.leverage);
      return {
        ...p,
        takeProfitPrice: dec(objetivo, 6),
        actions: { ...p.actions, tp: true, tpDisplay: `${req.percent}%` }
      };
    });
  }

  /**
   * Mueve el margen adicional en los dos sentidos, sin bajar de cero.
   *
   * El tope no es cosmético: el distintivo MGA dice cuánto margen adicional
   * lleva la posición, y un número negativo ahí sería un dato imposible. Es la
   * misma regla que aplica el almacén del proceso principal.
   */
  private async moverMargen(req: MarginRequest): Promise<BatchResult> {
    const quita = req.direction === 'quitar';
    return this.aplicarSobrePosicion(
      quita ? 'Quitar margen' : 'Agregar margen',
      req.targets,
      (p) => {
        const antes = Number.parseFloat(p.actions.mgDisplay || '0');
        const paso = Number.parseFloat(req.amount);
        const ahora = Math.max(0, quita ? antes - paso : antes + paso);
        return {
          ...p,
          /* Retirar margen no quita el aviso crítico: lo justifica. */
          marginCritical: quita ? p.marginCritical : false,
          actions: {
            ...p.actions,
            mg: ahora > 0,
            mgDisplay: ahora > 0 ? dec(ahora, 2) : ''
          }
        };
      }
    );
  }

  private async fijarApalancamiento(req: LeverageRequest): Promise<BatchResult> {
    return this.aplicarSobrePosicion('Apalancamiento', req.targets, (p) => ({
      ...p,
      leverage: req.leverage,
      actions: { ...p.actions, ap: true, apDisplay: `${req.leverage}x` }
    }));
  }

  /* ---------------- planificación (modo demostración) ---------------- */

  /**
   * Arma un plan de mentira con la misma forma que el de verdad.
   *
   * El modo demostración no habla con Bitget, pero **sí respeta las dos
   * fases**: si aquí se enviara de una sola vez, la pantalla se probaría contra
   * un flujo que no es el que se usa en producción y el diálogo de
   * confirmación nunca se ejercitaría.
   *
   * El ejecutor queda guardado contra el `id` del plan, igual que el proceso
   * principal guarda el suyo: confirmar solo devuelve ese identificador.
   */
  private planificar(
    kind: PlanKind,
    title: string,
    summary: string,
    targets: BatchTarget[],
    detalle: (t: BatchTarget) => string | null,
    ejecutar: (solo?: BatchTarget[]) => Promise<BatchResult>
  ): BatchPlan {
    const id = `plan_${kind}_${Date.now()}`;
    const entries: PlanEntry[] = [];
    const discards: PlanDiscard[] = [];

    for (const t of targets) {
      const etiqueta = this.nombreDe(t.subAccountId);
      const linea = detalle(t);
      if (linea === null) {
        discards.push({ ...t, label: etiqueta, reason: 'No hay ninguna posición de ese lado.' });
        continue;
      }
      entries.push({ ...t, label: etiqueta, detail: linea });
    }

    this.planes.set(id, ejecutar);
    /* La demostración no modela saldos, así que nada puede quedar impedido. */
    return { kind, id, title, summary, reference: null, entries, discards, blocker: null };
  }

  private nombreDe(subAccountId: string): string {
    for (const cuenta of this.cuentas) {
      const sub = cuenta.subAccounts.find((s) => s.id === subAccountId);
      if (sub) return `${sub.label} · ${cuenta.name.replace('Cuenta principal - ', '')}`;
    }
    return subAccountId;
  }

  private posicionDe(t: BatchTarget): Position | undefined {
    return this.posiciones.get(claveObjetivo(t.subAccountId, t.side));
  }

  async planOpen(req: OpenRequest): Promise<BatchPlan> {
    await latencia(180, 220);
    /* La misma puerta que el proceso principal, para que la demostración se comporte igual. */
    const tope = this.estadoTope();
    if (tope.status !== 'active' || tope.value === null) {
      throw new Error(
        'Antes de abrir posiciones hay que fijar el margen inicial máximo de este panel.'
      );
    }
    if (Number.parseFloat(req.initialMargin) > Number.parseFloat(tope.value)) {
      throw new Error(
        `Escribió ${req.initialMargin} de margen inicial y el tope de este panel es ${tope.value}. ` +
          'No se envió ninguna orden. El tope no se puede cambiar hasta que pasen 24 horas desde que se fijó.'
      );
    }
    const precio = this.precios[req.assetId] ?? PRECIO_BASE[req.assetId] ?? 1;
    /* Las mismas unidades que el panel real: la cantidad en moneda base y los importes en USDT. */
    const margen = Number.parseFloat(req.initialMargin);
    const nocional = margen * req.leverage;
    return this.planificar(
      'open',
      'Abrir posiciones',
      `${req.initialMargin} USDT de margen por casilla · ${req.leverage}x · ` +
        `${req.marginMode === 'isolated' ? 'AISLADO' : 'CRUZADO'} · ` +
        `${req.orderType === 'limit' ? `límite ${req.limitPrice ?? '—'}` : 'a mercado'}` +
        (req.takeProfitPercent === null ? '' : ` · Take Profit ${req.takeProfitPercent}%`) +
        (req.additionalMargin === null
          ? ''
          : ` · margen adicional ${req.additionalMargin} USDT por casilla`),
      req.targets,
      () =>
        `${dec(nocional / precio, 6)} ${req.assetId} · margen real ${dec(margen, 2)} USDT · ` +
        `nocional ${dec(nocional, 2)} USDT`,
      (solo) => this.abrir({ ...req, targets: solo ?? req.targets })
    );
  }

  async planClose(req: CloseRequest): Promise<BatchPlan> {
    await latencia(180, 220);
    return this.planificar(
      'close',
      'Cerrar posiciones',
      'Cierre rápido: se cierra la posición entera, a mercado',
      req.targets,
      (t) => this.posicionDe(t)?.initialMarginAccum ?? null,
      (solo) => this.cerrar({ ...req, targets: solo ?? req.targets })
    );
  }

  async planTakeProfit(req: TpRequest): Promise<BatchPlan> {
    await latencia(180, 220);
    return this.planificar(
      'tp',
      'Poner Take Profit',
      `${req.percent}% de ganancia sobre el margen inicial de cada posición`,
      req.targets,
      (t) => {
        const posicion = this.posicionDe(t);
        if (!posicion) return null;
        const dir = t.side === 'long' ? 1 : -1;
        const entrada = Number.parseFloat(posicion.entryPrice);
        const objetivo =
          entrada * (1 + (dir * Number.parseFloat(req.percent)) / 100 / posicion.leverage);
        const destino = `${dec(objetivo, 6)} · entrada ${posicion.entryPrice} · ${posicion.leverage}x`;
        /* Como el real: si ya hay uno puesto, se enseña que este lo sustituye. */
        return posicion.takeProfitPrice === null
          ? `TP a ${destino}`
          : `TP ${posicion.takeProfitPrice} → ${destino} (sustituye el puesto)`;
      },
      (solo) => this.ponerTp({ ...req, targets: solo ?? req.targets })
    );
  }

  async planRemoveTakeProfit(req: CloseRequest): Promise<BatchPlan> {
    await latencia(180, 220);
    return this.planificar(
      'tp-remove',
      'Quitar Take Profit',
      'Esas posiciones se quedan sin Take Profit: habrá que cerrarlas a mano',
      req.targets,
      (t) => {
        const puesto = this.posicionDe(t)?.takeProfitPrice;
        return puesto == null ? null : `se quita el Take Profit puesto en ${puesto}`;
      },
      (solo) =>
        this.aplicarSobrePosicion('Quitar Take Profit', solo ?? req.targets, (posicion) => ({
          ...posicion,
          takeProfitPrice: null,
          actions: { ...posicion.actions, tp: false, tpDisplay: '' }
        }))
    );
  }

  async planMargin(req: MarginRequest): Promise<BatchPlan> {
    await latencia(180, 220);
    const quita = req.direction === 'quitar';
    return this.planificar(
      quita ? 'margin-remove' : 'margin-add',
      quita ? 'Quitar margen' : 'Agregar margen',
      `${req.amount} por casilla · ${quita ? 'vuelve al saldo' : 'sale del saldo'}`,
      req.targets,
      (t) => {
        const posicion = this.posicionDe(t);
        if (!posicion) return null;
        const antes = Number.parseFloat(posicion.actions.mgDisplay || '0');
        const paso = Number.parseFloat(req.amount);
        const ahora = Math.max(0, quita ? antes - paso : antes + paso);
        return `margen ${dec(antes, 2)} → ${dec(ahora, 2)}`;
      },
      (solo) => this.moverMargen({ ...req, targets: solo ?? req.targets })
    );
  }

  async planLeverage(req: LeverageRequest): Promise<BatchPlan> {
    await latencia(180, 220);
    return this.planificar(
      'leverage',
      'Ajustar apalancamiento',
      `${req.leverage}x en las casillas seleccionadas`,
      req.targets,
      (t) => `${this.posicionDe(t)?.leverage ?? '?'}x → ${req.leverage}x`,
      (solo) => this.fijarApalancamiento({ ...req, targets: solo ?? req.targets })
    );
  }

  async executePlan(plan: BatchPlan, only?: BatchTarget[]): Promise<BatchResult> {
    const ejecutar = this.planes.get(plan.id);
    if (!ejecutar) throw new Error('Ese plan ya no existe. Vuelva a revisar la operación.');
    const r = await ejecutar(only);
    if (only === undefined) this.planes.delete(plan.id);
    return { ...r, label: plan.title };
  }

  async hasStepPassword(): Promise<boolean> {
    await latencia(40, 40);
    return this.pasoActual !== '';
  }

  /* ---------------- tope de margen inicial ---------------- */

  private estadoTope(): MarginCap {
    if (this.tope === null) {
      return { status: 'missing', value: null, setAt: null, expiresAt: null, currency: 'USDT' };
    }
    const vence = this.tope.fijadoEnMs + TOPE_MARGEN_VIGENCIA_MS;
    return {
      status: Date.now() < vence ? 'active' : 'expired',
      value: this.tope.valor,
      setAt: new Date(this.tope.fijadoEnMs).toISOString(),
      expiresAt: new Date(vence).toISOString(),
      currency: 'USDT'
    };
  }

  async getMarginCap(): Promise<MarginCap> {
    await latencia(40, 40);
    return this.estadoTope();
  }

  async setMarginCap(value: string): Promise<MarginCap> {
    await latencia(120, 80);
    const actual = this.estadoTope();
    if (actual.status === 'active') {
      throw new Error(
        `El tope de ${actual.value ?? '—'} sigue vigente y no se puede cambiar hasta que pasen 24 horas.`
      );
    }
    if (!/^\d+(\.\d+)?$/.test(value.trim()) || Number.parseFloat(value) <= 0) {
      throw new Error('Escriba el tope como un número mayor que cero, por ejemplo 0.5 o 10.');
    }
    this.tope = { valor: value.trim(), fijadoEnMs: Date.now() };
    return this.estadoTope();
  }

  /* ---------------- credenciales y seguridad ---------------- */

  async listApiKeys(): Promise<ApiKeyRow[]> {
    await latencia(120, 120);
    return [...this.apiKeys.values()];
  }

  async registerApiKey(input: ApiKeyInput): Promise<ValidationResult> {
    await latencia(400, 500);
    if (input.apiKey.length < 8 || input.secretKey.length < 8 || input.passphrase.length < 1) {
      return {
        ok: false,
        verdict: 'invalida',
        reason: 'Bitget no aceptó la credencial.',
        warnings: [],
        latencyMs: 180,
        uid: null,
        parentUid: null
      };
    }

    /*
     * La casilla ocupada se rechaza igual que en el proceso principal. Se repite
     * aquí y no se da por buena porque la demostración existe para revisar la
     * pantalla: si el mock aceptara lo que el backend rechaza, este aviso no se
     * vería hasta estar operando contra Bitget de verdad.
     */
    const ocupante = this.cuentas
      .find((c) => c.name === input.accountName)
      ?.subAccounts.find((s) => s.slot === input.slot);
    if (ocupante !== undefined) {
      return {
        ok: false,
        verdict: null,
        reason:
          `La casilla ${input.slot} de la cuenta «${input.accountName}» ya la ocupa ` +
          `«${ocupante.label}». Elija otra casilla, o dé de baja esa subcuenta primero.`,
        warnings: [],
        latencyMs: 120,
        uid: null,
        parentUid: null
      };
    }

    const id = `demo-${Date.now()}`;
    /* Como en la API real: el UID lo dice el exchange, no el formulario. */
    const uid = `5476143${String(this.apiKeys.size).padStart(3, '0')}`;
    this.apiKeys.set(id, {
      id,
      subAccountLabel: input.subAccountLabel,
      accountName: input.accountName,
      maskedKey: `${input.apiKey.slice(0, 6)}••••${input.apiKey.slice(-4)}`,
      uid,
      parentUid: MockPanelService.UID_PADRE_DEMO,
      status: 'ok',
      reason: null,
      accountMode: 'classic',
      inTransition: false
    });

    return {
      ok: true,
      verdict: 'valida',
      reason: null,
      warnings: [],
      latencyMs: 180,
      uid,
      parentUid: MockPanelService.UID_PADRE_DEMO
    };
  }

  async testApiKey(id: string): Promise<ValidationResult> {
    await latencia(220, 260);
    const fila = this.apiKeys.get(id);
    if (!fila) {
      return {
        ok: false,
        verdict: 'invalida',
        reason: 'Credencial no encontrada.',
        warnings: [],
        latencyMs: 0,
        uid: null,
        parentUid: null
      };
    }

    if (fila.status === 'error') {
      return {
        ok: false,
        verdict: 'invalida',
        reason: fila.reason ?? 'Bitget rechazó la credencial.',
        warnings: [],
        latencyMs: 210,
        uid: fila.uid,
        parentUid: fila.parentUid
      };
    }
    return {
      ok: true,
      verdict: 'valida',
      reason: null,
      warnings: [],
      latencyMs: 140,
      uid: fila.uid,
      parentUid: fila.parentUid
    };
  }

  /*
   * La baja pide la contraseña de paso, igual que en el panel de verdad.
   *
   * Sin contraseña fijada no se deja pasar —nunca se responde «vale» porque no
   * haya nada que comprobar—, que es lo mismo que hace `Vault.comprobarPaso`.
   */
  async deleteApiKey(id: string, stepPassword: string): Promise<DeleteOutcome> {
    await latencia(100, 100);
    if (this.pasoActual === '' || stepPassword !== this.pasoActual) return 'paso-incorrecto';
    if (!this.apiKeys.has(id)) return 'no-estaba';
    this.apiKeys.delete(id);
    return 'borrada';
  }

  /* ---------------- cuentas madre y saldos ---------------- */

  async listParentAccounts(): Promise<ParentAccount[]> {
    await latencia(120, 100);
    return [...this.madres.values()];
  }

  async registerParentAccount(input: ParentAccountInput): Promise<ParentValidationResult> {
    await latencia(400, 400);

    if (input.apiKey.length < 8 || input.secretKey.length < 8 || input.passphrase.length < 1) {
      return { ok: false, reason: 'Bitget no aceptó la credencial.', warnings: [], parent: null };
    }

    /*
     * El caso que de verdad importa ensayar aquí: una clave válida de una cuenta
     * que no es madre de nadie. Es lo que ocurrió contra la API real el
     * 03/09/2026, y la pantalla tiene que saber pintarlo.
     */
    const sinSubcuentas = input.apiKey.includes('vacia');
    const uid = sinSubcuentas ? '7514542716' : '1513226215';

    const madre: ParentAccount = {
      id: `madre_${this.madres.size + 1}`,
      uid,
      name: input.name,
      maskedKey: `${input.apiKey.slice(0, 2)}••••${input.apiKey.slice(-4)}`,
      addedAt: new Date().toISOString(),
      subAccountsSeen: sinSubcuentas ? 0 : (this.cuentas[0]?.subAccounts.length ?? 0)
    };
    this.madres.set(uid, madre);

    return {
      ok: true,
      reason: null,
      warnings: sinSubcuentas
        ? [
            {
              code: 'sin-subcuentas',
              message:
                'Esta clave es válida, pero Bitget no le reporta ninguna subcuenta. Comprueba que ' +
                'sea la API Key de la cuenta principal de la que cuelgan tus subcuentas.'
            }
          ]
        : [],
      parent: madre
    };
  }

  async deleteParentAccount(uid: string, stepPassword: string): Promise<DeleteOutcome> {
    await latencia(100, 100);
    if (this.pasoActual === '' || stepPassword !== this.pasoActual) return 'paso-incorrecto';
    if (!this.madres.has(uid)) return 'no-estaba';
    this.madres.delete(uid);
    return 'borrada';
  }

  async getBalanceSheet(parentUid?: string): Promise<BalanceSheet> {
    await latencia(500, 400);

    const madre =
      parentUid === undefined ? [...this.madres.values()][0] : this.madres.get(parentUid);

    if (madre === undefined) {
      throw new Error(
        'No hay ninguna cuenta principal registrada. Da de alta su API Key para ver los saldos.'
      );
    }

    const subcuentas = this.cuentas[0]?.subAccounts ?? [];

    const rows: SubAccountBalance[] = subcuentas.map((s, i) => {
      /* Una de cada siete sin datos, y una de cada cinco con margen retenido. */
      const sinDatos = i % 7 === 3;
      const disponible = Number.parseFloat(s.balance);
      /*
       * El caso que la pantalla tiene que saber contar: hay saldo, pero parte
       * está comprometida en posiciones abiertas y no puede salir.
       */
      const transferible = i % 5 === 0 ? disponible * 0.6 : disponible;

      return {
        uid: `54761437${String(10 + i).padStart(2, '0')}`,
        subAccountId: s.id,
        label: s.label,
        available: sinDatos ? null : dec(disponible, 2),
        maxTransferable: sinDatos ? null : dec(transferible, 2),
        equity: sinDatos ? null : dec(disponible, 2),
        onlyInBitget: false,
        noData: sinDatos
      };
    });

    /* Y una que Bitget reporta pero el panel no tiene dada de alta. */
    rows.push({
      uid: '9999888877',
      subAccountId: null,
      label: '9999888877',
      available: dec(250, 2),
      maxTransferable: dec(250, 2),
      equity: dec(250, 2),
      onlyInBitget: true,
      noData: false
    });

    let totalAvailable = 0;
    let totalTransferable = 0;
    let withData = 0;
    for (const r of rows) {
      if (r.available !== null) {
        totalAvailable += Number.parseFloat(r.available);
        withData += 1;
      }
      if (r.maxTransferable !== null) totalTransferable += Number.parseFloat(r.maxTransferable);
    }

    return {
      parentUid: madre.uid,
      parentName: madre.name,
      /* La madre tiene su propio saldo, de otra petición: es de donde se reparte. */
      parentAvailable: dec(4820.5, 2),
      currency: 'USDT',
      fetchedAt: new Date().toISOString(),
      rows,
      totalAvailable: dec(totalAvailable, 2),
      totalTransferable: dec(totalTransferable, 2),
      withData
    };
  }

  /* ---------------- traspaso ---------------- */

  async planTransfer(input: {
    fromUid: string;
    toUid: string;
    amount: string;
    parentUid?: string;
  }): Promise<TransferPlan> {
    await latencia(350, 250);

    const hoja = await this.getBalanceSheet(input.parentUid);

    /*
     * La cuenta principal es una punta más, igual que en el panel real: no está
     * en `rows` —no se reporta a sí misma— y por eso no tiene saldo conocido ni
     * máximo transferible que comprobar. Ver `plan-traspaso.ts`.
     */
    const esMadre = (uid: string): boolean => uid !== '' && uid === hoja.parentUid;
    const origen = esMadre(input.fromUid) ? null : hoja.rows.find((r) => r.uid === input.fromUid);
    const destino = esMadre(input.toUid) ? null : hoja.rows.find((r) => r.uid === input.toUid);

    if (origen === undefined)
      throw new Error('La subcuenta de origen no está en esta cuenta principal.');
    if (destino === undefined)
      throw new Error('La subcuenta de destino no está en esta cuenta principal.');
    if (input.fromUid === input.toUid)
      throw new Error('El origen y el destino son la misma cuenta.');

    const importe = Number.parseFloat(input.amount);
    if (!Number.isFinite(importe) || importe <= 0)
      throw new Error('El importe tiene que ser mayor que cero.');

    if (origen !== null && (origen.maxTransferable === null || origen.available === null)) {
      throw new Error('No se conoce el saldo de la subcuenta de origen. Actualiza los saldos.');
    }

    /* El caso que justifica la pantalla: hay saldo, pero no puede salir todo. */
    const maximo = origen === null ? null : Number.parseFloat(origen.maxTransferable ?? '0');
    if (origen !== null && maximo !== null && importe > maximo) {
      throw new Error(
        `De ${origen.label} solo pueden salir ${dec(maximo, 2)} ${hoja.currency}: ` +
          'el resto está comprometido en posiciones abiertas.'
      );
    }

    /* De la madre también se conoce el saldo: llega en la hoja, de otra petición. */
    const saldoMadre =
      hoja.parentAvailable === null ? null : Number.parseFloat(hoja.parentAvailable);
    const saldoOrigen = origen === null ? saldoMadre : Number.parseFloat(origen.available ?? '0');
    const saldoDestino =
      destino === null
        ? saldoMadre
        : destino.available === null
          ? null
          : Number.parseFloat(destino.available);
    const nombreMadre = hoja.parentName === '' ? 'Cuenta principal' : hoja.parentName;

    const plan: TransferPlan = {
      id: `tr_${this.planesTraspaso.size + 1}_${Date.now().toString(36)}`,
      parentUid: hoja.parentUid,
      from: {
        uid: origen?.uid ?? hoja.parentUid,
        label: origen?.label ?? nombreMadre,
        before: saldoOrigen === null ? '' : dec(saldoOrigen, 2),
        after: saldoOrigen === null ? '' : dec(saldoOrigen - importe, 2)
      },
      to: {
        uid: destino?.uid ?? hoja.parentUid,
        label: destino?.label ?? nombreMadre,
        before: saldoDestino === null ? '' : dec(saldoDestino, 2),
        after: saldoDestino === null ? '' : dec(saldoDestino + importe, 2)
      },
      amount: dec(importe, 2),
      currency: hoja.currency,
      maxTransferable: maximo === null ? '' : dec(maximo, 2),
      createdAt: new Date().toISOString()
    };

    this.planesTraspaso.set(plan.id, plan);
    return plan;
  }

  async executeTransfer(planId: string, stepPassword: string): Promise<TransferResult> {
    await latencia(600, 400);

    const plan = this.planesTraspaso.get(planId);
    if (plan === undefined) throw new Error('Ese traspaso ya no está vigente. Vuelve a revisarlo.');

    if (this.pasoActual === '' || stepPassword !== this.pasoActual) {
      return { ok: false, failure: 'paso-incorrecto', message: null, transferId: null, plan };
    }

    /* Un plan se envía una sola vez, como en el panel real. */
    this.planesTraspaso.delete(planId);

    /* Un importe acabado en .77 se rechaza: así se puede ensayar el fallo. */
    if (plan.amount.endsWith('.77')) {
      const message = 'Bitget rechazó el traspaso: fondos insuficientes en la subcuenta de origen.';
      this.traspasos.unshift({
        id: `oid_${this.traspasos.length + 1}`,
        at: new Date().toISOString(),
        fromLabel: plan.from.label,
        toLabel: plan.to.label,
        amount: plan.amount,
        currency: plan.currency,
        outcome: 'fallo',
        transferId: null,
        message
      });
      return { ok: false, failure: 'rechazado', message, transferId: null, plan };
    }

    const transferId = `bg-${Math.floor(Math.random() * 900000 + 100000)}`;
    this.traspasos.unshift({
      id: `oid_${this.traspasos.length + 1}`,
      at: new Date().toISOString(),
      fromLabel: plan.from.label,
      toLabel: plan.to.label,
      amount: plan.amount,
      currency: plan.currency,
      outcome: 'exito',
      transferId,
      message: null
    });

    return { ok: true, failure: null, message: null, transferId, plan };
  }

  async listTransfers(limit = 100): Promise<TransferRecord[]> {
    await latencia(120, 100);
    return this.traspasos.slice(0, limit);
  }

  /* ---------------- reparto y recogida ---------------- */

  async planSpread(input: {
    toUids: string[];
    total: string;
    mode: SpreadMode;
    parentUid?: string;
  }): Promise<SpreadPlan> {
    await latencia(400, 300);

    const hoja = await this.getBalanceSheet(input.parentUid);
    const total = Number.parseFloat(input.total);
    if (!Number.isFinite(total) || total <= 0)
      throw new Error('El importe tiene que ser mayor que cero.');

    const elegidas = hoja.rows.filter(
      (r) => input.toUids.includes(r.uid) && !r.noData && r.available !== null
    );
    if (elegidas.length === 0)
      throw new Error('Ninguna de las subcuentas elegidas tiene saldo conocido.');

    const skipped: SpreadSkip[] = hoja.rows
      .filter((r) => input.toUids.includes(r.uid) && (r.noData || r.available === null))
      .map((r) => ({
        uid: r.uid,
        label: r.label,
        reason: 'sin-datos',
        message: 'La cuenta principal no informa de su saldo.'
      }));

    /*
     * Partes: iguales, o lo que le falta a cada una para llegar al mismo nivel.
     *
     * --------------------------------------------------------------------
     * El nivel NO es «(suma + total) / n»
     * --------------------------------------------------------------------
     * Esa fórmula reparte de más, y bastante: las subcuentas que ya están por
     * encima del nivel no devuelven su exceso, así que lo que se entrega a las
     * de abajo supera el total pedido. Aquí se vio repartiendo 48.724 cuando se
     * habían pedido 5.000, y una demostración que miente sobre cuánto se mueve
     * es peor que no tenerla.
     *
     * Lo correcto es llenar los vasos más bajos hasta un nivel que consuma
     * exactamente el total: se ordenan de menor a mayor y se prueba a llenar los
     * `k` primeros, aceptando el nivel que no rebase al siguiente. Es el mismo
     * cálculo que hace de verdad `main/domain/plan-reparto.ts`, que es quien
     * manda; esto es su equivalente en la demostración.
     */
    let partes: number[];
    if (input.mode === 'iguales') {
      partes = elegidas.map(() => total / elegidas.length);
    } else {
      const orden = elegidas
        .map((r, i) => ({ i, saldo: Number.parseFloat(r.available ?? '0') }))
        .sort((a, b) => a.saldo - b.saldo);

      let nivel: number | null = null;
      let cuantos = orden.length;
      let acumulado = 0;

      for (let k = 1; k <= orden.length; k += 1) {
        acumulado += orden[k - 1]?.saldo ?? 0;
        const candidato = (acumulado + total) / k;
        const siguiente = orden[k]?.saldo;
        if (siguiente === undefined || candidato <= siguiente) {
          nivel = candidato;
          cuantos = k;
          break;
        }
      }

      partes = elegidas.map(() => 0);
      if (nivel !== null) {
        for (let k = 0; k < cuantos; k += 1) {
          const e = orden[k];
          if (e !== undefined) partes[e.i] = Math.max(0, nivel - e.saldo);
        }
      }
    }

    const moves: SpreadMove[] = [];
    for (const [i, r] of elegidas.entries()) {
      const parte = partes[i] ?? 0;
      const saldo = Number.parseFloat(r.available ?? '0');
      if (parte <= 0) {
        skipped.push({
          uid: r.uid,
          label: r.label,
          reason: 'ya-por-encima',
          message: 'Ya está por encima del nivel de las demás: no recibe nada.'
        });
        continue;
      }
      moves.push({
        fromUid: hoja.parentUid,
        fromLabel: hoja.parentName || 'Cuenta principal',
        toUid: r.uid,
        toLabel: r.label,
        amount: dec(parte, 2),
        before: dec(saldo, 2),
        after: dec(saldo + parte, 2)
      });
    }

    if (moves.length === 0)
      throw new Error('Con ese importe no le toca nada a ninguna de las elegidas.');

    const plan: SpreadPlan = {
      id: `sp_${this.planesReparto.size + 1}_${Date.now().toString(36)}`,
      parentUid: hoja.parentUid,
      kind: 'reparto',
      mode: input.mode,
      currency: hoja.currency,
      total: dec(
        moves.reduce((a, m) => a + Number.parseFloat(m.amount), 0),
        2
      ),
      moves,
      skipped,
      createdAt: new Date().toISOString()
    };
    this.planesReparto.set(plan.id, plan);
    return plan;
  }

  async planCollect(input: { fromUids: string[]; parentUid?: string }): Promise<SpreadPlan> {
    await latencia(400, 300);

    const hoja = await this.getBalanceSheet(input.parentUid);
    const moves: SpreadMove[] = [];
    const skipped: SpreadSkip[] = [];

    for (const r of hoja.rows.filter((x) => input.fromUids.includes(x.uid))) {
      const transferible = r.maxTransferable === null ? null : Number.parseFloat(r.maxTransferable);
      if (r.noData || transferible === null) {
        skipped.push({
          uid: r.uid,
          label: r.label,
          reason: 'sin-datos',
          message: 'La cuenta principal no informa de su saldo.'
        });
        continue;
      }
      if (transferible <= 0) {
        skipped.push({
          uid: r.uid,
          label: r.label,
          reason: 'importe-cero',
          message: 'No tiene saldo transferible.'
        });
        continue;
      }
      const saldo = Number.parseFloat(r.available ?? r.maxTransferable ?? '0');
      moves.push({
        fromUid: r.uid,
        fromLabel: r.label,
        toUid: hoja.parentUid,
        toLabel: hoja.parentName || 'Cuenta principal',
        amount: dec(transferible, 2),
        before: dec(saldo, 2),
        after: dec(saldo - transferible, 2)
      });
    }

    if (moves.length === 0)
      throw new Error('Ninguna de las elegidas tiene saldo que se pueda mover.');

    const plan: SpreadPlan = {
      id: `sp_${this.planesReparto.size + 1}_${Date.now().toString(36)}`,
      parentUid: hoja.parentUid,
      kind: 'recogida',
      mode: null,
      currency: hoja.currency,
      total: dec(
        moves.reduce((a, m) => a + Number.parseFloat(m.amount), 0),
        2
      ),
      moves,
      skipped,
      createdAt: new Date().toISOString()
    };
    this.planesReparto.set(plan.id, plan);
    return plan;
  }

  async executeSpread(planId: string, stepPassword: string): Promise<SpreadResult> {
    await latencia(900, 600);

    const plan = this.planesReparto.get(planId);
    if (plan === undefined) throw new Error('Ese reparto ya no está vigente. Vuelve a revisarlo.');

    if (this.pasoActual === '' || stepPassword !== this.pasoActual) {
      return {
        ok: false,
        failure: 'paso-incorrecto',
        plan,
        results: [],
        sent: 0,
        failed: 0,
        unconfirmed: 0
      };
    }

    this.planesReparto.delete(planId);

    /*
     * La demostración enseña los tres desenlaces, no dos.
     *
     * Uno de cada cinco es rechazado y uno de cada siete queda **sin confirmar**
     * —enviado, sin respuesta de Bitget—. Ese tercer caso está aquí a propósito:
     * es el que el operador tiene que aprender a distinguir, porque un rechazo se
     * puede repetir y un «sin confirmar» hay que comprobarlo antes, o el dinero
     * se mueve dos veces.
     */
    let unconfirmed = 0;
    const results: SpreadMoveResult[] = plan.moves.map((m, i) => {
      const dudoso = i % 7 === 5;
      const ok = !dudoso && i % 5 !== 3;
      if (dudoso) unconfirmed += 1;

      const message = ok
        ? null
        : dudoso
          ? 'Se envió y Bitget no confirmó si entró. Comprueba el saldo antes de repetirlo.'
          : 'Bitget rechazó el traspaso: fondos insuficientes.';

      this.traspasos.unshift({
        id: `oid_${this.traspasos.length + 1}_${i}`,
        at: new Date().toISOString(),
        fromLabel: m.fromLabel,
        toLabel: m.toLabel,
        amount: m.amount,
        currency: plan.currency,
        outcome: ok ? 'exito' : dudoso ? 'pendiente' : 'fallo',
        transferId: ok ? `bg-${Math.floor(Math.random() * 900000 + 100000)}` : null,
        message
      });
      return {
        id: `mv_${i}`,
        fromLabel: m.fromLabel,
        toLabel: m.toLabel,
        amount: m.amount,
        ok,
        message
      };
    });

    const failed = results.filter((r) => !r.ok).length - unconfirmed;
    return {
      ok: failed === 0 && unconfirmed === 0,
      failure: null,
      plan,
      results,
      sent: results.length - failed - unconfirmed,
      failed,
      unconfirmed
    };
  }

  /*
   * En la demostración el almacén siempre existe: hay cuentas inventadas desde
   * el primer segundo, así que nunca es un primer arranque y el botón de
   * importar no llega a ofrecerse. Se implementa igual porque el puerto lo
   * exige, y devolver lo que de verdad pasa aquí es más honesto que fingir.
   */
  async isFirstRun(): Promise<boolean> {
    return false;
  }

  async importCredentials(): Promise<ImportResult> {
    await latencia(200, 150);
    return {
      cancelled: false,
      ok: false,
      message: 'La demostración no lee carpetas del disco: no hay credenciales que importar.',
      accounts: null
    };
  }

  /*
   * El respaldo copia archivos de una carpeta del disco, y aquí no hay ninguna:
   * las cuentas de la demostración viven en memoria. Se dice tal cual en vez de
   * fingir un archivo que luego no estaría donde se prometió.
   */
  async backupAccounts(): Promise<BackupResult> {
    await latencia(250, 150);
    return {
      ok: false,
      reason: 'demostracion',
      message: 'La demostración no escribe en el disco: no hay credenciales reales que respaldar.',
      fileName: null,
      folder: null,
      accounts: null
    };
  }

  async findBackup(): Promise<BackupInfo | null> {
    return null;
  }

  async openBackupFolder(): Promise<void> {
    return undefined;
  }

  async restoreBackup(): Promise<RestoreResult> {
    await latencia(250, 150);
    return {
      cancelled: false,
      ok: false,
      reason: 'demostracion',
      message: 'La demostración no lee archivos del disco: no hay ningún respaldo que restaurar.',
      accounts: null,
      replaced: null
    };
  }

  async restoreBackupFromFile(): Promise<RestoreResult> {
    return this.restoreBackup();
  }

  /*
   * El freno de la maestra, tambien aqui.
   *
   * En el panel de demostracion no hay `vault.enc` ni disco que tocar, pero la
   * espera se simula con la **misma** regla -`esperaTrasFallos`, compartida- en
   * lugar de con números propios. Es lo que permite ver y probar la pantalla de
   * espera sin backend; una demo que no frena nunca convertiria esta pantalla en
   * la única que nadie mira antes de entregar.
   *
   * Vive en memoria y se va al recargar, a diferencia del freno de verdad.
   */
  private fallosMaestra = 0;
  private esperaMaestraHasta = 0;

  private esperaMaestra(): number {
    return Math.max(0, this.esperaMaestraHasta - Date.now());
  }

  private anotarIntentoMaestra(ok: boolean): void {
    if (ok) {
      this.fallosMaestra = 0;
      this.esperaMaestraHasta = 0;
      return;
    }
    this.fallosMaestra += 1;
    const duracion = esperaTrasFallos(this.fallosMaestra);
    this.esperaMaestraHasta = duracion === 0 ? 0 : Date.now() + duracion;
  }

  async unlockVault(masterPassword: string): Promise<UnlockResult> {
    await latencia(300, 200);

    const espera = this.esperaMaestra();
    if (espera > 0) {
      return {
        ok: false,
        reason:
          'Demasiados intentos seguidos con la contraseña maestra. Vuelva a intentarlo dentro ' +
          `de ${textoEspera(espera)}.`
      };
    }

    const ok = masterPassword === this.maestra || masterPassword.length >= 4;
    this.anotarIntentoMaestra(ok);
    return ok ? { ok: true, reason: null } : { ok: false, reason: 'Contraseña incorrecta.' };
  }

  async verifyMasterPassword(masterPassword: string): Promise<boolean> {
    await latencia(200, 150);
    if (this.esperaMaestra() > 0) return false;

    const ok = masterPassword === this.maestra || masterPassword.length >= 4;
    this.anotarIntentoMaestra(ok);
    return ok;
  }

  async masterCooldownMs(): Promise<number> {
    return this.esperaMaestra();
  }

  async verifyStepPassword(pwd: string): Promise<boolean> {
    await latencia(60, 40);
    return pwd === this.pasoActual;
  }

  async setStepPassword(pwd: string): Promise<void> {
    await latencia(60, 40);
    this.pasoActual = pwd;
  }
}
