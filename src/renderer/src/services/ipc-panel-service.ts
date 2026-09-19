/**
 * `PanelService` cableado al proceso principal real, vía `window.pcb`.
 *
 * Implementa lo que el backend expone por IPC (`shared/ipc-contract.ts`):
 * vault, registro de cuentas, catálogo de activos y las seis operaciones de la
 * Fase 4. Lo que aún no tiene respaldo real lanza `NotImplementedError` con el
 * nombre exacto del método, en vez de inventar datos.
 *
 * --------------------------------------------------------------------------
 * Aquí se traduce, no se decide
 * --------------------------------------------------------------------------
 * Los planes llegan del proceso principal ya calculados: cantidades, precios y
 * motivos de descarte vienen hechos. Esta clase solo los pasa a la forma que
 * dibuja la pantalla —un título, una línea de resumen y una lista de casillas—
 * y traduce el informe del lote a los desenlaces que el operador ve. Ningún
 * número se recalcula aquí: si se recalculara, la pantalla podría enseñar una
 * cifra distinta de la que se envió.
 */
import type {
  Account,
  ApiKeyInput,
  ApiKeyRow,
  ApiKeyStatus,
  Asset,
  Balance,
  BalanceSheet,
  BatchFailure,
  BatchPlan,
  BatchResult,
  BatchTarget,
  ClosedPosition,
  CloseRequest,
  DeleteOutcome,
  LeverageRequest,
  MarginRequest,
  OpenRequest,
  ParentAccount,
  ParentAccountInput,
  ParentValidationResult,
  SpreadMode,
  SpreadPlan,
  SpreadResult,
  TransferPlan,
  TransferRecord,
  TransferResult,
  PlanDiscard,
  PlanKind,
  ImportResult,
  BackupInfo,
  BackupResult,
  RestoreResult,
  Position,
  PositionSnapshot,
  SystemInfo,
  TpRequest,
  UnlockResult,
  ValidationResult
} from '@shared/domain/panel-view';
import type {
  ActivoIpc,
  CuentaPanel,
  MadreIpc,
  PlanRepartoIpc,
  PlanTraspasoIpc
} from '@shared/ipc-contract';
import type { EstadoConexion, EstadoJob, Lado, Lote, PosicionMonitor } from '@shared/types';
import {
  NotImplementedError,
  type PanelService,
  type Unsubscribe
} from '@shared/ports/panel-service';

const ESTADO_A_STATUS: Record<EstadoConexion, ApiKeyStatus> = {
  conectada: 'ok',
  'modo-rest': 'ok',
  conectando: 'conectando',
  desconectada: 'error'
};

/**
 * Un activo del proceso principal, o el hueco de una casilla vacía.
 *
 * Acepta `null` porque las ocho casillas del selector llegan con sus huecos: la
 * posición es parte del dato —el operador las edita por su número— y compactar
 * la lista aquí las renumeraría al vaciar una.
 */
const aActivo = (a: ActivoIpc | null): Asset | null =>
  a === null
    ? null
    : {
        id: a.id,
        symbol: a.simbolo,
        label: a.etiqueta,
        priceDecimals: a.decimalesPrecio,
        maxLeverage: a.apalancamientoMax,
        minLeverage: a.apalancamientoMin,
        tradable: a.operable
      };

/** Proyección de la matriz tal como la envía el proceso principal. */
const aCuenta = (c: CuentaPanel): Account => ({
  id: c.id,
  name: c.nombre,
  subAccounts: c.subcuentas.map((s) => ({
    id: s.id,
    accountId: c.id,
    label: s.etiqueta,
    slot: s.slot,
    balance: s.saldo,
    status: ESTADO_A_STATUS[s.estado],
    statusReason: s.motivo
  }))
});

/** El plan de reparto o recogida, traducido al vocabulario de la pantalla. */
const aPlanReparto = (p: PlanRepartoIpc): SpreadPlan => ({
  id: p.id,
  parentUid: p.uidMadre,
  kind: p.tipo,
  mode: p.modo,
  currency: p.moneda,
  total: p.total,
  moves: p.movimientos.map((m) => ({
    fromUid: m.uidOrigen,
    fromLabel: m.etiquetaOrigen,
    toUid: m.uidDestino,
    toLabel: m.etiquetaDestino,
    amount: m.importe,
    before: m.antes,
    after: m.despues
  })),
  skipped: p.descartes.map((d) => ({
    uid: d.uid,
    label: d.etiqueta,
    reason: d.motivo,
    message: d.mensaje
  })),
  createdAt: p.creadoEn
});

