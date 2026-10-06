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
import type { Decimal, EstadoConexion, FilaMonitor, Lado, Lote } from './types';

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
  /**
   * Mercado contra el que opera este panel.
   *
   * Se lee de `config.json` y arranca en `simulado`. Es informacion que la
   * pantalla debe mostrar siempre: la diferencia entre las dos es si las
   * ordenes mueven dinero de verdad.
   */
  mercado: 'real' | 'simulado';
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
  /**
   * UID que Bitget asigna a la subcuenta. Lo detecta el panel al validar.
   *
   * No es un secreto -no sirve para firmar nada- y por eso puede cruzar el IPC:
   * es lo que permite enseñar en pantalla a que cuenta de Bitget corresponde
   * esta ficha, sin que el operador tenga que escribirlo ni saberlo.
   */
  uid: string;
  /** UID de la cuenta principal segun Bitget. Vacio si no es subcuenta. */
  uidPadre: string;
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

/* ---------- proyeccion de la matriz de cuentas ---------- */

/**
 * Una subcuenta tal como la dibuja la matriz de seleccion.
 *
 * Es distinta de `FilaCuenta` -la de la pantalla de API keys- a proposito:
 * aquella administra credenciales y esta se opera. Aqui no aparece la clave
 * enmascarada, porque en la pantalla de operación no pinta nada, y si aparecen
 * la casilla y el saldo, que alli sobran.
 */
export interface SubcuentaPanel {
  id: string;
  etiqueta: string;
  /** Casilla fija dentro de la cuenta principal, de 1 a SUBCUENTAS_POR_GRUPO. */
  slot: number;
  /**
   * Saldo disponible en USDT segun la ultima verificacion de la credencial.
   *
   * No se consulta aparte: llega en la misma respuesta con la que Bitget
   * confirma que la API Key sirve, asi que mostrarlo no cuesta ni una peticion
   * mas. Se refresca cuando la cuenta se verifica -al reconectar, o al pulsar
   * «Probar»-; el refresco continuo es del Centro de Monitoreo (Fase 6).
   */
  saldo: Decimal;
  estado: EstadoConexion;
  motivo: string | null;
}

/** Una cuenta principal con sus subcuentas, ordenadas por casilla. */
export interface CuentaPanel {
  id: string;
  nombre: string;
  subcuentas: SubcuentaPanel[];
}

/* ---------- apertura de operaciones ---------- */

export type ClaveMercadoIpc = 'real' | 'simulado';

/** Lo que la pantalla pide abrir. El precio y la cantidad los pone el proceso principal. */
export interface PeticionAperturaIpc {
  simbolo: string;
  objetivos: { cuentaId: string; lado: Lado }[];
  /** Margen por casilla seleccionada, en moneda de margen. */
  margenInicial: string;
  apalancamiento: number;
  /** `null` para orden a mercado. */
  precioLimite: string | null;
}

/**
 * Una casilla del plan, tal como se ensena en la confirmacion.
 *
 * **Dos unidades distintas conviven en esta estructura**, y confundirlas es el
 * error que la confirmacion existe para impedir:
 *
 *   size                    moneda base    331 XRP
 *   nocional / margenReal   moneda margen  499,14 USDT / 9,98 USDT
 *
 * Por eso el plan lleva ademas `monedaMargen`: la pantalla no tiene que
 * deducirla del simbolo, y ningun numero de dinero se ensena sin su moneda al
 * lado. El operador que ve «331 · 9,98 · 499,14» sin unidades no tiene forma de
 * saber cual de los tres es dinero.
 *
 * Los dos importes vienen **truncados a dos decimales** desde el proceso
 * principal, con decimal.js y hacia abajo. Truncar y no redondear es la misma
 * regla que sigue `dimensionarApertura`: de los dos errores posibles, ensenar un
 * centimo de menos es el inofensivo; ensenar uno de mas seria decirle al
 * operador que compromete mas de lo que compromete. El valor exacto que se envia
 * vive en el plan del proceso principal y no cambia por esto.
 */
