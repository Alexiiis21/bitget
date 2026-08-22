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
export type ApiKeyStatus = 'ok' | 'conectando' | 'error' | 'sin-api';

/** Catálogo de activos operables. Futuros USDT-M. */
export interface Asset {
  id: string;
  /** Símbolo tal como lo espera la API de Bitget, p. ej. `BTCUSDT`. */
  symbol: string;
  label: string;
  /** Decimales de precio propios del activo: PEPE necesita 8, PAXG necesita 2. */
  priceDecimals: number;
  /**
   * Tope de apalancamiento del activo, leído del contrato de Bitget.
   *
   * Cada activo tiene el suyo —BTC 150x, PEPE 75x, PAXG 50x— y en el mercado de
   * pruebas son otros. Con este dato el campo puede proponer el máximo del
   * activo elegido, que es como opera el cliente, sin que tenga que recordarlo.
   */
  maxLeverage: number;
  minLeverage: number;
  /** `false` si Bitget tiene el contrato suspendido: no se puede operar. */
  tradable: boolean;
}

export interface SubAccount {
  id: string;
  accountId: string;
  label: string;
  /** Posición dentro de la cuenta principal, 1 a `CASILLAS_POR_CUENTA`. */
  slot: number;
  balance: Decimal;
  /**
   * Estado de la credencial de esta subcuenta contra Bitget.
   *
   * Vive aquí y no solo en la pantalla de API keys porque es lo que separa
   * «esta casilla no tiene posición» de «esta casilla no responde», y esas dos
   * piden reacciones opuestas del operador. RF-002.
   */
  status: ApiKeyStatus;
  /** Texto del fallo cuando `status` no es `ok`. */
  statusReason: string | null;
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
  /**
   * Casillas cuyo desenlace **no se pudo determinar**.
   *
   * No son fallos y no se pueden reintentar como si lo fueran: la orden se
   * envió, la respuesta no llegó y el panel tampoco pudo averiguar después qué
   * pasó. Reintentarlas a ciegas es lo único que puede duplicar una posición,
   * así que se cuentan aparte y quedan fuera de «reintentar las fallidas».
   */
  undetermined: BatchFailure[];
}

/* ---------- planes (lo que se aprueba antes de enviar) ---------- */

export type PlanKind = 'open' | 'close' | 'tp' | 'tp-remove' | 'margin' | 'leverage';

/** Una casilla que sí va a recibir la operación, con lo que le va a pasar. */
export interface PlanEntry extends BatchTarget {
  /** Nombre visible: «Sub-01 · A». */
  label: string;
  /** Lo concreto que se va a hacer ahí: «0,0157 BTC · margen 100 USDT». */
  detail: string;
}

/** Una casilla que se queda fuera, y por qué. Se enseña igual que las demás. */
export interface PlanDiscard extends BatchTarget {
  label: string;
  reason: string;
}

/**
 * Lo que el operador aprueba antes de que salga una sola orden.
 *
 * Es la pieza que sostiene la promesa del contrato: no se aprueba «abrir 100
 * USDT a 150x», se aprueba «0,0157 BTC en estas 34 casillas, y estas 3 no
 * pueden por saldo». Los números vienen del proceso principal, calculados con
 * el precio y el saldo de ese momento.
 *
 * El plan vive en el proceso principal; aquí solo llega su `id` y lo que hay
 * que enseñar. Confirmar devuelve ese `id`, de modo que ninguna cantidad puede
 * cambiar entre lo aprobado y lo enviado.
 */
export interface BatchPlan {
  kind: PlanKind;
  id: string;
  /** Título de la confirmación: «Abrir posiciones». */
  title: string;
  /** Una línea con lo común a todas: «100 USDT por casilla · a mercado». */
  summary: string;
  /** Precio con el que se calculó, cuando la operación depende de uno. */
  reference: string | null;
  entries: PlanEntry[];
  discards: PlanDiscard[];
}

export interface OpenRequest {
  targets: BatchTarget[];
  assetId: string;
  orderType: OrderType;
  limitPrice: Decimal | null;
  initialMargin: Decimal;
  leverage: number;
}

export interface CloseRequest {
  targets: BatchTarget[];
  assetId: string;
}

export interface TpRequest {
  targets: BatchTarget[];
  assetId: string;
  percent: Decimal;
}

export interface MarginRequest {
  targets: BatchTarget[];
  assetId: string;
  amount: Decimal;
}

export interface LeverageRequest {
  targets: BatchTarget[];
  assetId: string;
  leverage: number;
}

/* ---------- credenciales ---------- */

export interface ApiKeyRow {
  id: string;
  subAccountLabel: string;
  accountName: string;
  /** Nunca la clave completa: solo prefijo y sufijo. RNF-001. */
  maskedKey: string;
  /**
   * UID que Bitget asigna a la subcuenta. Lo detecta el panel al validar.
   *
   * A diferencia de la clave, no se enmascara: no sirve para firmar nada y es
   * justamente lo que permite reconocer la cuenta cuando la clave cambia.
   */
  uid: string;
  /** UID de la cuenta principal segun Bitget. Vacio si Bitget no lo informa. */
  parentUid: string;
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
  /** UID detectado en Bitget. `null` cuando la credencial no llego a validar. */
  uid: string | null;
  /** UID de la cuenta principal detectado en Bitget, si la cuenta es subcuenta. */
  parentUid: string | null;
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
