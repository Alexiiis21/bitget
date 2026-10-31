/**
 * ¿Esto lo hizo el panel, Bitget solo, o el cliente por su cuenta?
 *
 * Puro: sin red ni disco. Recibe los movimientos de una subcuenta, la parte de
 * la bitácora que le toca y los traspasos que registró el panel, y devuelve
 * **solo lo externo**: lo que el cliente hizo fuera del PCB.
 *
 * ==========================================================================
 * La regla, verificada contra Bitget el 15/10/2026
 * ==========================================================================
 *   1. Lo automático —TP/SL disparado, liquidación— se descarta siempre.
 *      V2 lo marca: `orderSource` de plan (`pos_profit_market`…), `tradeSide`
 *      de liquidación (`burst_close_long`) u origen `sys`.
 *   2. Lo que lleva nuestro `clientOid` (`pcb…`) es del panel: aperturas, TP
 *      y traspasos (`pcbtr…`).
 *   3. Lo demás es del panel solo si **coincide con la bitácora**: misma
 *      cuenta, mismo símbolo y una escritura del panel unos segundos antes.
 *      Es lo que reconoce los cierres —`close-positions` no admite
 *      `clientOid`—, el margen y todo UTA, cuyo historial no trae origen.
 *   4. Lo que no cumple nada de lo anterior es **externo** y se avisa.
 *
 * Ante la duda se avisa: una alerta de más se comprueba en la app; una
 * operación del cliente que no se avisa no se entera nadie.
 */
import Decimal from 'decimal.js';
import type { AccionPropia } from '../storage/bitacora-acciones';
import type { EventoCuenta } from './tipos';

/** Una escritura del panel cuenta para un evento si llegó hasta esto antes. */
export const ANTES_MS = 5 * 60_000;
/** …y hasta esto después: el reloj de Bitget y el del panel no son el mismo. */
export const DESPUES_MS = 15_000;
/** Un TP cancelado a esta distancia de un cierre lo canceló Bitget al cerrar. */
export const CANCELACION_POR_CIERRE_MS = 2 * 60_000;
/** Ventana para reconocer un traspaso del panel en los movimientos de la cuenta. */
export const TRASPASO_MS = 10 * 60_000;
/**
 * Un TP/SL que aparece hasta esto después de una apertura del mismo símbolo y
 * lado lo creó Bitget con la orden (el TP/SL del formulario de la web o la
 * app). Capturado el 28/10/2026: 104 ms entre la orden y su plan.
 */
export const TP_DE_APERTURA_MS = 5_000;

const AUTOMATICO_ORIGEN =
  /(profit|loss|plan|track|trigger|tpsl|stop|liq|burst|adl|settle|deliver)/i;

/**
 * Si un movimiento lo generó Bitget solo.
 *
 * Mira todos los campos de origen que existen en alguna de las dos
 * superficies; el que no venga, no cuenta. En V2 está verificado; en V3 el
 * historial no trae origen y estos campos son la mejor apuesta hasta capturar
 * un TP disparado en UTA.
 */
export function esAutomatico(campos: {
  orderSource?: unknown;
  enterPointSource?: unknown;
  tradeSide?: unknown;
  delegateType?: unknown;
  execType?: unknown;
}): boolean {
  const texto = (v: unknown): string => (typeof v === 'string' ? v : '');
  if (texto(campos.enterPointSource).toLowerCase() === 'sys') return true;
  if (/^burst|liquid|adl/i.test(texto(campos.tradeSide))) return true;
  return [campos.orderSource, campos.delegateType, campos.execType].some((v) =>
    AUTOMATICO_ORIGEN.test(texto(v))
  );
}

export const esClientOidPropio = (clientOid: string | null): boolean =>
  clientOid !== null && clientOid.startsWith('pcb');

/** El símbolo y el lado de una escritura del panel, de su cuerpo. */
function cuerpoDe(a: AccionPropia): { simbolo: string | null; lado: string | null; texto: string } {
  const c = (a.cuerpo ?? {}) as Record<string, unknown>;
  const simbolo = typeof c['symbol'] === 'string' ? c['symbol'] : null;
  const ladoCrudo = c['holdSide'] ?? c['posSide'];
  const lado = typeof ladoCrudo === 'string' ? ladoCrudo.toLowerCase() : null;
  return { simbolo, lado, texto: JSON.stringify(a.cuerpo ?? null) };
}

