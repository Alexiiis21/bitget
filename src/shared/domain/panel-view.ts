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
/**
 * Aislado o cruzado, con los nombres de la API.
 *
 * Se conserva el vocabulario de Bitget -`isolated`/`crossed`- en vez de
 * traducirlo, como el resto de este puerto: lo que se traduce es la etiqueta
 * que lee el operador, no el valor que viaja. Un `aislado` aquí obligaría a
 * traducir en los dos sentidos en cada frontera, y esa es justo la clase de
 * traducción en la que se pierde un modo de margen.
 */
export type MarginMode = 'isolated' | 'crossed';
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
  /**
   * `null` en una posición que ya estaba abierta cuando arrancó el panel.
   *
   * Bitget no tiene este número —su `marginSize` es el margen de ahora, con el
   * adicional dentro y moviéndose solo— y deducirlo de él sería enseñar como
   * aprobado algo que nadie aprobó. La pantalla enseña un guion, que es la
   * verdad, y empieza a contar desde el primer lote de esta sesión.
   */
  initialMarginAccum: Decimal | null;
  /**
   * Ganancia o pérdida no realizada, tal como la informa Bitget. Cadena vacía
   * si el exchange no la mandó en la última lectura.
   */
  pnl: Decimal;
  /**
   * Retorno sobre el margen actual, en %. Bitget no lo informa: lo calcula el
   * proceso principal contra el margen que el exchange tiene ahora mismo, no
   * contra `initialMarginAccum` -que puede ser `null`-. `null` sin P&L
   * conocido o sin margen contra el que dividir.
   */
  roe: number | null;
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
  /** `null` si la posición ya estaba abierta al arrancar: el panel no la vio abrirse. */
  openedAt: string | null;
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
  /**
   * ¿Entra en «reintentar solo las fallidas»?
   *
   * --------------------------------------------------------------------------
   * Por qué una casilla fallida puede no ser reintentable
   * --------------------------------------------------------------------------
   * El informe de una apertura trae hasta tres filas por casilla: la orden, su
   * Take Profit y su margen adicional. Las tres llevan el mismo `subAccountId` y
   * el mismo `side`, porque son la misma casilla.
   *
   * Y ahí estaba el problema: reintentar se pide por «cuenta y lado», así que un
   * Take Profit fallido metía **la apertura entera** en la lista de reintento.
   * Al reenviarla se volvía a ejecutar la colocación del Take Profit, con un
   * plan nuevo y `clientOid` nuevos —de modo que el identificador ya no protegía
   * de nada— y la posición acababa con dos.
   *
   * Solo es reintentable la fila que tiene su propio identificador de orden: la
   * de la operación en sí. Las derivadas se enseñan igual, porque el operador
   * tiene que saber que su posición quedó sin Take Profit o sin margen, pero no
   * se pueden reenviar desde aquí.
   */
  retryable: boolean;
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

/**
 * Las operaciones que el panel sabe planificar y enviar.
 *
 * --------------------------------------------------------------------------
 * Editar una posición abierta: cómo vuelve sin traerse el fallo
 * --------------------------------------------------------------------------
 * `tp`, `margin-add` y `margin-remove` estuvieron retirados entre el 26/08/2026
 * y el 01/09/2026. Se quitaron porque el Take Profit y el margen adicional
 * viajan **también** dentro de `open`, y con las dos vías abiertas la misma
 * cantidad se podía enviar dos veces sobre la misma posición: el 26/08/2026 una
 * acabó con 2 USDT de margen donde el operador había escrito 1. `set-margin` es
 * la única petición del panel sin identificador propio, así que ahí nada rechaza
 * el repetido.
 *
 * Vuelven porque el cliente los necesita —una posición que quedó sin Take
 * Profit, otra a la que hay que darle o quitarle colchón—, y con las tres cosas
 * que faltaban:
 *
 *  1. **Campos distintos.** El importe que sale con la apertura y el del ajuste
 *     posterior se teclean en casillas separadas, así que el valor que quedó
 *     escrito para abrir no se puede reenviar por inercia. Ver `CAMPOS` en la
 *     barra lateral.
 *  2. **`tp` sustituye, no añade.** El plan lee lo que Bitget tiene puesto, lo
 *     cancela y coloca el nuevo, de modo que una posición nunca acaba con dos
 *     órdenes de cierre. La confirmación enseña «0,00263 → 0,00271».
 *  3. **El margen enseña `actual → resultante`**, leído de Bitget al planificar.
 *     Aplicarlo dos veces se ve en la confirmación, antes de enviar.
 *
 * Agregar y quitar margen son dos entradas y no una con signo: la dirección la
 * elige el operador con el botón que pulsa, no con un `-` que puede sobrar o
 * faltar. Retirar margen acerca la liquidación, y esa no es una diferencia que
 * pueda depender de un carácter.
 *
 * `leverage` nunca se fue porque no es una edición: es configuración de la
 * cuenta que se deja puesta **antes** de operar, y no viaja en ninguna orden.
 */
