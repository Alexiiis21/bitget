import { useCallback, useRef, useState } from 'react';

/**
 * El ancho real de un elemento, al día cuando cambia.
 *
 * --------------------------------------------------------------------------
 * Por qué se mide el elemento y no la ventana
 * --------------------------------------------------------------------------
 * Lo que decide si una tabla cabe no es el tamaño de la pantalla: es el hueco
 * que le queda después de la barra lateral, los márgenes y lo que haya al lado.
 * Una consulta a `window.innerWidth` acierta hoy y miente en cuanto alguien
 * cambia el ancho de la barra, que es la clase de suposición que envejece sin
 * que nadie se entere hasta que la mitad de una fila desaparece.
 *
 * Se devuelve una **ref de función** en vez de una `useRef` con `useEffect`:
 * así la medida se toma en cuanto el nodo entra en el DOM y se vuelve a tomar
 * si el elemento se monta y se desmonta —una sección plegable lo hace cada vez
 * que se abre—. Con `useEffect(..., [])` sobre una ref normal, un elemento que
 * no existía en el primer render no se mediría nunca.
 *
 * La primera medida se toma durante el commit, antes de que el navegador
 * pinte, así que no hay parpadeo entre la disposición supuesta y la real.
 *
 * El nombre empieza por `use` y no por `usar`, que es la única excepción al
 * castellano de este código: `react-hooks/rules-of-hooks` solo reconoce como
 * hook lo que empieza por `use`, y renunciar a esa comprobación por una
 * preferencia de nombre saldría caro el día que alguien llame a esto dentro de
 * un `if`.
 */
export function useAncho(): [(nodo: HTMLElement | null) => void, number] {
  const [ancho, fijarAncho] = useState(0);
  const observador = useRef<ResizeObserver | null>(null);

  const medir = useCallback((nodo: HTMLElement | null) => {
    observador.current?.disconnect();
    observador.current = null;

    if (nodo === null) return;

    fijarAncho(nodo.getBoundingClientRect().width);

    /* Sin `ResizeObserver` queda la medida del montaje, que es mejor que nada. */
    if (typeof ResizeObserver === 'undefined') return;

    const observa = new ResizeObserver((entradas) => {
      const entrada = entradas[0];
      if (entrada !== undefined) fijarAncho(entrada.contentRect.width);
    });
    observa.observe(nodo);
    observador.current = observa;
  }, []);

  return [medir, ancho];
}