/** El plan de traspaso, traducido al vocabulario de la pantalla. */
const aPlanTraspaso = (p: PlanTraspasoIpc): TransferPlan => ({
  id: p.id,
  parentUid: p.uidMadre,
  from: {
    uid: p.origen.uid,
    label: p.origen.etiqueta,
    before: p.origen.antes,
    after: p.origen.despues
  },
  to: {
    uid: p.destino.uid,
    label: p.destino.etiqueta,
    before: p.destino.antes,
    after: p.destino.despues
  },
  amount: p.importe,
  currency: p.moneda,
  maxTransferable: p.maxTransferible,
  createdAt: p.creadoEn
});

/** Una cuenta principal registrada, tal como la envía el proceso principal. */
const traducirMadre = (m: MadreIpc): ParentAccount => ({
  id: m.id,
  uid: m.uidMadre,
  name: m.etiqueta,
  maskedKey: m.apiKeyEnmascarada,
  addedAt: m.altaEn,
  subAccountsSeen: m.subcuentasVistas
});

/**
 * Una punta viva del proceso principal, traducida a lo que dibuja la pantalla.
 *
 * Es traducción campo a campo y nada más: los cuatro distintivos se derivan de
 * lo que la punta ya trae, sin preguntar nada ni recalcular ningún número.
 *
 * `tpDisplay` queda vacío —y el distintivo enseña un guion— cuando hay Take
 * Profit pero no se sabe con qué porcentaje se puso. Pasa con las posiciones
 * que ya estaban abiertas al arrancar: de esas el panel lee el precio de
 * disparo del exchange, pero el porcentaje era del formulario y no viaja en
 * ninguna respuesta. El precio sí se enseña, en su columna.
 */
const aPosicion = (p: PosicionMonitor): Position => ({
  subAccountId: p.cuentaId,
  side: p.lado,
  assetId: p.activoId,
  entryPrice: p.entrada,
  liquidationPrice: p.liquidacion,
  takeProfitPrice: p.takeProfit,
  initialMarginAccum: p.margenInicial,
  pnl: p.pnl,
  roe: p.roe,
  leverage: p.apalancamiento,
  actions: {
    /* Si llega hasta aquí, está abierta: es lo que significa estar viva. */
    oe: true,
    tp: p.takeProfit !== null,
    mg: p.margenAdicional !== null,
    /* El apalancamiento siempre está puesto; lo que importa es cuál. */
    ap: true,
    tpDisplay: p.takeProfitPorcentaje === null ? '' : `${p.takeProfitPorcentaje}%`,
    mgDisplay: p.margenAdicional ?? '',
    apDisplay: `${p.apalancamiento}x`
  },
  /*
   * Sin calcular todavía, y por eso `false` en lugar de un valor inventado.
   *
   * «En riesgo de liquidación» es la distancia del precio de ahora al de
   * liquidación, y eso pide el precio de marca junto a la posición y un umbral
   * con justificación escrita en `shared/constants.ts`. Ninguna de las dos cosas
   * entra en esta rebanada, que es liquidación, entrada y Take Profit. Poner
   * aquí una aproximación —la pérdida no realizada contra el margen, por
   * ejemplo— encendería el banner CRÍTICO con un umbral que nadie aprobó, y ese
   * banner solo sirve mientras el operador se lo crea.
   */
  marginCritical: false,
  hasError: p.estado === 'sin-conexion' || p.estado === 'indeterminada',
  errorReason: p.motivo,
  openedAt: p.abiertaEn
});

/**
 * Cada cuánto se vuelve a preguntar el precio de los activos.
 *
 * Tres segundos es el mismo ritmo que el monitor y está muy por debajo del
 * presupuesto de peticiones: son cinco consultas públicas, sin firmar y sin
 * cuota por cuenta.
 */
const REFRESCO_PRECIOS_MS = 3_000;

/** La pantalla habla de casillas; el proceso principal, de cuenta y lado. */
const aObjetivo = (t: BatchTarget): { cuentaId: string; lado: Lado } => ({
  cuentaId: t.subAccountId,
  lado: t.side
});

/** Los descartes se enseñan junto al plan: una casilla que no sale, se ve. */
const aDescartes = (
  ds: readonly { cuentaId: string; etiqueta: string; lado: Lado; mensaje: string }[]
): PlanDiscard[] =>
  ds.map((d) => ({
    subAccountId: d.cuentaId,
    side: d.lado,
    label: d.etiqueta,
    reason: d.mensaje
  }));

/** El canal de ejecución de cada tipo de plan. */
const EJECUTORES: Record<
  PlanKind,
  (planId: string, soloEstos?: { cuentaId: string; lado: Lado }[]) => Promise<Lote>
> = {
  open: (id, solo) => window.pcb.aperturaEjecutar(id, solo),
  close: (id, solo) => window.pcb.cierreEjecutar(id, solo),
  tp: (id, solo) => window.pcb.tpEjecutar(id, solo),
  'tp-remove': (id, solo) => window.pcb.tpEjecutarQuitar(id, solo),
  /* Los dos sentidos comparten canal: la dirección ya viajó con el plan. */
  'margin-add': (id, solo) => window.pcb.margenEjecutar(id, solo),
  'margin-remove': (id, solo) => window.pcb.margenEjecutar(id, solo),
  leverage: (id, solo) => window.pcb.apalancamientoEjecutar(id, solo)
};