export interface EntradaPlanIpc {
  cuentaId: string;
  etiqueta: string;
  lado: Lado;
  /** Cantidad en moneda base, exacta: es la que viaja en la orden. */
  size: string;
  /** Valor de la posicion en moneda de margen, truncado a 2 decimales. */
  nocional: string;
  /** Margen que de verdad se compromete tras ajustar la cantidad, truncado a 2 decimales. */
  margenReal: string;
}

export interface DescartePlanIpc {
  cuentaId: string;
  etiqueta: string;
  lado: Lado;
  motivo: string;
  mensaje: string;
}

/**
 * Algo que el operador debe leer antes de confirmar, pero que no impide enviar.
 *
 * El caso previsto es el apalancamiento: se fija una vez en Bitget y queda
 * fijo, asi que la apertura no lo cambia; pero si la cuenta esta en uno
 * distinto al del campo, el margen que se comprometeria no es el que se enseña.
 */
export interface AvisoPlanIpc {
  cuentaId: string;
  etiqueta: string;
  lado: Lado;
  codigo: string;
  mensaje: string;
}

/**
 * El plan que se ensena al operador antes de confirmar.
 *
 * Viaja al renderer **solo para mirarlo**: para ejecutarlo se manda de vuelta
 * su `id`, no su contenido. El proceso principal conserva el plan de verdad, de
 * modo que ninguna cantidad ni ningun precio pueden alterarse en el camino.
 */
export interface PlanAperturaIpc {
  id: string;
  mercado: ClaveMercadoIpc;
  /**
   * Moneda en la que estan `nocional`, `margenReal` y `margenTotal`.
   *
   * `USDT` en el mercado real y `SUSDT` en el simulado: son mercados distintos
   * con monedas de margen distintas, no el mismo con una bandera. Viaja con el
   * plan y no se deduce en la pantalla porque es la etiqueta que acompana a cada
   * cifra de dinero, y una etiqueta adivinada en el renderer podria decir USDT
   * sobre importes que no lo son.
   */
  monedaMargen: string;
  simbolo: string;
  apalancamiento: number;
  precioLimite: string | null;
  /** Precio de marca con el que se calcularon las cantidades. */
  precioReferencia: string;
  margenInicial: string;
  /**
   * Unidad en la que se interpreta lo que teclea el operador.
   *
   * Siempre `costo-usdt`: escribe el margen que compromete y el panel calcula
   * la cantidad. Viaja para que la confirmación pueda mostrarlo bloqueado y no
   * quede como una suposición tácita.
   */
  unidad: string;
  entradas: EntradaPlanIpc[];
  descartes: DescartePlanIpc[];
  avisos: AvisoPlanIpc[];
  /** Suma del margen real de todas las entradas. Es lo que se compromete. */
  margenTotal: string;
  creadoEn: string;
  /** Pasado este instante hay que volver a planificar: el precio ya no vale. */
  expiraEn: string;
}

/* ---------- cierre de operaciones ---------- */

export interface PeticionCierreIpc {
  simbolo: string;
  objetivos: { cuentaId: string; lado: Lado }[];
}

export interface EntradaCierreIpc {
  cuentaId: string;
  etiqueta: string;
  lado: Lado;
  /** Tamano de la posicion cuando se planifico. Se ensena; no se envia. */
  size: string;
  precioEntrada: string | null;
  /** Margen que quedara libre al cerrar, si Bitget lo informa. */
  margenLiberado: string | null;
}

/**
 * El plan de cierre que se ensena antes de confirmar.
 *
 * Como en la apertura, viaja al renderer solo para mirarlo: se ejecuta
 * mandando de vuelta su `id`.
 */
export interface PlanCierreIpc {
  id: string;
  mercado: ClaveMercadoIpc;
  /** Moneda de `margenLiberado` y `margenLiberadoTotal`. Ver `PlanAperturaIpc`. */
  monedaMargen: string;
  simbolo: string;
  entradas: EntradaCierreIpc[];
  descartes: DescartePlanIpc[];
  /** Suma del margen que se libera. Es lo que el operador recupera. */
  margenLiberadoTotal: string;
  creadoEn: string;
}

