/**
 * El «ka-ching» de caja registradora que suena al abrir y al cerrar posiciones.
 *
 * --------------------------------------------------------------------------
 * Suena una vez por lote, no una vez por posición
 * --------------------------------------------------------------------------
 * Abrir cuarenta casillas son cuarenta `place-order` —no hay endpoint de
 * apertura en bloque; ver `motor-lotes.ts`—, así que engancharlo al envío de
 * cada orden produciría cuarenta sonidos solapados. Lo que el operador quiere
 * oír es «el lote entró», y eso ocurre una sola vez: en `enviarPlan`, cuando
 * vuelve el informe. Por eso este módulo no sabe nada de órdenes ni de
 * casillas, y `reproducirCajaRegistradora` no lleva argumentos.
 *
 * Quién lo dispara y con qué condición está en `store/panel.ts`, junto al
 * informe del lote: aquí solo se sabe sonar.
 *
 * --------------------------------------------------------------------------
 * El archivo se descubre, no se importa
 * --------------------------------------------------------------------------
 * `import.meta.glob` en vez de un `import` directo por dos razones:
 *
 *  1. Sin archivo, la compilación sigue en pie. Un `import` de una ruta que no
 *     existe rompe el build; el glob sin coincidencias devuelve `{}` y el panel
 *     arranca mudo. Cambiar el sonido no debe poder dejar sin compilar el
 *     binario que mueve dinero.
 *  2. Sirve la extensión que haya. Quien descargue un `.mp3` de Pixabay y quien
 *     exporte un `.wav` dejan caer el archivo en `assets/sonidos/` con el
 *     nombre `caja-registradora.<lo que sea>` y no toca este archivo.
 *
 * Vite reescribe la URL en las dos formas de arranque: `http://localhost` en
 * desarrollo y `file://` en el .exe empaquetado. Es el mismo mecanismo por el
 * que ya se sirven las fuentes de @fontsource, así que la CSP estricta del
 * index.html —`media-src` cae en `default-src 'self'`— lo admite igual.
 */

const ARCHIVOS = import.meta.glob<string>('../assets/sonidos/caja-registradora.*', {
  eager: true,
  query: '?url',
  import: 'default'
});

const URL_SONIDO: string | null = Object.values(ARCHIVOS)[0] ?? null;

/**
 * Ni al 100 % ni inaudible. Un lote de apertura se confirma con la contraseña
 * de paso y la vista puesta en la pantalla: el sonido confirma, no avisa.
 */
const VOLUMEN = 0.7;

/**
 * Un solo elemento, creado al cargar el módulo.
 *
 * Crearlo en cada apertura obligaría a leer y decodificar el archivo justo
 * cuando acaba de entrar el lote, que es el momento en que la interfaz está
 * dibujando el informe. Preparado de antemano, sonar cuesta un `play()`.
 *
 * `typeof Audio` porque este módulo entra en las pruebas del store por la vía
 * de `store/panel.ts`, y esas corren en `environment: 'node'` —ver
 * vitest.config.ts—, donde `Audio` no existe. Sin la guarda, añadir un sonido
 * tumbaría la suite entera del renderer con un `ReferenceError` en la carga
 * del módulo, antes de la primera aserción.
 */
const elemento: HTMLAudioElement | null = (() => {
  if (URL_SONIDO === null || typeof Audio === 'undefined') return null;
  const audio = new Audio(URL_SONIDO);
  audio.preload = 'auto';
  audio.volume = VOLUMEN;
  return audio;
})();

/**
 * Suena la caja registradora. Nunca lanza.
 *
 * Un fallo de audio no puede tumbar el informe de un lote que ya salió a
 * Bitget: el dinero se movió igual, y la pantalla que lo cuenta importa más
 * que el sonido. Todo lo que puede fallar —archivo ausente, códec que el
 * empaquetado no trae, la política de reproducción automática de Chromium—
 * acaba en silencio, no en excepción.
 */
export function reproducirCajaRegistradora(): void {
  if (elemento === null) return;
  try {
    /*
     * Rebobinar antes de sonar. Dos lotes seguidos —abrir y reintentar las
     * fallidas— llegan con segundos de diferencia, y sin esto el segundo
     * `play()` sobre un elemento que ya terminó no vuelve a empezar.
     */
    elemento.currentTime = 0;
    void elemento.play().catch(() => undefined);
  } catch {
    /* Ni el rebobinado ni el arranque merecen romper nada. */
  }
}