/**
 * El informe del lote, tal como lo lee un operador.
 *
 * Los cuatro desenlaces del motor no se colapsan en dos. `indeterminada` es el
 * que obliga a distinguirlos: la orden salió, no llegó respuesta y tampoco se
 * pudo averiguar después qué pasó. Contarla como fallo invitaría a reintentarla,
 * y reintentar a ciegas es lo único capaz de duplicar una posición. Por eso va
 * en su propia lista y queda fuera de «reintentar las fallidas».
 */
const aResultado = (label: string, lote: Lote): BatchResult => {
  const de = (estado: EstadoJob): BatchFailure[] =>
    lote.jobs
      .filter((j) => j.estado === estado)
      .map((j) => ({
        subAccountId: j.cuentaId,
        side: j.lado,
        reason:
          j.mensaje ?? (j.codigoBitget === null ? 'Sin detalle.' : `Bitget ${j.codigoBitget}`),
        /*
         * El `clientOid` vacío marca las filas que no son la operación en sí:
         * los descartes y las derivadas de la apertura -«Sub-01 · TP»,
         * «Sub-01 · MGA»-. Reintentarlas reenviaría la apertura entera, porque
         * el reintento se pide por cuenta y lado y las tres filas comparten los
         * dos. Ver `BatchFailure.retryable`.
         */
        retryable: j.clientOid !== ''
      }));

  return {
    label,
    ok: lote.jobs.filter((j) => j.estado === 'exito').length,
    skipped: lote.jobs.filter((j) => j.estado === 'omitida').length,
    failures: de('fallo'),
    undetermined: de('indeterminada')
  };
};

/** Traduce el `motivo` crudo de `ErrorVault` (proceso principal) a texto para el operador. */
const MOTIVO_VAULT_A_TEXTO: Record<string, string> = {
  'contrasena-incorrecta': 'Contraseña incorrecta.',
  'no-existe': 'No hay ningún almacén de credenciales en este equipo.',
  'ya-existe': 'Ya existe un almacén de credenciales en este equipo.'
};

/**
 * Los dos canales de restauración devuelven lo mismo; solo cambia de dónde sale
 * el archivo. La traducción se escribe una vez.
 */
const aRestauracion = (r: {
  cancelado: boolean;
  ok: boolean;
  motivo: string | null;
  mensaje: string;
  cuentas: number | null;
  reemplazo: string | null;
}): RestoreResult => ({
  cancelled: r.cancelado,
  ok: r.ok,
  reason: r.motivo,
  message: r.mensaje,
  accounts: r.cuentas,
  replaced: r.reemplazo
});

export class IpcPanelService implements PanelService {
  /* ---------------- sistema ---------------- */

  async getSystemInfo(): Promise<SystemInfo> {
    const info = await window.pcb.sistemaInfo();
    return {
      appVersion: info.appVersion,
      panelNumber: info.numeroPanel,
      portable: info.portable,
      market: info.mercado
    };
  }

  /**
   * Cambia el número visible del panel. Lo guarda `instancia.json`.
   *
   * Estuvo sin implementar hasta el 28/08/2026 —lanzaba `NotImplemented`— y esa
   * era la brecha completa: la pantalla dejaba teclear el número, el store lo
   * aplicaba en el acto y el aviso «número de panel no persistido» pasaba
   * desapercibido, así que el cambio duraba hasta el siguiente arranque.
   */
  async setPanelNumber(numeroPanel: number): Promise<void> {
    await window.pcb.sistemaFijarNumeroPanel(numeroPanel);
  }

  /* ---------------- activos ---------------- */

  async listAssetSlots(): Promise<(Asset | null)[]> {
    return (await window.pcb.mercadoRanuras()).map(aActivo);
  }

  async listAssetCatalog(): Promise<Asset[]> {
    return (await window.pcb.mercadoCatalogo()).map((a) => aActivo(a) as Asset);
  }

  async setAssetSlot(index: number, symbol: string | null): Promise<(Asset | null)[]> {
    return (await window.pcb.mercadoFijarRanura(index, symbol)).map(aActivo);
  }

  /**
   * Precios por sondeo, no por WebSocket.
   *
   * El canal de posiciones en vivo es de la Fase 6. Hasta entonces la pantalla
   * pregunta el precio de marca cada pocos segundos, que para un selector de
   * activo sobra: con este número no se opera —cada plan trae el suyo, leído en
   * el instante de planificar— sino que sirve para orientarse.
   */
  subscribeAssetPrices(cb: (precios: Readonly<Record<string, string>>) => void): Unsubscribe {
    let vivo = true;

    const sondear = async (): Promise<void> => {
      try {
        const precios = await window.pcb.mercadoPrecios();
        if (vivo) cb(precios);
      } catch {
        /* Un fallo de red deja el precio anterior; no hay nada que avisar. */
      }
    };

    void sondear();
    const temporizador = setInterval(() => void sondear(), REFRESCO_PRECIOS_MS);

    return () => {
      vivo = false;
      clearInterval(temporizador);
    };
  }

