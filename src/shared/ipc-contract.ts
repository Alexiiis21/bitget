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
import type {
  AccountMode,
  Decimal,
  EstadoConexion,
  Lado,
  Lote,
  PosicionMonitor
} from './types';

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

/**
 * Resultado de traer las credenciales de una instalacion anterior.
 *
 * `cancelado` no es un fallo: el operador cerro el selector de carpeta. Se
 * distingue para que la pantalla no enseñe un error donde no lo hubo.
 */
export interface ResultadoImportacionIpc {
  cancelado: boolean;
  ok: boolean;
  motivo: string | null;
  mensaje: string;
  /** Cuantas subcuentas traia el registro importado, si venia. */
  cuentas: number | null;
}

/**
 * Un respaldo `.pcbak` encontrado en la carpeta de Documentos.
 *
 * Es solo para enseñarlo: **la ruta del archivo no sale del proceso principal**.
 * El renderer no puede señalar que restaurar, solo pedir que se restaure el que
 * se le ha enseñado. Mismo criterio que `credenciales:importar`.
 */
export interface RespaldoDisponibleIpc {
  nombre: string;
  /** Carpeta que lo contiene, para el texto de ayuda de la pantalla. */
  carpeta: string;
  creadoEn: string;
  appVersion: string;
  cuentas: number | null;
  mercado: 'real' | 'simulado' | null;
  /** Numero del panel que lo creo. Se enseña; nunca se restaura. */
  panelOrigen: number | null;
  /** Lo hizo una version mas nueva del panel: se enseña, no se ofrece restaurar. */
  demasiadoNuevo: boolean;
}

export interface ResultadoRespaldoIpc {
  ok: boolean;
  motivo: string | null;
  mensaje: string;
  nombre: string | null;
  carpeta: string | null;
  cuentas: number | null;
}

/**
 * Resultado de restaurar un respaldo.
 *
 * `cancelado` solo lo puede traer `respaldo:restaurar-archivo`, que abre un
 * selector; el automatico nunca cancela. Por eso son dos canales y no uno con
 * una bandera: un campo que significa algo «a veces» se lee mal seis meses
 * despues.
 */
export interface ResultadoRestauracionIpc {
  cancelado: boolean;
  ok: boolean;
  motivo: string | null;
  mensaje: string;
  cuentas: number | null;
  /** Habia almacen y se aparto. La pantalla lo dice y nombra el archivo. */
  reemplazo: string | null;
}

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
  /**
   * Con que API habla la subcuenta: `classic` (V2) o `uta` (V3).
   *
   * Va a la pantalla porque una subcuenta que se actualiza a UTA deja de
   * responder a la API clasica **sin avisar a nadie**, y sin este dato el
   * operador solo veria una fila caida sin motivo aparente. Es el unico sitio
   * del panel donde la diferencia entre las dos superficies se hace visible; en
   * todo lo demas se operan igual.
   */
  accountMode: AccountMode;
  /** `true` mientras Bitget declara la cuenta a mitad del cambio a UTA. */
  enTransicion: boolean;
  altaEn: string;
}

/** Datos del formulario de alta. Es el unico payload con secretos, y va en un solo sentido. */
export interface AltaCuenta {
  etiqueta: string;
  /** Cuenta principal, de la `A` a la `O`. La lista es fija: `NOMBRES_CUENTA_MADRE`. */
  grupoNombre: string;
  /**
   * Casilla de esa cuenta principal, de 1 a `SUBCUENTAS_POR_GRUPO`.
   *
   * La elige el operador en el formulario desde el 28/08/2026. Antes se
   * asignaba sola -la primera libre-, y no habia forma de decir «esta subcuenta
   * va en la 7», que es como el operador tiene organizada su rejilla y lo que
   * tiene memorizado al operar.
   *
   * Opcional en el tipo y **obligatoria en el canal**: el esquema de
   * `cuentas:agregar` la exige, asi que del panel no puede salir un alta sin
   * ella. Lo que puede omitirla es quien llama a `Sesion.agregar` por dentro
   * -la importacion masiva de subcuentas-, y entonces vuelve el reparto
   * automatico. Sin esa puerta, importar cien subcuentas obligaria a inventar
   * una casilla para cada una.
   */
  casilla?: number;
  apiKey: string;
  secretKey: string;
  passphrase: string;
}

export interface AvisoCredencial {
  codigo: string;
  mensaje: string;
}

