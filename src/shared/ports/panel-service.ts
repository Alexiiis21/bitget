/**
 * Puerto único entre el renderer y el resto del mundo.
 *
 * El renderer nunca llama a la API de Bitget ni toca credenciales: siempre
 * pasa por aquí. `MockPanelService` (renderer, datos de ejemplo) e
 * `IpcPanelService` (renderer → preload → proceso principal) son las dos
 * implementaciones intercambiables; los componentes React nunca importan
 * ninguna de las dos directamente, solo este tipo.
 *
 * Es deliberadamente más amplio que lo que el proceso principal ya expone
 * hoy por IPC (`shared/ipc-contract.ts`): declara la superficie completa que
 * necesita el diseño aprobado v2, y `IpcPanelService` marca con
 * `NotImplemented` cada método sin respaldo real en el backend en lugar de
 * inventar datos. Ver el reporte de brechas al final del encargo.
 *
 * Cinco adiciones sobre la interfaz que se pidió, cada una justificada:
 *  - `listAssets` / `subscribeAssetPrices`: el selector de activos necesita
 *    un catálogo y un precio en vivo que no estaban en la interfaz original.
 *  - `getSystemInfo` / `setPanelNumber`: el número de panel pasa a ser
 *    editable por el operador en el diseño v2 (antes era fijo por instancia).
 *  - `setStepPassword`: `verifyStepPassword` sin una forma de fijarla no
 *    sirve para el diálogo de Seguridad.
 *  - `verifyMasterPassword`: comprobar la maestra sin abrir el almacén es
 *    una operación ya existente en el backend (`vault:comprobar`) y distinta
 *    de `unlockVault`, que sí reemplaza la sesión abierta.
 */
import type {
  Account,
  ApiKeyInput,
  ApiKeyRow,
  Asset,
  Balance,
  BatchPlan,
  BatchResult,
  BatchTarget,
  ClosedPosition,
  CloseRequest,
  LeverageRequest,
  MarginCap,
  MarginRequest,
  OpenRequest,
  PositionSnapshot,
  SystemInfo,
  TpRequest,
  UnlockResult,
  ValidationResult
} from '../domain/panel-view';
import type { Decimal } from '../types';

export type Unsubscribe = () => void;

export interface PanelService {
  /* ---- sistema ---- */
  getSystemInfo(): Promise<SystemInfo>;
  setPanelNumber(numeroPanel: number): Promise<void>;

  /* ---- activos ---- */
  listAssets(): Promise<Asset[]>;
  subscribeAssetPrices(cb: (prices: Readonly<Record<string, Decimal>>) => void): Unsubscribe;

  /* ---- lectura ---- */
  getAccounts(): Promise<Account[]>;
  /**
   * Avisa cuando cambia la matriz: una cuenta que reconecta, un saldo nuevo,
   * un alta o una baja.
   *
   * Sin esto, `getAccounts` seria una foto que envejece: el estado de conexion
   * lo mueve el proceso principal en segundo plano y la pantalla no tendria
   * forma de enterarse. RF-002.
   */
  subscribeAccounts(cb: (accounts: Account[]) => void): Unsubscribe;
  getBalance(subAccountId: string): Promise<Balance>;
  getHistory(subAccountId: string, limit: number): Promise<ClosedPosition[]>;
  subscribePositions(cb: (snapshot: PositionSnapshot) => void): Unsubscribe;

  /* ---- escritura, en dos fases ---- */

  /**
   * Las seis operaciones se planifican antes de enviarse, y ninguna de estas
   * seis llamadas envia nada a Bitget.
   *
   * Planificar cuesta consultas -precio, saldo, posiciones- y devuelve lo que
   * de verdad va a pasar en cada casilla. Es lo que el operador aprueba. Si
   * cancela, no ha salido ni una orden.
   */
  planOpen(req: OpenRequest): Promise<BatchPlan>;
  planClose(req: CloseRequest): Promise<BatchPlan>;
  planTakeProfit(req: TpRequest): Promise<BatchPlan>;
  planRemoveTakeProfit(req: CloseRequest): Promise<BatchPlan>;
  planMargin(req: MarginRequest): Promise<BatchPlan>;
  planLeverage(req: LeverageRequest): Promise<BatchPlan>;

  /**
   * Envia un plan ya aprobado, identificandolo por su `id`.
   *
   * `only` acota el envio a unas casillas concretas: es «reintentar solo las
   * fallidas». Reutiliza los identificadores de orden del plan original, que es
   * lo que impide que un reintento duplique lo que ya entro.
   */
  executePlan(plan: BatchPlan, only?: BatchTarget[]): Promise<BatchResult>;

  /* ---- contrasena de paso ---- */
  hasStepPassword(): Promise<boolean>;

  /* ---- tope de margen inicial ---- */
  getMarginCap(): Promise<MarginCap>;
  /** Falla si hay un tope vigente: no se cambia en 24 horas, ni para subir ni para bajar. */
  setMarginCap(value: string): Promise<MarginCap>;

  /* ---- credenciales y seguridad ---- */
  listApiKeys(): Promise<ApiKeyRow[]>;
  registerApiKey(input: ApiKeyInput): Promise<ValidationResult>;
  testApiKey(id: string): Promise<ValidationResult>;
  deleteApiKey(id: string): Promise<void>;
  unlockVault(masterPassword: string): Promise<UnlockResult>;
  /** Confirma la maestra sin dar acceso: para acciones sensibles con la sesión ya abierta. */
  verifyMasterPassword(masterPassword: string): Promise<boolean>;
  verifyStepPassword(pwd: string): Promise<boolean>;
  setStepPassword(pwd: string): Promise<void>;
}

/**
 * Fallo de un método del puerto sin respaldo real en el proceso principal.
 *
 * `IpcPanelService` lo lanza en vez de simular datos: es preferible que la
 * pantalla se rompa de forma ruidosa a que muestre una cifra inventada como
 * si viniera de Bitget.
 */
export class NotImplementedError extends Error {
  constructor(metodo: string) {
    super(`NotImplemented: ${metodo}`);
    this.name = 'NotImplementedError';
  }
}
