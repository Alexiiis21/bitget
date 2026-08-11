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
  ActionKey,
  Asset,
  ClosedPosition,
  Position,
  Side
} from '@shared/domain/panel-view';
import type { Decimal } from '@shared/types';
import { NotImplementedError } from '@shared/ports/panel-service';
import { panelService } from '@/services/panel-service';
import { casillas } from '@/lib/formato';
import type {
  AccionPendiente,
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
  return e instanceof Error ? e.message : 'Fallo inesperado del panel.';
};

const CLAVE_TEMA = 'pcb.tema';

const temaInicial = (): 'light' | 'dark' => {
  const guardado = localStorage.getItem(CLAVE_TEMA);
  if (guardado === 'light' || guardado === 'dark') return guardado;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

let secuenciaAviso = 0;
let temporizadorMensaje: ReturnType<typeof setTimeout> | undefined;
let cancelarPrecios: (() => void) | undefined;
let cancelarPosiciones: (() => void) | undefined;

export interface EstadoPanel {
  /* ---- sesión ---- */
  pantalla: 'login' | 'panel';
  contrasena: string;
  errorContrasena: string;
  numeroPanel: number;
  ocupado: boolean;
  tema: 'light' | 'dark';

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
  mensaje: string;

  /* ---- datos ---- */
  cuentas: Account[];
  seleccion: Record<string, SeleccionCuenta>;
  posiciones: Position[];
  historial: Record<string, ClosedPosition[]>;
  apiKeys: ApiKeyRow[];
  formulario: FormularioApiKey;

  /* ---- carga de cada sección ---- */
  cargaCuentas: EstadoCarga;
  motivoCuentas: string | null;
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
  batch: import('@shared/domain/panel-view').BatchResult | null;
  /** Repite el último lote, acotado a sus objetivos fallidos. `null` si el último lote no tuvo fallos o no es repetible. */
  reintentarFallidas: (() => Promise<void>) | null;

  /* ---- seguridad ---- */
  seguridadAbierta: boolean;
  etapaSeguridad: 'maestra' | 'editar';
  maestraSeguridad: string;
  errorSeguridad: string;
  pasoNuevo: string;
  pasoNuevo2: string;

  /* ---- confirmación de apertura ---- */
  pendiente: AccionPendiente | null;
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

  aplicarHerramienta: (clave: ActionKey, campo: keyof ValoresHerramientas, etiqueta: string) => Promise<void>;
  aplicarTodo: () => Promise<void>;
  reintentarMargenCuenta: (accountId: string) => Promise<void>;
  pedirPaso: () => void;
  cerrarSeleccionados: () => Promise<void>;
  cerrarLote: () => void;
  escribirPin: (v: string) => void;
  confirmarPaso: () => Promise<void>;
  cancelarPaso: () => void;

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

  alternarCmp: (accountId: string) => void;
  alternarHist: (accountId: string) => Promise<void>;
  alternarHistSub: (subAccountId: string) => void;
  abrirDetalle: (accountId: string, subAccountId: string) => void;
  cerrarDetalle: () => void;
  reintentarConexion: (accountId: string, subAccountId: string) => void;

  avisar: (tipo: TipoAviso, titulo: string, cuerpo: string, meta?: string) => void;
  cerrarAviso: (id: string) => void;
}

export const usarPanel = create<EstadoPanel>()((set, get) => ({
  pantalla: 'login',
  contrasena: '',
  errorContrasena: '',
  numeroPanel: 1,
  ocupado: false,
  tema: temaInicial(),

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

  cargaCuentas: 'inicial',
  motivoCuentas: null,
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

  seguridadAbierta: false,
  etapaSeguridad: 'maestra',
  maestraSeguridad: '',
  errorSeguridad: '',
  pasoNuevo: '',
  pasoNuevo2: '',

  pendiente: null,
  pinPaso: '',
  errorPaso: '',
  intentosPaso: 0,

  avisos: [],

  /* ---------------- sesión ---------------- */

  iniciar: async () => {
    try {
      const [info, activos] = await Promise.all([panelService.getSystemInfo(), panelService.listAssets()]);
      set({ numeroPanel: info.panelNumber, activos, activoId: activos[0]?.id ?? 'BTC' });
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

      set({ cargaCuentas: 'cargando', motivoCuentas: null });
      try {
        const cuentas = await panelService.getAccounts();
        set({ cuentas, cargaCuentas: 'listo', motivoCuentas: null });
        cancelarPosiciones?.();
        cancelarPosiciones = panelService.subscribePositions((snap) => set({ posiciones: snap.positions }));
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
    cancelarPosiciones?.();
    cancelarPosiciones = undefined;
    set({
      pantalla: 'login',
      contrasena: '',
      errorContrasena: '',
      apisAbierto: false,
      seguridadAbierta: false,
      pendiente: null,
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
      cargaApis: 'inicial',
      motivoApis: null,
      cargaHistorial: {},
      historial: {}
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

  fijarActivo: (activoId) => set({ activoId }),
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

  /* ---------------- acciones sobre la selección ---------------- */

  aplicarHerramienta: async (clave, campo, etiquetaBase) => {
    const { objetivosSeleccionados, avisar, valores } = get();
    const targets = objetivosSeleccionados();
    if (targets.length === 0) {
      avisar('aviso', 'Ninguna casilla seleccionada', 'Marque al menos una casilla sobre los números 1–20 antes de aplicar la acción.', `PCB · ${etiquetaBase}`);
      return;
    }

    const valor = valores[campo];
    if (valor.trim() === '') {
      avisar('aviso', 'Campo vacío', `Escriba un valor en ${etiquetaBase} antes de aplicarlo.`, `PCB · ${etiquetaBase}`);
      return;
    }

    const ejecutar = (obj: { subAccountId: string; side: Side }[]) =>
      clave === 'tp'
        ? panelService.setTakeProfit({ targets: obj, percent: valor })
        : clave === 'mg'
          ? panelService.addMargin({ targets: obj, amount: valor })
          : panelService.setLeverage({ targets: obj, leverage: Number.parseFloat(valor) });

    const aplicarResultado = (r: Awaited<ReturnType<typeof ejecutar>>): void => {
      set({
        batch: r,
        reintentarFallidas:
          r.failures.length > 0
            ? async () => aplicarResultado(await ejecutar(r.failures.map((f) => ({ subAccountId: f.subAccountId, side: f.side }))))
            : null
      });
    };

    try {
      const resultado = await ejecutar(targets);
      aplicarResultado(resultado);
      clearTimeout(temporizadorMensaje);
      set({ mensaje: `${etiquetaBase} ${valor} → ${casillas(targets.length)}` });
      temporizadorMensaje = setTimeout(() => set({ mensaje: '' }), 3200);

      if (!get().valoresFijos) get().fijarValor(campo, campo === 'ap' ? valores.ap : '');
    } catch (e) {
      avisar('error', 'No se pudo aplicar', textoDeError(e), `PCB · ${etiquetaBase}`);
    }
  },

  aplicarTodo: async () => {
    const { objetivosSeleccionados, avisar, valores, valoresFijos } = get();
    const targets = objetivosSeleccionados();
    if (targets.length === 0) {
      avisar('aviso', 'Ninguna casilla seleccionada', 'Marque al menos una casilla sobre los números 1–20 antes de aplicar la acción.', 'PCB · Aplicar todo');
      return;
    }

    try {
      const [tp, mg, ap] = await Promise.all([
        valores.tp.trim() ? panelService.setTakeProfit({ targets, percent: valores.tp }) : null,
        valores.mga.trim() ? panelService.addMargin({ targets, amount: valores.mga }) : null,
        valores.ap.trim() ? panelService.setLeverage({ targets, leverage: Number.parseFloat(valores.ap) }) : null
      ]);

      const combinado = tp ?? mg ?? ap;
      if (combinado) {
        set({
          batch: {
            label: 'TP + margen adicional + apalancamiento',
            ok: (tp?.ok ?? 0) + (mg?.ok ?? 0) + (ap?.ok ?? 0),
            skipped: (tp?.skipped ?? 0) + (mg?.skipped ?? 0) + (ap?.skipped ?? 0),
            failures: [...(tp?.failures ?? []), ...(mg?.failures ?? []), ...(ap?.failures ?? [])]
          },
          /* Combina tres lotes distintos: no hay una única llamada que repetir, así que no se ofrece reintento granular aquí. */
          reintentarFallidas: null
        });
      }

      clearTimeout(temporizadorMensaje);
      set({ mensaje: `TP + margen + apalancamiento → ${casillas(targets.length)}` });
      temporizadorMensaje = setTimeout(() => set({ mensaje: '' }), 3200);

      /* El apalancamiento nunca se borra; el resto se limpia salvo «valores fijos». */
      if (!valoresFijos) set((s) => ({ valores: { tp: '', mgi: '', mga: '', ap: s.valores.ap }, limitPrice: '' }));
    } catch (e) {
      avisar('error', 'No se pudo aplicar', textoDeError(e), 'PCB · Aplicar todo');
    }
  },

  reintentarMargenCuenta: async (accountId) => {
    const { cuentas, posiciones, avisar } = get();
    const cuenta = cuentas.find((c) => c.id === accountId);
    if (!cuenta) return;

    const subIds = new Set(cuenta.subAccounts.map((s) => s.id));
    const targets = posiciones
      .filter((p) => p.marginCritical && subIds.has(p.subAccountId))
      .map((p) => ({ subAccountId: p.subAccountId, side: p.side }));

    if (targets.length === 0) return;

    try {
      const resultado = await panelService.addMargin({ targets, amount: '50' });
      avisar('ok', 'Margen adicional aplicado', 'Se reenvió el margen adicional a las posiciones que lo tenían pendiente. Ya no están expuestas a liquidación.', 'Alerta crítica resuelta');
      if (resultado.failures.length > 0) {
        avisar('error', 'Algunas posiciones siguen sin margen', `${resultado.failures.length} no se pudieron actualizar.`, cuenta.name);
      }
    } catch (e) {
      avisar('error', 'No se pudo aplicar el margen', textoDeError(e), cuenta.name);
    }
  },

  pedirPaso: () => {
    const { objetivosSeleccionados, avisar, valores } = get();
    if (objetivosSeleccionados().length === 0) {
      avisar('aviso', 'Ninguna casilla seleccionada', 'Marque al menos una casilla sobre los números 1–20 antes de abrir.', 'PCB · Abrir');
      return;
    }
    set({
      pendiente: {
        tipo: 'abrir',
        etiqueta: 'Abrir',
        alcanceTexto: casillas(objetivosSeleccionados().length),
        margenInicial: valores.mgi
      },
      pinPaso: '',
      errorPaso: '',
      intentosPaso: 0
    });
  },

  cerrarSeleccionados: async () => {
    const { objetivosSeleccionados, avisar, activoId } = get();
    const targets = objetivosSeleccionados();
    if (targets.length === 0) {
      avisar('aviso', 'Ninguna casilla seleccionada', 'Marque al menos una casilla sobre los números 1–20 antes de cerrar.', 'PCB · Cerrar');
      return;
    }
    const ejecutar = (obj: { subAccountId: string; side: Side }[]) => panelService.closePositions({ targets: obj, assetId: activoId });
    const aplicarResultado = (r: Awaited<ReturnType<typeof ejecutar>>): void => {
      set({
        batch: r,
        reintentarFallidas:
          r.failures.length > 0
            ? async () => aplicarResultado(await ejecutar(r.failures.map((f) => ({ subAccountId: f.subAccountId, side: f.side }))))
            : null
      });
    };

    try {
      const resultado = await ejecutar(targets);
      aplicarResultado(resultado);
      avisar('ok', 'Cierre enviado', `${casillas(resultado.ok)} cerradas correctamente.`, 'PCB · Cerrar');
    } catch (e) {
      avisar('error', 'No se pudo cerrar', textoDeError(e), 'PCB · Cerrar');
    }
  },

  cerrarLote: () => set({ batch: null, reintentarFallidas: null }),

  escribirPin: (v) => set({ pinPaso: v, errorPaso: '' }),

  confirmarPaso: async () => {
    const { pendiente, pinPaso, intentosPaso, avisar, objetivosSeleccionados, activoId, tipoOrden, limitPrice, valores } = get();
    if (!pendiente) return;

    let valido: boolean;
    try {
      valido = await panelService.verifyStepPassword(pinPaso);
    } catch (e) {
      set({ pendiente: null, pinPaso: '', errorPaso: '', intentosPaso: 0 });
      avisar('error', 'No se pudo confirmar', textoDeError(e), 'Seguridad');
      return;
    }

    if (!valido) {
      const intentos = intentosPaso + 1;
      if (intentos >= INTENTOS_PASO) {
        set({ pendiente: null, pinPaso: '', errorPaso: '', intentosPaso: 0 });
        avisar('error', 'Apertura cancelada', 'Se introdujo la contraseña de paso incorrecta 3 veces. No se envió ninguna orden a Bitget.', 'Seguridad');
        return;
      }
      set({ pinPaso: '', errorPaso: `Contraseña de paso incorrecta. Intento ${intentos} de ${INTENTOS_PASO}.`, intentosPaso: intentos });
      return;
    }

    set({ pendiente: null, pinPaso: '', errorPaso: '', intentosPaso: 0 });

    const ejecutar = (obj: { subAccountId: string; side: Side }[]) =>
      panelService.openPositions({
        targets: obj,
        assetId: activoId,
        orderType: tipoOrden,
        limitPrice: tipoOrden === 'limit' && limitPrice.trim() ? limitPrice : null,
        initialMargin: valores.mgi
      });
    const aplicarResultado = (r: Awaited<ReturnType<typeof ejecutar>>): void => {
      set({
        batch: r,
        reintentarFallidas:
          r.failures.length > 0
            ? async () => aplicarResultado(await ejecutar(r.failures.map((f) => ({ subAccountId: f.subAccountId, side: f.side }))))
            : null
      });
    };

    try {
      const resultado = await ejecutar(objetivosSeleccionados());
      aplicarResultado(resultado);
      avisar('ok', 'Apertura enviada', `${casillas(resultado.ok)} abiertas correctamente.`, 'PCB · Abrir');
    } catch (e) {
      avisar('error', 'No se pudo abrir', textoDeError(e), 'PCB · Abrir');
    }
  },

  cancelarPaso: () => set({ pendiente: null, pinPaso: '', errorPaso: '', intentosPaso: 0 }),

  /* ---------------- API keys ---------------- */

  abrirApis: () => set({ apisAbierto: true }),
  cerrarApis: () => set({ apisAbierto: false }),
  escribirFormulario: (clave, v) => set((s) => ({ formulario: { ...s.formulario, [clave]: v } })),

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

      set({ formulario: FORMULARIO_VACIO });
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
