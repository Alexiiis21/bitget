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
 *
 * Vale para las dos superficies: los normalizadores de V2 estan arriba y los de
 * los temas de UTA -`position` y `account`- al final del archivo.
 */
import { z } from 'zod';
import type { Lado, Posicion, TakeProfit } from '@shared/types';
import type { OrdenVista } from '../registro-ordenes-uta';
import { disponibleDe, esquemaActivosCuenta } from '../rest/endpoints/ajustes-v3';
import { posicionV3AFormatoV2 } from '../rest/endpoints/posiciones-v3';

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

/* ========================================================================== */
/* Temas de UTA (V3)                                                          */
/* ========================================================================== */

/**
 * Una posicion empujada por el tema `position` de UTA.
 *
 * ==========================================================================
 * Se aceptan los dos nombres de simbolo, y no es celo excesivo
 * ==========================================================================
 * La cabecera de este archivo cuenta el tropiezo de V2: `all-position` dice
 * `symbol` y el canal `positions` dice `instId`, para el mismo dato. No hay
 * ningun motivo para suponer que V3 sea mas coherente consigo mismo, y **el
 * empujon de V3 no esta capturado**: se leen los dos, con `symbol` primero
 * porque es el que usa `current-position`.
 *
 * Lo mismo con el lado: `posSide` es el nombre de V3, pero si el empujon llegara
 * con el `holdSide` de V2 la posicion se descartaria entera por no poder
 * colocarla en el monitor, que es un fallo caro para un renombre barato.
 */
export const esquemaPosicionWsV3 = z.object({
  symbol: z.string().nullish(),
  instId: z.string().nullish(),
  posSide: z.string().nullish(),
  holdSide: z.string().nullish(),
  total: z.string().nullish(),
  /** Nombre del tamaño en la documentación del tema `position` de UTA. */
  size: z.string().nullish(),
  available: z.string().nullish(),
  marginMode: z.string().nullish(),
  avgPrice: z.string().nullish(),
  liquidationPrice: z.string().nullish(),
  liqPrice: z.string().nullish(),
  markPrice: z.string().nullish(),
  leverage: z.union([z.string(), z.number()]).nullish(),
  /* Los nombres capturados en REST el 01/10/2026; ver `posiciones-v3.ts`. */
  positionBalance: z.string().nullish(),
  unrealisedPnl: z.string().nullish(),
  marginSize: z.string().nullish(),
  margin: z.string().nullish(),
  unrealizedPL: z.string().nullish(),
  unrealizedPnl: z.string().nullish(),
  /** `ended`/`closed` en una punta que se acaba de cerrar. */
  positionStatus: z.string().nullish(),
  updatedTime: z.union([z.string(), z.number()]).nullish()
});

const ESTADOS_POSICION_CERRADA = new Set(['ended', 'closed', 'close']);

export type PosicionWsV3 = z.infer<typeof esquemaPosicionWsV3>;

/**
 * Un empujon del tema `position` en posiciones del dominio.
 *
 * Los renombres de V3 **no se repiten aqui**: se delegan en
 * `posicionV3AFormatoV2`, que es el mismo traductor que usa la lectura REST de
 * `current-position`. Asi el dia que la sonda diga como se llama de verdad el
 * margen de una posicion UTA, se corrige en un sitio y queda corregido en los
 * dos caminos —el socket y el barrido—, que es exactamente la clase de
 * divergencia que produce un monitor que se contradice consigo mismo cada 45
 * segundos.
 *
 * Las reglas de descarte son las de su gemelo de V2, palabra por palabra: sin
 * simbolo o sin lado no se puede colocar la fila, y una posicion en la columna
 * equivocada es peor que una ausente.
 */
export function posicionesDeEmpujonV3(
  cuentaId: string,
  datos: readonly unknown[],
  instante: string
): Posicion[] {
  const salida: Posicion[] = [];

  for (const crudo of datos) {
    const leido = esquemaPosicionWsV3.safeParse(crudo);
    if (!leido.success) continue;

    const p = leido.data;
    const simbolo = p.symbol ?? p.instId ?? '';
    const lado = ladoDe(p.posSide ?? p.holdSide);
    if (simbolo === '' || lado === null) continue;

    /*
     * Sin tamaño no se sabe nada, y aqui NO se rellena con `'0'` como en V2:
     * un cero es un cierre, y un nombre de campo mal supuesto borraria del
     * monitor la fila que el barrido acaba de pintar. Lo que no se entiende se
     * descarta y el barrido REST sigue mandando. Solo cierra un estado explicito.
     */
    const cerrada = ESTADOS_POSICION_CERRADA.has((p.positionStatus ?? '').toLowerCase());
    const tamano = cerrada ? '0' : (p.total ?? p.size ?? null);
    if (tamano === null) continue;

    const v2 = posicionV3AFormatoV2({
      ...p,
      symbol: simbolo,
      posSide: lado,
      total: tamano,
      liquidationPrice: p.liquidationPrice ?? p.liqPrice
    });

    salida.push({
      cuentaId,
      simbolo: v2.symbol,
      lado,
      tamano: v2.total,
      precioEntrada: v2.openPriceAvg ?? '',
      precioLiquidacion: v2.liquidationPrice ?? '',
      apalancamiento: Number(v2.leverage ?? 0),
      modoMargen: v2.marginMode === 'crossed' ? 'cruzado' : 'aislado',
      margen: v2.marginSize ?? '',
      pnl: v2.unrealizedPL ?? '',
      takeProfit: null,
      origen: 'ws',
      actualizadoEn: instante,
      estado: 'viva'
    });
  }

  return salida;
}

