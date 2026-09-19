/**
 * Limites, intervalos y umbrales del sistema.
 *
 * Todo numero magico del proyecto vive aqui, con la referencia al documento que
 * lo justifica. Si un valor no tiene justificacion escrita, no deberia existir.
 *
 * Y, cuando una regla **se deriva** de uno de estos valores y la necesitan los
 * dos procesos, la funcion que la aplica vive al lado del valor. Separarlas es
 * como se desincronizan: el orden de las cuentas principales estuvo escrito
 * solo en el renderer y la matriz -que lo resolvia por su cuenta- acabo
 * pintandolas en un orden distinto del de la pantalla de API Keys.
 */

/* ---------- Techos que impone Bitget ---------- */
/** Conexiones WebSocket concurrentes por IP. docs/01 seccion 1, Hallazgo 2. */
export const WS_MAX_POR_IP = 100;
/** Solicitudes de conexion WS por IP cada 5 minutos. */
export const WS_CONEXIONES_POR_5MIN = 300;
/** Ordenes por segundo y por UID. docs/01 seccion 9. */
export const REST_ORDENES_POR_SEGUNDO_UID = 10;
/** Techo global por IP, aproximado: ~6.000 req/min. */
export const REST_POR_SEGUNDO_IP = 100;
/** Recuperacion que impone Bitget tras un 429, si no manda `Retry-After`. */
export const PENALIZACION_429_MS = 5_000;

/* ---------- Presupuesto de peticiones, por debajo del techo ---------- */
/** Conservador frente a los ~100/s permitidos. docs/01 seccion 9. */
export const LIMITE_GLOBAL_POR_SEGUNDO = 40;
/** Conservador frente a los 10/s por UID. */
export const LIMITE_CUENTA_POR_SEGUNDO = 8;
/**
 * Rafaga permitida antes de aplicar la tasa sostenida.
 *
 * Es lo que hace que un lote sobre 100 cuentas arranque de golpe en lugar de
 * gotear: cada cuenta gasta su rafaga propia y el techo real lo pone el bucket
 * global.
 */
export const RAFAGA_GLOBAL = 40;
export const RAFAGA_CUENTA = 8;
/** Peticiones simultaneas en vuelo. docs/01 seccion 9. */
export const CONCURRENCIA_MAXIMA = 12;

/**
 * Endpoints con un techo **por debajo** del bucket por cuenta.
 *
 * ==========================================================================
 * Por que esta tabla es corta a proposito
 * ==========================================================================
 * V3 publica limites por endpoint y por UID: `place-order` 10/s,
 * `current-position` 20/s, `close-positions` 5/s. De los tres, solo el ultimo
 * cae por debajo de `LIMITE_CUENTA_POR_SEGUNDO` (8/s), asi que es el unico que
 * necesita un bucket propio; los otros dos ya estan protegidos por el bucket de
 * cuenta y anadirlos solo gastaria memoria y confundiria el diagnostico.
 *
 * --------------------------------------------------------------------------
 * Lo que NO se hace: un bucket por superficie
 * --------------------------------------------------------------------------
 * Seria el error caro. El techo de Bitget es **por UID**, no por superficie:
 * dar 8/s a V2 y otros 8/s a V3 pondria a un mismo UID en 16/s, por encima de
 * su limite de 10/s, y un 429 cuesta cinco minutos de bloqueo en mitad de una
 * operacion. Ademas no haria falta: una cuenta es Classic **o** UTA, nunca las
 * dos a la vez. docs/00-uta-fase-1-equivalencias.md seccion 6.3.
 */
export const LIMITES_POR_ENDPOINT: Readonly<Record<string, number>> = {
  '/api/v3/trade/close-positions': 5
};

