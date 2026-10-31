/**
 * Lo que Bitget registra de una subcuenta, traducido a `EventoCuenta`.
 *
 * Una función por tipo de registro y superficie —órdenes, planes TP/SL,
 * movimientos de cuenta, en V2 y en V3—, y un lector que los junta. Las formas
 * están verificadas contra la API real el 15/10/2026: fixture en
 * `test/fixtures/alertas/bitget-registros.json`, detalle en
 * docs/00-alertas-fase-1.md.
 *
 * Solo lee. Todo pasa por el cliente y su limitador, con el reintento de
 * lecturas de `historial/reintento.ts`.
 */
import { z } from 'zod';
import type { Mercado } from '../bitget/mercado';
import { categoriaDe } from '../bitget/superficie';
import type { ClienteBitget } from '../bitget/rest/client';
import { superficieDe, type Credencial } from '../bitget/rest/signer';
import { obtenerCuentaSimbolo } from '../bitget/rest/endpoints/cuenta';
import { obtenerAjustesCuenta } from '../bitget/rest/endpoints/ajustes-v3';
import { leerConReintentos } from '../historial/reintento';
import { tramosDe } from '../historial/paginador';
import { planTpV2, planTpV3, type PlanTp } from '../historial/take-profit';
import { esAutomatico } from './clasificador';
import type { AjustesSimbolo, EventoCuenta, TipoEvento } from './tipos';

const DIA = 86_400_000;
/** Órdenes y planes: Bitget no entrega más de 90 días ni admite rangos mayores. */
export const VENTANA_ORDENES_MS = 89 * DIA;
/** Movimientos de cuenta: probado con 29 días; se piden en tramos de ese tamaño. */
export const VENTANA_MOVIMIENTOS_MS = 29 * DIA;
const LIMITE = 100;
const MAX_PAGINAS = 50;

type Registro = Record<string, unknown>;

/* ---------------- lectura de campos ---------------- */

const s = (o: Registro, k: string): string | null => {
  const v = o[k];
  if (typeof v === 'string') return v === '' ? null : v;
  if (typeof v === 'number') return String(v);
  return null;
};

