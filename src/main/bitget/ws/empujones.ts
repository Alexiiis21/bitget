/**
 * Lo que llega por los dos canales, traducido al dominio.
 *
 * --------------------------------------------------------------------------
 * El socket no manda lo mismo que REST, aunque hable de lo mismo
 * --------------------------------------------------------------------------
 * La diferencia que muerde es el nombre del simbolo: `all-position` lo llama
 * `symbol` y el canal `positions` lo llama `instId`. Es el mismo dato y el
 * mismo contrato, con dos nombres, y leer el que no es produce una posicion con
 * el simbolo vacio -que en un almacen indexado por cuenta, simbolo y lado es
 * una posicion que no se puede encontrar ni cerrar-.
 *
 * Se leen **los dos**, con `instId` primero. Asi la traduccion sobrevive a que
 * Bitget unifique los nombres en cualquiera de las dos direcciones, que es mas
 * barato que descubrirlo con posiciones fantasma en pantalla.
 *
 * Todo lo demas se declara opcional por la misma razon que en `posiciones.ts`:
 * un campo renombrado tiene que fallar la validacion con su nombre, no producir
 * en silencio un precio de liquidacion inventado.
 *
 * --------------------------------------------------------------------------
 * Estado de verificacion
 * --------------------------------------------------------------------------
 * Escrito desde la documentacion de Bitget; **no capturado** de un empujon
 * real, porque para eso hace falta una posicion abierta en la cuenta de
 * pruebas. `test/red/ws-privado.test.ts` deja la traza cuando se ejecuta contra
 * el mercado real con posiciones vivas.
 */
import { z } from 'zod';
import type { Lado, Posicion, TakeProfit } from '@shared/types';

/* ---------- canal `positions` ---------- */

export const esquemaPosicionWs = z.object({
  /** El simbolo. `instId` en el socket, `symbol` en REST. Ver la cabecera. */
  instId: z.string().nullish(),
  symbol: z.string().nullish(),
  holdSide: z.string().nullish(),
  total: z.string().nullish(),
  available: z.string().nullish(),
  marginCoin: z.string().nullish(),
  marginMode: z.string().nullish(),
  marginSize: z.string().nullish(),
  openPriceAvg: z.string().nullish(),
  liquidationPrice: z.string().nullish(),
  leverage: z.union([z.string(), z.number()]).nullish(),
  unrealizedPL: z.string().nullish(),
  uTime: z.union([z.string(), z.number()]).nullish()
});

export type PosicionWs = z.infer<typeof esquemaPosicionWs>;

/**
 * Un empujon de posiciones en posiciones del dominio.
 *
 * Lo que no se puede identificar -sin simbolo o sin lado- se descarta en vez de
 * completarse con un valor por defecto: una posicion con el lado equivocado se
 * dibujaria en la columna contraria del monitor, y ahi el operador lee la
 * distancia entre su long y su short.
 *
 * `tamano` sale como `'0'` cuando no viene, y eso el almacen lo lee como un
 * cierre. Es la direccion segura: una posicion que desaparece del monitor y
 * vuelve en el siguiente barrido es un parpadeo; una que se queda con un tamano
 * inventado es una posicion que el operador cree tener.
 */
export function posicionesDeEmpujon(
  cuentaId: string,
  datos: readonly unknown[],
  instante: string
): Posicion[] {
  const salida: Posicion[] = [];

  for (const crudo of datos) {
    const leido = esquemaPosicionWs.safeParse(crudo);
    if (!leido.success) continue;

    const p = leido.data;
    const simbolo = p.instId ?? p.symbol ?? '';
    const lado = ladoDe(p.holdSide);
    if (simbolo === '' || lado === null) continue;

    salida.push({
      cuentaId,
      simbolo,
      lado,
      tamano: p.total ?? '0',
      precioEntrada: p.openPriceAvg ?? '',
      precioLiquidacion: p.liquidationPrice ?? '',
      apalancamiento: Number(p.leverage ?? 0),
      modoMargen: p.marginMode === 'crossed' ? 'cruzado' : 'aislado',
      margen: p.marginSize ?? '',
      pnl: p.unrealizedPL ?? '',
      takeProfit: null,
      origen: 'ws',
      actualizadoEn: instante,
      estado: 'viva'
    });
  }

  return salida;
}

/* ---------- canal `orders-algo` ---------- */

export const esquemaPlanWs = z.object({
  instId: z.string().nullish(),
  symbol: z.string().nullish(),
  orderId: z.string().nullish(),
  clientOid: z.string().nullish(),
  planType: z.string().nullish(),
  triggerPrice: z.string().nullish(),
  posSide: z.string().nullish(),
  holdSide: z.string().nullish(),
  /** `live`, `cancelled`, `executed`… Decide si el plan sigue protegiendo algo. */
  status: z.string().nullish()
});

export type PlanWs = z.infer<typeof esquemaPlanWs>;

/** Un cambio de Take Profit sobre una punta concreta. `tp` en `null` es «ya no hay». */
export interface CambioTakeProfit {
  simbolo: string;
  lado: Lado;
  tp: TakeProfit | null;
}

/**
 * Estados en los que un plan ya no protege la posicion.
 *
 * Se listan los que **no** valen en vez de los que si: si Bitget añade un
 * estado nuevo, tratarlo como vivo deja un Take Profit de mas en pantalla hasta
 * el siguiente barrido -que lo corrige-, mientras que tratarlo como muerto
 * borraria uno que si esta puesto. El barrido corrige lo primero; lo segundo
 * hace que el operador crea desprotegida una posicion que no lo esta.
 */
const ESTADOS_MUERTOS = new Set(['cancelled', 'canceled', 'executed', 'fail_execute', 'expired']);

/**
 * Un empujon de planes en cambios de Take Profit.
 *
 * Se filtra igual que `buscarTakeProfit` y por el mismo motivo: la lista trae
 * los Stop Loss mezclados con los Take Profit, y confundirlos aqui pondria en
 * la columna «Take Profit» del monitor el precio al que la posicion se cierra
 * **en perdidas**.
 */
export function takeProfitDeEmpujon(datos: readonly unknown[]): CambioTakeProfit[] {
  const salida: CambioTakeProfit[] = [];

  for (const crudo of datos) {
    const leido = esquemaPlanWs.safeParse(crudo);
    if (!leido.success) continue;

    const p = leido.data;
    const simbolo = p.instId ?? p.symbol ?? '';
    const lado = ladoDe(p.posSide ?? p.holdSide);
    const tipo = p.planType ?? '';
    if (simbolo === '' || lado === null) continue;
    if (!tipo.includes('profit') || tipo.includes('loss')) continue;

    const muerto = ESTADOS_MUERTOS.has((p.status ?? '').toLowerCase());
    const precio = p.triggerPrice ?? null;

    salida.push({
      simbolo,
      lado,
      tp:
        muerto || precio === null
          ? null
          : { precio, porcentaje: null, planId: p.orderId ?? '' }
    });
  }

  return salida;
}

/** `null` cuando el lado no es reconocible: sin el, la posicion no se puede colocar. */
function ladoDe(valor: string | null | undefined): Lado | null {
  const texto = (valor ?? '').toLowerCase();
  if (texto === 'long') return 'long';
  if (texto === 'short') return 'short';
  return null;
}
