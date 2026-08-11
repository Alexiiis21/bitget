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
  BatchResult,
  ClosedPosition,
  CloseRequest,
  LeverageRequest,
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
  getBalance(subAccountId: string): Promise<Balance>;
  getHistory(subAccountId: string, limit: number): Promise<ClosedPosition[]>;
  subscribePositions(cb: (snapshot: PositionSnapshot) => void): Unsubscribe;

  /* ---- escritura (lotes) ---- */
  openPositions(req: OpenRequest): Promise<BatchResult>;
  closePositions(req: CloseRequest): Promise<BatchResult>;
  setTakeProfit(req: TpRequest): Promise<BatchResult>;
  addMargin(req: MarginRequest): Promise<BatchResult>;
  setLeverage(req: LeverageRequest): Promise<BatchResult>;

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
