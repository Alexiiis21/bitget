/**
 * Tipos del dominio, compartidos por los tres procesos.
 *
 * Regla: aqui solo hay tipos y constantes. Si algo con comportamiento aparece en
 * shared/, es senal de que se filtro logica hacia el renderer.
 * Ver docs/03-modelo-de-datos.md.
 */

/* ---------- primitivas ---------- */

/**
 * Cantidad monetaria como cadena decimal. Nunca `number`: 0.1 + 0.2 !== 0.3, y
 * un float en un precio de liquidacion es un error que se descubre con dinero
 * real. La aritmetica pasa por decimal.js. docs/03 seccion 14.
 */
export type Decimal = string;

export type Lado = 'long' | 'short';
export type ModoMargen = 'aislado' | 'cruzado';
export type ModoPosicion = 'cobertura' | 'unilateral';

/* ---------- cuentas ---------- */

export type EstadoConexion = 'conectada' | 'conectando' | 'desconectada' | 'modo-rest';

export interface Grupo {
  id: string;
  nombre: string;
  orden: number;
  colapsado: boolean;
}

/** Metadatos de cuenta. Nunca contiene secretos: viven cifrados en vault.enc. */
export interface Cuenta {
  id: string;
  grupoId: string;
  etiqueta: string;
  /**
   * UID que Bitget asigna a la subcuenta (`bitget_uid`).
   *
   * Lo devuelve el propio exchange al validar la credencial; el operador nunca
   * lo escribe. Es lo unico de esta ficha que **sobrevive a un cambio de API
   * Key**, y por eso es el identificador con el que se reconoce a la subcuenta
   * cuando se vuelve a registrar.
   */
  uid: string;
  /**
   * UID de la cuenta principal a la que pertenece (`bitget_parent_uid`).
   *
   * Cadena vacia si Bitget no lo informa, que es lo que pasa con una cuenta que
   * no es subcuenta de nadie. Como el `uid`, sale del exchange y no del
   * formulario.
   */
  uidPadre: string;
  credencialId: string;
  /** Solo los primeros 2 y ultimos 4 caracteres. El valor completo no cruza el IPC. */
  apiKeyEnmascarada: string;
  /**
   * Casilla fija dentro de la cuenta principal, de 1 a SUBCUENTAS_POR_GRUPO.
   *
   * No es la posicion en una lista: es el numero que el operador ve en la
   * rejilla y que aprende de memoria. La casilla 7 sigue siendo la 7 aunque se
   * borre la 3, porque una rejilla que se recoloca sola le haria perder la
   * referencia justo cuando mas rapido necesita actuar. docs/04 pregunta P-6.
   */
  slot: number;
  activa: boolean;
  modoPosicion: ModoPosicion;
  modoMargen: ModoMargen;
  altaEn: string;
}

/* ---------- posiciones ---------- */

export interface TakeProfit {
  /** Precio de disparo. Es lo unico que devuelve el exchange. */
  precio: Decimal;
  /**
   * Porcentaje de ganancia con el que se aprobo, o `null` si no se sabe.
   *
   * Es `null` en todo Take Profit que el panel no puso en esta sesion: el
   * porcentaje se escribio en un formulario y no viaja en ninguna respuesta de
   * Bitget, que solo conoce el precio de disparo. Un `0` en su lugar se
   * ensenaria como «0 %» y el operador leeria que su posicion cierra sin
   * ganancia.
   */
  porcentaje: number | null;
  /** `orderId` del plan en Bitget. Es con el que se cancela. */
  planId: string;
}

/**
 * Clave compuesta: cuentaId + simbolo + lado.
 *
 * El lado forma parte de la clave porque el panel opera en modo cobertura: una
 * cuenta puede tener LONG y SHORT vivos sobre el mismo simbolo al mismo tiempo.
 * Con la clave `(cuenta, simbolo)` se perderia una de las dos en silencio.
 * docs/03 seccion 1, Hallazgo 3.
 */
export interface Posicion {
  cuentaId: string;
  simbolo: string;
  lado: Lado;
  tamano: Decimal;
  precioEntrada: Decimal;
  precioLiquidacion: Decimal;
  apalancamiento: number;
  modoMargen: ModoMargen;
  margen: Decimal;
  /**
   * Ganancia o perdida no realizada de la punta, tal como la informa Bitget
   * (`unrealizedPL`). Cadena vacia si el exchange no la mando en esta lectura,
   * igual que `precioEntrada` o `margen`: no es un dato que el panel calcule.
   */
  pnl: Decimal;
  /** Llega por el canal orders-algo, no por positions: puede faltar un instante. */
  takeProfit: TakeProfit | null;
  origen: 'ws' | 'rest';
  actualizadoEn: string;
  estado: 'viva' | 'indeterminada';
}

export const clavePosicion = (cuentaId: string, simbolo: string, lado: Lado): string =>
  `${cuentaId}|${simbolo}|${lado}`;

/* ---------- proyeccion del monitor ---------- */

export type EstadoPunta = 'ok' | 'indeterminada' | 'sin-conexion' | 'modo-rest';