  /* ---------------- lectura ---------------- */

  async getAccounts(): Promise<Account[]> {
    return (await window.pcb.panelCuentas()).map(aCuenta);
  }

  subscribeAccounts(cb: (accounts: Account[]) => void): Unsubscribe {
    return window.pcb.suscribir('panel:cuentas', (cuentas) => cb(cuentas.map(aCuenta)));
  }

  /**
   * Saldo de una subcuenta, de la misma proyeccion que dibuja la matriz.
   *
   * No sale a Bitget: el saldo llega con la verificacion de la credencial y el
   * proceso principal lo mantiene. Pedirlo aparte gastaria una peticion del
   * cupo por cada consulta y devolveria exactamente el mismo numero.
   */
  async getBalance(subAccountId: string): Promise<Balance> {
    for (const cuenta of await window.pcb.panelCuentas()) {
      const sub = cuenta.subcuentas.find((s) => s.id === subAccountId);
      if (sub) return { subAccountId, total: sub.saldo };
    }
    throw new Error(`La subcuenta ${subAccountId} ya no está registrada en este panel.`);
  }

  async getHistory(): Promise<ClosedPosition[]> {
    /* Excluido por contrato hoy: docs/03-modelo-de-datos.md linea 684. */
    throw new NotImplementedError('getHistory');
  }

  /**
   * Las posiciones vivas, del proceso principal.
   *
   * Se suscribe **antes** de pedir la foto inicial, no después: entre la
   * petición y la suscripción cabe un empujón, y perderlo dejaría la pantalla
   * con una posición cerrada dibujada hasta el siguiente cambio, que puede
   * tardar minutos. Suscribirse primero puede repetir un dato; al revés,
   * pierde uno.
   */
  subscribePositions(cb: (snapshot: PositionSnapshot) => void): Unsubscribe {
    let vivo = true;

    const cancelar = window.pcb.suscribir('monitor:posiciones', (posiciones) => {
      if (vivo) cb({ positions: posiciones.map(aPosicion) });
    });

    void window.pcb.monitorInstantanea().then(
      (posiciones) => {
        if (vivo) cb({ positions: posiciones.map(aPosicion) });
      },
      () => {
        /*
         * La foto inicial no se pudo leer. No es motivo para tumbar la
         * suscripción: el primer empujón la deja al día igual, y hasta
         * entonces el monitor enseña que no hay nada, que es lo que sabe.
         */
      }
    );

    return () => {
      vivo = false;
      cancelar();
    };
  }

  /* ---------------- escritura, en dos fases ---------------- */