/* ---------- Presupuesto propio, por debajo del techo ---------- */
/** 20 % de margen bajo el techo de 100. docs/01 seccion 8. */
export const WS_MAX_CONCURRENTES = 80;
/** Conexiones nuevas por segundo durante el arranque escalonado. */
export const WS_ARRANQUE_POR_SEGUNDO = 5;
/** Ping de aplicacion. El servidor corta a los 120 s; 20 da seis oportunidades. */
export const WS_PING_MS = 20_000;
export const WS_PONG_TIMEOUT_MS = 10_000;
/**
 * Solicitudes de conexion que el panel se permite por ventana de 5 minutos.
 *
 * 20 % por debajo del techo de `WS_CONEXIONES_POR_5MIN`, como el resto de los
 * presupuestos propios. Es el que protege del caso peor: un corte de red que
 * tira los 80 sockets a la vez y los devuelve todos con backoff. Con el margen,
 * dos oleadas completas caben sin rozar el limite de la IP.
 */
export const WS_PRESUPUESTO_CONEXIONES = 240;
/**
 * Cada cuanto revisa el pool si hay sockets que abrir, cerrar o reconectar.
 *
 * Un segundo es la resolucion con la que se aplica el arranque escalonado de
 * `WS_ARRANQUE_POR_SEGUNDO`, y el mismo razonamiento que `REINTENTO_TICK_MS`:
 * por debajo no se nota, y despertar una vez por segundo para recorrer cien
 * entradas no se nota en el proceso.
 */
export const WS_TICK_MS = 1_000;

/* ---------- Ritmos del panel ---------- */
/** Refresco del monitor. El contrato acota el rango a 2-5 s. */
export const MONITOR_REFRESCO_MS_MIN = 2_000;
export const MONITOR_REFRESCO_MS_MAX = 5_000;
export const MONITOR_REFRESCO_MS_DEFECTO = 3_000;
/** Coalescencia de eventos hacia el renderer, para no quemar la CPU. */
export const PUBLICACION_COALESCIDA_MS = 250;
/** Cotejo REST contra el estado en memoria. docs/01 seccion 8. */
export const RECONCILIACION_MS = 45_000;
/**
 * Dispersion del barrido, arriba y abajo del intervalo.
 *
 * Sin el, las cien cuentas que se registran al desbloquear vencerian su
 * relectura siempre juntas y el barrido saldria a rafagas cada 45 segundos en
 * vez de gotear. Es el mismo motivo del jitter de reconexion, con una
 * proporcion menor: aqui no hay que evitar una tormenta contra una IP, solo
 * repartir un trabajo que se repite.
 */
export const RECONCILIACION_JITTER = 0.2;
/**
 * Resolucion con que se detecta que a una cuenta le toca relectura.
 *
 * No es el ritmo del barrido -ese lo fija `RECONCILIACION_MS` por cuenta-, sino
 * cada cuanto se mira quien vence. Mismo razonamiento que `REINTENTO_TICK_MS`.
 */
export const RECONCILIACION_TICK_MS = 1_000;
/**
 * Cuentas que se barren a la vez.
 *
 * Cien cuentas cada 45 segundos son ~2,2 barridos por segundo, y cada uno gasta
 * una peticion -dos si la cuenta tiene posiciones-. Con dos en vuelo sobra para
 * sostener ese ritmo.
 *
 * El tope es bajo a proposito, y no por el cupo de peticiones: lo que hay que
 * proteger es la **concurrencia**. El limitador solo deja `CONCURRENCIA_MAXIMA`
 * peticiones en vuelo entre todos, y el barrido convive con el supervisor de
 * reconexion -otras `REINTENTO_CONCURRENCIA`- y con los lotes de apertura, que
 * son lo unico que el operador esta mirando. Un barrido de fondo no puede
 * quedarse con un tercio de los huecos mientras salen cien ordenes.
 */
export const RECONCILIACION_CONCURRENCIA = 2;