const enVentana = (a: AccionPropia, cuandoMs: number): boolean =>
  a.ts >= cuandoMs - ANTES_MS && a.ts <= cuandoMs + DESPUES_MS;

const RUTA_ORDEN = /(close-positions|place-order|batch-place-order|flash-close|cancel-order)/;
const RUTA_PLAN = /(tpsl|plan-order|strategy-order|place-pos-tpsl)/;
const RUTA_CANCELAR_PLAN = /(cancel-plan|cancel-strategy|modify-strategy|modify-tpsl|modify-plan)/;
/** `set-margin` pero no `set-margin-mode`, que es otra cosa. */
const RUTA_MARGEN = /set-margin(?!-)/;
const RUTA_AJUSTES = /(set-leverage|set-margin-mode|set-position-mode)/;

export interface TraspasoDelPanel {
  ts: number;
  importe: string;
  /** UID de la subcuenta de origen y de destino del traspaso. */
  uidOrigen: string;
  uidDestino: string;
}

export interface ContextoClasificacion {
  /** Solo las escrituras de **esta** cuenta (misma huella de API Key). */
  bitacora: readonly AccionPropia[];
  /** Traspasos que el panel registró, de cualquier cuenta. */
  traspasos: readonly TraspasoDelPanel[];
  uid: string;
}

const mismoImporte = (a: string | null, b: unknown): boolean => {
  if (a === null || (typeof b !== 'string' && typeof b !== 'number')) return false;
  try {
    return new Decimal(a).abs().equals(new Decimal(String(b)).abs());
  } catch {
    return false;
  }
};

/** Lo externo de una lista de movimientos de una subcuenta. */
export function clasificar(
  eventos: readonly EventoCuenta[],
  ctx: ContextoClasificacion
): EventoCuenta[] {
  const acciones = ctx.bitacora.map((a) => ({ a, ...cuerpoDe(a) }));
  /* Cada escritura de margen reconoce un solo movimiento: dos aportes iguales no se confunden. */
  const margenUsado = new Set<number>();

  const delPanel = (e: EventoCuenta): boolean => {
    if (esClientOidPropio(e.clientOid)) return true;

    switch (e.tipo) {
      case 'abrir':
      case 'cerrar':
      case 'orden':
        return acciones.some(
          (x) =>
            RUTA_ORDEN.test(x.a.ruta) &&
            x.simbolo === e.simbolo &&
            (x.lado === null || e.lado === null || x.lado === e.lado) &&
            enVentana(x.a, e.cuandoMs)
        );

      case 'tp-sl-puesto':
        return acciones.some(
          (x) => RUTA_PLAN.test(x.a.ruta) && x.simbolo === e.simbolo && enVentana(x.a, e.cuandoMs)
        );

      case 'tp-sl-quitado':
        return acciones.some(
          (x) =>
            (RUTA_CANCELAR_PLAN.test(x.a.ruta) || RUTA_PLAN.test(x.a.ruta)) &&
            ((e.orderId !== null && x.texto.includes(e.orderId)) || x.simbolo === e.simbolo) &&
            enVentana(x.a, e.cuandoMs)
        );

      case 'margen-agregado':
      case 'margen-quitado': {
        const i = acciones.findIndex(
          (x, n) =>
            !margenUsado.has(n) &&
            RUTA_MARGEN.test(x.a.ruta) &&
            (e.simbolo === null || x.simbolo === e.simbolo) &&
            mismoImporte(e.importe, (x.a.cuerpo as Record<string, unknown> | null)?.['amount']) &&
            enVentana(x.a, e.cuandoMs)
        );
        if (i < 0) return false;
        margenUsado.add(i);
        return true;
      }

      case 'traspaso-entrada':
      case 'traspaso-salida':
        return ctx.traspasos.some(
          (t) =>
            (t.uidOrigen === ctx.uid || t.uidDestino === ctx.uid) &&
            mismoImporte(e.importe, t.importe) &&
            Math.abs(t.ts - e.cuandoMs) <= TRASPASO_MS
        );

      case 'apalancamiento':
      case 'modo-margen':
        return acciones.some(
          (x) => RUTA_AJUSTES.test(x.a.ruta) && x.simbolo === e.simbolo && x.a.ts <= e.cuandoMs
        );

      /* Un aviso del propio panel: nunca es «del panel» en el sentido de no avisarse. */
      case 'nota':
        return false;
    }
  };

  /*
   * Un TP/SL que Bitget cancela porque la posición se cerró no es «quitar el
   * TP»: es efecto del cierre. Se reconoce porque hay un cierre del mismo
   * símbolo —del panel, del cliente o automático— pegado a la cancelación.
   */
  const cierres = eventos.filter((e) => e.tipo === 'cerrar');
  const canceladoPorCierre = (e: EventoCuenta): boolean =>
    e.tipo === 'tp-sl-quitado' &&
    cierres.some(
      (c) =>
        c.simbolo === e.simbolo &&
        (c.lado === null || e.lado === null || c.lado === e.lado) &&
        Math.abs(c.cuandoMs - e.cuandoMs) <= CANCELACION_POR_CIERRE_MS
    );

  return eventos
    .filter((e) => !e.automatico && !canceladoPorCierre(e) && !delPanel(e))
    .sort((a, b) => a.cuandoMs - b.cuandoMs);
}

