/**
 * El Take Profit que tenía puesto cada posición cerrada.
 *
 * ==========================================================================
 * Por qué hace falta enlazarlo
 * ==========================================================================
 * El historial de posiciones de Bitget no trae el TP, y el de planes TP/SL
 * (`orders-plan-history` en V2, `history-strategy-orders` en V3) no trae el
 * `positionId`: solo par, lado, precio y fechas (verificado el 15/10/2026,
 * docs/00-alertas-fase-1.md). Se enlazan por par, lado y tiempo.
 *
 * ==========================================================================
 * La regla
 * ==========================================================================
 * El TP de una posición es un plan del mismo par y lado que:
 *
 *   1. se creó mientras la posición estaba abierta, y
 *   2. seguía vivo al cerrarse: se ejecutó, o Bitget lo canceló al cerrar.
 *
 * Un TP quitado a mano antes del cierre no cuenta: no «estaba colocado». Si
 * cumplen varios —un TP reemplazado al agregar un lote y cancelado justo antes
 * del cierre—, gana el ejecutado y, si no hay, el más reciente.
 *
 * Puro: sin red. La lectura de los planes está en `alertas/fuentes.ts`.
 */
import type { PosicionCerrada, TakeProfitCerrada } from '../domain/posicion-cerrada';

/** Un plan TP terminado, ya normalizado. */
export interface PlanTp {
  symbol: string;
  lado: 'long' | 'short';
  precio: string;
  creadoEnMs: number;
  /** Cuándo se ejecutó o se canceló. */
  terminadoEnMs: number;
  ejecutado: boolean;
}

/** Margen para relojes y para el TP enviado junto con la orden de apertura. */
const TOLERANCIA_APERTURA_MS = 5_000;
/** Lo que tarda Bitget en cancelar el TP de una posición que se acaba de cerrar. */
const TOLERANCIA_CIERRE_MS = 60_000;

type Registro = Record<string, unknown>;

const texto = (o: Registro, k: string): string | null => {
  const v = o[k];
  if (typeof v === 'string') return v === '' ? null : v;
  if (typeof v === 'number') return String(v);
  return null;
};

const ms = (o: Registro, k: string): number => {
  const n = Number(o[k]);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const ladoDe = (v: string | null): PlanTp['lado'] | null => {
  const l = (v ?? '').toLowerCase();
  return l === 'long' || l === 'short' ? l : null;
};

/** Plan V2 de `orders-plan-history` (`planType=profit_loss`). `null` si no es un TP. */
export function planTpV2(p: Registro): PlanTp | null {
  const tipo = texto(p, 'planType');
  if (tipo !== 'pos_profit' && tipo !== 'profit_plan') return null;
  const precio = texto(p, 'triggerPrice') ?? texto(p, 'stopSurplusTriggerPrice');
  const symbol = texto(p, 'symbol');
  const lado = ladoDe(texto(p, 'posSide'));
  if (precio === null || symbol === null || lado === null) return null;
  return {
    symbol,
    lado,
    precio,
    creadoEnMs: ms(p, 'cTime'),
    terminadoEnMs: ms(p, 'uTime'),
    ejecutado: (texto(p, 'planStatus') ?? '').toLowerCase() === 'executed'
  };
}

/** Plan V3 de `history-strategy-orders`. `null` si no lleva TP. */
export function planTpV3(p: Registro): PlanTp | null {
  const precio = texto(p, 'takeProfit');
  const symbol = texto(p, 'symbol');
  const lado = ladoDe(texto(p, 'posSide'));
  if (precio === null || symbol === null || lado === null) return null;
  const estado = (texto(p, 'status') ?? '').toLowerCase();
  return {
    symbol,
    lado,
    precio,
    creadoEnMs: ms(p, 'createdTime'),
    terminadoEnMs: ms(p, 'updatedTime'),
    /* Solo se ha capturado `cancelled` en V3; lo demás se lee por si llega. */
    ejecutado: estado === 'executed' || estado === 'triggered' || estado === 'filled'
  };
}

/** El TP que estaba puesto al cerrarse `p`, o `null` si no tenía. */
export function takeProfitDe(
  p: PosicionCerrada,
  planes: readonly PlanTp[]
): TakeProfitCerrada | null {
  const candidatos = planes.filter(
    (t) =>
      t.symbol === p.symbol &&
      t.lado === p.lado &&
      t.creadoEnMs >= p.abiertaEnMs - TOLERANCIA_APERTURA_MS &&
      t.creadoEnMs <= p.cerradaEnMs &&
      t.terminadoEnMs >= p.cerradaEnMs - TOLERANCIA_CIERRE_MS &&
      t.terminadoEnMs <= p.cerradaEnMs + TOLERANCIA_CIERRE_MS
  );
  if (candidatos.length === 0) return null;
  const ejecutados = candidatos.filter((t) => t.ejecutado);
  const entre = ejecutados.length > 0 ? ejecutados : candidatos;
  const t = entre.reduce((a, b) => (b.creadoEnMs > a.creadoEnMs ? b : a));
  return {
    precio: t.precio,
    colocadoEnMs: t.creadoEnMs,
    disparadoEnMs: t.ejecutado ? t.terminadoEnMs : null
  };
}
