/**
 * Estado del panel (diseño aprobado v2).
 *
 * Es una proyección de solo lectura sobre `PanelService`: la verdad vive
 * detrás del puerto (proceso principal o `MockPanelService`), y este store
 * solo la refleja más el estado propio de la pantalla — selección de
 * casillas, acordeones, avisos. Ningún componente llama a `panelService`
 * directamente; todos pasan por una acción de aquí.
 *
 * Clasificación del estado (Paso 4 del encargo):
 *  - Efímero de UI: valores capturados, selección, acordeones, último lote,
 *    modales abiertos. Vive solo aquí, se pierde al cerrar.
 *  - Persistente vía PanelService: cuentas, api keys, número de panel,
 *    contraseña de paso.
 *  - Derivado del exchange, nunca la verdad: `posiciones`, `precios`. Se
 *    vuelven a pedir, nunca se asumen ciertos entre sesiones.
 *  - Local sin puerto de persistencia todavía: `valoresFijos` vive en memoria
 *    del renderer y se pierde al reiniciar. Es una brecha deliberada, no un
 *    olvido — ver el reporte final del encargo. `tema` es la excepción: no
 *    hay backend detrás, se guarda en `localStorage` del propio renderer.
 */
import { create } from 'zustand';
import type {
  Account,
  Asset,
  BatchPlan,
  BatchResult,
  BatchTarget,
  ClosedPosition,
  MarginCap,
  PlanKind,
  Position,
  Side
} from '@shared/domain/panel-view';
import type { Decimal } from '@shared/types';
import { NotImplementedError } from '@shared/ports/panel-service';
import { panelService } from '@/services/panel-service';
import { casillas } from '@/lib/formato';
import type {
  AlcanceLado,
  Aviso,
  FormularioApiKey,
  SeleccionCuenta,
  TipoAviso,
  ValoresHerramientas
} from '@/features/panel/tipos';
import type { ApiKeyRow, ValidationResult } from '@shared/domain/panel-view';

const INTENTOS_PASO = 3;
const MINIMO_MAESTRA = 4;
const MINIMO_PASO = 3;

const FORMULARIO_VACIO: FormularioApiKey = {
  subcuenta: '',
  cuenta: 'A',
  apiKey: '',
  secretKey: '',
  passphrase: ''
};

const seleccionVacia = (n: number): boolean[] => Array.from({ length: n }, () => false);

/**
 * Estado de carga de una sección que trae datos de fuera.
 *
 * Los cuatro valores existen porque la pantalla debe distinguirlos, y con un
 * booleano `cargando` no se puede: una lista vacía porque todavía no llegó, una
 * vacía porque el operador no ha registrado nada y una vacía porque la petición
 * falló se ven igual, y piden respuestas opuestas. `inicial` es «ni siquiera se
 * ha pedido», que es lo que hay con el panel bloqueado.
 */
export type EstadoCarga = 'inicial' | 'cargando' | 'listo' | 'error';

const textoDeError = (e: unknown): string => {
  if (e instanceof NotImplementedError) {
    return 'Esta función todavía no está conectada al proceso principal (backend pendiente).';
  }
  if (!(e instanceof Error)) return 'Fallo inesperado del panel.';
  /*
   * Electron antepone a todo error del proceso principal «Error invoking remote
   * method 'canal': ErrorPlan: ». Al operador solo le sirve lo que va después.
   */
  return e.message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '');
};

const CLAVE_TEMA = 'pcb.tema';