  async planOpen(req: OpenRequest): Promise<BatchPlan> {
    const activo = await this.activoDe(req.assetId);
    const plan = await window.pcb.aperturaPlanificar({
      simbolo: activo.simbolo,
      objetivos: req.targets.map(aObjetivo),
      margenInicial: req.initialMargin,
      apalancamiento: req.leverage,
      precioLimite: req.orderType === 'limit' ? req.limitPrice : null,
      modoMargen: req.marginMode,
      margenAdicional: req.additionalMargin,
      takeProfitPorcentaje: req.takeProfitPercent
    });

    /*
     * Cada cifra con su moneda al lado. La cantidad va en moneda base -331 XRP-
     * y los dos importes en moneda de margen -USDT en el mercado real, SUSDT en
     * el simulado-. Sin las unidades, «331 · 9,98 · 499,14» obliga a adivinar
     * cuál de los tres es dinero, y esta pantalla existe justamente para que no
     * se apruebe nada adivinando.
     */
    const moneda = plan.monedaMargen;

    return {
      kind: 'open',
      id: plan.id,
      title: 'Abrir posiciones',
      summary:
        `${req.initialMargin} ${moneda} de margen por casilla · ${req.leverage}x · ` +
        /*
         * El modo va en la primera línea y no en la letra pequeña: abrir lo deja
         * configurado en el activo, así que es un efecto de esta operación y no
         * un ajuste que ya estuviera puesto.
         */
        `${plan.modoMargen === 'isolated' ? 'AISLADO' : 'CRUZADO'} · ` +
        (req.orderType === 'limit' ? `límite ${req.limitPrice ?? '—'}` : 'a mercado') +
        /*
         * El Take Profit y el margen adicional se enumeran como un dato más de
         * la orden, sin repetir en cada uno que sale con ella.
         *
         * Lo repetían —«con la misma orden», dos veces en la misma línea—
         * mientras existía la otra vía, la de aplicarlos sueltos, y entonces
         * decir cuál era la que iba a usarse valía la pena. Ya no existe esa
         * otra vía: todo lo de esta línea sale con esta orden, y decirlo dos
         * veces solo alargaba el resumen hasta hacerlo saltar de línea.
         */
        (plan.takeProfitPorcentaje === null ? '' : ` · Take Profit ${plan.takeProfitPorcentaje}%`) +
        (plan.margenAdicional === null
          ? ''
          : ` · margen adicional ${plan.margenAdicional} ${moneda} por casilla ` +
            `(${plan.margenAdicionalTotal} en total)`),
      reference: plan.precioReferencia,
      entries: plan.entradas.map((e) => ({
        subAccountId: e.cuentaId,
        side: e.lado,
        label: e.etiqueta,
        detail:
          `${e.size} ${activo.id} · margen real ${e.margenReal} ${moneda} · ` +
          `nocional ${e.nocional} ${moneda}` +
          /*
           * «aprox.» no es un adorno: el precio de disparo definitivo se calcula
           * con el precio de entrada real de la posición, y este sale del de
           * referencia porque al aprobar todavía no hay posición.
           */
          (e.precioDisparoTp === null ? '' : ` · TP aprox. ${e.precioDisparoTp}`) +
          /*
           * Solo se dice cuando la apertura va a cambiarlo. Repetir «aislado» en
           * las cien casillas que ya lo están es ruido; anunciar «cruzado →
           * aislado» en la que sí cambia es el efecto que hay que aprobar.
           */
          (e.modoMargenActual === plan.modoMargen
            ? ''
            : ` · ${e.modoMargenActual === 'isolated' ? 'aislado' : 'cruzado'} → ` +
              `${plan.modoMargen === 'isolated' ? 'aislado' : 'cruzado'}`)
      })),
      discards: aDescartes(plan.descartes),
      /*
       * La única de las cuatro que puede venir impedida. Las otras tres no
       * comprometen saldo nuevo, así que no hay nada que pueda no caber.
       */
      blocker:
        plan.impedimento === null
          ? null
          : {
              code: plan.impedimento.codigo,
              message: plan.impedimento.mensaje,
              boxes: plan.impedimento.casillas
            }
    };
  }

  async planClose(req: CloseRequest): Promise<BatchPlan> {
    const activo = await this.activoDe(req.assetId);
    const plan = await window.pcb.cierrePlanificar({
      simbolo: activo.simbolo,
      objetivos: req.targets.map(aObjetivo)
    });

    return {
      kind: 'close',
      id: plan.id,
      title: 'Cerrar posiciones',
      summary: 'Cierre rápido: se cierra la posición entera, a mercado',
      reference: null,
      entries: plan.entradas.map((e) => ({
        subAccountId: e.cuentaId,
        side: e.lado,
        label: e.etiqueta,
        detail:
          `${e.size} ${activo.id} · entrada ${e.precioEntrada ?? '—'}` +
          (e.margenLiberado === null ? '' : ` · libera ${e.margenLiberado} ${plan.monedaMargen}`)
      })),
      /* Cerrar libera saldo, nunca lo compromete: no hay nada que pueda no caber. */
      discards: aDescartes(plan.descartes),
      blocker: null
    };
  }

  /**
   * Pone —o sustituye— el Take Profit de posiciones ya abiertas.
   *
   * El detalle de cada casilla dice de dónde sale el precio, y dice además qué
   * se quita cuando hay algo que quitar: «0,00263 → 0,00271» en vez de solo el
   * destino. Sustituir sin enseñar qué se sustituye es hacerlo a escondidas.
   */
  async planTakeProfit(req: TpRequest): Promise<BatchPlan> {
    const plan = await window.pcb.tpPlanificar({
      simbolo: (await this.activoDe(req.assetId)).simbolo,
      objetivos: req.targets.map(aObjetivo),
      porcentaje: req.percent
    });

    return {
      kind: 'tp',
      id: plan.id,
      title: 'Poner Take Profit',
      summary: `${req.percent}% de ganancia sobre el margen inicial de cada posición`,
      reference: null,
      entries: plan.entradas.map((e) => ({
        subAccountId: e.cuentaId,
        side: e.lado,
        label: e.etiqueta,
        detail:
          (e.precioDisparoAnterior === null
            ? `TP a ${e.precioDisparo}`
            : `TP ${e.precioDisparoAnterior} → ${e.precioDisparo} (sustituye el puesto)`) +
          ` · entrada ${e.precioEntrada} · ${e.apalancamiento}x · ` +
          `el precio se mueve ${e.movimientoPorcentaje}%`
      })),
      discards: aDescartes(plan.descartes),
      /* Poner Take Profit no compromete saldo: no hay nada que pueda no caber. */
      blocker: null
    };
  }

