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
  BatchFailure,
  BatchPlan,
  BatchResult,
  BatchTarget,
  ClosedPosition,
  CloseRequest,
  LeverageRequest,
  MarginCap,
  MarginRequest,
  OpenRequest,
  PlanDiscard,
  PlanEntry,
  PlanKind,
  Position,
  PositionSnapshot,
  Side,
  SystemInfo,
  TpRequest,
  UnlockResult,
  ValidationResult
} from '@shared/domain/panel-view';
import type { Decimal } from '@shared/types';
import type { PanelService, Unsubscribe } from '@shared/ports/panel-service';
import { prohibidoEnStaging } from '@shared/entorno';
import { TOPE_MARGEN_VIGENCIA_MS } from '@shared/constants';
import { CASILLAS_POR_CUENTA, HISTORIAL_MAXIMO } from '@/lib/tokens';

/* Topes verificados contra el catálogo real de Bitget el 18/08/2026. */
const ASSETS: Asset[] = [
  { id: 'BTC', symbol: 'BTCUSDT', label: 'BTC/USDT', priceDecimals: 1, maxLeverage: 150, minLeverage: 1, tradable: true },
  { id: 'ETH', symbol: 'ETHUSDT', label: 'ETH/USDT', priceDecimals: 2, maxLeverage: 150, minLeverage: 1, tradable: true },
  { id: 'SOL', symbol: 'SOLUSDT', label: 'SOL/USDT', priceDecimals: 3, maxLeverage: 100, minLeverage: 1, tradable: true },
  { id: 'PEPE', symbol: 'PEPEUSDT', label: 'PEPE/USDT', priceDecimals: 8, maxLeverage: 75, minLeverage: 1, tradable: true },
  { id: 'PAXG', symbol: 'PAXGUSDT', label: 'PAXG/USDT', priceDecimals: 2, maxLeverage: 50, minLeverage: 1, tradable: true }
];

const PRECIO_BASE: Record<string, number> = {
  BTC: 102450,
  ETH: 3624.8,
  SOL: 168.42,
  PEPE: 0.00001238,
  PAXG: 3486.5
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
  return { tp: false, mg: false, ap: false, oe: false, tpDisplay: '', mgDisplay: '', apDisplay: '' };
}

export class MockPanelService implements PanelService {
  private readonly cuentas: Account[];
  private readonly plantillas = new Map<string, EstadoInterno>();
  private readonly posiciones = new Map<string, Position>();
  private readonly historial = new Map<string, ClosedPosition[]>();
  private readonly apiKeys = new Map<string, ApiKeyRow>();
  private readonly precios: Record<string, number> = { ...PRECIO_BASE };

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
    const nombres = [
      { id: 'a1', nombre: 'Cuenta principal - A', semilla: 11 },
      { id: 'a2', nombre: 'Cuenta principal - B', semilla: 29 }
    ];