/* ---------- Seguridad ---------- */
/** scrypt: 2^17 -> ~128 MB y ~0,5 s por derivacion. docs/03 seccion 5. */
export const KDF_SCRYPT_N = 131_072;
export const KDF_SCRYPT_R = 8;
export const KDF_SCRYPT_P = 1;
export const KDF_LONGITUD_CLAVE = 32;
/** Desbloqueo rapido. docs/03 seccion 6. */
export const PIN_LONGITUD_DEFECTO = 2;
export const PIN_LONGITUD_MIN = 2;
export const PIN_LONGITUD_MAX = 8;
export const PIN_MAX_INTENTOS = 5;
/** Espera creciente entre intentos fallidos, en milisegundos. */
export const PIN_ESPERAS_MS = [0, 1_000, 3_000, 10_000, 30_000] as const;

/* ---------- Estado de conexion por cuenta ---------- */
/** Reintentos de reconexion: 1, 2, 4, 8, 16, 30 s con jitter. docs/01 seccion 8. */
export const RECONEXION_BASE_MS = 1_000;
export const RECONEXION_TOPE_MS = 30_000;
/** Proporcion de jitter aplicada al backoff, arriba y abajo. */
export const RECONEXION_JITTER = 0.3;
/**
 * Fallos seguidos tras los que una cuenta se declara desconectada.
 *
 * Uno solo no basta: un corte de un segundo dejaria 100 cuentas en rojo y el
 * operador aprenderia a ignorar el color.
 */
export const FALLOS_PARA_DESCONECTAR = 3;

/**
 * Cada cuanto mira el supervisor si hay cuentas cuyo reintento ya vencio.
 *
 * No es el ritmo de los reintentos -ese lo fija el backoff por cuenta-, sino la
 * resolucion con que se detecta que uno ha vencido. Un segundo mantiene el error
 * de redondeo por debajo de lo que un operador percibe, y despertar una vez por
 * segundo para recorrer un mapa de 100 entradas no se nota en el proceso.
 */
export const REINTENTO_TICK_MS = 1_000;
/**
 * Cuentas que el supervisor reintenta a la vez.
 *
 * Al desbloquear el panel las 100 cuentas vencen su reintento en el mismo
 * instante. El limitador de peticiones ya impide la rafaga contra Bitget, pero
 * sin este tope se abririan 100 promesas simultaneas esperando turno, y el
 * primer reintento de la cuenta 100 llegaria despues de que su backoff hubiera
 * vencido dos veces mas. Reintentar de cuatro en cuatro mantiene la cola corta y
 * el orden previsible.
 */
export const REINTENTO_CONCURRENCIA = 4;

/* ---------- Ejecucion de lotes ---------- */
/**
 * Cuanto vale un plan de apertura desde que se calcula.
 *
 * Un plan lleva dentro el precio con el que se calcularon las cantidades. Si el
 * operador lo deja abierto y lo confirma diez minutos despues, esas cantidades
 * ya no corresponden al mercado y el margen comprometido no seria el que
 * aprobo. Pasado este plazo hay que volver a planificar, que cuesta una
 * peticion publica.
 */
export const PLAN_VIGENCIA_MS = 120_000;

/* ---------- Interfaz ---------- */
/** Retardo del boton de confirmacion, contra el doble clic reflejo. docs/04 W-09. */
export const CONFIRMACION_RETARDO_MS = 2_000;
/** Alto de fila en densidad compacta. Verificado en docs/04 W-01. */
export const FILA_COMPACTA_PX = 18;
/** Resolucion minima para el mosaico de 100 cuentas. docs/04 seccion 2. */
export const MOSAICO_ANCHO_MIN = 1920;
export const MOSAICO_ALTO_MIN = 1080;

/* ---------- Estructura ---------- */
export const SUBCUENTAS_POR_GRUPO = 20;
/**
 * Cuentas principales del panel: quince, de la A a la O.
 *
 * Eran cinco hasta el 28/08/2026, y no eran una lista: el operador escribia el
 * nombre a mano en el formulario de alta, asi que «A» y «a » creaban una cuenta
 * cada una. El cliente lo cerro ese dia -de la A a la O, fijas- y con ello el
 * panel pasa de 100 subcuentas a 300: quince cuentas principales por las
 * `SUBCUENTAS_POR_GRUPO` de cada una.
 *
 * El techo sigue existiendo por lo mismo que existia con cinco: la matriz se
 * dibuja entera en pantalla y el presupuesto de sockets -`WS_MAX_CONCURRENTES`-
 * no da para una conexion viva por subcuenta. Con 300 no todas tendran socket a
 * la vez; las que tienen posicion abierta si, que es el orden que ya aplica el
 * pool.
 */
