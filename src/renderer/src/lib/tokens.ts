/**
 * Tokens de diseño del panel — diseño aprobado v2.
 *
 * Los colores viven como custom properties de CSS (`styles/index.css`), no
 * aquí: este archivo solo expone los mismos nombres semánticos como cadenas
 * `var(--x)`, para que los componentes lean `T.fondo` en vez de un hex y el
 * cambio de tema no dispare un solo re-render de React. Cambiar un color es
 * tocar `styles/index.css`, nunca un componente.
 *
 * Los tamaños, rejillas y sombras sí son valores fijos: no dependen del tema.
 */

export const T = {
  fondo: 'var(--bg)',
  superficie: 'var(--surface)',
  superficie2: 'var(--surface-2)',
  superficie3: 'var(--surface-3)',
  banda: 'var(--band)',
  bandaHover: 'var(--band-hover)',
  seleccion: 'var(--sel)',
  seleccionSuave: 'var(--sel-soft)',
  hover: 'var(--hover)',
  fondoCampo: 'var(--input-bg)',
  /**
   * Campos de formulario con superficie propia (`<input>` blanco).
   *
   * No confundir con `fondoCampo`, que es el relleno de los envoltorios de la
   * barra lateral: allí el `<input>` es transparente y el texto sí sigue al
   * tema. Estos dos no siguen al tema a propósito. Ver `styles/index.css`.
   */
  campoFondo: 'var(--field-bg)',
  campoTexto: 'var(--field-fg)',
  campoBorde: 'var(--field-line)',
  borde: 'var(--line)',
  bordeSuave: 'var(--line-soft)',
  bordeFuerte: 'var(--line-strong)',
  texto: 'var(--fg)',
  texto2: 'var(--fg-2)',
  texto3: 'var(--fg-3)',
  marca: 'var(--brand)',
  marcaRelleno: 'var(--brand-fill)',
  marcaTexto: 'var(--brand-fg)',
  largo: 'var(--long)',
  corto: 'var(--short)',
  filaCritica: 'var(--row-crit)',
  filaAviso: 'var(--row-warn)',
  alertaCriticaFondo: 'var(--alert-crit-bg)',
  alertaCriticaBorde: 'var(--alert-crit-line)',
  alertaCriticaTexto: 'var(--alert-crit-fg)',
  alertaCriticaTexto2: 'var(--alert-crit-fg2)',
  alertaAvisoFondo: 'var(--alert-warn-bg)',
  alertaAvisoBorde: 'var(--alert-warn-line)',
  alertaAvisoTexto: 'var(--alert-warn-fg)'
} as const;

export const FUENTE = {
  sans: "'IBM Plex Sans', system-ui, sans-serif",
  mono: "'IBM Plex Mono', monospace"
} as const;

/** Paleta fija de los avisos emergentes: no cambia con el tema, por contraste. */
export const AVISO = {
  ok: { acento: T.marcaRelleno, fondo: '#eff7fd', borde: '#cfe4f5', icono: '✓' },
  aviso: { acento: '#d99a04', fondo: '#fffaef', borde: '#f2e2b8', icono: '!' },
  error: { acento: '#e03131', fondo: '#fef6f5', borde: '#f5d5d1', icono: '×' }
} as const;

/**
 * Botón de acción principal.
 *
 * Se rellena con `marcaRelleno` y no con `marca`. En el tema oscuro `--brand`
 * es `#0a1a2b` y la superficie de las tarjetas es `#0e1c28`: cuatro puntos de
 * diferencia, así que el botón y su contorno desaparecían dentro del modal. El
 * azul de `--brand-fill` destaca sobre la tarjeta en los dos temas, que es lo
 * único que se le pide al botón que confirma una acción.
 */
export const BOTON_PRIMARIO = {
  fondo: T.marcaRelleno,
  borde: T.marcaRelleno,
  texto: '#ffffff'
} as const;

export const CAJA_ERROR = {
  fondo: '#fef6f5',
  borde: '#f5d5d1',
  acento: '#e03131',
  texto: '#8c3226'
} as const;

export const VELO = {
  detalle: 'rgba(6,20,34,.48)',
  seguridad: 'rgba(6,20,34,.5)',
  paso: 'rgba(6,20,34,.58)',
  apis: T.fondo,
  login: '#08243c'
} as const;

export const SOMBRA = {
  login: '0 30px 90px rgba(3,15,26,.5)',
  seguridad: '0 30px 80px rgba(5,20,34,.4)',
  paso: '0 30px 80px rgba(5,20,34,.45)',
  detalle: '0 30px 80px rgba(5,20,34,.38)',
  aviso: '0 14px 36px rgba(8,26,42,.20)'
} as const;

/** Estados de acción TP · MGA · AP · OE, colores configurables por el cliente. */
export const ESTADO_ACCION = {
  realizada: '#2f9e44',
  pendiente: '#e03131',
  error: '#f2b705'
} as const;

/** Realce de la primera entrada de cada cuenta (long/short). */
export const REALCE = {
  largoFondo: '#a8e6cf',
  largoTexto: '#08483e',
  cortoFondo: '#f9c4bc',
  cortoTexto: '#7d1f13'
} as const;

export const DISTINTIVO_POSICION = {
  abierta: { etiqueta: 'abierta', fondo: '#e8f7ee', texto: '#1f7a3a' },
  cerrada: { etiqueta: 'cerrada', fondo: '#fdeceb', texto: '#c0392b' },
  ninguna: { etiqueta: 'sin posición', fondo: '#f1f4f3', texto: '#8794a0' }
} as const;

export const DISTINTIVO_API = {
  ok: { etiqueta: 'conectada', fondo: '#e8f7ee', texto: '#1f7a3a', punto: '#2f9e44' },
  conectando: { etiqueta: 'conectando', fondo: '#fffaef', texto: '#8a6a05', punto: '#f2b705' },
  error: { etiqueta: 'desconectada', fondo: '#fdeceb', texto: '#c0392b', punto: '#e03131' },
  'sin-api': { etiqueta: 'sin API', fondo: '#f1f4f3', texto: '#8794a0', punto: '#d7e0e8' }
} as const;

/**
 * Rejilla del Centro de Monitoreo.
 *
 * Anchuras fijas a propósito: las cifras se comparan en columna entre
 * subcuentas, y una columna elástica las desalinearía al cambiar de activo.
 */
export const REJILLA_MONITOR =
  'minmax(190px,1.15fr) repeat(4,minmax(0,96px)) minmax(0,1.34fr) minmax(0,1.05fr) repeat(4,minmax(0,96px)) minmax(0,1.34fr)';
export const ANCHO_MINIMO_MONITOR = 1546;
/** 2 bloques de 20 casillas + etiquetas de lado. */
export const ANCHO_MINIMO_MATRIZ = 1180;
export const CASILLAS_POR_CUENTA = 20;
/** Máximo de operaciones cerradas que se muestran por subcuenta en el historial. */
export const HISTORIAL_MAXIMO = 20;