/* ---------- catalogo de activos ---------- */

/**
 * Un activo operable, con los limites que impone el propio contrato de Bitget.
 *
 * La pantalla los necesita para dos cosas que antes se adivinaban: cuantos
 * decimales tiene el precio y hasta que apalancamiento llega el activo. El tope
 * es distinto en cada uno -BTC 150x, PEPE 75x, PAXG 50x- y distinto ademas en
 * el mercado de pruebas, asi que sale del exchange y no de una tabla escrita a
 * mano que envejeceria en silencio.
 */
export interface ActivoIpc {
  id: string;
  simbolo: string;
  etiqueta: string;
  decimalesPrecio: number;
  apalancamientoMax: number;
  apalancamientoMin: number;
  nocionalMinimo: string;
  operable: boolean;
}

/* ---------- take profit ---------- */

export interface PeticionTakeProfitIpc {
  simbolo: string;
  objetivos: { cuentaId: string; lado: Lado }[];
  /** Ganancia sobre el margen inicial, en porcentaje. P. ej. `35`. */
  porcentaje: string;
}

export interface EntradaTakeProfitIpc {
  cuentaId: string;
  etiqueta: string;
  lado: Lado;
  /** Precio al que Bitget cerrara la posicion. Es lo que se envia. */
  precioDisparo: string;
  precioEntrada: string;
  apalancamiento: number;
  /** Cuanto tiene que moverse el precio, en %. El resto lo pone el apalancamiento. */
  movimientoPorcentaje: string;
}

/**
 * El plan de Take Profit que se ensena antes de confirmar.
 *
 * Es el segundo freno del pliego: el operador no aprueba «35%», aprueba los
 * precios concretos a los que va a quedar cada posicion.
 */
export interface PlanTakeProfitIpc {
  id: string;
  mercado: ClaveMercadoIpc;
  simbolo: string;
  porcentaje: string;
  entradas: EntradaTakeProfitIpc[];
  descartes: DescartePlanIpc[];
  creadoEn: string;
}

/* ---------- quitar el take profit ---------- */

export interface PeticionQuitarTpIpc {
  simbolo: string;
  objetivos: { cuentaId: string; lado: Lado }[];
}

export interface EntradaQuitarTpIpc {
  cuentaId: string;
  etiqueta: string;
  lado: Lado;
  /** Precio al que estaba puesto el Take Profit que se va a quitar. */
  precioDisparo: string;
}

/**
 * Lo que hay puesto ahora mismo, antes de quitar nada.
 *
 * Sale de preguntarle a Bitget, no de lo que el panel recuerde haber colocado:
 * el operador tambien pone y quita Take Profit desde la app.
 */
export interface PlanQuitarTpIpc {
  id: string;
  mercado: ClaveMercadoIpc;
  simbolo: string;
  entradas: EntradaQuitarTpIpc[];
  descartes: DescartePlanIpc[];
  creadoEn: string;
}

/* ---------- agregar margen y apalancamiento ---------- */

export interface PeticionMargenIpc {
  simbolo: string;
  objetivos: { cuentaId: string; lado: Lado }[];
  /** Margen a anadir a cada casilla, en moneda de margen. */
  cantidad: string;
}

export interface EntradaMargenIpc {
  cuentaId: string;
  etiqueta: string;
  lado: Lado;
  cantidad: string;
  margenActual: string;
  margenResultante: string;
}

export interface PlanMargenIpc {
  id: string;
  mercado: ClaveMercadoIpc;
  /** Moneda de `cantidad`, `margenActual`, `margenResultante` y el total. Ver `PlanAperturaIpc`. */
  monedaMargen: string;
  simbolo: string;
  cantidad: string;
  /** Suma de lo que sale del saldo. Es dinero nuevo comprometido. */
  totalComprometido: string;
  entradas: EntradaMargenIpc[];
  descartes: DescartePlanIpc[];
  creadoEn: string;
}