const ms = (o: Registro, k: string): number => {
  const n = Number(o[k]);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const lado = (v: string | null): 'long' | 'short' | null => {
  const l = (v ?? '').toLowerCase();
  if (l === 'long' || l.endsWith('_long') || l.includes('long')) return 'long';
  if (l === 'short' || l.endsWith('_short') || l.includes('short')) return 'short';
  return null;
};

const absoluto = (v: string | null): string | null => (v === null ? null : v.replace(/^-/, ''));

/** Las listas llegan en `entrustedList`, `bills`, `list`… o sueltas. */
export function listaDe(datos: unknown): Registro[] {
  if (Array.isArray(datos)) return datos as Registro[];
  if (datos !== null && typeof datos === 'object') {
    for (const v of Object.values(datos as Registro)) {
      if (Array.isArray(v)) return v as Registro[];
    }
  }
  return [];
}

function evento(
  parcial: Partial<EventoCuenta> & Pick<EventoCuenta, 'clave' | 'tipo' | 'cuandoMs'>
): EventoCuenta {
  return {
    simbolo: null,
    lado: null,
    cantidad: null,
    precio: null,
    importe: null,
    origen: null,
    clientOid: null,
    orderId: null,
    automatico: false,
    detalle: null,
    ...parcial
  };
}

/* ---------------- órdenes ---------------- */

/** Orden V2 ejecutada. `null` si no se ejecutó (cancelada sin llenar). */
export function ordenV2AEvento(o: Registro): EventoCuenta | null {
  const volumen = Number(s(o, 'baseVolume') ?? '0');
  if (!(volumen > 0) && s(o, 'status') !== 'filled') return null;

  const tradeSide = (s(o, 'tradeSide') ?? '').toLowerCase();
  const tipo: TipoEvento = tradeSide.includes('open')
    ? 'abrir'
    : tradeSide.includes('close')
      ? 'cerrar'
      : 'orden';

  return evento({
    clave: `orden:${s(o, 'orderId') ?? ''}`,
    tipo,
    cuandoMs: ms(o, 'cTime'),
    simbolo: s(o, 'symbol'),
    lado: lado(s(o, 'posSide')) ?? lado(tradeSide),
    cantidad: s(o, 'baseVolume') ?? s(o, 'size'),
    precio: s(o, 'priceAvg') ?? s(o, 'price'),
    origen: s(o, 'enterPointSource'),
    clientOid: s(o, 'clientOid'),
    orderId: s(o, 'orderId'),
    automatico: esAutomatico({
      orderSource: o['orderSource'],
      enterPointSource: o['enterPointSource'],
      tradeSide: o['tradeSide']
    })
  });
}

/**
 * Orden V3 ejecutada.
 *
 * V3 no dice si abrió o cerró: se deduce del lado de la posición y del de la
 * orden. Comprar en una long abre; vender en una long la cierra.
 */
export function ordenV3AEvento(o: Registro): EventoCuenta | null {
  if (!(Number(s(o, 'cumExecQty') ?? '0') > 0)) return null;

  const posSide = lado(s(o, 'posSide'));
  const side = (s(o, 'side') ?? '').toLowerCase();
  const tipo: TipoEvento =
    posSide === 'long'
      ? side === 'buy'
        ? 'abrir'
        : 'cerrar'
      : posSide === 'short'
        ? side === 'sell'
          ? 'abrir'
          : 'cerrar'
        : s(o, 'reduceOnly') === 'YES'
          ? 'cerrar'
          : 'orden';

  return evento({
    clave: `orden:${s(o, 'orderId') ?? ''}`,
    tipo,
    cuandoMs: ms(o, 'createdTime'),
    simbolo: s(o, 'symbol'),
    lado: posSide,
    cantidad: s(o, 'cumExecQty') ?? s(o, 'qty'),
    precio: s(o, 'avgPrice') ?? s(o, 'price'),
    clientOid: s(o, 'clientOid'),
    orderId: s(o, 'orderId'),
    automatico: esAutomatico({ delegateType: o['delegateType'], execType: o['execType'] })
  });
}

/* ---------------- planes TP/SL ---------------- */

const NOMBRE_PLAN: Record<string, string> = {
  pos_profit: 'TP',
  profit_plan: 'TP parcial',
  pos_loss: 'SL',
  loss_plan: 'SL parcial',
  moving_plan: 'Trailing stop',
  track_plan: 'Trailing stop',
  normal_plan: 'Orden condicional'
};

/**
 * Un plan V2 da hasta dos eventos: cuándo se puso y, si se canceló, cuándo se
 * quitó. Uno ejecutado no da más: dispararse es automático. Uno vivo
 * (`orders-plan-pending`) da solo el de «puesto», con la misma clave que tendrá
 * cuando pase al historial.
 *
 * Los vivos se leen porque el historial solo trae un plan **cuando termina**:
 * sin ellos, un TP puesto desde la app se avisaba al dispararse o cancelarse,
 * y si eso pasaba fuera de la ventana de la revisión, nunca (visto el
 * 28/10/2026).
 *
 * El de «quitado» no lleva el `clientOid`: que el TP lo pusiera el panel no
 * dice quién lo quitó. Eso lo decide la bitácora.
 */
export function planV2AEventos(p: Registro): EventoCuenta[] {
  const id = s(p, 'orderId') ?? '';
  const comun = {
    simbolo: s(p, 'symbol'),
    lado: lado(s(p, 'posSide')),
    cantidad: s(p, 'size'),
    precio: s(p, 'triggerPrice') ?? s(p, 'stopSurplusTriggerPrice') ?? s(p, 'stopLossTriggerPrice'),
    origen: s(p, 'enterPointSource'),
    orderId: id,
    detalle: NOMBRE_PLAN[s(p, 'planType') ?? ''] ?? 'TP/SL'
  };

  const salida = [
    evento({
      ...comun,
      clave: `plan:${id}:puesto`,
      tipo: 'tp-sl-puesto',
      cuandoMs: ms(p, 'cTime'),
      clientOid: s(p, 'clientOid')
    })
  ];
  if ((s(p, 'planStatus') ?? '').toLowerCase() === 'cancelled') {
    salida.push(
      evento({
        ...comun,
        clave: `plan:${id}:quitado`,
        tipo: 'tp-sl-quitado',
        cuandoMs: ms(p, 'uTime')
      })
    );
  }
  return salida;
}

export function planV3AEventos(p: Registro): EventoCuenta[] {
  const id = s(p, 'orderId') ?? '';
  const tp = s(p, 'takeProfit');
  const sl = s(p, 'stopLoss');
  const comun = {
    simbolo: s(p, 'symbol'),
    lado: lado(s(p, 'posSide')),
    cantidad: s(p, 'qty'),
    precio: tp ?? sl ?? s(p, 'triggerPrice'),
    orderId: id,
    detalle:
      tp !== null && sl !== null ? 'TP/SL' : tp !== null ? 'TP' : sl !== null ? 'SL' : 'TP/SL'
  };

  const salida = [
    evento({
      ...comun,
      clave: `plan:${id}:puesto`,
      tipo: 'tp-sl-puesto',
      cuandoMs: ms(p, 'createdTime'),
      clientOid: s(p, 'clientOid')
    })
  ];
  if ((s(p, 'status') ?? '').toLowerCase() === 'cancelled') {
    salida.push(
      evento({
        ...comun,
        clave: `plan:${id}:quitado`,
        tipo: 'tp-sl-quitado',
        cuandoMs: ms(p, 'updatedTime')
      })
    );
  }
  return salida;
}

/* ---------------- movimientos de cuenta ---------------- */

/**
 * Movimiento V2 de margen o de traspaso. Lo demás —comisiones, financiamiento,
 * aperturas y cierres, margen automático— se ignora: o es automático o ya lo
 * cuentan las órdenes.
 */
export function movimientoV2AEvento(b: Registro): EventoCuenta | null {
  const tipoBitget = (s(b, 'businessType') ?? '').toLowerCase();
  const tipo: TipoEvento | null =
    tipoBitget === 'append_margin'
      ? 'margen-agregado'
      : tipoBitget === 'adjust_down_margin'
        ? 'margen-quitado'
        : tipoBitget.startsWith('trans_from')
          ? 'traspaso-entrada'
          : tipoBitget.startsWith('trans_to')
            ? 'traspaso-salida'
            : null;
  if (tipo === null) return null;

  return evento({
    clave: `mov:${s(b, 'billId') ?? ''}`,
    tipo,
    cuandoMs: ms(b, 'cTime'),
    simbolo: s(b, 'symbol'),
    importe: absoluto(s(b, 'amount')),
    detalle: tipoBitget
  });
}

export function movimientoV3AEvento(r: Registro): EventoCuenta | null {
  const tipoBitget = (s(r, 'type') ?? '').toUpperCase();
  const importe = s(r, 'amount');
  const tipo: TipoEvento | null =
    tipoBitget === 'INCREASE_MARGIN'
      ? 'margen-agregado'
      : tipoBitget === 'DECREASE_MARGIN' || tipoBitget === 'REDUCE_MARGIN'
        ? 'margen-quitado'
        : tipoBitget.includes('TRANS')
          ? (importe ?? '').startsWith('-')
            ? 'traspaso-salida'
            : 'traspaso-entrada'
          : null;
  if (tipo === null) return null;

  return evento({
    clave: `mov:${s(r, 'id') ?? ''}`,
    tipo,
    cuandoMs: ms(r, 'ts'),
    simbolo: s(r, 'symbol'),
    importe: absoluto(importe),
    detalle: tipoBitget
  });
}

/* ---------------- lectura paginada ---------------- */

/**
 * Todo lo de `[desdeMs, hastaMs]`, por tramos y por fecha.
 *
 * Mismo método que el historial (ver `historial/paginador.ts`): el cursor de
 * Bitget pierde registros en la frontera de página, así que se pide la página
 * siguiente con `endTime` = el registro más antiguo recibido y se descartan
 * los repetidos.
 */
async function recorrer(
  pedir: (desdeMs: number, hastaMs: number) => Promise<Registro[]>,
  desdeMs: number,
  hastaMs: number,
  ventanaMs: number,
  tiempo: (r: Registro) => number,
  id: (r: Registro) => string
): Promise<Registro[]> {
  const porId = new Map<string, Registro>();
  for (const [inicio, finTramo] of tramosDe(desdeMs, hastaMs, ventanaMs)) {
    let fin = finTramo;
    for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
      const lote = await pedir(inicio, fin);
      let nuevos = 0;
      for (const r of lote) {
        const k = id(r);
        if (!porId.has(k)) {
          porId.set(k, r);
          nuevos++;
        }
      }
      if (lote.length < LIMITE || nuevos === 0) break;
      fin = Math.min(...lote.map(tiempo).filter((t) => t > 0));
    }
  }
  return [...porId.values()];
}