/**
 * Una punta viva, tal como la publica el proceso principal al Centro de
 * Monitoreo.
 *
 * --------------------------------------------------------------------------
 * Viaja la punta, no la fila
 * --------------------------------------------------------------------------
 * Hasta la Fase 6 este canal transportaba una `FilaMonitor` con las dos puntas
 * dentro y una fila por subcuenta. No servia: en Bitget la posicion se
 * identifica por cuenta, **simbolo** y lado -por eso `clavePosicion` lleva los
 * tres-, y una casilla con BTC y ETH abiertos no cabe en una fila por
 * subcuenta; la segunda posicion se perdia sin decirlo.
 *
 * Ahora viaja lo que el exchange tiene: una punta por posicion viva. Agrupar
 * en filas -una por casilla y activo, con su long, su short y su distancia
 * L/S- es cosa de la pantalla, que es la que sabe como se dibuja.
 *
 * Es tambien la unidad que ya usa la vista del renderer (`Position` de
 * `shared/domain/panel-view.ts`), asi que la traduccion es campo a campo y no
 * hay que partir ni recomponer nada por el camino.
 */
export interface PosicionMonitor {
  /** La subcuenta, que es la casilla del panel. */
  cuentaId: string;
  /** La cuenta principal que la agrupa. La pantalla dibuja un acordeon por cada una. */
  grupoId: string;
  etiqueta: string;
  /** Simbolo de la API: `BTCUSDT`, `SBTCSUSDT`. */
  simbolo: string;
  /** Nombre corto del catalogo: `BTC`. Es lo que se ensena y con lo que se opera. */
  activoId: string;
  lado: Lado;
  entrada: Decimal;
  liquidacion: Decimal;
  takeProfit: Decimal | null;
  /** Porcentaje con el que se aprobo el Take Profit, para el distintivo. */
  takeProfitPorcentaje: number | null;
  /**
   * Margen inicial acumulado, propiedad del panel.
   *
   * `null` en una posicion que ya estaba abierta cuando arranco el panel: ese
   * numero no lo tiene Bitget -su `margen` es el de ahora, con el adicional
   * dentro- y deducirlo seria ensenar como aprobado algo que nadie aprobo. La
   * pantalla enseña un guion, que es la verdad.
   */
  margenInicial: Decimal | null;
  /** Margen adicional agregado por el panel, o `null`. */
  margenAdicional: Decimal | null;
  /** Margen que la posicion tiene ahora segun Bitget. */
  margenActual: Decimal;
  /** Ganancia o perdida no realizada, tal como la informa Bitget. Cadena vacia si no llego. */
  pnl: Decimal;
  /**
   * Retorno sobre el margen actual, en porcentaje: `pnl / margenActual * 100`.
   *
   * Bitget no manda este numero -a diferencia del P&L, no hay campo `roe` en
   * `all-position` ni en el canal `positions`-, asi que lo deriva el proceso
   * principal contra el margen que el exchange informa ahora mismo, no contra
   * `margenInicial`: ese es del panel y sale `null` en una posicion que ya
   * estaba abierta al arrancar, y el ROE tiene que poder leerse en cualquier
   * posicion viva. `null` sin P&L conocido o con margen cero o desconocido.
   */
  roe: number | null;
  apalancamiento: number;
  tamano: Decimal;
  /** De donde salio el ultimo dato. Distingue lo instantaneo de lo de hace 45 s. */
  origen: 'ws' | 'rest';
  actualizadoEn: string;
  /** Cuando la abrio el panel. `null` si ya estaba abierta al arrancar. */
  abiertaEn: string | null;
  estado: EstadoPunta;
  /** Texto para el operador cuando el estado no es `ok`. */
  motivo: string | null;
}

/* ---------- lotes de ejecucion ---------- */

/**
 * Agregar y quitar margen son dos acciones, no una con signo.
 *
 * Comparten endpoint -`set-margin` con `amount` positivo o negativo- y comparten
 * el codigo del motor, pero no el rotulo del informe: un lote que retira margen
 * anunciado como «agregar-margen» dice al operador lo contrario de lo que hizo,
 * y el margen es justo lo que el cliente pidio poder revisar sin margen de duda.
 */
export type AccionLote =
  | 'abrir'
  | 'cerrar'
  | 'take-profit'
  | 'quitar-take-profit'
  | 'agregar-margen'
  | 'quitar-margen'
  | 'apalancamiento';

/**
 * Cuatro desenlaces, no dos. `indeterminado` no es un fallo: es la ausencia de
 * respuesta despues de enviar, y nunca se reintenta a ciegas.
 * docs/03 seccion 10.
 */
export type EstadoJob = 'pendiente' | 'enviando' | 'exito' | 'fallo' | 'omitida' | 'indeterminada';

export interface Job {
  cuentaId: string;
  /**
   * Lado sobre el que actua este trabajo.
   *
   * Forma parte de la identidad del trabajo, no es un adorno: en modo cobertura
   * una misma subcuenta puede recibir una apertura long y otra short en el
   * mismo lote, y sin el lado serian dos trabajos indistinguibles en el informe.
   * docs/adr/0006.
   */
  lado: Lado;
  /** Nombre visible de la subcuenta. El informe lo lee un operador, no una maquina. */
  etiqueta: string;
  clientOid: string;
  estado: EstadoJob;
  codigoBitget: string | null;
  mensaje: string | null;
  ordenId: string | null;
}

export interface Lote {
  id: string;
  accion: AccionLote;
  simbolo: string;
  iniciadoEn: string;
  terminadoEn: string | null;
  jobs: Job[];
}

/* ---------- catalogo de simbolos ---------- */

export interface Simbolo {
  simbolo: string;
  tickSize: Decimal;
  pricePlace: number;
  minTradeNum: Decimal;
  sizeMultiplier: Decimal;
  apalancamientoMax: number;
  estado: 'normal' | 'suspendido';
}