export interface PeticionApalancamientoIpc {
  simbolo: string;
  objetivos: { cuentaId: string; lado: Lado }[];
  apalancamiento: number;
}

export interface EntradaApalancamientoIpc {
  cuentaId: string;
  etiqueta: string;
  lado: Lado;
  apalancamiento: number;
  /** El que el panel cree que tiene ahora, o `null` si no lo sabe. */
  apalancamientoActual: number | null;
}

export interface PlanApalancamientoIpc {
  id: string;
  mercado: ClaveMercadoIpc;
  simbolo: string;
  apalancamiento: number;
  entradas: EntradaApalancamientoIpc[];
  descartes: DescartePlanIpc[];
  creadoEn: string;
}

/* ---------- tope de margen inicial ---------- */

/**
 * El tope de margen inicial del panel, tal como lo ve la pantalla.
 *
 * `sin-tope` es un panel recien instalado; `vencido`, uno cuyo tope cumplio sus
 * 24 horas. En los dos casos la pantalla pide un tope nuevo antes de dejar
 * abrir nada. Las fechas van en ISO 8601. Ver `main/domain/tope-margen.ts`.
 */
export interface EstadoTopeIpc {
  estado: 'sin-tope' | 'vigente' | 'vencido';
  /** Margen inicial maximo por casilla. `null` sin tope. */
  valor: Decimal | null;
  fijadoEn: string | null;
  /** Desde cuando se puede fijar otro. */
  venceEn: string | null;
  /** USDT en el mercado real, SUSDT en el simulado. */
  monedaMargen: string;
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
  /** La matriz de seleccion: cuentas principales, casillas y saldo. */
  'panel:cuentas': () => Promise<CuentaPanel[]>;
  /** Los activos que el panel deja operar en el mercado activo. */
  'mercado:activos': () => Promise<ActivoIpc[]>;
  /** Precio de marca de cada activo, el mismo con el que se dimensiona. */
  'mercado:precios': () => Promise<Record<string, string>>;
  /** ¿Hay contrasena de paso configurada? */
  'paso:hay': () => Promise<boolean>;
  'paso:comprobar': (contrasena: string) => Promise<boolean>;
  'paso:fijar': (contrasena: string) => Promise<void>;
  /** El tope de margen inicial del panel. No sale a la red. */
  'tope:estado': () => Promise<EstadoTopeIpc>;
  /**
   * Fija el tope. Falla si hay uno vigente: no se cambia durante 24 horas, ni
   * para subirlo ni para bajarlo.
   */
  'tope:fijar': (valor: string) => Promise<EstadoTopeIpc>;
  /** Calcula que saldria y que no. No envia ninguna orden. */
  'apertura:planificar': (peticion: PeticionAperturaIpc) => Promise<PlanAperturaIpc>;
  /**
   * Envia un plan ya aprobado, identificandolo por su `id`.
   *
   * `soloEstos` son las cuentas a reintentar; se identifican por `cuentaId` y
   * lado, y el proceso principal reutiliza sus mismos `clientOid`, que es lo
   * que impide duplicar una posicion al reintentar.
   */
  'apertura:ejecutar': (
    planId: string,
    soloEstos?: { cuentaId: string; lado: Lado }[]
  ) => Promise<Lote>;
  /** Consulta que hay abierto en las casillas elegidas. No cierra nada. */
  'cierre:planificar': (peticion: PeticionCierreIpc) => Promise<PlanCierreIpc>;
  'cierre:ejecutar': (
    planId: string,
    soloEstos?: { cuentaId: string; lado: Lado }[]
  ) => Promise<Lote>;
  /** Calcula a que precio queda el Take Profit de cada posicion. No coloca nada. */
  'tp:planificar': (peticion: PeticionTakeProfitIpc) => Promise<PlanTakeProfitIpc>;
  'tp:ejecutar': (
    planId: string,
    soloEstos?: { cuentaId: string; lado: Lado }[]
  ) => Promise<Lote>;
  /** Averigua que Take Profit hay puesto en cada casilla. No quita nada. */
  'tp:planificar-quitar': (peticion: PeticionQuitarTpIpc) => Promise<PlanQuitarTpIpc>;
  'tp:ejecutar-quitar': (
    planId: string,
    soloEstos?: { cuentaId: string; lado: Lado }[]
  ) => Promise<Lote>;
  'margen:planificar': (peticion: PeticionMargenIpc) => Promise<PlanMargenIpc>;
  'margen:ejecutar': (
    planId: string,
    soloEstos?: { cuentaId: string; lado: Lado }[]
  ) => Promise<Lote>;
  'apalancamiento:planificar': (
    peticion: PeticionApalancamientoIpc
  ) => Promise<PlanApalancamientoIpc>;
  'apalancamiento:ejecutar': (
    planId: string,
    soloEstos?: { cuentaId: string; lado: Lado }[]
  ) => Promise<Lote>;
  'monitor:instantanea': () => Promise<FilaMonitor[]>;
}