/**
 * Desenlace de una baja de credencial.
 *
 * --------------------------------------------------------------------------
 * Por que no es un `boolean`
 * --------------------------------------------------------------------------
 * Desde el 31/08/2026 la baja exige la contrasena de paso -la misma de abrir y
 * cerrar-, y entonces «no se borro» tiene dos motivos que la pantalla tiene que
 * distinguir: la clave estaba mal -y el operador puede volver a intentarlo- o
 * esa ficha ya no estaba en el registro -y no hay nada que reintentar-. Un
 * `false` para los dos casos obligaria a adivinar cual fue, y adivinar aqui es
 * decirle a alguien que su subcuenta sigue dada de alta cuando no lo esta.
 */
export type ResultadoBaja = 'borrada' | 'paso-incorrecto' | 'no-estaba';

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

/* ---------- cuentas madre y traspasos ---------- */

/**
 * Alta de la credencial de una cuenta principal.
 *
 * No lleva `uid`: lo dice Bitget al verificarla, igual que en el alta de una
 * subcuenta. Pedirselo al operador seria pedirle un dato que puede equivocar y
 * que ya esta disponible.
 */
export interface AltaMadre {
  etiqueta: string;
  apiKey: string;
  secretKey: string;
  passphrase: string;
}

/** Una cuenta principal registrada. Nunca lleva secretos. */
export interface MadreIpc {
  id: string;
  uidMadre: string;
  etiqueta: string;
  apiKeyEnmascarada: string;
  altaEn: string;
  /**
   * Subcuentas que Bitget reporto al darla de alta.
   *
   * `null` cuando no se ha vuelto a comprobar -al listar, sin gastar una
   * peticion-. Cero al alta es la senal de que la clave no es de la madre que
   * el operador cree.
   */
  subcuentasVistas: number | null;
}

export interface ResultadoAltaMadre {
  ok: boolean;
  motivo: string | null;
  advertencias: AvisoCredencial[];
  madre: MadreIpc | null;
}

/** Una subcuenta en la pantalla de saldos. */
export interface FilaSaldoIpc {
  uid: string;
  cuentaId: string | null;
  etiqueta: string;
  /** `null` significa «no se sabe», nunca «cero». */
  disponible: Decimal | null;
  /** Lo que de verdad puede salir: el saldo menos lo comprometido en posiciones. */
  maxTransferible: Decimal | null;
  equity: Decimal | null;
  /** La reporta Bitget, pero no esta dada de alta en el panel. */
  soloEnBitget: boolean;
  /** Esta en el panel, pero la madre no la reporto. */
  sinDatos: boolean;
}

/** Lo que la pantalla de saldos necesita para pintarse entera. */
export interface SaldosPantalla {
  uidMadre: string;
  etiquetaMadre: string;
  /**
   * Saldo de futuros de la **propia cuenta principal**, o `null` si no se pudo leer.
   *
   * No sale de `sub-account-assets` -ahi la madre no se reporta a si misma- sino
   * de `mix/account/accounts` firmado con su propia credencial. Es una peticion
   * mas por refresco, y la paga con creces: es la cuenta desde la que se reparte,
   * y sin este dato era la unica de la pantalla sin cifra.
   */
  disponibleMadre: Decimal | null;
  moneda: string;
  /** Cuando se leyo. La pantalla lo enseña: un saldo sin hora es un saldo que miente. */
  obtenidoEn: string;
  filas: FilaSaldoIpc[];
  totalDisponible: Decimal;
  totalTransferible: Decimal;
  conDatos: number;
}

/* ---------- traspaso entre subcuentas (Fase 3) ---------- */

/** Una punta del traspaso, tal como se enseña en la confirmación. */
export interface PuntaTraspasoIpc {
  uid: string;
  etiqueta: string;
  /** Saldo antes del movimiento. Vacío si no se conoce. */
  antes: Decimal;
  /** Cómo queda si sale bien. Vacío si no se conoce el de partida. */
  despues: Decimal;
}

/**
 * Un traspaso calculado y pendiente de aprobar. **Todavía no se ha enviado.**
 *
 * Es lo que el operador ve antes de decidir: origen, destino, importe y cómo
 * quedan los dos saldos. El renderer devuelve solo el `id`, nunca los números:
 * si los devolviera, la pantalla podría enviar un importe distinto del que se
 * aprobó.
 */