/* ---------------- planes TP para el historial ---------------- */

/**
 * Los TP terminados —ejecutados o cancelados— creados en `[desdeMs, hastaMs]`.
 * Lo usa el historial de posiciones para enseñar el TP que tenía cada una; ver
 * `historial/take-profit.ts`.
 */
export async function leerPlanesTp(
  cliente: ClienteBitget,
  credencial: Credencial,
  mercado: Mercado,
  desdeMs: number,
  hastaMs: number
): Promise<PlanTp[]> {
  const get = async (ruta: string, consulta: Record<string, string>): Promise<Registro[]> =>
    leerConReintentos(() =>
      cliente.peticionFirmada(
        credencial,
        { metodo: 'GET', ruta, consulta, idempotente: true },
        z.unknown()
      )
    ).then((r) => listaDe(r.datos));
  const rango = (d: number, h: number) => ({
    startTime: String(Math.floor(d)),
    endTime: String(Math.floor(h)),
    limit: String(LIMITE)
  });

  if (superficieDe(credencial) === 'v3') {
    const planes = await recorrer(
      (d, h) =>
        get('/api/v3/trade/history-strategy-orders', {
          category: categoriaDe(mercado),
          ...rango(d, h)
        }),
      desdeMs,
      hastaMs,
      VENTANA_ORDENES_MS,
      (r) => ms(r, 'createdTime'),
      (r) => s(r, 'orderId') ?? JSON.stringify(r)
    );
    return planes.map(planTpV3).filter((p): p is PlanTp => p !== null);
  }

  const planes = await recorrer(
    (d, h) =>
      get('/api/v2/mix/order/orders-plan-history', {
        productType: mercado.productType,
        planType: 'profit_loss',
        ...rango(d, h)
      }),
    desdeMs,
    hastaMs,
    VENTANA_ORDENES_MS,
    (r) => ms(r, 'cTime'),
    (r) => s(r, 'orderId') ?? JSON.stringify(r)
  );
  return planes.map(planTpV2).filter((p): p is PlanTp => p !== null);
}