  async planRemoveTakeProfit(req: CloseRequest): Promise<BatchPlan> {
    const plan = await window.pcb.tpPlanificarQuitar({
      simbolo: (await this.activoDe(req.assetId)).simbolo,
      objetivos: req.targets.map(aObjetivo)
    });

    return {
      kind: 'tp-remove',
      id: plan.id,
      title: 'Quitar Take Profit',
      summary: 'Esas posiciones se quedan sin Take Profit: habrá que cerrarlas a mano',
      reference: null,
      entries: plan.entradas.map((e) => ({
        subAccountId: e.cuentaId,
        side: e.lado,
        label: e.etiqueta,
        detail: `se quita el Take Profit puesto en ${e.precioDisparo}`
      })),
      discards: aDescartes(plan.descartes),
      blocker: null
    };
  }

  /**
   * Agrega o retira margen de posiciones ya abiertas.
   *
   * El detalle es siempre `margen actual → resultante`, con el actual leído de
   * Bitget al planificar y no de lo que el panel recuerde. Es lo que hace
   * visible un envío repetido **antes** de enviarlo: una casilla que ya recibió
   * el margen se ve porque su «actual» ya lo lleva dentro.
   */
  async planMargin(req: MarginRequest): Promise<BatchPlan> {
    const quita = req.direction === 'quitar';
    const plan = await window.pcb.margenPlanificar({
      simbolo: (await this.activoDe(req.assetId)).simbolo,
      objetivos: req.targets.map(aObjetivo),
      cantidad: req.amount,
      direccion: req.direction
    });

    return {
      kind: quita ? 'margin-remove' : 'margin-add',
      id: plan.id,
      title: quita ? 'Quitar margen' : 'Agregar margen',
      summary:
        `${req.amount} ${plan.monedaMargen} por casilla · ` +
        (quita
          ? `libera ${plan.totalComprometido} ${plan.monedaMargen} en total`
          : `compromete ${plan.totalComprometido} ${plan.monedaMargen} en total`),
      reference: null,
      entries: plan.entradas.map((e) => ({
        subAccountId: e.cuentaId,
        side: e.lado,
        label: e.etiqueta,
        detail: `margen ${e.margenActual} → ${e.margenResultante} ${plan.monedaMargen}`
      })),
      discards: aDescartes(plan.descartes),
      /*
       * El saldo insuficiente se resuelve casilla a casilla, como descarte: cada
       * cuenta tiene el suyo, así que no hay un impedimento del lote entero.
       */
      blocker: null
    };
  }

  async planLeverage(req: LeverageRequest): Promise<BatchPlan> {
    const plan = await window.pcb.apalancamientoPlanificar({
      simbolo: (await this.activoDe(req.assetId)).simbolo,
      objetivos: req.targets.map(aObjetivo),
      apalancamiento: req.leverage
    });

    return {
      kind: 'leverage',
      id: plan.id,
      title: 'Ajustar apalancamiento',
      summary: `${req.leverage}x en las casillas seleccionadas`,
      reference: null,
      entries: plan.entradas.map((e) => ({
        subAccountId: e.cuentaId,
        side: e.lado,
        label: e.etiqueta,
        detail: `${e.apalancamientoActual ?? '?'}x → ${e.apalancamiento}x`
      })),
      discards: aDescartes(plan.descartes),
      blocker: null
    };
  }

  /**
   * Envía un plan ya aprobado. Solo viaja su `id`, nunca los números.
   *
   * Que el plan viva en el proceso principal es lo que hace imposible que algo
   * cambie entre lo que el operador aprobó y lo que sale hacia Bitget: aquí no
   * queda ninguna cantidad que se pudiera alterar.
   */
  async executePlan(plan: BatchPlan, only?: BatchTarget[]): Promise<BatchResult> {
    const soloEstos = only?.map(aObjetivo);
    const lote = await EJECUTORES[plan.kind](plan.id, soloEstos);
    return aResultado(plan.title, lote);
  }

  /* ---------------- contraseña de paso ---------------- */

  async hasStepPassword(): Promise<boolean> {
    return window.pcb.pasoHay();
  }

  /**
   * El activo del catálogo que corresponde a lo elegido en pantalla.
   *
   * La pantalla trabaja con `BTC` y la API con `BTCUSDT` —o `SBTCSUSDT` en el
   * mercado de pruebas—. La correspondencia la decide el proceso principal, que
   * es quien sabe en qué mercado está el panel.
   *
   * Devuelve el activo entero y no solo el símbolo porque la confirmación
   * necesita además su `id`: es el nombre de la moneda base con la que se
   * rotula la cantidad —`331 XRP`—, ya sin el prefijo del mercado simulado.
   */
  private async activoDe(assetId: string): Promise<ActivoIpc> {
    /*
     * Se busca entre las ocho casillas y no en el catálogo entero: lo que no
     * ocupa una casilla no se opera. Es la misma regla que sostiene el buscador
     * —elegir y operar son dos actos distintos—, y aquí es además la última
     * comprobación antes de planificar sobre un activo que ya no está.
     */
    const activo = (await window.pcb.mercadoRanuras()).find((a) => a !== null && a.id === assetId);
    if (activo === undefined || activo === null) {
      throw new Error(`El activo ${assetId} no está disponible en este mercado.`);
    }
    return activo;
  }

