import { useEffect, useRef, useState, type RefObject } from 'react';
import { T } from '@/lib/tokens';
import { usarPanel } from '@/store/panel';

/**
 * Selección por arrastre sobre las casillas, como el rectángulo de Excel.
 *
 * Se arrastra desde la zona de casillas de cualquier cuenta y el rectángulo
 * puede cruzar varias cuentas: si el cursor se acerca al borde superior o
 * inferior de la matriz -o sale de ella-, el contenedor se desplaza solo y el
 * rectángulo sigue creciendo.
 *
 * Solo **marca**. No desmarca ni toca nada más: al soltar, cada casilla tocada
 * que aún no estaba marcada pasa por `alternarCasilla`, el mismo camino que un
 * clic. Así el store sigue siendo el único que decide -alcance, columna entera
 * en «Ambos»- y el arrastre no tiene reglas propias que puedan divergir.
 *
 * Mientras se arrastra, las casillas que se marcarían llevan `data-en-lazo`
 * (el estilo está en index.css). Escape cancela sin marcar nada.
 */

const UMBRAL_PX = 5;
const MARGEN_AUTOSCROLL_PX = 48;
const VELOCIDAD_MAX_PX = 22;

type Lado = 'selLong' | 'selShort';
type Punto = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };

/** Pasa un punto de pantalla a coordenadas del contenido desplazable. */
function aContenido(el: HTMLElement, clientX: number, clientY: number): Punto {
  const r = el.getBoundingClientRect();
  const x = clientX - r.left + el.scrollLeft;
  const y = clientY - r.top + el.scrollTop;
  return {
    x: Math.max(0, Math.min(x, el.scrollWidth)),
    y: Math.max(0, Math.min(y, el.scrollHeight))
  };
}

function rectEntre(a: Punto, b: Punto): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

function casillasDentro(el: HTMLElement, rect: Rect): HTMLElement[] {
  const base = el.getBoundingClientRect();
  const dentro: HTMLElement[] = [];
  el.querySelectorAll<HTMLElement>('[data-lazo-cuenta]').forEach((c) => {
    if (c.getAttribute('aria-disabled') === 'true') return;
    const r = c.getBoundingClientRect();
    const x = r.left - base.left + el.scrollLeft;
    const y = r.top - base.top + el.scrollTop;
    const corta = x < rect.x + rect.w && x + r.width > rect.x && y < rect.y + rect.h && y + r.height > rect.y;
    if (corta) dentro.push(c);
  });
  return dentro;
}

function limpiarMarcas(el: HTMLElement): void {
  el.querySelectorAll('[data-en-lazo]').forEach((c) => c.removeAttribute('data-en-lazo'));
}

