/**
 * Limites, intervalos y umbrales del sistema.
 *
 * Todo numero magico del proyecto vive aqui, con la referencia al documento que
 * lo justifica. Si un valor no tiene justificacion escrita, no deberia existir.
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

/* ---------- Presupuesto propio, por debajo del techo ---------- */
/** 20 % de margen bajo el techo de 100. docs/01 seccion 8. */
export const WS_MAX_CONCURRENTES = 80;
/** Conexiones nuevas por segundo durante el arranque escalonado. */
export const WS_ARRANQUE_POR_SEGUNDO = 5;
/** Ping de aplicacion. El servidor corta a los 120 s; 20 da seis oportunidades. */
export const WS_PING_MS = 20_000;
export const WS_PONG_TIMEOUT_MS = 10_000;

/* ---------- Ritmos del panel ---------- */
/** Refresco del monitor. El contrato acota el rango a 2-5 s. */
export const MONITOR_REFRESCO_MS_MIN = 2_000;
export const MONITOR_REFRESCO_MS_MAX = 5_000;
export const MONITOR_REFRESCO_MS_DEFECTO = 3_000;
/** Coalescencia de eventos hacia el renderer, para no quemar la CPU. */
export const PUBLICACION_COALESCIDA_MS = 250;
/** Cotejo REST contra el estado en memoria. docs/01 seccion 8. */
export const RECONCILIACION_MS = 45_000;

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
export const CUENTAS_MADRE_MAX = 5;