    return nombres.map(({ id, nombre, semilla }) => {
      const azar = pseudoAleatorio(semilla);
      const subAccounts = Array.from({ length: CASILLAS_POR_CUENTA }, (_, i) => {
        const slot = i + 1;
        const subAccountId = `${id}-s${String(slot).padStart(2, '0')}`;
        const saldo = 900 + azar() * 21000;

        const tieneLong = azar() < 0.72;
        const tieneShort = azar() < 0.42;
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
        this.historial.set(subAccountId, this.generarHistorial(subAccountId, azar));

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
    const base = 1 + (azar() - 0.5) / 25;
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
      leverage: 10,
      actions: acciones,
      marginCritical: sinMargenAdicional,
      hasError: conError,
      errorReason: conError ? (MOTIVOS_ERROR[Math.floor(azar() * MOTIVOS_ERROR.length)] ?? null) : null,
      openedAt: new Date(Date.now() - Math.floor(azar() * 6) * 3_600_000).toISOString()
    });
  }

  private generarHistorial(subAccountId: string, azar: () => number): ClosedPosition[] {
    const cantidad = Math.floor(azar() * 6);
    return Array.from({ length: cantidad }, (_, i) => {
      const side: Side = azar() < 0.5 ? 'long' : 'short';
      const dir = side === 'long' ? 1 : -1;
      const entrada = 1 + (azar() - 0.5) / 25;
      const gana = azar() < 0.58;
      const movimiento = 0.004 + azar() * 0.022;
      const salida = entrada * (1 + dir * (gana ? movimiento : -movimiento));
      const margen = azar() < 0.2 ? 150 : 100;
      const pnl = (gana ? 1 : -1) * movimiento * margen * 10;
      const cerradoPor: ClosedPosition['closedBy'] = gana
        ? 'take-profit'
        : azar() < 0.3
          ? 'liquidacion'
          : 'manual';

      return {
        id: `${subAccountId}-h${i}`,
        subAccountId,
        side,
        entryPrice: dec(entrada, 6),
        exitPrice: dec(salida, 6),
        initialMargin: dec(margen, 2),
        pnl: dec(pnl, 2),
        closedBy: cerradoPor,
        closedAt: new Date(Date.now() - (i + 1) * 5_400_000).toISOString()
      };
    });
  }

  /** Planes calculados y aún sin enviar, igual que en el proceso principal. */
  private readonly planes = new Map<string, (solo?: BatchTarget[]) => Promise<BatchResult>>();

  /** UID de la cuenta principal en el modo demostracion. Formato real de Bitget. */
  private static readonly UID_PADRE_DEMO = '1513226215';

  private generarApiKeys(): void {
    const estados: ApiKeyStatus[] = ['ok', 'ok', 'error', 'ok', 'ok', 'ok', 'conectando', 'sin-api'];
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
          reason: estado === 'error' ? 'Bitget rechazó la firma: revise Secret Key y Passphrase.' : null
        });
      }
    }
  }

  /* ---------------- sistema ---------------- */

  async getSystemInfo(): Promise<SystemInfo> {
    await latencia(60, 60);
    /* El servicio de demostración no habla con ningún mercado; se anuncia como simulado. */
    return { appVersion: '0.1.0-demo', panelNumber: this.panelNumero, portable: true, market: 'simulado' };
  }

  async setPanelNumber(numeroPanel: number): Promise<void> {
    await latencia(40, 40);
    this.panelNumero = numeroPanel;
  }

  /* ---------------- activos ---------------- */

  async listAssets(): Promise<Asset[]> {
    await latencia(60, 60);
    return ASSETS;
  }

  subscribeAssetPrices(cb: (precios: Readonly<Record<string, Decimal>>) => void): Unsubscribe {
    this.oyentesPrecios.add(cb);
    this.publicarPrecios();

    if (this.temporizadorPrecios === undefined) {
      this.temporizadorPrecios = setInterval(() => {
        for (const activo of ASSETS) {
          const base = PRECIO_BASE[activo.id] ?? 1;
          const deriva = (Math.random() - 0.5) * base * 0.0015;
          this.precios[activo.id] = (this.precios[activo.id] ?? base) + deriva;
        }
        this.publicarPrecios();
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
    for (const activo of ASSETS) {
      instantanea[activo.id] = dec(this.precios[activo.id] ?? PRECIO_BASE[activo.id] ?? 0, activo.priceDecimals);
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

  async getHistory(subAccountId: string, limit: number): Promise<ClosedPosition[]> {
    await latencia(120, 160);
    return (this.historial.get(subAccountId) ?? []).slice(0, Math.min(limit, HISTORIAL_MAXIMO));
  }

  subscribePositions(cb: (snapshot: PositionSnapshot) => void): Unsubscribe {
    this.oyentesPosiciones.add(cb);
    cb({ positions: [...this.posiciones.values()] });
    return () => {
      this.oyentesPosiciones.delete(cb);
    };
  }

  private publicarPosiciones(): void {
    const instantanea: PositionSnapshot = { positions: [...this.posiciones.values()] };
    for (const cb of this.oyentesPosiciones) cb(instantanea);
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
        fails.push({ ...objetivo, reason: motivo });
        continue;
      }

      const precio =
        req.orderType === 'limit' && req.limitPrice
          ? Number.parseFloat(req.limitPrice)
          : (this.precios[req.assetId] ?? PRECIO_BASE[req.assetId] ?? 1);
      const dir = objetivo.side === 'long' ? 1 : -1;

      this.posiciones.set(claveObjetivo(objetivo.subAccountId, objetivo.side), {
        subAccountId: objetivo.subAccountId,
        side: objetivo.side,
        assetId: req.assetId,
        entryPrice: dec(precio, 6),
        liquidationPrice: dec(precio * (1 - dir * 0.061), 6),
        takeProfitPrice: null,
        initialMarginAccum: req.initialMargin,
        leverage: 10,
        actions: { ...accionesVacias(), oe: true, ap: true, apDisplay: '10x' },
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
        fails.push({ ...objetivo, reason: motivo });
        continue;
      }

      const salida = this.precios[posicion.assetId] ?? Number.parseFloat(posicion.entryPrice);
      const entrada = Number.parseFloat(posicion.entryPrice);
      const dir = objetivo.side === 'long' ? 1 : -1;
      const pnl = dir * (salida - entrada) * (Number.parseFloat(posicion.initialMarginAccum) / entrada) * 10;

      const lista = this.historial.get(objetivo.subAccountId) ?? [];
      lista.unshift({
        id: `${objetivo.subAccountId}-h${Date.now()}`,
        subAccountId: objetivo.subAccountId,
        side: objetivo.side,
        entryPrice: posicion.entryPrice,
        exitPrice: dec(salida, 6),
        initialMargin: posicion.initialMarginAccum,
        pnl: dec(pnl, 2),
        closedBy: 'manual',
        closedAt: new Date().toISOString()
      });
      this.historial.set(objetivo.subAccountId, lista.slice(0, HISTORIAL_MAXIMO));

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
        fails.push({ ...objetivo, reason: motivo });
        continue;
      }
      this.posiciones.set(clave, mutar(posicion));
      ok += 1;
    }

    this.publicarPosiciones();
    return { label: etiqueta, ok, skipped: omitidas, failures: fails, undetermined: [] };
  }

  private async ponerTp(req: TpRequest): Promise<BatchResult> {
    return this.aplicarSobrePosicion('Take Profit', req.targets, (p) => {
      const dir = p.side === 'long' ? 1 : -1;
      const porcentaje = Number.parseFloat(req.percent) / 100;
      const entrada = Number.parseFloat(p.entryPrice);
      return {
        ...p,
        takeProfitPrice: dec(entrada * (1 + dir * porcentaje), 6),
        actions: { ...p.actions, tp: true, tpDisplay: `${req.percent}%` }
      };
    });
  }

  private async agregarMargen(req: MarginRequest): Promise<BatchResult> {
    return this.aplicarSobrePosicion('Margen adicional', req.targets, (p) => ({
      ...p,
      marginCritical: false,
      actions: { ...p.actions, mg: true, mgDisplay: req.amount }
    }));
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
    return { kind, id, title, summary, reference: null, entries, discards };
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
      throw new Error('Antes de abrir posiciones hay que fijar el margen inicial máximo de este panel.');
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
      `${req.initialMargin} USDT de margen por casilla · ${req.leverage}x · ${req.orderType === 'limit' ? `límite ${req.limitPrice ?? '—'}` : 'a mercado'}`,
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
        const objetivo = entrada * (1 + (dir * Number.parseFloat(req.percent)) / 100 / posicion.leverage);
        return `TP a ${dec(objetivo, 6)} · entrada ${posicion.entryPrice} · ${posicion.leverage}x`;
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
    return this.planificar(
      'margin',
      'Agregar margen',
      `${req.amount} por casilla`,
      req.targets,
      (t) => {
        const posicion = this.posicionDe(t);
        if (!posicion) return null;
        const resultante = Number.parseFloat(posicion.initialMarginAccum) + Number.parseFloat(req.amount);
        return `margen ${posicion.initialMarginAccum} → ${dec(resultante, 2)}`;
      },
      (solo) => this.agregarMargen({ ...req, targets: solo ?? req.targets })
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
      throw new Error(`El tope de ${actual.value ?? '—'} sigue vigente y no se puede cambiar hasta que pasen 24 horas.`);
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
      return { ok: false, verdict: 'invalida', reason: 'Bitget no aceptó la credencial.', warnings: [], latencyMs: 180, uid: null, parentUid: null };
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
      reason: null
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
      return { ok: false, verdict: 'invalida', reason: 'Credencial no encontrada.', warnings: [], latencyMs: 0, uid: null, parentUid: null };
    }

    if (fila.status === 'error') {
      return { ok: false, verdict: 'invalida', reason: fila.reason ?? 'Bitget rechazó la credencial.', warnings: [], latencyMs: 210, uid: fila.uid, parentUid: fila.parentUid };
    }
    return { ok: true, verdict: 'valida', reason: null, warnings: [], latencyMs: 140, uid: fila.uid, parentUid: fila.parentUid };
  }

  async deleteApiKey(id: string): Promise<void> {
    await latencia(100, 100);
    this.apiKeys.delete(id);
  }

  async unlockVault(masterPassword: string): Promise<UnlockResult> {
    await latencia(300, 200);
    const ok = masterPassword === this.maestra || masterPassword.length >= 4;
    return ok ? { ok: true, reason: null } : { ok: false, reason: 'Contraseña incorrecta.' };
  }

  async verifyMasterPassword(masterPassword: string): Promise<boolean> {
    await latencia(200, 150);
    return masterPassword === this.maestra || masterPassword.length >= 4;
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
