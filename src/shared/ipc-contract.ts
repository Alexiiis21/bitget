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
import type { EstadoConexion, FilaMonitor, Lote } from './types';

/* ---------- estado del sistema ---------- */

export interface InfoSistema {
  appVersion: string;
  instanciaId: string;
  instanciaNombre: string;
  /**
   * Numero visible del panel, el «#3» de la barra superior.
   *
   * Cada sistema corre en su maquina con su carpeta de datos, y confundir dos
   * paneles abiertos es confundir dos juegos de cien cuentas. docs/03 seccion 3.
   */
  numeroPanel: number;
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

/* ---------- almacen de credenciales ---------- */

/**
 * Resultado de abrir o crear el almacen.
 *
 * No se lanza una excepcion a traves del IPC porque el motivo importa: la
 * pantalla de desbloqueo dice cosas distintas ante una contrasena equivocada y
 * ante un archivo danado, y un `Error` serializado pierde esa distincion.
 */
export interface ResultadoVault {
  ok: boolean;
  /** `contrasena-incorrecta`, `archivo-danado`, `version-futura`… */
  motivo: string | null;
  mensaje: string | null;
}

/**
 * Una fila de la pantalla de API keys. Corresponde 1:1 con docs/04 W-06.
 *
 * Lleva la clave ya enmascarada porque el valor completo no cruza esta
 * frontera en ningun caso. RNF-001.
 */
export interface FilaCuenta {
  id: string;
  /** Nombre de la subcuenta, «Sub-01». */
  etiqueta: string;
  /** Nombre de la cuenta principal que la agrupa, «A». */
  grupoNombre: string;
  apiKeyEnmascarada: string;
  estado: EstadoConexion;
  /** Texto para el operador cuando el estado no es `conectada`. */
  motivo: string | null;
  altaEn: string;
}

/** Datos del formulario de alta. Es el unico payload con secretos, y va en un solo sentido. */
export interface AltaCuenta {
  etiqueta: string;
  grupoNombre: string;
  apiKey: string;
  secretKey: string;
  passphrase: string;
}

export interface AvisoCredencial {
  codigo: string;
  mensaje: string;
}

/**
 * Desenlace de un alta.
 *
 * `ok: false` con `veredicto` no nulo significa que Bitget contesto y la
 * credencial no sirve; con `veredicto` nulo, que ni siquiera se pudo preguntar.
 */
export interface ResultadoAlta {
  ok: boolean;
  veredicto: 'valida' | 'rechazada' | 'invalida' | null;
  motivo: string | null;
  /** Cosas que funcionan pero conviene saber: margen cruzado, sin IP ligada… */
  advertencias: AvisoCredencial[];
  cuenta: FilaCuenta | null;
}

/** Desenlace de «Probar» sobre una credencial ya guardada. */
export interface ResultadoPrueba {
  ok: boolean;
  estado: EstadoConexion;
  motivo: string | null;
  latenciaMs: number;
  advertencias: AvisoCredencial[];
}

/* ---------- peticiones del renderer (invoke) ---------- */

export interface PeticionesIpc {
  'sistema:info': () => Promise<InfoSistema>;
  'sistema:estado': () => Promise<EstadoApp>;
  'vault:estado': () => Promise<EstadoVault>;
  'vault:crear': (contrasena: string) => Promise<ResultadoVault>;
  'vault:abrir': (contrasena: string) => Promise<ResultadoVault>;
  'vault:cerrar': () => Promise<void>;
  /** Confirma la maestra sin dar acceso: solo para acciones sensibles. */
  'vault:comprobar': (contrasena: string) => Promise<boolean>;
  'cuentas:listar': () => Promise<FilaCuenta[]>;
  'cuentas:agregar': (alta: AltaCuenta) => Promise<ResultadoAlta>;
  'cuentas:eliminar': (cuentaId: string) => Promise<boolean>;
  'cuentas:verificar': (cuentaId: string) => Promise<ResultadoPrueba>;
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
  vaultEstado(): Promise<EstadoVault>;
  vaultCrear(contrasena: string): Promise<ResultadoVault>;
  vaultAbrir(contrasena: string): Promise<ResultadoVault>;
  vaultCerrar(): Promise<void>;
  vaultComprobar(contrasena: string): Promise<boolean>;
  cuentasListar(): Promise<FilaCuenta[]>;
  cuentasAgregar(alta: AltaCuenta): Promise<ResultadoAlta>;
  cuentasEliminar(cuentaId: string): Promise<boolean>;
  cuentasVerificar(cuentaId: string): Promise<ResultadoPrueba>;
  monitorInstantanea(): Promise<FilaMonitor[]>;
  /** Devuelve la funcion para cancelar la suscripcion. */
  suscribir<C extends CanalEvento>(canal: C, cb: (dato: EventosIpc[C]) => void): () => void;
}