export interface PlanTraspasoIpc {
  id: string;
  uidMadre: string;
  origen: PuntaTraspasoIpc;
  destino: PuntaTraspasoIpc;
  importe: Decimal;
  moneda: string;
  /** Lo máximo que Bitget deja salir del origen ahora mismo. */
  maxTransferible: Decimal;
  clientOid: string;
  creadoEn: string;
}

/**
 * Por que no salio un traspaso.
 *
 * `indeterminado` no es un fallo: se envio y Bitget no confirmo si entro. La
 * diferencia manda en lo que puede hacer el operador -ante un rechazo puede
 * repetir; ante esto tiene que comprobar el saldo antes, porque un plan nuevo
 * lleva un `clientOid` nuevo y reenviarlo moveria el dinero dos veces-.
 */
export type MotivoFalloTraspaso =
  'paso-incorrecto' | 'sin-credencial' | 'rechazado' | 'indeterminado';

export interface ResultadoTraspaso {
  ok: boolean;
  motivo: MotivoFalloTraspaso | null;
  /** Texto en castellano cuando el exchange lo rechaza. */
  mensaje: string | null;
  /** Identificador del movimiento en Bitget. Lo único con lo que reclamar. */
  transferId: string | null;
  plan: PlanTraspasoIpc;
}

/** Un traspaso del historial, tal como quedó registrado. */
export interface MovimientoTraspasoIpc {
  clientOid: string;
  ts: string;
  uidOrigen: string;
  etiquetaOrigen: string;
  uidDestino: string;
  etiquetaDestino: string;
  importe: Decimal;
  moneda: string;
  /**
   * `pendiente` es el estado importante: se envió y no se supo el desenlace.
   * No es un fallo —el dinero pudo salir— y por eso nunca se reintenta solo.
   */
  resultado: 'exito' | 'fallo' | 'pendiente';
  transferId: string | null;
  mensaje: string | null;
  resueltoEn: string | null;
}

/* ---------- reparto y recogida masiva (Fase 4) ---------- */

export type ModoRepartoIpc = 'iguales' | 'igualar';

/** Un traspaso de la lista, ya calculado y pendiente de aprobar. */
export interface MovimientoRepartoIpc {
  uidOrigen: string;
  etiquetaOrigen: string;
  uidDestino: string;
  etiquetaDestino: string;
  importe: Decimal;
  /** Saldo de la subcuenta antes y después. La madre no lleva estos dos. */
  antes: Decimal;
  despues: Decimal;
}

/** Una subcuenta que se queda fuera, y por qué. Se enseña: no desaparece. */
export interface DescarteRepartoIpc {
  uid: string;
  etiqueta: string;
  motivo: string;
  mensaje: string;
}

/**
 * Un reparto o una recogida, calculados y **sin enviar**.
 *
 * `total` es la suma exacta de los importes de `movimientos`, no lo que el
 * operador escribió: si alguna subcuenta se descarta, el total que se enseña es
 * el que de verdad va a moverse.
 */
export interface PlanRepartoIpc {
  id: string;
  uidMadre: string;
  tipo: 'reparto' | 'recogida';
  modo: ModoRepartoIpc | null;
  moneda: string;
  total: Decimal;
  movimientos: MovimientoRepartoIpc[];
  descartes: DescarteRepartoIpc[];
  creadoEn: string;
}

/** Cómo fue cada uno de los traspasos del lote. */
export interface ResultadoMovimientoIpc {
  clientOid: string;
  etiquetaOrigen: string;
  etiquetaDestino: string;
  importe: Decimal;
  ok: boolean;
  mensaje: string | null;
}

export interface ResultadoReparto {
  /** `true` solo si **todos** salieron. Con uno fallido, es `false`. */
  ok: boolean;
  motivo: 'paso-incorrecto' | 'sin-credencial' | null;
  plan: PlanRepartoIpc;
  resultados: ResultadoMovimientoIpc[];
  enviados: number;
  fallidos: number;
  /** Enviados sin confirmacion. Se cuentan aparte: no son fallos. */
  indeterminados: number;
}

/* ---------- apertura de operaciones ---------- */

export type ClaveMercadoIpc = 'real' | 'simulado';

/**
 * Modo de margen con el que se abre, tal como lo nombra la API de Bitget.
 *
 * En Bitget es un ajuste **por simbolo**, no por cuenta, y viaja dentro de la
 * propia orden: abrir con un modo lo deja configurado en ese activo. Por eso lo
 * elige el operador en el panel en vez de deducirse de la cuenta —deducirlo de
 * un simbolo y aplicarlo a otro reconfiguraba activos en silencio—.
 */