export type CanalPeticion = keyof PeticionesIpc;

/* ---------- avisos del proceso principal (push) ---------- */

export interface EventosIpc {
  /** Proyeccion del monitor, coalescida a PUBLICACION_COALESCIDA_MS. */
  'monitor:filas': FilaMonitor[];
  /**
   * La matriz entera cada vez que cambia algo suyo: una cuenta que reconecta,
   * un saldo nuevo, un alta o una baja.
   *
   * Se envia completa en lugar de por diferencias porque son cien filas de
   * cuatro campos: el coste de recalcularla es despreciable frente al de
   * mantener sincronizados dos modelos que pueden separarse en silencio.
   */
  'panel:cuentas': CuentaPanel[];
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
  panelCuentas(): Promise<CuentaPanel[]>;
  mercadoActivos(): Promise<ActivoIpc[]>;
  mercadoPrecios(): Promise<Record<string, string>>;
  pasoHay(): Promise<boolean>;
  pasoComprobar(contrasena: string): Promise<boolean>;
  pasoFijar(contrasena: string): Promise<void>;
  topeEstado(): Promise<EstadoTopeIpc>;
  topeFijar(valor: string): Promise<EstadoTopeIpc>;
  aperturaPlanificar(peticion: PeticionAperturaIpc): Promise<PlanAperturaIpc>;
  aperturaEjecutar(planId: string, soloEstos?: { cuentaId: string; lado: Lado }[]): Promise<Lote>;
  cierrePlanificar(peticion: PeticionCierreIpc): Promise<PlanCierreIpc>;
  cierreEjecutar(planId: string, soloEstos?: { cuentaId: string; lado: Lado }[]): Promise<Lote>;
  tpPlanificar(peticion: PeticionTakeProfitIpc): Promise<PlanTakeProfitIpc>;
  tpPlanificarQuitar(peticion: PeticionQuitarTpIpc): Promise<PlanQuitarTpIpc>;
  tpEjecutar(planId: string, soloEstos?: { cuentaId: string; lado: Lado }[]): Promise<Lote>;
  tpEjecutarQuitar(planId: string, soloEstos?: { cuentaId: string; lado: Lado }[]): Promise<Lote>;
  margenPlanificar(peticion: PeticionMargenIpc): Promise<PlanMargenIpc>;
  margenEjecutar(planId: string, soloEstos?: { cuentaId: string; lado: Lado }[]): Promise<Lote>;
  apalancamientoPlanificar(peticion: PeticionApalancamientoIpc): Promise<PlanApalancamientoIpc>;
  apalancamientoEjecutar(
    planId: string,
    soloEstos?: { cuentaId: string; lado: Lado }[]
  ): Promise<Lote>;
  monitorInstantanea(): Promise<FilaMonitor[]>;
  /** Devuelve la funcion para cancelar la suscripcion. */
  suscribir<C extends CanalEvento>(canal: C, cb: (dato: EventosIpc[C]) => void): () => void;
}