/**
 * Si un cambio de apalancamiento o de modo en `simbolo` lo pudo hacer el panel:
 * hay una escritura de ajustes de ese símbolo desde la revisión anterior.
 *
 * Bitget no registra estos cambios, así que no hay hora con qué comparar: solo
 * se sabe que entre una revisión y otra el valor cambió.
 */
export function ajustePropio(
  bitacora: readonly AccionPropia[],
  simbolo: string,
  desdeMs: number
): boolean {
  return bitacora.some(
    (a) =>
      a.ts >= desdeMs - DESPUES_MS && RUTA_AJUSTES.test(a.ruta) && cuerpoDe(a).simbolo === simbolo
  );
}

/**
 * Junta en una sola línea cada apertura y el TP/SL que vino con ella.
 *
 * Al abrir desde la web o la app con el TP/SL del formulario lleno, Bitget
 * crea la orden y, unos milisegundos después, un plan aparte (`profit_plan`,
 * origen `sys`). Para el cliente es una sola operación: «abrí con TP». Avisada
 * en dos líneas, la del plan parecía algo que nadie hizo.
 *
 * Solo se junta lo que llega en la misma lista. Si la apertura ya se avisó en
 * una revisión anterior, el plan sale solo: nunca se calla.
 */
export function unirTpDeApertura(eventos: readonly EventoCuenta[]): EventoCuenta[] {
  const aperturas = eventos.filter((e) => e.tipo === 'abrir');
  const unidos = new Map<string, EventoCuenta[]>();
  const absorbidos = new Set<string>();

  for (const p of eventos) {
    if (p.tipo !== 'tp-sl-puesto') continue;
    const candidatas = aperturas.filter(
      (a) =>
        a.simbolo === p.simbolo &&
        (a.lado === null || p.lado === null || a.lado === p.lado) &&
        p.cuandoMs >= a.cuandoMs - 1_000 &&
        p.cuandoMs <= a.cuandoMs + TP_DE_APERTURA_MS
    );
    const a = candidatas.sort(
      (x, y) => Math.abs(p.cuandoMs - x.cuandoMs) - Math.abs(p.cuandoMs - y.cuandoMs)
    )[0];
    if (a === undefined) continue;
    unidos.set(a.clave, [...(unidos.get(a.clave) ?? []), p]);
    absorbidos.add(p.clave);
  }

  return eventos
    .filter((e) => !absorbidos.has(e.clave))
    .map((e) => {
      const planes = unidos.get(e.clave);
      if (planes === undefined) return e;
      /* «parcial» es como Bitget llama al plan de una orden; dentro de la apertura sobra. */
      const texto = planes
        .map((p) => {
          const nombre = (p.detalle ?? 'TP/SL').replace(/ parcial$/, '');
          return p.precio === null ? nombre : `${nombre} ${p.precio}`;
        })
        .join(' y ');
      return {
        ...e,
        detalle: e.detalle === null ? texto : `${e.detalle} · ${texto}`,
        incluye: [...(e.incluye ?? []), ...planes.map((p) => p.clave)]
      };
    });
}