export type ModoMargenIpc = 'isolated' | 'crossed';

/** Lo que la pantalla pide abrir. El precio y la cantidad los pone el proceso principal. */
export interface PeticionAperturaIpc {
  simbolo: string;
  objetivos: { cuentaId: string; lado: Lado }[];
  /** Margen por casilla seleccionada, en moneda de margen. */
  margenInicial: string;
  apalancamiento: number;
  /** `null` para orden a mercado. */
  precioLimite: string | null;
  /** Aislado o cruzado. Se comprueba y, si hace falta, se fija antes de abrir. */
  modoMargen: ModoMargenIpc;
  /**
   * Margen adicional que se agrega con la **misma** confirmacion, o `null`.
   *
   * Bitget solo admite agregarlo en aislado, asi que pedirlo en cruzado no abre
   * nada: el plan entero se rechaza con el motivo, antes de enviar una orden.
   */
  margenAdicional: string | null;
  /**
   * Take Profit que se coloca con la **misma** confirmacion, en porcentaje de
   * ganancia sobre el margen inicial. `null` para abrir sin el.
   *
   * El precio de disparo no viaja: lo calcula el proceso principal, y dos
   * veces. Una con el precio de referencia, para que la confirmacion pueda
   * enseñarlo antes de abrir; y otra con el precio de entrada real, ya abierta
   * la posicion, que es la que se envia.
   */
  takeProfitPorcentaje: string | null;
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
  /**
   * Precio de disparo del Take Profit que se pondra al abrir, **estimado**.
   *
   * `null` cuando se abre sin Take Profit. Sale del precio de referencia porque
   * al confirmar la posicion todavia no existe; el que se envia se calcula
   * despues, con el precio de entrada real. Se enseña igualmente porque el
   * operador aprueba precios concretos, no porcentajes.
   */
  precioDisparoTp: string | null;
  /**
   * Modo de margen que **tiene ahora** ese activo en esa cuenta.
   *
   * Se enseña cuando no coincide con el elegido, porque entonces la apertura lo
   * va a cambiar en Bitget: «cruzado → aislado» es un efecto de la operacion, y
   * un efecto que no se enseña es un efecto que el operador no aprobo.
   */
  modoMargenActual: ModoMargenIpc;
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

/** Lo que impide enviar un plan entero. Ver `ImpedimentoPlan` en el motor. */
export interface ImpedimentoPlanIpc {
  codigo: string;
  mensaje: string;
  /** Cuantas casillas lo provocan. Las nombra la lista de descartes. */
  casillas: number;
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
  /** Modo de margen aprobado para esta apertura. */
  modoMargen: ModoMargenIpc;
  /** Margen adicional que sale con esta misma orden, o `null`. */
  margenAdicional: string | null;
  /** Suma del margen adicional de todas las entradas. Sale del saldo igual que el inicial. */
  margenAdicionalTotal: string;
  /** Porcentaje del Take Profit que sale con esta misma orden, o `null`. */
  takeProfitPorcentaje: string | null;
  entradas: EntradaPlanIpc[];
  descartes: DescartePlanIpc[];
  avisos: AvisoPlanIpc[];
  /**
   * Lo que impide enviar el lote entero, o `null`.
   *
   * No es un descarte -esos son por casilla- ni un aviso -esos no frenan-. Es
   * la puerta cerrada: mientras venga con valor, la confirmacion enseña el
   * motivo y no deja llegar a la contraseña. Quien lo hace cumplir de verdad es
   * el proceso principal, que rechaza el plan al ejecutarlo.
   */
  impedimento: ImpedimentoPlanIpc | null;
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

/* ---------- ajustes sobre una posicion ya abierta ---------- */

/**
 * Poner Take Profit sobre lo que ya esta abierto.
 *
 * Distinto del que viaja en `PeticionAperturaIpc`: aquel sale **con** la orden y
 * este se aplica **despues**, sobre una posicion que ya existe. Son dos campos
 * distintos en la pantalla por eso mismo -ver `PlanKind`-, y este siempre
 * sustituye lo que hubiera puesto en vez de anadirse a ello.
 */
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
  /**
   * El Take Profit que la posicion tiene puesto ahora, o `null` si no tiene.
   *
   * Viaja para que la confirmacion pueda decir «0,00263 → 0,00271» en vez de
   * solo el destino: poner Take Profit sobre una posicion que ya lo tiene
   * **sustituye** el anterior, y sustituir algo sin enseñar que se sustituye es
   * lo mismo que hacerlo a escondidas.
   */
  precioDisparoAnterior: string | null;
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

/** Hacia donde va el margen. Lo elige el operador con el boton, no con un signo. */
export type DireccionMargenIpc = 'agregar' | 'quitar';

export interface PeticionMargenIpc {
  simbolo: string;
  objetivos: { cuentaId: string; lado: Lado }[];
  /** Margen a mover en cada casilla, en moneda de margen. **Siempre positivo.** */
  cantidad: string;
  direccion: DireccionMargenIpc;
}

export interface EntradaMargenIpc {
  cuentaId: string;
  etiqueta: string;
  lado: Lado;
  /** La cifra tecleada, sin signo. El sentido lo da `direccion` del plan. */
  cantidad: string;
  /** Margen que la posicion tiene ahora, leido de Bitget al planificar. */
  margenActual: string;
  /** El que tendra si el envio sale bien. Es lo que el operador aprueba. */
  margenResultante: string;
}

export interface PlanMargenIpc {
  id: string;
  mercado: ClaveMercadoIpc;
  /** Moneda de `cantidad`, `margenActual`, `margenResultante` y el total. Ver `PlanAperturaIpc`. */
  monedaMargen: string;
  simbolo: string;
  cantidad: string;
  direccion: DireccionMargenIpc;
  /** Suma de lo que se mueve, sin signo: sale del saldo, o vuelve a el. */
  totalComprometido: string;
  entradas: EntradaMargenIpc[];
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

/* ---------- apalancamiento ---------- */

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
  /**
   * El modo en que esta **este simbolo** en esta cuenta, leido al planificar.
   *
   * Se enseña por el mismo motivo que `modoMargenActual` en la apertura: para
   * un operador que trabaja en aislado, ver «cruzado» en una casilla es el
   * primer aviso de que ese activo no esta como cree.
   */
  modoMargen: ModoMargenIpc;
  /** El que tiene ahora, recien leido, o `null` si Bitget no lo informa. */
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

/* ---------- peticiones del renderer (invoke) ---------- */

export interface PeticionesIpc {
  'sistema:info': () => Promise<InfoSistema>;
  'sistema:estado': () => Promise<EstadoApp>;
  /**
   * Cambia el numero visible de este panel y lo guarda en `instancia.json`.
   *
   * Existe desde el 28/08/2026. Antes el campo de la cabecera se dejaba
   * teclear, el cambio se veia en pantalla y al reiniciar volvia el anterior:
   * no habia canal que lo persistiera, y un rotulo que no recuerda hace creer
   * al operador que esta en un panel que no es.
   */
  'sistema:numero-panel': (numero: number) => Promise<void>;
  /**
   * Trae las credenciales de una carpeta de datos anterior.
   *
   * Sin parametros a proposito: el selector de carpeta lo abre el proceso
   * principal, asi que el renderer no puede señalar una ruta. Ver el manejador.
   */
  'credenciales:importar': () => Promise<ResultadoImportacionIpc>;
  /**
   * Guarda todas las credenciales en un `.pcbak` dentro de Documentos.
   *
   * No descifra nada: copia el almacen cifrado tal cual. Por eso no pide la
   * contrasena maestra y por eso funciona con el panel bloqueado.
   */
  'respaldo:crear': () => Promise<ResultadoRespaldoIpc>;
  /** El respaldo que se ofrecera restaurar, o `null` si no hay ninguno. */
  'respaldo:buscar': () => Promise<RespaldoDisponibleIpc | null>;
  'respaldo:abrir-carpeta': () => Promise<void>;
  /**
   * Restaura el respaldo detectado en Documentos.
   *
   * **Exige el panel bloqueado.** Con el almacen abierto en memoria, la
   * siguiente escritura del vault volcaria el contenido viejo sobre el archivo
   * recien restaurado y la restauracion se perderia en silencio.
   *
   * La maestra solo hace falta si ya hay un almacen que reemplazar: es lo que
   * demuestra que el almacen que se va a apartar es de quien lo aparta. En un
   * panel recien estrenado no hay nada que destruir y no se pide.
   */
  'respaldo:restaurar': (contrasenaMaestra?: string) => Promise<ResultadoRestauracionIpc>;
  /** Igual, pero el archivo lo elige el operador en un selector del proceso principal. */
  'respaldo:restaurar-archivo': (contrasenaMaestra?: string) => Promise<ResultadoRestauracionIpc>;
  'vault:estado': () => Promise<EstadoVault>;
  'vault:crear': (contrasena: string) => Promise<ResultadoVault>;
  'vault:abrir': (contrasena: string) => Promise<ResultadoVault>;
  'vault:cerrar': () => Promise<void>;
  /** Confirma la maestra sin dar acceso: solo para acciones sensibles. */
  'vault:comprobar': (contrasena: string) => Promise<boolean>;
  /**
   * Milisegundos que faltan para poder volver a probar la maestra. `0` si ya.
   *
   * Tras tres fallos seguidos el panel impone una espera que crece -3, 6, 12,
   * 24, 48 minutos y tope de una hora- y se borra al acertar. La cuenta la
   * lleva el proceso principal en disco: la pantalla solo la enseña, y no puede
   * levantarla recargandose ni cerrando el panel. Ver `security/freno-maestra.ts`.
   */
  'vault:espera': () => Promise<number>;
  'cuentas:listar': () => Promise<FilaCuenta[]>;
  'cuentas:agregar': (alta: AltaCuenta) => Promise<ResultadoAlta>;
  /**
   * Baja de una subcuenta. **Exige la contrasena de paso**, como abrir y cerrar.
   *
   * La clave viaja con la peticion y la comprueba el proceso principal, no la
   * pantalla: un freno que solo vive en el renderer es un freno que un fallo de
   * la pagina se salta, y lo que esta baja borra -la credencial cifrada- no se
   * recupera desde el panel. Ver `Sesion.eliminar`.
   */
  'cuentas:eliminar': (cuentaId: string, contrasenaPaso: string) => Promise<ResultadoBaja>;
  'cuentas:verificar': (cuentaId: string) => Promise<ResultadoPrueba>;
  /** La matriz de seleccion: cuentas principales, casillas y saldo. */
  'panel:cuentas': () => Promise<CuentaPanel[]>;
  /**
   * Las ocho casillas del selector, en su orden y con sus huecos.
   *
   * `null` es una casilla vacia. No se compactan: el operador las edita por su
   * numero, y una lista sin huecos las renumeraria al vaciar una.
   */
  'mercado:ranuras': () => Promise<(ActivoIpc | null)[]>;
  /**
   * Todo lo que el mercado ofrece. **Solo para el buscador.**
   *
   * Nada de esta lista se puede operar mientras no ocupe una de las ocho
   * casillas: quien decide eso es `mercado:ranuras`, y el proceso principal
   * comprueba el simbolo contra este mismo catalogo antes de guardarlo.
   */
  'mercado:catalogo': () => Promise<ActivoIpc[]>;
  /** Pone un activo en una casilla, o la vacia con `null`. Devuelve las ocho. */
  'mercado:fijar-ranura': (indice: number, simbolo: string | null) => Promise<(ActivoIpc | null)[]>;
  /** Precio de marca de cada activo, el mismo con el que se dimensiona. */
  'mercado:precios': () => Promise<Record<string, string>>;
  /** ¿Hay contrasena de paso configurada? */
  'paso:hay': () => Promise<boolean>;
  'paso:comprobar': (contrasena: string) => Promise<boolean>;
  'paso:fijar': (contrasena: string) => Promise<void>;
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
  /*
   * Los cuatro canales de ajuste sobre una posicion ya abierta.
   *
   * Estuvieron retirados entre el 26/08/2026 y el 01/09/2026: mientras
   * existieron la primera vez, la misma cantidad se podia enviar dos veces sobre
   * la misma posicion -una con la apertura, que ya la lleva dentro, y otra por
   * el canal suelto-, y `set-margin` no lleva identificador que lo impida.
   *
   * Vuelven porque el cliente necesita corregir lo que ya esta abierto, y con lo
   * que faltaba entonces: el Take Profit **sustituye** el que hubiera en vez de
   * anadirse, el margen enseña `actual → resultante` leido de Bitget antes de
   * confirmar, y en la pantalla los importes de la apertura y los del ajuste son
   * campos distintos. Ver `PlanKind` y `Sesion.planificarMargen`.
   */
  /** Calcula a que precio queda el Take Profit de cada posicion. No coloca nada. */
  'tp:planificar': (peticion: PeticionTakeProfitIpc) => Promise<PlanTakeProfitIpc>;
  'tp:ejecutar': (planId: string, soloEstos?: { cuentaId: string; lado: Lado }[]) => Promise<Lote>;
  /** Calcula como queda el margen de cada posicion. No mueve nada. */
  'margen:planificar': (peticion: PeticionMargenIpc) => Promise<PlanMargenIpc>;
  'margen:ejecutar': (
    planId: string,
    soloEstos?: { cuentaId: string; lado: Lado }[]
  ) => Promise<Lote>;
  /** Averigua que Take Profit hay puesto en cada casilla. No quita nada. */
  'tp:planificar-quitar': (peticion: PeticionQuitarTpIpc) => Promise<PlanQuitarTpIpc>;
  'tp:ejecutar-quitar': (
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
  /**
   * Las posiciones vivas ahora mismo, para pintar el monitor al desbloquear.
   *
   * El evento `monitor:posiciones` mantiene la pantalla al dia despues; esto
   * solo evita el hueco entre que se abre el panel y llega el primer empujon.
   */
  'monitor:instantanea': () => Promise<PosicionMonitor[]>;

  /*
   * Traspasos entre subcuentas. Fase 2: solo lectura.
   *
   * `saldos:leer` es la unica de las tres que sale a Bitget, y gasta una
   * peticion de un cupo de 1 cada 10 s por UID: se llama al abrir la pantalla y
   * al refrescar a mano, nunca en un intervalo.
   */
  'madres:listar': () => Promise<MadreIpc[]>;
  'madres:agregar': (alta: AltaMadre) => Promise<ResultadoAltaMadre>;
  'madres:eliminar': (uidMadre: string, contrasenaPaso: string) => Promise<ResultadoBaja>;
  'saldos:leer': (uidMadre?: string) => Promise<SaldosPantalla>;

  /*
   * Traspaso, Fase 3. Aqui se mueve dinero.
   *
   * En dos pasos, como las seis operaciones: `planificar` calcula y no envia
   * nada, `ejecutar` envia lo ya aprobado identificandolo por su `id`. La
   * pantalla nunca manda importes al ejecutar -solo el id-, de modo que no
   * puede enviarse algo distinto de lo que se aprobo.
   */
  'traspaso:planificar': (peticion: {
    uidOrigen: string;
    uidDestino: string;
    importe: string;
    uidMadre?: string;
  }) => Promise<PlanTraspasoIpc>;
  /** Exige la contrasena de paso, como la apertura de posiciones. */
  'traspaso:ejecutar': (planId: string, contrasenaPaso: string) => Promise<ResultadoTraspaso>;
  'traspaso:historial': (limite?: number) => Promise<MovimientoTraspasoIpc[]>;

  /*
   * Reparto y recogida masiva. Mismo esquema de dos pasos: planificar no envia
   * nada y ejecutar manda la lista entera, uno detras de otro.
   */
  'reparto:planificar': (peticion: {
    destinos: string[];
    total: string;
    modo: ModoRepartoIpc;
    uidMadre?: string;
  }) => Promise<PlanRepartoIpc>;
  'recogida:planificar': (peticion: {
    origenes: string[];
    uidMadre?: string;
  }) => Promise<PlanRepartoIpc>;
  /** Exige la contrasena de paso, como todo lo que mueve dinero. */
  'reparto:ejecutar': (planId: string, contrasenaPaso: string) => Promise<ResultadoReparto>;
}

export type CanalPeticion = keyof PeticionesIpc;

/* ---------- avisos del proceso principal (push) ---------- */

export interface EventosIpc {
  /**
   * Todas las posiciones vivas, coalescidas a PUBLICACION_COALESCIDA_MS.
   *
   * Se envia el conjunto completo y no las diferencias, por lo mismo que
   * `panel:cuentas`: son unos cientos de puntas como mucho, y mantener
   * sincronizados dos modelos que pueden separarse en silencio cuesta mas que
   * recalcularlo. Una posicion que desaparece de la lista es una posicion
   * cerrada, y su fila desaparece sin mensaje.
   */
  'monitor:posiciones': PosicionMonitor[];
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
  sistemaFijarNumeroPanel(numero: number): Promise<void>;
  credencialesImportar(): Promise<ResultadoImportacionIpc>;
  respaldoCrear(): Promise<ResultadoRespaldoIpc>;
  respaldoBuscar(): Promise<RespaldoDisponibleIpc | null>;
  respaldoAbrirCarpeta(): Promise<void>;
  respaldoRestaurar(contrasenaMaestra?: string): Promise<ResultadoRestauracionIpc>;
  respaldoRestaurarArchivo(contrasenaMaestra?: string): Promise<ResultadoRestauracionIpc>;
  vaultEstado(): Promise<EstadoVault>;
  vaultCrear(contrasena: string): Promise<ResultadoVault>;
  vaultAbrir(contrasena: string): Promise<ResultadoVault>;
  vaultCerrar(): Promise<void>;
  vaultComprobar(contrasena: string): Promise<boolean>;
  /** Milisegundos que faltan para poder volver a probar la maestra. `0` si ya. */
  vaultEspera(): Promise<number>;
  cuentasListar(): Promise<FilaCuenta[]>;
  cuentasAgregar(alta: AltaCuenta): Promise<ResultadoAlta>;
  cuentasEliminar(cuentaId: string, contrasenaPaso: string): Promise<ResultadoBaja>;
  cuentasVerificar(cuentaId: string): Promise<ResultadoPrueba>;
  panelCuentas(): Promise<CuentaPanel[]>;
  mercadoRanuras(): Promise<(ActivoIpc | null)[]>;
  mercadoCatalogo(): Promise<ActivoIpc[]>;
  mercadoFijarRanura(indice: number, simbolo: string | null): Promise<(ActivoIpc | null)[]>;
  mercadoPrecios(): Promise<Record<string, string>>;
  pasoHay(): Promise<boolean>;
  pasoComprobar(contrasena: string): Promise<boolean>;
  pasoFijar(contrasena: string): Promise<void>;
  aperturaPlanificar(peticion: PeticionAperturaIpc): Promise<PlanAperturaIpc>;
  aperturaEjecutar(planId: string, soloEstos?: { cuentaId: string; lado: Lado }[]): Promise<Lote>;
  cierrePlanificar(peticion: PeticionCierreIpc): Promise<PlanCierreIpc>;
  cierreEjecutar(planId: string, soloEstos?: { cuentaId: string; lado: Lado }[]): Promise<Lote>;
  tpPlanificar(peticion: PeticionTakeProfitIpc): Promise<PlanTakeProfitIpc>;
  tpEjecutar(planId: string, soloEstos?: { cuentaId: string; lado: Lado }[]): Promise<Lote>;
  tpPlanificarQuitar(peticion: PeticionQuitarTpIpc): Promise<PlanQuitarTpIpc>;
  tpEjecutarQuitar(planId: string, soloEstos?: { cuentaId: string; lado: Lado }[]): Promise<Lote>;
  margenPlanificar(peticion: PeticionMargenIpc): Promise<PlanMargenIpc>;
  margenEjecutar(planId: string, soloEstos?: { cuentaId: string; lado: Lado }[]): Promise<Lote>;
  apalancamientoPlanificar(peticion: PeticionApalancamientoIpc): Promise<PlanApalancamientoIpc>;
  apalancamientoEjecutar(
    planId: string,
    soloEstos?: { cuentaId: string; lado: Lado }[]
  ): Promise<Lote>;
  monitorInstantanea(): Promise<PosicionMonitor[]>;
  madresListar(): Promise<MadreIpc[]>;
  madresAgregar(alta: AltaMadre): Promise<ResultadoAltaMadre>;
  madresEliminar(uidMadre: string, contrasenaPaso: string): Promise<ResultadoBaja>;
  saldosLeer(uidMadre?: string): Promise<SaldosPantalla>;
  traspasoPlanificar(peticion: {
    uidOrigen: string;
    uidDestino: string;
    importe: string;
    uidMadre?: string;
  }): Promise<PlanTraspasoIpc>;
  traspasoEjecutar(planId: string, contrasenaPaso: string): Promise<ResultadoTraspaso>;
  traspasoHistorial(limite?: number): Promise<MovimientoTraspasoIpc[]>;
  repartoPlanificar(peticion: {
    destinos: string[];
    total: string;
    modo: ModoRepartoIpc;
    uidMadre?: string;
  }): Promise<PlanRepartoIpc>;
  recogidaPlanificar(peticion: { origenes: string[]; uidMadre?: string }): Promise<PlanRepartoIpc>;
  repartoEjecutar(planId: string, contrasenaPaso: string): Promise<ResultadoReparto>;
  /** Devuelve la funcion para cancelar la suscripcion. */
  suscribir<C extends CanalEvento>(canal: C, cb: (dato: EventosIpc[C]) => void): () => void;
}
