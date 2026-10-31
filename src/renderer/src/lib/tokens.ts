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

/**
 * Estados de acción TP · MGA · AP · OE. Los elige el operador.
 *
 * Eran tres hex fijos hasta el 29/08/2026, y eran la única excepción a la regla
 * que encabeza este archivo: los colores viven en `styles/index.css`, aquí solo
 * sus nombres. Al hacerlos configurables se corrige también esa excepción, y
 * por eso cambiar uno no vuelve a renderizar ni un componente: se reescribe la
 * variable en el `<body>` y la cascada hace el resto.
 *
 * `error` no pinta solo el distintivo: también los rótulos SUSP y SUSPENDIDO de
 * la barra lateral y del buscador. Es el mismo token semántico —«esto no se
 * puede operar»— y por eso se mueve con él.
 */
export const ESTADO_ACCION = {
  realizada: 'var(--estado-realizada)',
  pendiente: 'var(--estado-pendiente)',
  error: 'var(--estado-error)'
} as const;

export type ClaveColorEstado = keyof typeof ESTADO_ACCION;

/**
 * Los valores de fábrica, en hex.
 *
 * Hacen falta en hex y no como `var(--x)` por dos motivos: `<input type="color">`
 * solo acepta `#rrggbb`, y *Restablecer* tiene que poder volver a un valor
 * concreto. Son los mismos que declara `:root` en `styles/index.css`; si se
 * cambian ahí, hay que cambiarlos aquí.
 */
export const ESTADO_ACCION_FABRICA: Record<ClaveColorEstado, string> = {
  realizada: '#2f9e44',
  pendiente: '#e03131',
  error: '#f2b705'
};

/** Nombre de cada color en la pantalla de ajustes. */
export const ESTADO_ACCION_ROTULO: Record<ClaveColorEstado, string> = {
  realizada: 'Realizada',
  pendiente: 'Pendiente',
  error: 'Error o suspendido'
};

/** La variable CSS que hay que escribir para cada color. */
export const ESTADO_ACCION_VARIABLE: Record<ClaveColorEstado, string> = {
  realizada: '--estado-realizada',
  pendiente: '--estado-pendiente',
  error: '--estado-error'
};

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
 * Modelo de cuenta en Bitget, por fila de la pantalla de API keys.
 *
 * `classic` va deliberadamente en gris apagado y sin punto: es lo normal, y son
 * casi todas las filas. Lo que tiene que saltar a la vista es lo otro.
 *
 * `uta` va en azul —informativo, no alarma—: una cuenta UTA funciona, solo que
 * por otra API. `transicion` va en ámbar porque sí exige no tocar la cuenta
 * hasta que Bitget termine el cambio.
 */
export const DISTINTIVO_MODO = {
  classic: { etiqueta: 'V2', fondo: '#f1f4f3', texto: '#8794a0', pista: 'Cuenta clásica · API V2' },
  uta: {
    etiqueta: 'UTA',
    fondo: '#eaf1fd',
    texto: '#1c5fb8',
    pista: 'Cuenta unificada · API V3. El cambio a UTA es irreversible.'
  },
  transicion: {
    etiqueta: 'CAMBIANDO',
    fondo: '#fffaef',
    texto: '#8a6a05',
    pista:
      'Bitget está cambiando el modelo de esta cuenta. No se opera mientras dure; termina sola.'
  }
} as const;

/**
 * Rejilla del Centro de Monitoreo.
 *
 * Anchuras fijas a propósito: las cifras se comparan en columna entre
 * subcuentas, y una columna elástica las desalinearía al cambiar de activo.
 *
 * La segunda columna es el activo, y es estrecha porque lleva el nombre corto
 * del catálogo —`BTC`, `PEPE`—, nunca el símbolo de la API. Existe desde que la
 * fila es la pareja (casilla, activo): una casilla puede tener dos activos
 * abiertos, y sin esta columna las dos filas serían indistinguibles.
 */
export const REJILLA_MONITOR =
  'minmax(160px,1fr) minmax(0,58px) repeat(6,minmax(0,100px)) minmax(0,1.34fr) minmax(0,1.05fr) repeat(6,minmax(0,100px)) minmax(0,1.34fr)';
/**
 * Ancho a partir del cual las dos puntas caben una al lado de la otra.
 *
 * Es a la vez el ancho mínimo de la rejilla ancha y **el punto de quiebre**:
 * por debajo, el monitor no encoge la tabla —encogerla es lo que dejaba el
 * SHORT fuera de la pantalla, recortado y sin barra de desplazamiento— sino que
 * parte cada fila en dos, con el SHORT debajo del LONG. Ver `AccordeonMonitor`.
 *
 * Subió con la incorporación de P&L y ROE el 03/09/2026: dos columnas más por
 * lado, a `minmax(0,100px)` cada una, como el resto de cifras.
 */
export const ANCHO_MINIMO_MONITOR = 2020;

/**
 * Escala tipográfica del Centro de Monitoreo.
 *
 * Vive aquí y no repartida por el componente porque la usan las dos
 * disposiciones —la ancha y la partida— y tienen que crecer a la vez: son la
 * misma información leída en dos sitios distintos, y que una quede más pequeña
 * que la otra es lo que hace dudar de si se está mirando lo mismo.
 *
 * Los tamaños subieron el 31/08/2026 a petición del cliente: las cifras iban a
 * 9,5 px y los distintivos a 7, que en una laptop de 14" no se leen de un
 * vistazo, y este panel se mira de un vistazo mientras el precio se mueve.
 */
const VALOR_MONITOR = 12.5;

export const TIPO_MONITOR = {
  /** Rótulos de columna: SUBCUENTA, Liquidación… */
  rotulo: 11,
  /** Las cifras: liquidación, entrada, margen, take profit. */
  valor: VALOR_MONITOR,
  /** Lo que se busca primero: el nombre de la casilla y la distancia L/S. */
  destacado: 13.5,
  /** La sigla del distintivo dentro de su pastilla: TP, MGA, AP, OE. */
  distintivo: 10,
  /**
   * El numerito bajo cada distintivo: el `1.5%` del TP, el `50` del margen, el
   * `10x` del apalancamiento.
   *
   * **Es el mismo tamaño que `valor`, y a propósito.** Iba a 8,5 px —la letra
   * más pequeña de todo el panel— y el cliente lo dijo con estas palabras el
   * 31/08/2026: «exageradamente pequeños». No es un pie de foto: es el
   * porcentaje al que sale el Take Profit y el apalancamiento al que está la
   * posición, la misma clase de dato que las cifras de la izquierda de la fila.
   * Se escribe como referencia y no como número suelto para que no vuelvan a
   * separarse.
   */
  distintivoValor: VALOR_MONITOR
} as const;
/** 2 bloques de 20 casillas + etiquetas de lado. */
export const ANCHO_MINIMO_MATRIZ = 1180;
export const CASILLAS_POR_CUENTA = 20;