export function LazoSeleccion({ contenedor }: { contenedor: RefObject<HTMLDivElement | null> }) {
  const [rect, setRect] = useState<Rect | null>(null);
  const estado = useRef<{
    origen: Punto;
    puntero: { clientX: number; clientY: number };
    activo: boolean;
    raf: number;
    tocadas: HTMLElement[];
  } | null>(null);

  useEffect(() => {
    const el = contenedor.current;
    if (!el) return;

    const actualizar = (): void => {
      const s = estado.current;
      if (!s?.activo) return;
      const fin = aContenido(el, s.puntero.clientX, s.puntero.clientY);
      const r = rectEntre(s.origen, fin);
      setRect(r);
      const nuevas = casillasDentro(el, r);
      s.tocadas.forEach((c) => {
        if (!nuevas.includes(c)) c.removeAttribute('data-en-lazo');
      });
      nuevas.forEach((c) => c.setAttribute('data-en-lazo', ''));
      s.tocadas = nuevas;
    };

    /* Desplazamiento automático mientras el cursor esté cerca del borde. */
    const bucle = (): void => {
      const s = estado.current;
      if (!s?.activo) return;
      const r = el.getBoundingClientRect();
      const y = s.puntero.clientY;
      let dy = 0;
      if (y < r.top + MARGEN_AUTOSCROLL_PX) {
        dy = -Math.min(VELOCIDAD_MAX_PX, Math.ceil((r.top + MARGEN_AUTOSCROLL_PX - y) / 3));
      } else if (y > r.bottom - MARGEN_AUTOSCROLL_PX) {
        dy = Math.min(VELOCIDAD_MAX_PX, Math.ceil((y - (r.bottom - MARGEN_AUTOSCROLL_PX)) / 3));
      }
      if (dy !== 0) {
        const antes = el.scrollTop;
        el.scrollTop += dy;
        if (el.scrollTop !== antes) actualizar();
      }
      s.raf = requestAnimationFrame(bucle);
    };

    /* Un clic que cierra un arrastre no debe alternar la casilla donde se soltó. */
    const tragarClic = (e: MouseEvent): void => {
      e.stopPropagation();
      e.preventDefault();
    };

    const terminar = (aplicar: boolean): void => {
      const s = estado.current;
      estado.current = null;
      window.removeEventListener('mousemove', alMover);
      window.removeEventListener('mouseup', alSoltar);
      window.removeEventListener('keydown', alTecla);
      if (!s) return;
      cancelAnimationFrame(s.raf);
      document.body.style.userSelect = '';
      limpiarMarcas(el);
      setRect(null);
      if (!s.activo) return;

      window.addEventListener('click', tragarClic, { capture: true, once: true });
      /* Si el mouseup no genera clic (se soltó en otro elemento), retirar el filtro. */
      setTimeout(() => window.removeEventListener('click', tragarClic, { capture: true }), 0);

      if (!aplicar) return;
      for (const c of s.tocadas) {
        const cuentaId = c.dataset.lazoCuenta;
        const lado = c.dataset.lazoLado as Lado | undefined;
        const indice = Number(c.dataset.lazoIndice);
        if (!cuentaId || !lado || Number.isNaN(indice)) continue;
        /* Se relee el store en cada vuelta: en «Ambos» marcar una punta marca la otra. */
        const { seleccion, alternarCasilla } = usarPanel.getState();
        if (seleccion[cuentaId]?.[lado][indice] === true) continue;
        alternarCasilla(cuentaId, lado, indice);
      }
    };

    const alMover = (e: MouseEvent): void => {
      const s = estado.current;
      if (!s) return;
      s.puntero = { clientX: e.clientX, clientY: e.clientY };
      if (!s.activo) {
        const p = aContenido(el, e.clientX, e.clientY);
        if (Math.hypot(p.x - s.origen.x, p.y - s.origen.y) < UMBRAL_PX) return;
        s.activo = true;
        document.body.style.userSelect = 'none';
        window.getSelection()?.removeAllRanges();
        s.raf = requestAnimationFrame(bucle);
      }
      e.preventDefault();
      actualizar();
    };

    const alSoltar = (): void => terminar(true);
    const alTecla = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') terminar(false);
    };

    const alPulsar = (e: MouseEvent): void => {
      if (e.button !== 0 || estado.current) return;
      const objetivo = e.target as HTMLElement | null;
      /* Solo arranca desde la zona de casillas: el resto de la matriz conserva su comportamiento. */
      if (!objetivo?.closest('[data-zona-lazo]')) return;
      estado.current = {
        origen: aContenido(el, e.clientX, e.clientY),
        puntero: { clientX: e.clientX, clientY: e.clientY },
        activo: false,
        raf: 0,
        tocadas: []
      };
      window.addEventListener('mousemove', alMover);
      window.addEventListener('mouseup', alSoltar);
      window.addEventListener('keydown', alTecla);
    };

    /* El scroll con la rueda durante el arrastre también tiene que mover el rectángulo. */
    const alDesplazar = (): void => actualizar();

    el.addEventListener('mousedown', alPulsar);
    el.addEventListener('scroll', alDesplazar);
    return () => {
      el.removeEventListener('mousedown', alPulsar);
      el.removeEventListener('scroll', alDesplazar);
      terminar(false);
    };
  }, [contenedor]);

  if (!rect) return null;
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        border: `1px solid ${T.marcaRelleno}`,
        background: 'color-mix(in srgb, var(--brand-fill) 14%, transparent)',
        borderRadius: 2,
        pointerEvents: 'none',
        zIndex: 5
      }}
    />
  );
}
