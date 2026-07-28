/**
 * Contrato de IPC: la unica frontera entre el proceso principal y el renderer.
 *
 * Reglas que este archivo hace cumplir por tipos:
 *  - El renderer pide y recibe; nunca ejecuta I/O ni toca secretos.
 *  - Ningun payload contiene apiKey, secretKey ni passphrase completas.
 *  - Todo canal esta declarado aqui. Un canal no declarado no existe.
 *
 * Ver docs/02-arquitectura.html y docs/03-modelo-de-datos.md.
 */
import type { Cuenta, FilaMonitor, Grupo, Lote } from './types';

/* ---------- estado del sistema ---------- */

export interface InfoSistema {
  appVersion: string;
  instanciaId: string;
  instanciaNombre: string;
  /** `true` cuando corre como ejecutable portable. docs/03 seccion 3. */
  portable: boolean;
  carpetaDatos: string;
  electron: string;
  node: string;
}

export type EstadoVault = 'sin-inicializar' | 'bloqueado' | 'desbloqueado';

export interface EstadoApp {
  vault: EstadoVault;
  /** Intentos de PIN restantes; `null` si el desbloqueo rapido esta desactivado. */
  pinIntentosRestantes: number | null;
  cuentasRegistradas: number;
  cuentasConectadas: number;
  /** Consumo del presupuesto de sockets: calientes / WS_MAX_CONCURRENTES. */
  socketsCalientes: number;
}

/* ---------- peticiones del renderer (invoke) ---------- */

export interface PeticionesIpc {
  'sistema:info': () => Promise<InfoSistema>;
  'sistema:estado': () => Promise<EstadoApp>;
  'cuentas:listar': () => Promise<{ grupos: Grupo[]; cuentas: Cuenta[] }>;
  'monitor:instantanea': () => Promise<FilaMonitor[]>;
}

export type CanalPeticion = keyof PeticionesIpc;

/* ---------- avisos del proceso principal (push) ---------- */

export interface EventosIpc {
  /** Proyeccion del monitor, coalescida a PUBLICACION_COALESCIDA_MS. */
  'monitor:filas': FilaMonitor[];
  'sistema:estado': EstadoApp;
  'lote:progreso': Lote;
  'log:linea': { ts: string; nivel: 'info' | 'aviso' | 'error'; texto: string };
}

export type CanalEvento = keyof EventosIpc;

/** Superficie exacta que el preload expone en `window.pcb`. */
export interface ApiPcb {
  sistemaInfo(): Promise<InfoSistema>;
  sistemaEstado(): Promise<EstadoApp>;
  cuentasListar(): Promise<{ grupos: Grupo[]; cuentas: Cuenta[] }>;
  monitorInstantanea(): Promise<FilaMonitor[]>;
  /** Devuelve la funcion para cancelar la suscripcion. */
  suscribir<C extends CanalEvento>(canal: C, cb: (dato: EventosIpc[C]) => void): () => void;
}