/**
 * Una orden empujada por el tema `order` de UTA.
 *
 * ==========================================================================
 * En la Fase D se decidió NO escribir este esquema. Ahora sí, y por qué
 * ==========================================================================
 * La Fase D suscribió el tema y no lo consumió, con este argumento: escribir un
 * esquema para datos que nadie lee es inventar nombres de campo, y este
 * repositorio ya sabe lo que cuesta —`posSide` contra `holdSide`, 25/08/2026—.
 *
 * Lo que cambia en la Fase E es que ya hay un consumidor concreto y valioso: el
 * `RegistroOrdenesUta`, que cierra el hueco 2.1 y devuelve el tri-estado a las
 * cuentas UTA. Y cambia también el coste de equivocarse, que aquí es benigno:
 * si un nombre no acierta, el `clientOid` sale vacío, la orden **no se anota**,
 * y la casilla se queda `indeterminada` —exactamente donde estaba antes de esta
 * fase—. Un campo mal supuesto aquí no puede producir una respuesta falsa; solo
 * puede no producir ninguna.
 *
 * Esa es la diferencia con los esquemas que sí se dejaron sin escribir: allí un
 * nombre errado mandaba una petición equivocada a Bitget.
 *
 * Se aceptan los dos nombres plausibles de cada campo por la misma razón que en
 * el resto de la superficie V3: **nada de esto está capturado**.
 */
export const esquemaOrdenWsV3 = z.object({
  orderId: z.string().nullish(),
  clientOid: z.string().nullish(),
  clientOrderId: z.string().nullish(),
  symbol: z.string().nullish(),
  instId: z.string().nullish(),
  status: z.string().nullish(),
  state: z.string().nullish(),
  qty: z.string().nullish(),
  size: z.string().nullish(),
  filledQty: z.string().nullish(),
  baseVolume: z.string().nullish(),
  avgPrice: z.string().nullish(),
  priceAvg: z.string().nullish()
});

export type OrdenWsV3 = z.infer<typeof esquemaOrdenWsV3>;

/**
 * Un empujón del tema `order` en anotaciones para el registro.
 *
 * Se descarta lo que no trae `clientOid`: sin él la anotación no puede
 * responder a la única pregunta que se le va a hacer. Órdenes puestas desde la
 * app de Bitget llegarán por aquí sin el identificador del panel, y no anotarlas
 * es lo correcto —no son de ningún lote—.
 *
 * **No se filtra por estado.** Una orden cancelada también prueba que entró, que
 * es lo que se pregunta; es además lo que ya hace V2, donde `mix/order/detail`
 * devuelve la orden cancelada y el motor la da por entrada.
 */
export function ordenesDeEmpujon(datos: readonly unknown[]): OrdenVista[] {
  const salida: OrdenVista[] = [];

  for (const crudo of datos) {
    const leido = esquemaOrdenWsV3.safeParse(crudo);
    if (!leido.success) continue;

    const o = leido.data;
    const clientOid = o.clientOid ?? o.clientOrderId ?? '';
    const symbol = o.symbol ?? o.instId ?? '';
    if (clientOid === '' || symbol === '') continue;

    salida.push({
      orderId: o.orderId ?? '',
      clientOid,
      symbol,
      state: o.status ?? o.state ?? '',
      size: o.qty ?? o.size ?? null,
      baseVolume: o.filledQty ?? o.baseVolume ?? null,
      priceAvg: o.avgPrice ?? o.priceAvg ?? null
    });
  }

  return salida;
}

/**
 * El disponible que trae un empujon del tema `account`, o `null`.
 *
 * ==========================================================================
 * Por que existe este tema y V2 no lo tiene
 * ==========================================================================
 * El pool de V2 se suscribe a `positions` y `orders-algo`, y **no** al canal de
 * cuenta: en Classic el saldo lo refresca el barrido REST cada 45 s, tal como
 * explica la cabecera de `barrido-posiciones.ts`. En UTA el tema `account` viene
 * en el alcance, asi que el saldo de una subcuenta UTA se actualiza al momento.
 *
 * La asimetria es de latencia, no de contenido: las dos enseñan el mismo numero
 * en la misma columna, y la Classic lo enseña con hasta 45 s de retraso, que es
 * lo que ya hacia ayer.
 *
 * `null` cuando la respuesta no trae la moneda del mercado, y quien llama **no
 * escribe nada** en ese caso. Es la misma regla que `leerSaldo`: no escribir
 * conserva el ultimo saldo conocido, mientras que escribir un cero por no haber
 * encontrado la fila pondria a cero una cuenta con dinero.
 */
export function saldoDeEmpujon(datos: readonly unknown[], moneda: string): string | null {
  const leido = esquemaActivosCuenta.safeParse(datos);
  if (!leido.success) return null;
  return disponibleDe(leido.data, moneda);
}

/** `null` cuando el lado no es reconocible: sin el, la posicion no se puede colocar. */
function ladoDe(valor: string | null | undefined): Lado | null {
  const texto = (valor ?? '').toLowerCase();
  if (texto === 'long') return 'long';
  if (texto === 'short') return 'short';
  return null;
}