/* ---------------- lector de una subcuenta ---------------- */

export interface FuentesCuenta {
  /** Movimientos de la subcuenta con fecha en `[desdeMs, hastaMs]`. */
  eventos(desdeMs: number, hastaMs: number): Promise<EventoCuenta[]>;
  /** Apalancamiento y modo de cada símbolo, como están ahora. */
  ajustes(simbolos: readonly string[]): Promise<Record<string, AjustesSimbolo>>;
}

export function fuentesBitget(
  cliente: ClienteBitget,
  credencial: Credencial,
  mercado: Mercado,
  dormir?: (ms: number) => Promise<void>
): FuentesCuenta {
  const v3 = superficieDe(credencial) === 'v3';
  const opcionesReintento = dormir === undefined ? {} : { dormir };

  const get = async (ruta: string, consulta: Record<string, string>): Promise<Registro[]> =>
    leerConReintentos(
      () =>
        cliente.peticionFirmada(
          credencial,
          { metodo: 'GET', ruta, consulta, idempotente: true },
          z.unknown()
        ),
      opcionesReintento
    ).then((r) => listaDe(r.datos));

  const rango = (desde: number, hasta: number) => ({
    startTime: String(Math.floor(desde)),
    endTime: String(Math.floor(hasta)),
    limit: String(LIMITE)
  });
  const mercadoV2 = { productType: mercado.productType };
  const mercadoV3 = { category: categoriaDe(mercado) };

  return {
    async eventos(desdeMs, hastaMs) {
      const salida: EventoCuenta[] = [];
      /* Los planes se piden siempre de 89 días: quitar hoy un TP de hace un mes también cuenta. */
      const desdePlanes = Math.max(hastaMs - VENTANA_ORDENES_MS, 0);

      if (v3) {
        const ordenes = await recorrer(
          (d, h) => get('/api/v3/trade/history-orders', { ...mercadoV3, ...rango(d, h) }),
          desdeMs,
          hastaMs,
          VENTANA_ORDENES_MS,
          (r) => ms(r, 'createdTime'),
          (r) => s(r, 'orderId') ?? JSON.stringify(r)
        );
        const planes = await recorrer(
          (d, h) => get('/api/v3/trade/history-strategy-orders', { ...mercadoV3, ...rango(d, h) }),
          desdePlanes,
          hastaMs,
          VENTANA_ORDENES_MS,
          (r) => ms(r, 'createdTime'),
          (r) => s(r, 'orderId') ?? JSON.stringify(r)
        );
        const movimientos = await recorrer(
          (d, h) => get('/api/v3/account/financial-records', { ...mercadoV3, ...rango(d, h) }),
          desdeMs,
          hastaMs,
          VENTANA_MOVIMIENTOS_MS,
          (r) => ms(r, 'ts'),
          (r) => s(r, 'id') ?? JSON.stringify(r)
        );
        /* Los vivos: el historial solo trae un plan cuando termina. */
        planes.push(
          ...(await get('/api/v3/trade/unfilled-strategy-orders', { ...mercadoV3, type: 'tpsl' }))
        );
        for (const o of ordenes) {
          const e = ordenV3AEvento(o);
          if (e) salida.push(e);
        }
        for (const p of planes) salida.push(...planV3AEventos(p));
        for (const m of movimientos) {
          const e = movimientoV3AEvento(m);
          if (e) salida.push(e);
        }
      } else {
        const ordenes = await recorrer(
          (d, h) => get('/api/v2/mix/order/orders-history', { ...mercadoV2, ...rango(d, h) }),
          desdeMs,
          hastaMs,
          VENTANA_ORDENES_MS,
          (r) => ms(r, 'cTime'),
          (r) => s(r, 'orderId') ?? JSON.stringify(r)
        );
        const planes: Registro[] = [];
        for (const planType of ['profit_loss', 'normal_plan']) {
          planes.push(
            ...(await recorrer(
              (d, h) =>
                get('/api/v2/mix/order/orders-plan-history', {
                  ...mercadoV2,
                  planType,
                  ...rango(d, h)
                }),
              desdePlanes,
              hastaMs,
              VENTANA_ORDENES_MS,
              (r) => ms(r, 'cTime'),
              (r) => s(r, 'orderId') ?? JSON.stringify(r)
            ))
          );
          /* Los vivos: el historial solo trae un plan cuando termina. */
          planes.push(
            ...(await get('/api/v2/mix/order/orders-plan-pending', { ...mercadoV2, planType }))
          );
        }
        const movimientos = await recorrer(
          (d, h) => get('/api/v2/mix/account/bill', { ...mercadoV2, ...rango(d, h) }),
          desdeMs,
          hastaMs,
          VENTANA_MOVIMIENTOS_MS,
          (r) => ms(r, 'cTime'),
          (r) => s(r, 'billId') ?? JSON.stringify(r)
        );
        for (const o of ordenes) {
          const e = ordenV2AEvento(o);
          if (e) salida.push(e);
        }
        for (const p of planes) salida.push(...planV2AEventos(p));
        for (const m of movimientos) {
          const e = movimientoV2AEvento(m);
          if (e) salida.push(e);
        }
      }

      /* Un plan que terminó entre la lectura de vivos y la del historial sale en las dos. */
      const porClave = new Map<string, EventoCuenta>();
      for (const e of salida) {
        if (e.cuandoMs >= desdeMs && e.cuandoMs <= hastaMs && !porClave.has(e.clave)) {
          porClave.set(e.clave, e);
        }
      }
      return [...porClave.values()];
    },

    async ajustes(simbolos) {
      const salida: Record<string, AjustesSimbolo> = {};

      if (v3) {
        const r = await leerConReintentos(
          () => obtenerAjustesCuenta(cliente, credencial),
          opcionesReintento
        );
        const lista = r.datos.symbolConfigList ?? [];
        for (const simbolo of simbolos) {
          const cfg = lista.find((c) => c.symbol === simbolo);
          /* Sin entrada, Bitget lo trata como cruzado (capturado el 30/09/2026). */
          const lev =
            cfg?.leverage === null || cfg?.leverage === undefined ? null : String(cfg.leverage);
          salida[simbolo] = {
            modo: cfg === undefined ? 'crossed' : (cfg.marginMode ?? null),
            largo: lev,
            corto: lev,
            cruzado: lev
          };
        }
        return salida;
      }

      for (const simbolo of simbolos) {
        try {
          const r = await leerConReintentos(
            () =>
              obtenerCuentaSimbolo(
                cliente,
                credencial,
                simbolo,
                mercado.productType,
                mercado.marginCoin
              ),
            opcionesReintento
          );
          const t = (v: number | null | undefined): string | null =>
            v === null || v === undefined ? null : String(v);
          salida[simbolo] = {
            modo: r.datos.marginMode === '' ? null : r.datos.marginMode,
            largo: t(r.datos.isolatedLongLever),
            corto: t(r.datos.isolatedShortLever),
            cruzado: t(r.datos.crossedMarginLeverage)
          };
        } catch {
          /* Un símbolo que no se pudo leer no se compara esta vez; los demás sí. */
        }
      }
      return salida;
    }
  };
}