export type PlanKind =
  | 'open'
  | 'close'
  | 'tp'
  | 'tp-remove'
  | 'margin-add'
  | 'margin-remove'
  | 'leverage';

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
/**
 * Lo que impide enviar el plan entero.
 *
 * Ni descarte ni aviso: un descarte deja fuera una casilla y las demás salen,
 * un aviso no frena nada. Esto cierra la puerta del lote completo, y la
 * confirmación lo enseña en lugar de pedir la contraseña.
 */
export interface PlanBlocker {
  code: string;
  message: string;
  /** Cuántas casillas lo provocan. Están nombradas en `discards`. */
  boxes: number;
}

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
  /**
   * Lo que impide enviarlo, o `null`.
   *
   * Es obligatorio y no opcional a propósito: un plan que se construye sin
   * pensar en esto se envía, y el olvido no se ve en ninguna prueba. Quien
   * arma un `BatchPlan` tiene que decir explícitamente que no hay impedimento.
   */
  blocker: PlanBlocker | null;
}

export interface OpenRequest {
  targets: BatchTarget[];
  assetId: string;
  orderType: OrderType;
  limitPrice: Decimal | null;
  initialMargin: Decimal;
  leverage: number;
  /**
   * Modo de margen con el que se abre.
   *
   * Lo elige el operador y viaja con la orden. Antes salía de la ficha de la
   * cuenta, que guardaba el modo de **un solo símbolo** y lo aplicaba a todos:
   * como Bitget lo configura por símbolo y lo lee de la propia orden, abrir
   * reconfiguraba en silencio el activo que se estaba operando.
   */
  marginMode: MarginMode;
  /**
   * Margen adicional que se agrega con la **misma** confirmación, o `null`.
   *
   * Va con la apertura por lo mismo que el Take Profit: se escribe en el mismo
   * formulario y en la misma pulsación. Y en margen cruzado no se abre nada —
   * Bitget solo admite agregar margen en aislado, y abrir sin el margen que se
   * aprobó deja la posición con menos colchón del que el operador cree.
   */
  additionalMargin: Decimal | null;
  /**
   * Take Profit que se coloca con la **misma** confirmación, en porcentaje de
   * ganancia sobre el margen inicial. `null` para abrir sin él.
   *
   * Antes era una operación aparte con su propio botón y su propia
   * confirmación, y el porcentaje escrito en el formulario se enseñaba junto a
   * la apertura como si saliera con ella. No salía: quedaban posiciones
   * abiertas sin protección creyendo que la tenían.
   */
  takeProfitPercent: Decimal | null;
}

export interface CloseRequest {
  targets: BatchTarget[];
  assetId: string;
}

/**
 * Poner Take Profit sobre posiciones **ya abiertas**.
 *
 * Distinto de `OpenRequest.takeProfitPercent`, que sale con la orden. Este
 * sustituye el que la posición tuviera puesto; ver `PlanKind`.
 */
export interface TpRequest {
  targets: BatchTarget[];
  assetId: string;
  /** Ganancia sobre el margen inicial, en porcentaje. */
  percent: Decimal;
}

/**
 * Mover margen en posiciones **ya abiertas**: agregarlo o retirarlo.
 *
 * `amount` es siempre positivo y `direction` dice hacia dónde va. El signo lo
 * pone el proceso principal, nunca lo que se teclea. Ver `PlanKind`.
 */
export interface MarginRequest {
  targets: BatchTarget[];
  assetId: string;
  amount: Decimal;
  direction: 'agregar' | 'quitar';
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
  /** Cuenta principal: una de las quince del panel, de la `A` a la `O`. */
  accountName: string;
  /** Casilla de esa cuenta principal, de 1 a 20. La elige el operador. */
  slot: number;
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

/**
 * Desenlace de una baja de API key.
 *
 * La baja pide la contraseña de paso —la misma de abrir y cerrar—, así que «no
 * se borró» tiene dos motivos que la pantalla trata distinto: `paso-incorrecto`
 * se puede reintentar y `no-estaba` no. Ver `ResultadoBaja` en el contrato de
 * IPC, que es la misma respuesta al otro lado de la frontera.
 */
export type DeleteOutcome = 'borrada' | 'paso-incorrecto' | 'no-estaba';

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
  /**
   * Mercado contra el que opera este binario, leído de `config.json`.
   *
   * La pantalla lo enseña siempre. Un mismo ejecutable sirve para los dos
   * mercados —lo decide un archivo en la carpeta de datos, no la compilación—,
   * así que sin este distintivo no hay forma de saber si la próxima orden mueve
   * dinero de verdad, ni de comprobar que el `config.json` entregado se copió
   * donde debía.
   */
  market: 'real' | 'simulado';
}
