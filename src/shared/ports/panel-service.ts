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
 *  - `listAssetSlots` / `listAssetCatalog` / `setAssetSlot` /
 *    `subscribeAssetPrices`: el selector de activos necesita un catálogo y un
 *    precio en vivo que no estaban en la interfaz original, y desde el
 *    28/08/2026 también una forma de editar sus ocho casillas.
 *  - `getSystemInfo` / `setPanelNumber`: el número de panel pasa a ser
 *    editable por el operador en el diseño v2 (antes era fijo por instancia).
 *    Estuvo declarado aquí y sin respaldo hasta el 28/08/2026 —lanzaba
 *    `NotImplemented`—; ahora lo persiste el canal `sistema:numero-panel`.
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
  BalanceSheet,
  BatchPlan,
  BatchResult,
  BatchTarget,
  ClosedPosition,
  CloseRequest,
  DeleteOutcome,
  LeverageRequest,
  MarginRequest,
  OpenRequest,
  ParentAccount,
  ParentAccountInput,
  ParentValidationResult,
  SpreadMode,
  SpreadPlan,
  SpreadResult,
  TransferPlan,
  TransferRecord,
  TransferResult,
  ImportResult,
  BackupInfo,
  BackupResult,
  RestoreResult,
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
  /**
   * Cambia el número visible del panel y lo persiste.
   *
   * Se guarda en `instancia.json`, en la carpeta de datos del equipo, junto al
   * resto de la identidad de esta instalación. Devuelve cuando está escrito: si
   * la promesa falla, el número no quedó guardado.
   */
  setPanelNumber(numeroPanel: number): Promise<void>;

  /* ---- activos ---- */
  /**
   * Las ocho casillas del selector, en su orden y con sus huecos.
   *
   * `null` es una casilla vacía, y es un estado normal: el mercado de pruebas
   * solo ofrece tres contratos. No se compactan porque el operador las edita
   * por su número, y una lista sin huecos las renumeraría al vaciar una.
   */
  listAssetSlots(): Promise<(Asset | null)[]>;
  /**
   * Todo lo que el mercado ofrece. **Solo para el buscador.**
   *
   * Son los 754 contratos del exchange y nada de aquí se puede operar mientras
   * no ocupe una de las ocho casillas. Elegir y operar son dos actos distintos
   * desde el 28/08/2026, y esta separación es lo que mantiene el selector con
   * el mismo tamaño de siempre.
   */
  listAssetCatalog(): Promise<Asset[]>;
  /**
   * Pone un activo en una casilla, o la vacía con `null`. Devuelve las ocho.
   *
   * El proceso principal comprueba el símbolo contra el catálogo del exchange y
   * rechaza el que no exista o el que ya ocupe otra casilla —dos casillas con el
   * mismo activo serían dos botones llamados igual—.
   */
  setAssetSlot(index: number, symbol: string | null): Promise<(Asset | null)[]>;
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
   * llamadas envia nada a Bitget.
   *
   * Planificar cuesta consultas -precio, saldo, posiciones- y devuelve lo que
   * de verdad va a pasar en cada casilla. Es lo que el operador aprueba. Si
   * cancela, no ha salido ni una orden.
   *
   * `planTakeProfit` y `planMargin` actuan sobre posiciones **ya abiertas**, y
   * no son lo mismo que el Take Profit y el margen adicional que viajan dentro
   * de `planOpen`. Estuvieron retirados entre el 26/08/2026 y el 01/09/2026,
   * cuando tenerlos duplicados era poder enviar el mismo importe dos veces; ver
   * `PlanKind` para lo que cambio al devolverlos.
   */
  planOpen(req: OpenRequest): Promise<BatchPlan>;
  planClose(req: CloseRequest): Promise<BatchPlan>;
  /** Pone -o sustituye- el Take Profit de las posiciones seleccionadas. */
  planTakeProfit(req: TpRequest): Promise<BatchPlan>;
  planRemoveTakeProfit(req: CloseRequest): Promise<BatchPlan>;
  /** Agrega o retira margen de las posiciones seleccionadas, segun `req.direction`. */
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

  /* ---- credenciales y seguridad ---- */
  listApiKeys(): Promise<ApiKeyRow[]>;
  registerApiKey(input: ApiKeyInput): Promise<ValidationResult>;
  testApiKey(id: string): Promise<ValidationResult>;
  /**
   * Da de baja una credencial. **Exige la contraseña de paso**, la de operar.
   *
   * Quien decide si la clave vale es el proceso principal, no la pantalla: aquí
   * solo se le pasa lo tecleado y se lee el desenlace. Por eso no hay un
   * `verifyStepPassword` previo en el camino de la baja —comprobar en un sitio y
   * borrar en otro deja una rendija entre las dos llamadas—.
   */
  deleteApiKey(id: string, stepPassword: string): Promise<DeleteOutcome>;
  /* ---- cuentas madre y saldos (traspasos, Fase 2) ---- */

  /** Cuentas principales registradas, sin secretos. */
  listParentAccounts(): Promise<ParentAccount[]>;
  /**
   * Da de alta la API Key de una cuenta principal.
   *
   * Avisa -sin rechazarla- cuando Bitget no le reporta ninguna subcuenta: es
   * una clave valida de una cuenta que no es madre de nadie, y sin el aviso la
   * pantalla de saldos se veria vacia sin explicacion.
   */
  registerParentAccount(input: ParentAccountInput): Promise<ParentValidationResult>;
  /** Da de baja una cuenta principal. Exige la contraseña de paso. */
  deleteParentAccount(uid: string, stepPassword: string): Promise<DeleteOutcome>;
  /**
   * Saldos de las subcuentas de una cuenta principal, en una sola petición.
   *
   * Sin `parentUid` usa la única registrada. **No es un flujo en vivo**: Bitget
   * limita este endpoint a una petición cada 10 s por cuenta, así que se llama al
   * abrir la pantalla y al refrescar a mano, nunca en un intervalo.
   */
  getBalanceSheet(parentUid?: string): Promise<BalanceSheet>;

  /**
   * Calcula un traspaso y comprueba que se pueda hacer. **No envía nada.**
   *
   * Relee los saldos: el máximo transferible cambia en cuanto se abre o cierra
   * una posición, y validar contra una copia guardada autorizaría lo que Bitget
   * ya no admite.
   */
  planTransfer(input: {
    fromUid: string;
    toUid: string;
    amount: string;
    parentUid?: string;
  }): Promise<TransferPlan>;
  /**
   * Envía un traspaso ya aprobado. **Aquí se mueve el dinero.**
   *
   * Exige la contraseña de paso, la misma que la apertura de posiciones, y solo
   * viaja el `id` del plan: los importes ya se aprobaron.
   */
  executeTransfer(planId: string, stepPassword: string): Promise<TransferResult>;
  /** Historial de traspasos, lo más reciente primero. */
  listTransfers(limit?: number): Promise<TransferRecord[]>;

  /**
   * Calcula un reparto de la cuenta principal hacia varias subcuentas.
   *
   * `iguales` da la misma cantidad a cada una; `igualar` las deja al mismo
   * nivel de saldo, sin quitarle nada a la que ya esté por encima. **No envía
   * nada**: devuelve la lista para aprobarla.
   */
  planSpread(input: {
    toUids: string[];
    total: string;
    mode: SpreadMode;
    parentUid?: string;
  }): Promise<SpreadPlan>;
  /** Calcula la devolución del saldo de varias subcuentas a la principal. */
  planCollect(input: { fromUids: string[]; parentUid?: string }): Promise<SpreadPlan>;
  /**
   * Envía un reparto o una recogida ya aprobados. **Aquí se mueve el dinero.**
   *
   * Los traspasos salen uno detrás de otro y un fallo no detiene a los demás:
   * el resultado dice cuáles entraron y cuáles no. No hay rollback.
   */
  executeSpread(planId: string, stepPassword: string): Promise<SpreadResult>;

  /** `true` si este panel todavía no tiene almacén: es su primer arranque. */
  isFirstRun(): Promise<boolean>;

  /**
   * Trae las credenciales de una instalación anterior. **Copia; no mueve.**
   *
   * Solo tiene sentido en el primer arranque, y por eso la pantalla de
   * desbloqueo únicamente la ofrece entonces: con un almacén ya creado, el
   * proceso principal la rechaza en lugar de sobrescribirlo.
   */
  importCredentials(): Promise<ImportResult>;

  /**
   * Guarda todas las subcuentas en un archivo dentro de Documentos.
   *
   * No descifra nada: el almacén va cifrado tal cual, así que la contraseña
   * maestra **no está dentro del archivo** y sin ella no sirve de nada. La
   * pantalla tiene que decirlo donde el operador lo lea.
   */
  backupAccounts(): Promise<BackupResult>;

  /** El respaldo que el panel ha encontrado solo, o `null` si no hay ninguno. */
  findBackup(): Promise<BackupInfo | null>;

  openBackupFolder(): Promise<void>;

  /**
   * Restaura el respaldo detectado. **Solo con el panel bloqueado.**
   *
   * `masterPassword` es la de *este* panel y solo hace falta si ya hay un
   * almacén que reemplazar; en un panel recién estrenado no hay nada que
   * destruir y se restaura de un clic.
   */
  restoreBackup(masterPassword?: string): Promise<RestoreResult>;

  /** Igual, pero el archivo lo elige el operador en un selector del sistema. */
  restoreBackupFromFile(masterPassword?: string): Promise<RestoreResult>;

  unlockVault(masterPassword: string): Promise<UnlockResult>;
  /** Confirma la maestra sin dar acceso: para acciones sensibles con la sesión ya abierta. */
  verifyMasterPassword(masterPassword: string): Promise<boolean>;
  /**
   * Milisegundos que faltan para poder volver a probar la maestra. `0` si ya.
   *
   * Tras tres fallos seguidos hay una espera que crece con cada uno. La cuenta
   * la lleva el proceso principal y sobrevive a cerrar el panel: esto solo la
   * consulta para poder enseñarla. Ver `shared/espera-maestra.ts`.
   */
  masterCooldownMs(): Promise<number>;
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
