/**
 * `PanelService` cableado al proceso principal real, vía `window.pcb`.
 *
 * Solo implementa lo que el backend ya expone hoy por IPC
 * (`shared/ipc-contract.ts`): vault, registro de cuentas y verificación.
 * Todo lo demás lanza `NotImplementedError` con el nombre exacto del método,
 * en vez de inventar datos — ver el reporte de brechas al final del encargo
 * para el porqué de cada uno y el orden recomendado para cerrarlos.
 */
import type {
  Account,
  ApiKeyInput,
  ApiKeyRow,
  ApiKeyStatus,
  Asset,
  Balance,
  BatchResult,
  ClosedPosition,
  SystemInfo,
  UnlockResult,
  ValidationResult
} from '@shared/domain/panel-view';
import type { EstadoConexion } from '@shared/types';
import { NotImplementedError, type PanelService, type Unsubscribe } from '@shared/ports/panel-service';

const ESTADO_A_STATUS: Record<EstadoConexion, ApiKeyStatus> = {
  conectada: 'ok',
  'modo-rest': 'ok',
  conectando: 'conectando',
  desconectada: 'error'
};

/** Traduce el `motivo` crudo de `ErrorVault` (proceso principal) a texto para el operador. */
const MOTIVO_VAULT_A_TEXTO: Record<string, string> = {
  'contrasena-incorrecta': 'Contraseña incorrecta.',
  'no-existe': 'No hay ningún almacén de credenciales en este equipo.',
  'ya-existe': 'Ya existe un almacén de credenciales en este equipo.'
};

export class IpcPanelService implements PanelService {
  /* ---------------- sistema ---------------- */

  async getSystemInfo(): Promise<SystemInfo> {
    const info = await window.pcb.sistemaInfo();
    return { appVersion: info.appVersion, panelNumber: info.numeroPanel, portable: info.portable };
  }

  async setPanelNumber(): Promise<void> {
    /*
     * `numeroPanel` hoy es fijo por instancia (storage/instancia.ts), no
     * editable desde la pantalla. Falta un canal IPC nuevo que lo persista.
     * Ver reporte de brechas: "número de panel editable".
     */
    throw new NotImplementedError('setPanelNumber');
  }

  /* ---------------- activos ---------------- */

  async listAssets(): Promise<Asset[]> {
    /* No existe catálogo de símbolos por IPC todavía (docs/03 tiene `Simbolo` en el tipo, sin canal). */
    throw new NotImplementedError('listAssets');
  }

  subscribeAssetPrices(): Unsubscribe {
    throw new NotImplementedError('subscribeAssetPrices');
  }

  /* ---------------- lectura ---------------- */

  async getAccounts(): Promise<Account[]> {
    /*
     * `cuentas:listar` existe y devuelve subcuentas reales, pero sin saldo
     * (Bitget, no el registro local) y sin la rejilla fija de N casillas por
     * cuenta que pide esta pantalla. Cerrar esto es projectar `FilaCuenta[]`
     * a `Account[]` una vez exista una fuente de saldo.
     */
    throw new NotImplementedError('getAccounts');
  }

  async getBalance(): Promise<Balance> {
    throw new NotImplementedError('getBalance');
  }

  async getHistory(): Promise<ClosedPosition[]> {
    /* Excluido por contrato hoy: docs/03-modelo-de-datos.md linea 684. */
    throw new NotImplementedError('getHistory');
  }

  subscribePositions(): Unsubscribe {
    /*
     * `monitor:instantanea` existe pero devuelve `[]` fijo, y el evento
     * `monitor:filas` nunca lo emite el proceso principal (Fase 6, WebSocket
     * de posiciones). Aunque se cableara hoy, `FilaMonitor` no lleva
     * `assetId`, distintivos de acción ni margen inicial acumulado: faltaría
     * ampliar ese tipo antes de poder traducirlo a `Position` sin inventar
     * campos.
     */
    throw new NotImplementedError('subscribePositions');
  }

  /* ---------------- escritura (lotes) ---------------- */

  async openPositions(): Promise<BatchResult> {
    throw new NotImplementedError('openPositions');
  }

  async closePositions(): Promise<BatchResult> {
    throw new NotImplementedError('closePositions');
  }

  async setTakeProfit(): Promise<BatchResult> {
    throw new NotImplementedError('setTakeProfit');
  }

  async addMargin(): Promise<BatchResult> {
    throw new NotImplementedError('addMargin');
  }

  async setLeverage(): Promise<BatchResult> {
    throw new NotImplementedError('setLeverage');
  }

  /* ---------------- credenciales y seguridad ---------------- */

  async listApiKeys(): Promise<ApiKeyRow[]> {
    const filas = await window.pcb.cuentasListar();
    return filas.map((f) => ({
      id: f.id,
      subAccountLabel: f.etiqueta,
      accountName: f.grupoNombre,
      maskedKey: f.apiKeyEnmascarada,
      status: ESTADO_A_STATUS[f.estado],
      reason: f.motivo
    }));
  }

  async registerApiKey(input: ApiKeyInput): Promise<ValidationResult> {
    const resultado = await window.pcb.cuentasAgregar({
      etiqueta: input.subAccountLabel,
      grupoNombre: input.accountName,
      apiKey: input.apiKey,
      secretKey: input.secretKey,
      passphrase: input.passphrase
    });
    return {
      ok: resultado.ok,
      verdict: resultado.veredicto,
      reason: resultado.motivo,
      warnings: resultado.advertencias.map((a) => ({ code: a.codigo, message: a.mensaje })),
      latencyMs: null
    };
  }

  async testApiKey(id: string): Promise<ValidationResult> {
    const resultado = await window.pcb.cuentasVerificar(id);
    return {
      ok: resultado.ok,
      verdict: null,
      reason: resultado.motivo,
      warnings: resultado.advertencias.map((a) => ({ code: a.codigo, message: a.mensaje })),
      latencyMs: resultado.latenciaMs
    };
  }

  async deleteApiKey(id: string): Promise<void> {
    await window.pcb.cuentasEliminar(id);
  }

  async unlockVault(masterPassword: string): Promise<UnlockResult> {
    const estado = await window.pcb.vaultEstado();
    const resultado =
      estado === 'sin-inicializar'
        ? await window.pcb.vaultCrear(masterPassword)
        : await window.pcb.vaultAbrir(masterPassword);
    if (resultado.ok) return { ok: true, reason: null };
    return { ok: false, reason: MOTIVO_VAULT_A_TEXTO[resultado.motivo ?? ''] ?? resultado.mensaje };
  }

  async verifyMasterPassword(masterPassword: string): Promise<boolean> {
    return window.pcb.vaultComprobar(masterPassword);
  }

  async verifyStepPassword(): Promise<boolean> {
    /*
     * No hay concepto de "contraseña de paso" en el proceso principal: en el
     * diseño anterior vivía solo en memoria del renderer. Falta persistirla
     * (hash, no en claro) y un canal para verificarla y fijarla.
     */
    throw new NotImplementedError('verifyStepPassword');
  }

  async setStepPassword(): Promise<void> {
    throw new NotImplementedError('setStepPassword');
  }
}