export const CUENTAS_MADRE_MAX = 15;
/**
 * Como se llama cada cuenta principal: `A`, `B`, ... `O`.
 *
 * Se derivan del abecedario y no se escriben a mano para que no puedan
 * desajustarse de `CUENTAS_MADRE_MAX`: una lista de quince nombres junto a un
 * tope de quince son dos numeros que hay que acordarse de cambiar a la vez.
 */
export const NOMBRES_CUENTA_MADRE: readonly string[] = Array.from(
  { length: CUENTAS_MADRE_MAX },
  (_, i) => String.fromCharCode('A'.charCodeAt(0) + i)
);

/** Donde va cada cuenta principal. Las de fuera de A-O, al final. */
const ORDEN_CUENTA_MADRE = new Map(NOMBRES_CUENTA_MADRE.map((n, i) => [n, i]));

/**
 * El orden en que se enseñan las cuentas principales: A, B, C...
 *
 * --------------------------------------------------------------------------
 * Por que no vale el orden de alta
 * --------------------------------------------------------------------------
 * Porque no es un orden: es el rastro de en que orden se tecleo. El operador lo
 * pidio el 05/09/2026 para la pantalla de API Keys -una subcuenta de la B
 * quedaba entre dos de la A- y se arreglo solo alli; la matriz siguio pintando
 * por antiguedad, asi que quien daba de alta la B antes que la A veia la B
 * arriba. Con los nombres fijos de la A a la O, cualquier orden que no sea el
 * alfabetico es un orden que el operador no puede predecir.
 *
 * Se compara por **nombre** y no por ningun campo guardado a proposito: es lo
 * unico que no depende de cuando se creo la ficha, asi que corrige tambien las
 * instalaciones que ya existen, sin migrar el archivo.
 *
 * El nombre se normaliza antes de buscarlo porque `grupoPorNombre` empareja sin
 * distinguir mayusculas pero guarda lo que llego, y antes del 28/08/2026 se
 * escribia a mano: un `cuentas.json` viejo puede traer «a», que sin normalizar
 * caeria al final en vez de encabezar. No puede haber «A» y «a» a la vez, asi
 * que normalizar no crea empates nuevos.
 *
 * El desempate va sobre las cadenas originales y solo entra en juego entre dos
 * nombres de fuera de A-O -una instalacion antigua, un registro importado-,
 * donde lo que se quiere es orden alfabetico humano.
 */
export function compararCuentaMadre(a: string, b: string): number {
  const pa = ORDEN_CUENTA_MADRE.get(a.trim().toUpperCase()) ?? NOMBRES_CUENTA_MADRE.length;
  const pb = ORDEN_CUENTA_MADRE.get(b.trim().toUpperCase()) ?? NOMBRES_CUENTA_MADRE.length;
  return pa - pb || a.localeCompare(b, 'es');
}
/**
 * Casillas de activo del selector. Ocho, ni una mas.
 *
 * El cliente opera ocho activos y el selector tiene ocho huecos desde el primer
 * dia. Lo que cambio el 28/08/2026 es que **cual** va en cada hueco lo decide el
 * operador, con un buscador sobre el catalogo entero de Bitget; lo que no cambio
 * es el numero, y por el mismo motivo de siempre: un selector con los 754
 * contratos del exchange convierte una eleccion de un vistazo en una busqueda, y
 * abre la puerta a operar por error un activo que no es el suyo.
 *
 * Buscar es ahora un acto aparte -se abre, se elige, se cierra- y operar sigue
 * siendo elegir entre ocho.
 */
export const RANURAS_ACTIVO = 8;