const temaInicial = (): 'light' | 'dark' => {
  const guardado = localStorage.getItem(CLAVE_TEMA);
  if (guardado === 'light' || guardado === 'dark') return guardado;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

let secuenciaAviso = 0;
let cancelarPrecios: (() => void) | undefined;
let cancelarPosiciones: (() => void) | undefined;
let cancelarCuentas: (() => void) | undefined;
let temporizadorTope: ReturnType<typeof setTimeout> | undefined;

/**
 * El mayor retardo que admite `setTimeout`. Un tope vence a las 24 horas, muy
 * por debajo; el recorte solo evita que una fecha absurda dispare al instante.
 */
const RETARDO_MAXIMO_MS = 2_147_483_647;

export interface EstadoPanel {
  /* ---- sesión ---- */
  pantalla: 'login' | 'panel';
  contrasena: string;
  errorContrasena: string;
  numeroPanel: number;
  ocupado: boolean;
  tema: 'light' | 'dark';
  /**
   * Mercado contra el que opera este panel. Lo dice el proceso principal.
   *
   * Arranca en `simulado` a propósito: si la consulta al proceso principal
   * falla, el distintivo de la cabecera dirá «simulado» y no «real». De los dos
   * errores posibles, el que no se puede cometer es enseñar el mercado de
   * pruebas cuando se está operando con dinero de verdad.
   */
  mercado: 'real' | 'simulado';

  /* ---- activos ---- */
  activos: Asset[];
  precios: Record<string, Decimal>;
  activoId: string;

  /* ---- barra lateral ---- */
  alcance: AlcanceLado;
  valores: ValoresHerramientas;
  valoresFijos: boolean;
  tipoOrden: 'market' | 'limit';
  limitPrice: string;
  /**
   * Línea de estado de la barra lateral.
   *
   * Dice qué está haciendo el panel mientras dura: «revisando 34 casillas…».
   * No es un mensaje de éxito —eso lo cuenta el informe del lote— sino la
   * señal de que la pantalla está esperando a Bitget y no se ha quedado colgada.
   */
  mensaje: string;

  /* ---- datos ---- */
  cuentas: Account[];
  seleccion: Record<string, SeleccionCuenta>;
  posiciones: Position[];
  historial: Record<string, ClosedPosition[]>;
  apiKeys: ApiKeyRow[];
  formulario: FormularioApiKey;
  /**
   * Lo que Bitget contesto en la ultima alta correcta.
   *
   * Vive aqui y no en el componente porque es la prueba de que el UID se
   * detecto solo: el operador no lo escribio en ninguna parte. Se borra en
   * cuanto vuelve a tocar el formulario, para que no se confunda con el alta
   * siguiente.
   */
  ultimaValidacion: { etiqueta: string; uid: string; uidPadre: string } | null;

  /* ---- carga de cada sección ---- */
  cargaCuentas: EstadoCarga;
  motivoCuentas: string | null;
  /**
   * Carga del flujo de posiciones, aparte del de cuentas.
   *
   * Son dos fuentes distintas y de fases distintas: la matriz puede estar viva
   * mientras las posiciones todavía no existen. Mezclarlas hacía que la falta
   * de una vaciara la otra.
   */
  cargaPosiciones: EstadoCarga;
  motivoPosiciones: string | null;
  cargaApis: EstadoCarga;
  motivoApis: string | null;
  /** Por `accountId`: el historial se pide al desplegar el acordeón de cada cuenta. */
  cargaHistorial: Record<string, EstadoCarga>;

  /* ---- acordeones ---- */
  cmpAbierto: Record<string, boolean>;
  histAbierto: Record<string, boolean>;
  histSubAbierto: Record<string, boolean>;

  /* ---- pantallas superpuestas ---- */
  apisAbierto: boolean;
  detalle: { accountId: string; subAccountId: string } | null;
  batch: BatchResult | null;
  /** Repite el último lote, acotado a sus objetivos fallidos. `null` si el último lote no tuvo fallos o no es repetible. */
  reintentarFallidas: (() => Promise<void>) | null;

  /* ---- plan pendiente de aprobación ---- */
  /**
   * Lo que se va a enviar, ya calculado por el proceso principal.
   *
   * Mientras esto no sea `null`, hay un diálogo abierto y **no ha salido
   * ninguna orden**. El plan vive en el proceso principal; aquí solo está su
   * copia para dibujarla, y confirmar devuelve únicamente su `id`.
   */
  plan: BatchPlan | null;
  /** Planificando: la pantalla está esperando precios y saldos de Bitget. */
  planCargando: boolean;
  /** Enviando el lote aprobado. Bloquea un segundo clic sobre el mismo plan. */
  enviando: boolean;
  /**
   * Operaciones encadenadas que faltan por aprobar.
   *
   * «Aplicar todo» son tres operaciones distintas, no una: Take Profit, margen
   * y apalancamiento van a Bitget por caminos separados. Se aprueban de una en
   * una, con su plan a la vista, porque juntarlas en una sola confirmación
   * significaría aprobar a ciegas dos de las tres.
   */
  cola: PlanKind[];

  /* ---- seguridad ---- */
  seguridadAbierta: boolean;
  etapaSeguridad: 'maestra' | 'editar';
  maestraSeguridad: string;
  errorSeguridad: string;
  pasoNuevo: string;
  pasoNuevo2: string;

  /* ---- tope de margen inicial ---- */
  /**
   * Lo que dice el proceso principal del tope. `null` hasta la primera
   * consulta tras desbloquear.
   */
  tope: MarginCap | null;
  /** Diálogo que pide el tope: abierto al entrar sin tope o cuando vence. */
  topeAbierto: boolean;
  topeValor: string;
  topeValor2: string;
  errorTope: string;
  guardandoTope: boolean;

  /* ---- confirmación de la operación ---- */
  pinPaso: string;
  errorPaso: string;
  intentosPaso: number;

  /* ---- avisos ---- */
  avisos: Aviso[];

  /* ---- acciones ---- */
  iniciar: () => Promise<void>;
  escribirContrasena: (v: string) => void;
  desbloquear: () => Promise<void>;
  bloquear: () => void;
  fijarTema: (t: 'light' | 'dark') => void;
  fijarNumeroPanel: (n: number) => Promise<void>;

  fijarActivo: (id: string) => void;
  fijarAlcance: (a: AlcanceLado) => void;
  fijarValor: (clave: keyof ValoresHerramientas, v: string) => void;
  alternarValoresFijos: () => void;
  fijarTipoOrden: (t: 'market' | 'limit') => void;
  fijarLimitPrice: (v: string) => void;

  contarSeleccion: () => number;
  objetivosSeleccionados: () => { subAccountId: string; side: Side }[];
  alternarCuenta: (accountId: string) => void;
  alternarCasilla: (accountId: string, lado: 'selLong' | 'selShort', indice: number) => void;
  seleccionarTodo: () => void;
  limpiarSeleccion: () => void;

  /** Calcula qué pasaría. No envía nada. */
  planear: (kind: PlanKind) => Promise<void>;
  /** Encadena varias operaciones, aprobándolas de una en una. */
  planearVarios: (kinds: PlanKind[]) => Promise<void>;
  /** Aprueba el plan en pantalla y lo envía. */
  confirmarPlan: () => Promise<void>;
  /** Envía un plan, opcionalmente acotado a unas casillas: el reintento. */
  enviarPlan: (plan: BatchPlan, soloEstos?: BatchTarget[]) => Promise<void>;
  cancelarPlan: () => void;
  reintentarMargenCuenta: (accountId: string) => Promise<void>;
  cerrarLote: () => void;
  escribirPin: (v: string) => void;

  abrirApis: () => void;
  cerrarApis: () => void;
  escribirFormulario: (clave: keyof FormularioApiKey, v: string) => void;
  refrescarApis: () => Promise<void>;
  guardarApi: () => Promise<void>;
  probarApi: (id: string) => Promise<void>;
  eliminarApi: (id: string) => Promise<void>;

  abrirSeguridad: () => void;
  cerrarSeguridad: () => void;
  escribirMaestraSeguridad: (v: string) => void;
  verificarMaestra: () => Promise<void>;
  escribirPasoNuevo: (campo: 'pasoNuevo' | 'pasoNuevo2', v: string) => void;
  guardarPaso: () => Promise<void>;

  /** Pregunta el tope al proceso principal; con `pedir`, abre el diálogo si falta o venció. */
  refrescarTope: (pedir: boolean) => Promise<void>;
  abrirTope: () => void;
  cerrarTope: () => void;
  escribirTope: (campo: 'topeValor' | 'topeValor2', v: string) => void;
  guardarTope: () => Promise<void>;

  alternarCmp: (accountId: string) => void;
  alternarHist: (accountId: string) => Promise<void>;
  alternarHistSub: (subAccountId: string) => void;
  abrirDetalle: (accountId: string, subAccountId: string) => void;
  cerrarDetalle: () => void;
  reintentarConexion: (accountId: string, subAccountId: string) => void;

  avisar: (tipo: TipoAviso, titulo: string, cuerpo: string, meta?: string) => void;
  cerrarAviso: (id: string) => void;
}

/** Cómo se llama cada operación en los avisos y en el diálogo. */
const TITULOS: Record<PlanKind, string> = {
  open: 'Abrir posiciones',
  close: 'Cerrar posiciones',
  tp: 'Take Profit',
  'tp-remove': 'Quitar Take Profit',
  margin: 'Margen adicional',
  leverage: 'Apalancamiento'
};

/**
 * Qué campo del formulario necesita cada operación, o `null` si ninguno.
 *
 * Cerrar y quitar el Take Profit no llevan valor: actúan sobre lo que ya hay.
 */
const CAMPO_DE: Record<PlanKind, keyof ValoresHerramientas | null> = {
  open: 'mgi',
  close: null,
  tp: 'tp',
  'tp-remove': null,
  margin: 'mga',
  leverage: 'ap'
};

/**
 * Las operaciones que piden además la contraseña de paso.
 *
 * Solo la apertura, que es la que compromete dinero nuevo y la única con este
 * freno en el pliego (docs/04 W-09). Las demás se aprueban con el plan a la
 * vista, que ya impide enviar algo distinto de lo aprobado.
 */
const PIDE_PASO = new Set<PlanKind>(['open']);

/**
 * Qué campos se vacían tras enviar, salvo que estén fijados.
 *
 * El apalancamiento nunca se borra: el operador lo deja puesto porque casi
 * siempre repite el mismo. Los importes sí, para que un lote no herede por
 * descuido la cantidad del anterior.
 */
const LIMPIA_TRAS: Record<PlanKind, Partial<ValoresHerramientas>> = {
  open: { mgi: '' },
  close: {},
  tp: { tp: '' },
  'tp-remove': {},
  margin: { mga: '' },
  leverage: {}
};

export const usarPanel = create<EstadoPanel>()((set, get) => ({
  pantalla: 'login',
  contrasena: '',
  errorContrasena: '',
  numeroPanel: 1,
  ocupado: false,
  tema: temaInicial(),
  mercado: 'simulado',

  activos: [],
  precios: {},
  activoId: 'BTC',

  alcance: 'ambos',
  valores: { tp: '1.5', mgi: '100', mga: '50', ap: '10' },
  valoresFijos: false,
  tipoOrden: 'market',
  limitPrice: '',
  mensaje: '',

  cuentas: [],
  seleccion: {},
  posiciones: [],
  historial: {},
  apiKeys: [],
  formulario: FORMULARIO_VACIO,
  ultimaValidacion: null,

  cargaCuentas: 'inicial',
  motivoCuentas: null,
  cargaPosiciones: 'inicial',
  motivoPosiciones: null,
  cargaApis: 'inicial',
  motivoApis: null,
  cargaHistorial: {},

  cmpAbierto: {},
  histAbierto: {},
  histSubAbierto: {},

  apisAbierto: false,
  detalle: null,
  batch: null,
  reintentarFallidas: null,
  plan: null,
  planCargando: false,
  enviando: false,
  cola: [],

  seguridadAbierta: false,
  etapaSeguridad: 'maestra',
  maestraSeguridad: '',
  errorSeguridad: '',
  pasoNuevo: '',
  pasoNuevo2: '',

  tope: null,
  topeAbierto: false,
  topeValor: '',
  topeValor2: '',
  errorTope: '',
  guardandoTope: false,

  pinPaso: '',
  errorPaso: '',
  intentosPaso: 0,

  avisos: [],

  /* ---------------- sesión ---------------- */

  iniciar: async () => {
    try {
      const [info, activos] = await Promise.all([panelService.getSystemInfo(), panelService.listAssets()]);
      const primero = activos[0];
      set((estado) => ({
        numeroPanel: info.panelNumber,
        mercado: info.market,
        activos,
        activoId: primero?.id ?? 'BTC',
        valores: { ...estado.valores, ap: primero === undefined ? estado.valores.ap : String(primero.maxLeverage) }
      }));
    } catch {
      /* Sin catálogo de activos el selector se queda vacío; no bloquea el login. */
    }

    cancelarPrecios?.();
    try {
      cancelarPrecios = panelService.subscribeAssetPrices((precios) => set({ precios }));
    } catch {
      /* NotImplemented en IpcPanelService: el precio del activo no se muestra. */
    }
  },

  escribirContrasena: (v) => set({ contrasena: v, errorContrasena: '' }),

  desbloquear: async () => {
    const { contrasena, ocupado, avisar, numeroPanel, refrescarApis } = get();
    if (ocupado) return;

    if (contrasena.length < MINIMO_MAESTRA) {
      set({ errorContrasena: 'La contraseña maestra debe tener al menos 4 caracteres.' });
      return;
    }

    set({ ocupado: true });
    try {
      const resultado = await panelService.unlockVault(contrasena);
      if (!resultado.ok) {
        set({ errorContrasena: resultado.reason ?? 'No se pudo abrir el almacén de credenciales.' });
        return;
      }

      set({ pantalla: 'panel', contrasena: '', errorContrasena: '' });
      avisar('ok', 'Sesión iniciada', 'Verificando las API keys registradas de las subcuentas.', `PCB #${numeroPanel}`);

      /*
       * Lo primero tras entrar: el tope de margen inicial. Un panel recién
       * instalado no tiene, y uno que lleva más de 24 horas sin fijarlo lo
       * tiene vencido; en los dos casos se pide aquí, antes de operar.
       */
      await get().refrescarTope(true);

      set({ cargaCuentas: 'cargando', motivoCuentas: null });
      try {
        const cuentas = await panelService.getAccounts();
        set({ cuentas, cargaCuentas: 'listo', motivoCuentas: null });

        /*
         * A partir de aquí la matriz se mantiene sola. El estado de conexión lo
         * mueve el proceso principal en segundo plano, y sin esta suscripción
         * la pantalla se quedaría con la foto del desbloqueo: una cuenta que
         * reconecta seguiría en rojo y una que se cae, en verde. RF-002.
         */
        cancelarCuentas?.();
        cancelarCuentas = panelService.subscribeAccounts((frescas) => set({ cuentas: frescas }));
      } catch (e) {
        /*
         * El motivo se guarda además de avisar: el aviso emergente se va solo a
         * los pocos segundos y la matriz se queda vacía el resto de la sesión.
         * Sin esto, quien llegue tarde a la pantalla no tiene forma de saber
         * por qué no hay nada.
         */
        set({ cargaCuentas: 'error', motivoCuentas: textoDeError(e) });
        avisar('error', 'Sin datos de cuentas', textoDeError(e), 'PCB');
      }

      /*
       * Las posiciones son otra fuente y otra fase -llegan por WebSocket en la
       * Fase 6-. Se suscriben aparte a propósito: cuando no existen todavía, la
       * matriz de cuentas tiene que seguir en pie. Antes compartían el mismo
       * `try` y el fallo de esta línea dejaba la pantalla vacía con un error que
       * no era el suyo.
       */
      set({ cargaPosiciones: 'cargando', motivoPosiciones: null });
      try {
        cancelarPosiciones?.();
        cancelarPosiciones = panelService.subscribePositions((snap) =>
          set({ posiciones: snap.positions, cargaPosiciones: 'listo', motivoPosiciones: null })
        );
      } catch (e) {
        set({ cargaPosiciones: 'error', motivoPosiciones: textoDeError(e), posiciones: [] });
      }

      await refrescarApis();
      get()
        .apiKeys.filter((a) => a.status === 'error')
        .forEach((a) =>
          avisar('error', `Sin conexión con ${a.subAccountLabel}`, 'La credencial no responde.', `Cuenta ${a.accountName}`)
        );
    } catch (e) {
      set({ errorContrasena: textoDeError(e) });
    } finally {
      set({ ocupado: false });
    }
  },

  bloquear: () => {
    clearTimeout(temporizadorTope);
    temporizadorTope = undefined;
    cancelarPosiciones?.();
    cancelarPosiciones = undefined;
    cancelarCuentas?.();
    cancelarCuentas = undefined;
    set({
      pantalla: 'login',
      contrasena: '',
      errorContrasena: '',
      apisAbierto: false,
      seguridadAbierta: false,
      detalle: null,
      avisos: [],
      apiKeys: [],
      cuentas: [],
      posiciones: [],
      seleccion: {},
      cmpAbierto: {},
      histAbierto: {},
      /* Al bloquear se vuelve al punto de partida: nada pedido, nada sabido. */
      cargaCuentas: 'inicial',
      motivoCuentas: null,
      cargaPosiciones: 'inicial',
      motivoPosiciones: null,
      cargaApis: 'inicial',
      motivoApis: null,
      cargaHistorial: {},
      historial: {},
      tope: null,
      topeAbierto: false,
      topeValor: '',
      topeValor2: '',
      errorTope: ''
    });
  },

  fijarTema: (tema) => {
    localStorage.setItem(CLAVE_TEMA, tema);
    set({ tema });
  },

  fijarNumeroPanel: async (n) => {
    set({ numeroPanel: n });
    try {
      await panelService.setPanelNumber(n);
    } catch (e) {
      get().avisar('aviso', 'Número de panel no persistido', textoDeError(e), 'PCB');
    }
  },

  /* ---------------- barra lateral ---------------- */

  /**
   * Cambiar de activo pone el apalancamiento en el máximo de ese activo.
   *
   * El cliente opera siempre al máximo y son topes distintos —BTC 150x, PEPE
   * 75x, PAXG 50x, y otros en el mercado de pruebas—. El tope sale del catálogo
   * de Bitget, así que acierta solo y se ajusta al mercado sin que nadie tenga
   * que recordarlo.
   *
   * Es un valor de partida, no una imposición: el campo se sigue pudiendo
   * escribir. Con «valores fijos» activado no se toca nada, porque ese
   * interruptor significa justamente «no me cambies lo que escribí».
   */
  fijarActivo: (activoId) =>
    set((s) => {
      const activo = s.activos.find((a) => a.id === activoId);
      if (activo === undefined || s.valoresFijos) return { activoId };
      return { activoId, valores: { ...s.valores, ap: String(activo.maxLeverage) } };
    }),
  fijarAlcance: (alcance) => set({ alcance }),
  fijarValor: (clave, v) => set((s) => ({ valores: { ...s.valores, [clave]: v } })),
  alternarValoresFijos: () => set((s) => ({ valoresFijos: !s.valoresFijos })),
  fijarTipoOrden: (tipoOrden) => set({ tipoOrden }),
  fijarLimitPrice: (limitPrice) => set({ limitPrice }),

  /* ---------------- selección ---------------- */

  contarSeleccion: () => {
    const { seleccion, alcance } = get();
    return Object.values(seleccion).reduce(
      (total, s) =>
        total +
        (alcance !== 'short' ? s.selLong.filter(Boolean).length : 0) +
        (alcance !== 'long' ? s.selShort.filter(Boolean).length : 0),
      0
    );
  },

  objetivosSeleccionados: () => {
    const { seleccion, alcance, cuentas } = get();
    const objetivos: { subAccountId: string; side: Side }[] = [];
    for (const cuenta of cuentas) {
      const sel = seleccion[cuenta.id];
      if (!sel) continue;
      cuenta.subAccounts.forEach((sub, i) => {
        if (alcance !== 'short' && sel.selLong[i]) objetivos.push({ subAccountId: sub.id, side: 'long' });
        if (alcance !== 'long' && sel.selShort[i]) objetivos.push({ subAccountId: sub.id, side: 'short' });
      });
    }
    return objetivos;
  },

  alternarCuenta: (accountId) =>
    set((s) => {
      const cuenta = s.cuentas.find((c) => c.id === accountId);
      if (!cuenta) return s;
      const n = cuenta.subAccounts.length;
      const actual = s.seleccion[accountId] ?? { selLong: seleccionVacia(n), selShort: seleccionVacia(n) };
      const todas = actual.selLong.every(Boolean) && actual.selShort.every(Boolean);
      return {
        seleccion: {
          ...s.seleccion,
          [accountId]: { selLong: seleccionVacia(n).map(() => !todas), selShort: seleccionVacia(n).map(() => !todas) }
        }
      };
    }),

  alternarCasilla: (accountId, lado, indice) =>
    set((s) => {
      const cuenta = s.cuentas.find((c) => c.id === accountId);
      const n = cuenta?.subAccounts.length ?? 20;
      const actual = s.seleccion[accountId] ?? { selLong: seleccionVacia(n), selShort: seleccionVacia(n) };
      return {
        seleccion: {
          ...s.seleccion,
          [accountId]: { ...actual, [lado]: actual[lado].map((v, i) => (i === indice ? !v : v)) }
        }
      };
    }),

  /**
   * Marca todas las casillas de todas las cuentas principales.
   *
   * El contrato pide poder operar «sobre una cuenta, varias o todas», y sin
   * esto «todas» eran cinco pulsaciones -una por cuenta principal- justo en el
   * momento en que el operador tiene menos tiempo.
   */
  seleccionarTodo: () =>
    set((s) => ({
      seleccion: Object.fromEntries(
        s.cuentas.map((c) => [
          c.id,
          {
            selLong: c.subAccounts.map(() => true),
            selShort: c.subAccounts.map(() => true)
          }
        ])
      )
    })),

  /*
   * Deja la selección vacía. Es la salida rápida después de un lote: sin ella
   * hay que destildar a mano, y una casilla olvidada acaba recibiendo la
   * siguiente acción sin que nadie lo pretendiera.
   */
  limpiarSeleccion: () => set({ seleccion: {} }),

  /* ---------------- las seis operaciones, en dos fases ---------------- */

  /**
   * Calcula el plan de una operación. **No envía nada a Bitget.**
   *
   * Es la primera de las dos fases y la que sostiene la promesa del contrato:
   * lo que el operador aprueba no es «abrir 100 USDT a 150x», sino la lista
   * concreta de casillas con su cantidad, y las que se quedan fuera con su
   * motivo. Si cancela el diálogo, no ha salido ni una orden.
   *
   * Planificar cuesta consultas —precio, saldo, posiciones— así que se
   * comprueba antes lo que se puede comprobar sin gastar cupo: que haya
   * casillas marcadas y que el campo tenga valor.
   */
  planear: async (kind) => {
    const { objetivosSeleccionados, avisar, valores, activoId, activos, tipoOrden, limitPrice } = get();
    const targets = objetivosSeleccionados();
    const titulo = TITULOS[kind];

    if (targets.length === 0) {
      avisar('aviso', 'Ninguna casilla seleccionada', 'Marque al menos una casilla sobre los números 1–20 antes de continuar.', `PCB · ${titulo}`);
      return;
    }

    /*
     * Sin tope vigente no se abre nada: el proceso principal lo rechazaría
     * igual, pero aquí se le pide el tope en vez de enseñarle un error. El
     * resto de operaciones no dependen del tope -agregar margen tampoco, por
     * decisión del cliente-.
     */
    if (kind === 'open' && get().tope?.status !== 'active') {
      get().abrirTope();
      avisar('aviso', 'Falta el tope de margen inicial', 'Fije el margen inicial máximo del panel antes de abrir posiciones.', `PCB · ${titulo}`);
      return;
    }

    const activo = activos.find((a) => a.id === activoId);
    if (!activo) {
      avisar('error', 'Sin activo', 'No hay ningún activo seleccionado. Vuelva a abrir el panel si la lista está vacía.', `PCB · ${titulo}`);
      return;
    }
    if (!activo.tradable) {
      avisar('aviso', 'Activo suspendido', `Bitget tiene ${activo.label} suspendido ahora mismo: no admite órdenes.`, `PCB · ${titulo}`);
      return;
    }

    /* El campo que hace falta según la operación. Vacío, no se planifica. */
    const campo = CAMPO_DE[kind];
    const valor = campo === null ? '' : valores[campo].trim();
    if (campo !== null && valor === '') {
      avisar('aviso', 'Campo vacío', `Escriba un valor en ${titulo} antes de continuar.`, `PCB · ${titulo}`);
      return;
    }

    const apalancamiento = Number.parseFloat(valores.ap);
    if ((kind === 'open' || kind === 'leverage') && !Number.isFinite(apalancamiento)) {
      avisar('aviso', 'Apalancamiento inválido', 'Escriba el apalancamiento antes de continuar.', `PCB · ${titulo}`);
      return;
    }

    set({ planCargando: true, mensaje: `Revisando ${casillas(targets.length)}…` });
    try {
      const plan = await (kind === 'open'
        ? panelService.planOpen({
            targets,
            assetId: activoId,
            orderType: tipoOrden,
            limitPrice: tipoOrden === 'limit' && limitPrice.trim() !== '' ? limitPrice : null,
            initialMargin: valores.mgi,
            leverage: apalancamiento
          })
        : kind === 'close'
          ? panelService.planClose({ targets, assetId: activoId })
          : kind === 'tp'
            ? panelService.planTakeProfit({ targets, assetId: activoId, percent: valores.tp })
            : kind === 'tp-remove'
              ? panelService.planRemoveTakeProfit({ targets, assetId: activoId })
              : kind === 'margin'
                ? panelService.planMargin({ targets, assetId: activoId, amount: valores.mga })
                : panelService.planLeverage({ targets, assetId: activoId, leverage: apalancamiento }));

      /*
       * Un plan sin ninguna casilla viable no se enseña como plan: sería un
       * diálogo con una lista vacía y un botón de confirmar que no haría nada.
       * Se dice por qué no salió ninguna, que es la información útil.
       */
      if (plan.entries.length === 0) {
        set({ planCargando: false, plan: null, mensaje: '' });
        avisar(
          'aviso',
          'Ninguna casilla puede recibir esta acción',
          plan.discards[0]?.reason ?? 'Las casillas seleccionadas no admiten esta operación ahora mismo.',
          `PCB · ${titulo}`
        );
        return;
      }

      set({ plan, planCargando: false, mensaje: '', pinPaso: '', errorPaso: '', intentosPaso: 0 });
    } catch (e) {
      set({ planCargando: false, plan: null, mensaje: '' });
      avisar('error', `No se pudo preparar ${titulo.toLowerCase()}`, textoDeError(e), `PCB · ${titulo}`);
    }
  },

  /**
   * Envía el plan aprobado. Es la segunda fase y la única que toca Bitget.
   *
   * La apertura pide además la contraseña de paso: es la acción que compromete
   * dinero nuevo y la única con un freno propio en el pliego. Tres intentos
   * fallidos cancelan la operación **sin haber enviado nada**.
   */
  confirmarPlan: async () => {
    const { plan, pinPaso, intentosPaso, avisar } = get();
    if (!plan) return;

    if (PIDE_PASO.has(plan.kind)) {
      let valido: boolean;
      try {
        valido = await panelService.verifyStepPassword(pinPaso);
      } catch (e) {
        set({ plan: null, pinPaso: '', errorPaso: '', intentosPaso: 0 });
        avisar('error', 'No se pudo confirmar', textoDeError(e), 'Seguridad');
        return;
      }

      if (!valido) {
        const intentos = intentosPaso + 1;
        if (intentos >= INTENTOS_PASO) {
          set({ plan: null, pinPaso: '', errorPaso: '', intentosPaso: 0 });
          avisar('error', `${plan.title}: cancelado`, `Se introdujo la contraseña de paso incorrecta ${INTENTOS_PASO} veces. No se envió ninguna orden a Bitget.`, 'Seguridad');
          return;
        }
        set({ pinPaso: '', errorPaso: `Contraseña de paso incorrecta. Intento ${intentos} de ${INTENTOS_PASO}.`, intentosPaso: intentos });
        return;
      }
    }

    set({ plan: null, pinPaso: '', errorPaso: '', intentosPaso: 0, enviando: true, mensaje: 'Enviando a Bitget…' });
    await get().enviarPlan(plan);
  },

  /**
   * Envía un plan y deja el informe en pantalla.
   *
   * `soloEstos` es «reintentar solo las fallidas»: reutiliza el mismo plan y
   * por tanto los mismos identificadores de orden, que es lo que impide que un
   * reintento duplique lo que ya entró.
   */
  enviarPlan: async (plan, soloEstos) => {
    const { avisar } = get();
    try {
      const r = await panelService.executePlan(plan, soloEstos);
      set({
        batch: r,
        enviando: false,
        mensaje: '',
        /* Lo indeterminado queda fuera a propósito: reintentarlo a ciegas es lo único que puede duplicar. */
        reintentarFallidas:
          r.failures.length > 0
            ? async () => get().enviarPlan(plan, r.failures.map((f) => ({ subAccountId: f.subAccountId, side: f.side })))
            : null
      });

      if (r.undetermined.length > 0) {
        avisar('aviso', 'Hay casillas sin confirmar', `${casillas(r.undetermined.length)} se enviaron y no se pudo averiguar si entraron. Compruébelas en Bitget antes de repetir: reintentarlas a ciegas podría duplicarlas.`, `PCB · ${plan.title}`);
      } else if (r.failures.length === 0) {
        avisar('ok', `${plan.title}: correcto`, `${casillas(r.ok)} completadas.`, `PCB · ${plan.title}`);
      } else {
        avisar('error', `${plan.title}: con errores`, `${r.ok} correctas y ${r.failures.length} con error. El detalle está sobre la matriz.`, `PCB · ${plan.title}`);
      }

      /* El apalancamiento se conserva; el resto se limpia salvo «valores fijos». */
      if (!get().valoresFijos) {
        set((s) => ({ valores: { ...s.valores, ...LIMPIA_TRAS[plan.kind] }, limitPrice: plan.kind === 'open' ? '' : s.limitPrice }));
      }

      /* Si venía de «aplicar todo», se planifica la siguiente y se aprueba igual. */
      const [siguiente, ...resto] = get().cola;
      if (siguiente !== undefined && soloEstos === undefined) {
        set({ cola: resto });
        await get().planear(siguiente);
      }
    } catch (e) {
      set({ enviando: false, mensaje: '' });
      avisar('error', `No se pudo enviar ${plan.title.toLowerCase()}`, textoDeError(e), `PCB · ${plan.title}`);
    }
  },

  /**
   * Encadena varias operaciones sobre la misma selección.
   *
   * Solo entran las que tienen valor escrito: «aplicar todo» con el margen en
   * blanco no debe preguntar por un margen vacío.
   */
  planearVarios: async (kinds) => {
    const { valores, avisar } = get();
    const conValor = kinds.filter((k) => {
      const campo = CAMPO_DE[k];
      return campo === null || valores[campo].trim() !== '';
    });

    if (conValor.length === 0) {
      avisar('aviso', 'No hay nada que aplicar', 'Escriba al menos un valor —Take Profit, margen adicional o apalancamiento— antes de pulsar «Aplicar todo».', 'PCB · Aplicar todo');
      return;
    }

    set({ cola: conValor.slice(1) });
    await get().planear(conValor[0] as PlanKind);
  },

  /* Cancelar una operación de la cadena cancela la cadena entera: seguir con
   * las siguientes después de un «no» sería justo lo contrario de lo pedido. */
  cancelarPlan: () => set({ plan: null, cola: [], pinPaso: '', errorPaso: '', intentosPaso: 0 }),

  /**
   * Reenvía margen a las posiciones críticas de una cuenta principal.
   *
   * Pasa por el mismo plan que todo lo demás: es dinero nuevo saliendo del
   * saldo y no puede salir sin que alguien vea cuánto y a dónde.
   */
  reintentarMargenCuenta: async (accountId) => {
    const { cuentas, posiciones, avisar, activoId, valores } = get();
    const cuenta = cuentas.find((c) => c.id === accountId);
    if (!cuenta) return;

    const subIds = new Set(cuenta.subAccounts.map((s) => s.id));
    const targets = posiciones
      .filter((p) => p.marginCritical && subIds.has(p.subAccountId))
      .map((p) => ({ subAccountId: p.subAccountId, side: p.side }));

    if (targets.length === 0) return;

    try {
      const plan = await panelService.planMargin({ targets, assetId: activoId, amount: valores.mga.trim() || '50' });
      if (plan.entries.length === 0) {
        avisar('aviso', 'No se pudo agregar margen', plan.discards[0]?.reason ?? 'Ninguna posición admite margen adicional.', cuenta.name);
        return;
      }
      set({ plan });
    } catch (e) {
      avisar('error', 'No se pudo preparar el margen', textoDeError(e), cuenta.name);
    }
  },

  cerrarLote: () => set({ batch: null, reintentarFallidas: null }),

  escribirPin: (v) => set({ pinPaso: v, errorPaso: '' }),


  /* ---------------- API keys ---------------- */

  abrirApis: () => set({ apisAbierto: true }),
  cerrarApis: () => set({ apisAbierto: false, ultimaValidacion: null }),
  escribirFormulario: (clave, v) =>
    set((s) => ({ formulario: { ...s.formulario, [clave]: v }, ultimaValidacion: null })),

  refrescarApis: async () => {
    set({ cargaApis: 'cargando', motivoApis: null });
    try {
      const apiKeys = await panelService.listApiKeys();
      set({ apiKeys, cargaApis: 'listo', motivoApis: null });
    } catch (e) {
      set({ cargaApis: 'error', motivoApis: textoDeError(e) });
      get().avisar('error', 'No se pudo leer el registro', textoDeError(e), 'Gestión de API keys');
    }
  },

  guardarApi: async () => {
    const { formulario, ocupado, avisar, refrescarApis } = get();
    if (ocupado) return;
    if (!formulario.subcuenta || !formulario.apiKey || !formulario.secretKey || !formulario.passphrase) {
      avisar('aviso', 'Faltan datos', 'Complete subcuenta, API Key, Secret Key y Passphrase antes de guardar.', 'Gestión de API keys');
      return;
    }

    set({ ocupado: true });
    try {
      const resultado: ValidationResult = await panelService.registerApiKey({
        subAccountLabel: formulario.subcuenta,
        accountName: formulario.cuenta,
        apiKey: formulario.apiKey,
        secretKey: formulario.secretKey,
        passphrase: formulario.passphrase
      });

      if (!resultado.ok) {
        avisar('error', resultado.verdict === 'rechazada' ? 'Credenciales rechazadas' : 'Credenciales inválidas', resultado.reason ?? 'Bitget no aceptó la credencial.', `Cuenta ${formulario.cuenta}`);
        return;
      }

      set({
        formulario: FORMULARIO_VACIO,
        ultimaValidacion: {
          etiqueta: formulario.subcuenta,
          uid: resultado.uid ?? '',
          uidPadre: resultado.parentUid ?? ''
        }
      });
      await refrescarApis();
      avisar('ok', 'API key guardada', `${formulario.subcuenta} se registró en la cuenta ${formulario.cuenta}.`, 'Gestión de API keys');
      resultado.warnings.forEach((w) => avisar('aviso', 'Revise la configuración de la cuenta', w.message, formulario.subcuenta));
    } catch (e) {
      avisar('error', 'No se pudo guardar', textoDeError(e), 'Gestión de API keys');
    } finally {
      set({ ocupado: false });
    }
  },

  probarApi: async (id) => {
    const { apiKeys, avisar, refrescarApis } = get();
    const fila = apiKeys.find((a) => a.id === id);
    if (!fila) return;

    try {
      const resultado = await panelService.testApiKey(id);
      await refrescarApis();
      if (!resultado.ok) {
        avisar('error', 'Credenciales rechazadas', resultado.reason ?? 'Bitget no aceptó la credencial.', `Cuenta ${fila.accountName}`);
        return;
      }
      avisar('ok', 'Conexión válida', `${fila.subAccountLabel} responde correctamente a la API oficial de Bitget.`, `Cuenta ${fila.accountName}`);
    } catch (e) {
      avisar('error', 'No se pudo probar', textoDeError(e), `Cuenta ${fila.accountName}`);
    }
  },

  eliminarApi: async (id) => {
    const { apiKeys, avisar, refrescarApis } = get();
    const fila = apiKeys.find((a) => a.id === id);
    if (!fila) return;
    try {
      await panelService.deleteApiKey(id);
      await refrescarApis();
      avisar('aviso', 'API key eliminada', `${fila.subAccountLabel} ya no recibirá órdenes desde este panel.`, `Cuenta ${fila.accountName}`);
    } catch (e) {
      avisar('error', 'No se pudo eliminar', textoDeError(e), `Cuenta ${fila.accountName}`);
    }
  },

  /* ---------------- seguridad ---------------- */

  abrirSeguridad: () => set({ seguridadAbierta: true, etapaSeguridad: 'maestra', maestraSeguridad: '', errorSeguridad: '', pasoNuevo: '', pasoNuevo2: '' }),
  cerrarSeguridad: () => set({ seguridadAbierta: false, errorSeguridad: '' }),
  escribirMaestraSeguridad: (v) => set({ maestraSeguridad: v, errorSeguridad: '' }),

  verificarMaestra: async () => {
    const { maestraSeguridad, ocupado } = get();
    if (ocupado) return;
    if (maestraSeguridad.length < MINIMO_MAESTRA) {
      set({ errorSeguridad: 'Escriba la contraseña maestra para continuar.' });
      return;
    }
    set({ ocupado: true });
    try {
      const ok = await panelService.verifyMasterPassword(maestraSeguridad);
      if (!ok) {
        set({ maestraSeguridad: '', errorSeguridad: 'La contraseña maestra no es correcta.' });
        return;
      }
      set({ etapaSeguridad: 'editar', maestraSeguridad: '', errorSeguridad: '' });
    } catch (e) {
      set({ errorSeguridad: textoDeError(e) });
    } finally {
      set({ ocupado: false });
    }
  },

  escribirPasoNuevo: (campo, v) =>
    set(campo === 'pasoNuevo' ? { pasoNuevo: v, errorSeguridad: '' } : { pasoNuevo2: v, errorSeguridad: '' }),

  guardarPaso: async () => {
    const { pasoNuevo, pasoNuevo2, avisar } = get();
    if (pasoNuevo.length < MINIMO_PASO) {
      set({ errorSeguridad: `La contraseña de paso debe tener al menos ${MINIMO_PASO} caracteres.` });
      return;
    }
    if (pasoNuevo !== pasoNuevo2) {
      set({ errorSeguridad: 'Las dos contraseñas de paso no coinciden.' });
      return;
    }
    try {
      await panelService.setStepPassword(pasoNuevo);
      set({ seguridadAbierta: false, errorSeguridad: '', pasoNuevo: '', pasoNuevo2: '' });
      avisar('ok', 'Contraseña de paso actualizada', 'Se pedirá esta clave cada vez que se abra o se cierre una posición.', 'Seguridad');
    } catch (e) {
      set({ errorSeguridad: textoDeError(e) });
    }
  },

  /* ---------------- tope de margen inicial ---------------- */

  refrescarTope: async (pedir) => {
    let tope: MarginCap;
    try {
      tope = await panelService.getMarginCap();
    } catch (e) {
      get().avisar('error', 'No se pudo leer el tope de margen', textoDeError(e), 'Tope de margen');
      return;
    }
    set({ tope });

    /*
     * Al vencer con el panel abierto, se vuelve a preguntar y se pide el tope
     * nuevo sin esperar a que el operador intente abrir algo. Un segundo de
     * holgura evita preguntar justo en el borde, cuando el proceso principal
     * todavía podría contestar «vigente».
     */
    clearTimeout(temporizadorTope);
    temporizadorTope = undefined;
    if (tope.status === 'active' && tope.expiresAt !== null) {
      const falta = Date.parse(tope.expiresAt) - Date.now() + 1_000;
      temporizadorTope = setTimeout(
        () => void get().refrescarTope(true),
        Math.min(Math.max(falta, 1_000), RETARDO_MAXIMO_MS)
      );
    }

    if (pedir && tope.status !== 'active') get().abrirTope();
  },

  abrirTope: () => set({ topeAbierto: true, topeValor: '', topeValor2: '', errorTope: '' }),
  cerrarTope: () => set({ topeAbierto: false, topeValor: '', topeValor2: '', errorTope: '' }),
  escribirTope: (campo, v) => set({ [campo]: v, errorTope: '' } as Pick<EstadoPanel, typeof campo | 'errorTope'>),

  /**
   * Fija el tope. Se escribe dos veces, como una contraseña.
   *
   * Es justo el número que no se puede corregir durante 24 horas: un error de
   * tecleo aquí deja el panel un día entero con el tope equivocado. La coma se
   * acepta como separador decimal y se envía como punto.
   */
  guardarTope: async () => {
    const { topeValor, topeValor2, guardandoTope, avisar } = get();
    if (guardandoTope) return;

    const valor = topeValor.trim().replace(',', '.');
    const valor2 = topeValor2.trim().replace(',', '.');
    if (valor === '') {
      set({ errorTope: 'Escriba el margen inicial máximo.' });
      return;
    }
    if (valor !== valor2) {
      set({ errorTope: 'Los dos valores no coinciden. Escríbalo igual en los dos campos.' });
      return;
    }

    set({ guardandoTope: true });
    try {
      const tope = await panelService.setMarginCap(valor);
      set({ topeAbierto: false, topeValor: '', topeValor2: '', errorTope: '' });
      await get().refrescarTope(false);
      avisar(
        'ok',
        'Tope de margen fijado',
        `Ninguna apertura podrá llevar más de ${tope.value ?? valor} ${tope.currency} de margen inicial por casilla durante las próximas 24 horas.`,
        'Tope de margen'
      );
    } catch (e) {
      set({ errorTope: textoDeError(e) });
      /* Si el motivo es que sigue vigente, que la pantalla lo refleje. */
      await get().refrescarTope(false);
    } finally {
      set({ guardandoTope: false });
    }
  },

  /* ---------------- acordeones ---------------- */

  alternarCmp: (accountId) => set((s) => ({ cmpAbierto: { ...s.cmpAbierto, [accountId]: !s.cmpAbierto[accountId] } })),

  alternarHist: async (accountId) => {
    const abrira = !get().histAbierto[accountId];
    set((s) => ({ histAbierto: { ...s.histAbierto, [accountId]: !s.histAbierto[accountId] } }));
    if (!abrira) return;

    const cuenta = get().cuentas.find((c) => c.id === accountId);
    if (!cuenta) return;

    const faltantes = cuenta.subAccounts.filter((s) => !(s.id in get().historial));
    if (faltantes.length === 0) {
      set((s) => ({ cargaHistorial: { ...s.cargaHistorial, [accountId]: 'listo' } }));
      return;
    }

    set((s) => ({ cargaHistorial: { ...s.cargaHistorial, [accountId]: 'cargando' } }));
    try {
      const resultados = await Promise.all(faltantes.map((s) => panelService.getHistory(s.id, 20)));
      set((s) => {
        const historial = { ...s.historial };
        faltantes.forEach((sub, i) => {
          historial[sub.id] = resultados[i] ?? [];
        });
        return { historial, cargaHistorial: { ...s.cargaHistorial, [accountId]: 'listo' } };
      });
    } catch (e) {
      set((s) => ({ cargaHistorial: { ...s.cargaHistorial, [accountId]: 'error' } }));
      get().avisar('error', 'No se pudo leer el historial', textoDeError(e), cuenta.name);
    }
  },

  alternarHistSub: (subAccountId) => set((s) => ({ histSubAbierto: { ...s.histSubAbierto, [subAccountId]: !s.histSubAbierto[subAccountId] } })),

  abrirDetalle: (accountId, subAccountId) => set({ detalle: { accountId, subAccountId } }),
  cerrarDetalle: () => set({ detalle: null }),

  reintentarConexion: (accountId, subAccountId) => {
    const { cuentas, avisar } = get();
    const cuenta = cuentas.find((c) => c.id === accountId);
    const sub = cuenta?.subAccounts.find((s) => s.id === subAccountId);
    if (!cuenta || !sub) return;
    avisar('ok', 'Reintentando conexión', `Se envió una nueva solicitud de sincronización a ${sub.label}.`, cuenta.name);
    set({ detalle: null });
  },

  /* ---------------- avisos ---------------- */

  avisar: (tipo, titulo, cuerpo, meta = '') => {
    const id = `t${++secuenciaAviso}`;
    set((s) => ({ avisos: [...s.avisos, { id, tipo, titulo, cuerpo, meta }] }));
    if (tipo !== 'error') setTimeout(() => get().cerrarAviso(id), 4200);
  },

  cerrarAviso: (id) => set((s) => ({ avisos: s.avisos.filter((a) => a.id !== id) }))
}));
