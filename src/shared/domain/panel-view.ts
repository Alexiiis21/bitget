/**
 * Tipos de dominio para la capa de vista del panel (diseño aprobado v2).
 *
 * Distintos de `shared/types.ts`: aquellos son el dominio que habla con
 * Bitget (Posicion, Cuenta, FilaMonitor…); estos son lo que el renderer
 * necesita para dibujarse, tal como los expone `PanelService`
 * (`shared/ports/panel-service.ts`). La traducción entre uno y otro vive en
 * el proceso principal (`IpcPanelService` del lado renderer, `Sesion` +
 * handlers del lado main), nunca en un componente.
 *
 * Se usa vocabulario en inglés a propósito para este puerto: es la interfaz
 * que va a evolucionar junto con la ejecución de órdenes (Fase 3) y conviene
 * que sus nombres no colisionen por transliteración con el dominio Bitget ya
 * existente en español. `Decimal` se reutiliza de `shared/types` — nunca
 * `number` para precios o montos: ver docs/03-modelo-de-datos.md sección 14.
 */
import type { Decimal } from '../types';

export type Side = 'long' | 'short';
export type OrderType = 'market' | 'limit';
export type ActionKey = 'tp' | 'mg' | 'ap' | 'oe';

/** Catálogo de activos operables. Futuros USDT-M. */
export interface Asset {
  id: string;
  /** Símbolo tal como lo espera la API de Bitget, p. ej. `BTCUSDT`. */
  symbol: string;
  label: string;
  /** Decimales de precio propios del activo: PEPE necesita 8, PAXG necesita 2. */
  priceDecimals: number;
}

export interface SubAccount {
  id: string;
  accountId: string;
  label: string;
  /** Posición dentro de la cuenta principal, 1 a `CASILLAS_POR_CUENTA`. */
  slot: number;
  balance: Decimal;
}

export interface Account {
  id: string;
  name: string;
  /** Siempre las mismas N subcuentas, en orden de `slot`. */
  subAccounts: SubAccount[];
}

/**
 * Estado de las cuatro acciones de una punta (TP · MGA · AP · OE).
 *
 * Los campos `…Display` son el valor con el que se aplicó la acción, lo que
 * se pinta bajo cada distintivo. `oe` decide si la posición está abierta.
 */
export interface ActionState {
  tp: boolean;
  mg: boolean;
  ap: boolean;
  oe: boolean;
  tpDisplay: string;
  mgDisplay: string;
  apDisplay: string;
}

/**
 * Una punta (long o short) de una subcuenta sobre un activo.
 *
 * `initialMarginAccum` es propiedad del panel, no de Bitget: acumula cada
 * apertura y reposicionamiento, sin incluir el margen adicional, y se
 * descarta al cerrarse la posición. Ver Paso 4 del encargo.
 */
export interface Position {
  subAccountId: string;
  side: Side;
  assetId: string;
  entryPrice: Decimal;
  liquidationPrice: Decimal;
  takeProfitPrice: Decimal | null;
  initialMarginAccum: Decimal;
  leverage: number;
  actions: ActionState;
  /**
   * Posición abierta sin margen adicional aplicado y en riesgo de
   * liquidación. Distinto de `!actions.mg`: una posición sana también puede
   * no necesitar margen adicional nunca. Este flag es lo que dispara el
   * banner CRÍTICO, y en el backend real lo calcularía la distancia al
   * precio de liquidación, no la mera ausencia de la acción.
   */
  marginCritical: boolean;
  /** `true` si la última consulta a Bitget para esta punta falló. */
  hasError: boolean;
  errorReason: string | null;
  openedAt: string;
}

export interface PositionSnapshot {
  /** Todas las posiciones vivas conocidas, coalescido. Sustituye al anterior entero. */
  positions: Position[];
}

export interface Balance {
  subAccountId: string;
  total: Decimal;
}

export interface ClosedPosition {
  id: string;
  subAccountId: string;
  side: Side;
  entryPrice: Decimal;
  exitPrice: Decimal;
  initialMargin: Decimal;
  pnl: Decimal;
  closedBy: 'take-profit' | 'liquidacion' | 'manual';
  closedAt: string;
}

/* ---------- lotes de ejecución ---------- */

export interface BatchTarget {
  subAccountId: string;
  side: Side;
}

export interface BatchFailure extends BatchTarget {
  reason: string;
}

export interface BatchResult {
  label: string;
  ok: number;
  skipped: number;
  failures: BatchFailure[];
}

export interface OpenRequest {
  targets: BatchTarget[];
  assetId: string;
  orderType: OrderType;
  limitPrice: Decimal | null;
  initialMargin: Decimal;
}

export interface CloseRequest {
  targets: BatchTarget[];
  assetId: string;
}

export interface TpRequest {
  targets: BatchTarget[];
  percent: Decimal;
}

export interface MarginRequest {
  targets: BatchTarget[];
  amount: Decimal;
}

export interface LeverageRequest {
  targets: BatchTarget[];
  leverage: number;
}

/* ---------- credenciales ---------- */

export type ApiKeyStatus = 'ok' | 'conectando' | 'error' | 'sin-api';

export interface ApiKeyRow {
  id: string;
  subAccountLabel: string;
  accountName: string;
  /** Nunca la clave completa: solo prefijo y sufijo. RNF-001. */
  maskedKey: string;
  status: ApiKeyStatus;
  reason: string | null;
}

export interface ApiKeyInput {
  subAccountLabel: string;
  accountName: string;
  apiKey: string;
  secretKey: string;
  passphrase: string;
}

export interface Warning {
  code: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  verdict: 'valida' | 'rechazada' | 'invalida' | null;
  reason: string | null;
  warnings: Warning[];
  latencyMs: number | null;
}

/** Resultado de crear o abrir el almacén. `reason` distingue contraseña incorrecta de archivo dañado. */
export interface UnlockResult {
  ok: boolean;
  reason: string | null;
}

/* ---------- sistema ---------- */

export interface SystemInfo {
  appVersion: string;
  /** Número visible del panel. Editable por el operador; no es el id de instancia. */
  panelNumber: number;
  portable: boolean;
}
