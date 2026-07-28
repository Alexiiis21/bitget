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
