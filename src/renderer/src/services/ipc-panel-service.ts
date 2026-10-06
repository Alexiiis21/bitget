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
  BatchFailure,
  BatchPlan,
  BatchResult,
  BatchTarget,
  ClosedPosition,
  CloseRequest,
  LeverageRequest,
  MarginCap,
  MarginRequest,
  OpenRequest,
  PlanDiscard,
  PlanKind,
  SystemInfo,
  TpRequest,
  UnlockResult,
  ValidationResult
} from '@shared/domain/panel-view';
import type { ActivoIpc, CuentaPanel, EstadoTopeIpc } from '@shared/ipc-contract';
import type { EstadoConexion, EstadoJob, Lado, Lote } from '@shared/types';
import { NotImplementedError, type PanelService, type Unsubscribe } from '@shared/ports/panel-service';

const ESTADO_A_STATUS: Record<EstadoConexion, ApiKeyStatus> = {
  conectada: 'ok',
  'modo-rest': 'ok',
  conectando: 'conectando',
  desconectada: 'error'
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
  margin: (id, solo) => window.pcb.margenEjecutar(id, solo),
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
        reason: j.mensaje ?? (j.codigoBitget === null ? 'Sin detalle.' : `Bitget ${j.codigoBitget}`)
      }));

  return {
    label,
    ok: lote.jobs.filter((j) => j.estado === 'exito').length,
    skipped: lote.jobs.filter((j) => j.estado === 'omitida').length,
    failures: de('fallo'),
    undetermined: de('indeterminada')
  };
};

const ESTADO_TOPE: Record<EstadoTopeIpc['estado'], MarginCap['status']> = {
  'sin-tope': 'missing',
  vigente: 'active',
  vencido: 'expired'
};

const aTope = (t: EstadoTopeIpc): MarginCap => ({
  status: ESTADO_TOPE[t.estado],
  value: t.valor,
  setAt: t.fijadoEn,
  expiresAt: t.venceEn,
  currency: t.monedaMargen
});

/** Traduce el `motivo` crudo de `ErrorVault` (proceso principal) a texto para el operador. */
const MOTIVO_VAULT_A_TEXTO: Record<string, string> = {
  'contrasena-incorrecta': 'Contraseña incorrecta.',
  'no-existe': 'No hay ningún almacén de credenciales en este equipo.',
  'ya-existe': 'Ya existe un almacén de credenciales en este equipo.'
};

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

  async setPanelNumber(): Promise<void> {
    /*
     * `numeroPanel` hoy es fijo por instancia (storage/instancia.ts), no
     * editable desde la pantalla. Falta un canal IPC nuevo que lo persista.
     * Ver reporte de brechas: "número de panel editable".
     */
    throw new NotImplementedError('setPanelNumber');
  }

  /* ---------------- activos ---------------- */

  async listAssets(): Promise<Asset[]> {
    return (await window.pcb.mercadoActivos()).map((a) => ({
      id: a.id,
      symbol: a.simbolo,
      label: a.etiqueta,
      priceDecimals: a.decimalesPrecio,
      maxLeverage: a.apalancamientoMax,
      minLeverage: a.apalancamientoMin,
      tradable: a.operable
    }));
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

  subscribePositions(): Unsubscribe {
    /*
     * `monitor:instantanea` existe pero devuelve `[]` fijo, y el evento
     * `monitor:filas` nunca lo emite el proceso principal (Fase 6, WebSocket
     * de posiciones). Aunque se cableara hoy, `FilaMonitor` no lleva
     * `assetId`, distintivos de acción ni margen inicial acumulado: faltaría
     * ampliar ese tipo antes de poder traducirlo a `Position` sin inventar
     * campos.
     */
    throw new NotImplementedError('subscribePositions');
  }

  /* ---------------- escritura, en dos fases ---------------- */

  async planOpen(req: OpenRequest): Promise<BatchPlan> {
    const activo = await this.activoDe(req.assetId);
    const plan = await window.pcb.aperturaPlanificar({
      simbolo: activo.simbolo,
      objetivos: req.targets.map(aObjetivo),
      margenInicial: req.initialMargin,
      apalancamiento: req.leverage,
      precioLimite: req.orderType === 'limit' ? req.limitPrice : null
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
        (req.orderType === 'limit' ? `límite ${req.limitPrice ?? '—'}` : 'a mercado'),
      reference: plan.precioReferencia,
      entries: plan.entradas.map((e) => ({
        subAccountId: e.cuentaId,
        side: e.lado,
        label: e.etiqueta,
        detail:
          `${e.size} ${activo.id} · margen real ${e.margenReal} ${moneda} · ` +
          `nocional ${e.nocional} ${moneda}`
      })),
      discards: aDescartes(plan.descartes)
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
      discards: aDescartes(plan.descartes)
    };
  }

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
          `TP a ${e.precioDisparo} · entrada ${e.precioEntrada} · ${e.apalancamiento}x · ` +
          `el precio se mueve ${e.movimientoPorcentaje}%`
      })),
      discards: aDescartes(plan.descartes)
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
      discards: aDescartes(plan.descartes)
    };
  }

  async planMargin(req: MarginRequest): Promise<BatchPlan> {
    const plan = await window.pcb.margenPlanificar({
      simbolo: (await this.activoDe(req.assetId)).simbolo,
      objetivos: req.targets.map(aObjetivo),
      cantidad: req.amount
    });

    return {
      kind: 'margin',
      id: plan.id,
      title: 'Agregar margen',
      summary:
        `${req.amount} ${plan.monedaMargen} por casilla · ` +
        `compromete ${plan.totalComprometido} ${plan.monedaMargen} en total`,
      reference: null,
      entries: plan.entradas.map((e) => ({
        subAccountId: e.cuentaId,
        side: e.lado,
        label: e.etiqueta,
        detail: `margen ${e.margenActual} → ${e.margenResultante} ${plan.monedaMargen}`
      })),
      discards: aDescartes(plan.descartes)
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
      discards: aDescartes(plan.descartes)
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

  /* ---------------- tope de margen inicial ---------------- */

  async getMarginCap(): Promise<MarginCap> {
    return aTope(await window.pcb.topeEstado());
  }

  async setMarginCap(value: string): Promise<MarginCap> {
    return aTope(await window.pcb.topeFijar(value));
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
    const activo = (await window.pcb.mercadoActivos()).find((a) => a.id === assetId);
    if (activo === undefined) {
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
      reason: f.motivo
    }));
  }

  async registerApiKey(input: ApiKeyInput): Promise<ValidationResult> {
    const resultado = await window.pcb.cuentasAgregar({
      etiqueta: input.subAccountLabel,
      grupoNombre: input.accountName,
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

  async deleteApiKey(id: string): Promise<void> {
    await window.pcb.cuentasEliminar(id);
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

  async verifyStepPassword(pwd: string): Promise<boolean> {
    return window.pcb.pasoComprobar(pwd);
  }

  async setStepPassword(pwd: string): Promise<void> {
    await window.pcb.pasoFijar(pwd);
  }
}