  /* ---------------- credenciales y seguridad ---------------- */

  async listApiKeys(): Promise<ApiKeyRow[]> {
    const filas = await window.pcb.cuentasListar();
    return filas.map((f) => ({
      id: f.id,
      subAccountLabel: f.etiqueta,
      accountName: f.grupoNombre,
      maskedKey: f.apiKeyEnmascarada,
      uid: f.uid,
      parentUid: f.uidPadre,
      status: ESTADO_A_STATUS[f.estado],
      reason: f.motivo,
      accountMode: f.accountMode,
      inTransition: f.enTransicion
    }));
  }

  async registerApiKey(input: ApiKeyInput): Promise<ValidationResult> {
    const resultado = await window.pcb.cuentasAgregar({
      etiqueta: input.subAccountLabel,
      grupoNombre: input.accountName,
      casilla: input.slot,
      apiKey: input.apiKey,
      secretKey: input.secretKey,
      passphrase: input.passphrase
    });
    return {
      ok: resultado.ok,
      verdict: resultado.veredicto,
      reason: resultado.motivo,
      warnings: resultado.advertencias.map((a) => ({ code: a.codigo, message: a.mensaje })),
      latencyMs: null,
      uid: resultado.cuenta?.uid ?? null,
      parentUid: resultado.cuenta?.uidPadre ?? null
    };
  }

  async testApiKey(id: string): Promise<ValidationResult> {
    const resultado = await window.pcb.cuentasVerificar(id);
    return {
      ok: resultado.ok,
      verdict: null,
      reason: resultado.motivo,
      warnings: resultado.advertencias.map((a) => ({ code: a.codigo, message: a.mensaje })),
      latencyMs: resultado.latenciaMs,
      uid: null,
      parentUid: null
    };
  }

  /*
   * La contraseña de paso viaja con la baja y la comprueba el proceso principal.
   * `ResultadoBaja` y `DeleteOutcome` son la misma respuesta a los dos lados de
   * la frontera, así que no hay nada que traducir aquí.
   */
  async deleteApiKey(id: string, stepPassword: string): Promise<DeleteOutcome> {
    return window.pcb.cuentasEliminar(id, stepPassword);
  }

  /* ---- cuentas madre y saldos ---- */

  async listParentAccounts(): Promise<ParentAccount[]> {
    return (await window.pcb.madresListar()).map(traducirMadre);
  }

  async registerParentAccount(input: ParentAccountInput): Promise<ParentValidationResult> {
    const resultado = await window.pcb.madresAgregar({
      etiqueta: input.name,
      apiKey: input.apiKey,
      secretKey: input.secretKey,
      passphrase: input.passphrase
    });
    return {
      ok: resultado.ok,
      reason: resultado.motivo,
      warnings: resultado.advertencias.map((a) => ({ code: a.codigo, message: a.mensaje })),
      parent: resultado.madre === null ? null : traducirMadre(resultado.madre)
    };
  }

  async deleteParentAccount(uid: string, stepPassword: string): Promise<DeleteOutcome> {
    return window.pcb.madresEliminar(uid, stepPassword);
  }

  async planTransfer(input: {
    fromUid: string;
    toUid: string;
    amount: string;
    parentUid?: string;
  }): Promise<TransferPlan> {
    const p = await window.pcb.traspasoPlanificar({
      uidOrigen: input.fromUid,
      uidDestino: input.toUid,
      importe: input.amount,
      ...(input.parentUid === undefined ? {} : { uidMadre: input.parentUid })
    });
    return aPlanTraspaso(p);
  }

  async executeTransfer(planId: string, stepPassword: string): Promise<TransferResult> {
    const r = await window.pcb.traspasoEjecutar(planId, stepPassword);
    return {
      ok: r.ok,
      failure: r.motivo,
      message: r.mensaje,
      transferId: r.transferId,
      plan: aPlanTraspaso(r.plan)
    };
  }

  async listTransfers(limit?: number): Promise<TransferRecord[]> {
    return (await window.pcb.traspasoHistorial(limit)).map((m) => ({
      id: m.clientOid,
      at: m.ts,
      fromLabel: m.etiquetaOrigen,
      toLabel: m.etiquetaDestino,
      amount: m.importe,
      currency: m.moneda,
      outcome: m.resultado,
      transferId: m.transferId,
      message: m.mensaje
    }));
  }

  async planSpread(input: {
    toUids: string[];
    total: string;
    mode: SpreadMode;
    parentUid?: string;
  }): Promise<SpreadPlan> {
    return aPlanReparto(
      await window.pcb.repartoPlanificar({
        destinos: input.toUids,
        total: input.total,
        modo: input.mode,
        ...(input.parentUid === undefined ? {} : { uidMadre: input.parentUid })
      })
    );
  }

  async planCollect(input: { fromUids: string[]; parentUid?: string }): Promise<SpreadPlan> {
    return aPlanReparto(
      await window.pcb.recogidaPlanificar({
        origenes: input.fromUids,
        ...(input.parentUid === undefined ? {} : { uidMadre: input.parentUid })
      })
    );
  }

  async executeSpread(planId: string, stepPassword: string): Promise<SpreadResult> {
    const r = await window.pcb.repartoEjecutar(planId, stepPassword);
    return {
      ok: r.ok,
      failure: r.motivo,
      plan: aPlanReparto(r.plan),
      results: r.resultados.map((x) => ({
        id: x.clientOid,
        fromLabel: x.etiquetaOrigen,
        toLabel: x.etiquetaDestino,
        amount: x.importe,
        ok: x.ok,
        message: x.mensaje
      })),
      sent: r.enviados,
      failed: r.fallidos,
      unconfirmed: r.indeterminados
    };
  }

  async getBalanceSheet(parentUid?: string): Promise<BalanceSheet> {
    const s = await window.pcb.saldosLeer(parentUid);
    return {
      parentUid: s.uidMadre,
      parentName: s.etiquetaMadre,
      parentAvailable: s.disponibleMadre,
      currency: s.moneda,
      fetchedAt: s.obtenidoEn,
      rows: s.filas.map((f) => ({
        uid: f.uid,
        subAccountId: f.cuentaId,
        label: f.etiqueta,
        available: f.disponible,
        maxTransferable: f.maxTransferible,
        equity: f.equity,
        onlyInBitget: f.soloEnBitget,
        noData: f.sinDatos
      })),
      totalAvailable: s.totalDisponible,
      totalTransferable: s.totalTransferible,
      withData: s.conDatos
    };
  }

  async isFirstRun(): Promise<boolean> {
    return (await window.pcb.vaultEstado()) === 'sin-inicializar';
  }

  async importCredentials(): Promise<ImportResult> {
    const r = await window.pcb.credencialesImportar();
    return {
      cancelled: r.cancelado,
      ok: r.ok,
      message: r.mensaje,
      accounts: r.cuentas
    };
  }

  async backupAccounts(): Promise<BackupResult> {
    const r = await window.pcb.respaldoCrear();
    return {
      ok: r.ok,
      reason: r.motivo,
      message: r.mensaje,
      fileName: r.nombre,
      folder: r.carpeta,
      accounts: r.cuentas
    };
  }

  async findBackup(): Promise<BackupInfo | null> {
    const r = await window.pcb.respaldoBuscar();
    if (r === null) return null;
    return {
      fileName: r.nombre,
      folder: r.carpeta,
      createdAt: r.creadoEn,
      appVersion: r.appVersion,
      accounts: r.cuentas,
      market: r.mercado,
      panel: r.panelOrigen,
      tooNew: r.demasiadoNuevo
    };
  }

  async openBackupFolder(): Promise<void> {
    return window.pcb.respaldoAbrirCarpeta();
  }

  async restoreBackup(masterPassword?: string): Promise<RestoreResult> {
    return aRestauracion(await window.pcb.respaldoRestaurar(masterPassword));
  }

  async restoreBackupFromFile(masterPassword?: string): Promise<RestoreResult> {
    return aRestauracion(await window.pcb.respaldoRestaurarArchivo(masterPassword));
  }

  async unlockVault(masterPassword: string): Promise<UnlockResult> {
    const estado = await window.pcb.vaultEstado();
    const resultado =
      estado === 'sin-inicializar'
        ? await window.pcb.vaultCrear(masterPassword)
        : await window.pcb.vaultAbrir(masterPassword);
    if (resultado.ok) return { ok: true, reason: null };
    return { ok: false, reason: MOTIVO_VAULT_A_TEXTO[resultado.motivo ?? ''] ?? resultado.mensaje };
  }

  async verifyMasterPassword(masterPassword: string): Promise<boolean> {
    return window.pcb.vaultComprobar(masterPassword);
  }

  async masterCooldownMs(): Promise<number> {
    return window.pcb.vaultEspera();
  }

  async verifyStepPassword(pwd: string): Promise<boolean> {
    return window.pcb.pasoComprobar(pwd);
  }

  async setStepPassword(pwd: string): Promise<void> {
    await window.pcb.pasoFijar(pwd);
  }
}
