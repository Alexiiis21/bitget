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
  BackupInfo,
  BatchPlan,
  BatchResult,
  BatchTarget,
  MarginCap,
  ClosedPosition,
  MarginMode,
  PlanKind,
  Position,
  Side
} from '@shared/domain/panel-view';
import type { Decimal } from '@shared/types';
import { SUBCUENTAS_POR_GRUPO } from '@shared/constants';
import { NotImplementedError } from '@shared/ports/panel-service';
import { panelService } from '@/services/panel-service';
import { casillas } from '@/lib/formato';
import { reproducirCajaRegistradora } from '@/lib/sonido';
import { textoEspera } from '@shared/espera-maestra';
import { ESTADO_ACCION_FABRICA, type ClaveColorEstado } from '@/lib/tokens';
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
  casilla: '1',
  apiKey: '',
  secretKey: '',
  passphrase: ''
};

/**
 * La primera casilla libre de una cuenta principal, o `''` si está llena.
 *
 * El formulario la propone sola al elegir la cuenta principal: el operador
 * quiere decir «esta subcuenta va en la 7», pero cuando le da igual, lo que no
 * puede pasar es que el formulario proponga la 1 —ocupada desde hace meses— y el
 * alta se rechace después de haber tecleado tres claves de 64 caracteres.
 *
 * La cadena vacía es «no queda ninguna», y se enseña como tal en vez de
 * proponer una casilla que va a chocar.
 */
const primeraCasillaLibre = (
  cuentas: readonly Account[],
  nombre: string,
  /**
   * Una casilla más que contar como ocupada.
   *
   * Es la que se acaba de dar de alta: la matriz llega del proceso principal y
   * puede tardar un instante en traerla, y sin esto el formulario propondría
   * otra vez la casilla que acaba de llenarse.
   */
  ocupadaAdemas?: number
): string => {
  const cuenta = cuentas.find((c) => c.name === nombre);
  const ocupadas = new Set(cuenta?.subAccounts.map((s) => s.slot) ?? []);
  if (ocupadaAdemas !== undefined) ocupadas.add(ocupadaAdemas);
  for (let n = 1; n <= SUBCUENTAS_POR_GRUPO; n += 1) {
    if (!ocupadas.has(n)) return String(n);
  }
  return '';
};

const seleccionVacia = (n: number): boolean[] => Array.from({ length: n }, () => false);

/** Las casillas de activo que tienen algo. Una casilla vacía no es un activo. */
const llenas = (ranuras: readonly (Asset | null)[]): Asset[] =>
  ranuras.filter((a): a is Asset => a !== null);

/** Los lados que el alcance opera: en «Ambos», los dos. */
const operaLong = (a: AlcanceLado): boolean => a !== 'short';
const operaShort = (a: AlcanceLado): boolean => a !== 'long';

/**
 * Deja la selección de una cuenta coherente con el alcance.
 *
 * --------------------------------------------------------------------------
 * Por qué el alcance ya no se limita a filtrar
 * --------------------------------------------------------------------------
 * Hasta el 28/08/2026 el alcance no tocaba la selección: las casillas se
 * marcaban igual en los dos lados y al contar se descartaba el lado que no
 * tocaba. Eso dejaba marcas visibles que no se enviaban —y, peor, marcas que se
 * enviaban al cambiar el alcance—. Pulsar «Todas» con el alcance en *Long*
 * marcaba por dentro las veinte short, invisibles en el recuento; volver a
 * *Ambos* convertía un lote de veinte casillas en uno de cuarenta sin que nadie
 * hubiera tocado la matriz. La otra mitad del problema era la simétrica: en
 * *Ambos* se podía marcar una sola punta de la columna y salía una posición a
 * medias donde el operador había pedido el par.
 *
 * La regla que queda es una sola, y es la que el cliente acordó el 28/08/2026:
 * **lo marcado es exactamente lo que se va a enviar**. En «Ambos» las dos
 * casillas de una columna son una: marcar una marca la otra. En «Long» y en
 * «Short» el lado que no se opera se destilda, para que no quede nada esperando
 * a que un cambio de alcance lo despierte.
 */
const reconciliar = (sel: SeleccionCuenta, alcance: AlcanceLado): SeleccionCuenta => {
  if (alcance === 'ambos') {
    /* Una columna marcada por cualquiera de sus dos puntas queda marcada entera. */
    const par = sel.selLong.map((v, i) => v || sel.selShort[i] === true);
    return { selLong: par, selShort: [...par] };
  }
  return {
    selLong: operaLong(alcance) ? sel.selLong : sel.selLong.map(() => false),
    selShort: operaShort(alcance) ? sel.selShort : sel.selShort.map(() => false)
  };
};

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

/**
 * El acto de restaurar, compartido por los dos caminos que llegan a él.
 *
 * Lo llaman `pedirRestauracion` —panel recién estrenado, un clic, sin
 * contraseña— y `confirmarRestauracion` —con almacén que reemplazar, tras
 * teclear la maestra—. Es el mismo acto y se escribe una vez; lo único que
 * cambia es si hay contraseña y de dónde sale el archivo.
 *
 * El `cancelled` del selector no es un fallo y no deja aviso: el operador cerró
 * la ventana y no pasó nada.
 */
async function ejecutarRestauracion(
  set: (parcial: Partial<EstadoPanel>) => void,
  get: () => EstadoPanel,
  desdeArchivo: boolean,
  maestra: string | undefined
): Promise<void> {
  set({ restaurando: true, errorRestauracion: '' });
  try {
    const r = desdeArchivo
      ? await panelService.restoreBackupFromFile(maestra)
      : await panelService.restoreBackup(maestra);

    if (r.cancelled) return;

    if (!r.ok) {
      /*
       * Una contraseña equivocada deja el diálogo abierto con el error dentro:
       * cerrarlo obligaría a volver a empezar por un fallo de tecleo. Lo demás
       * —un respaldo dañado, una versión futura— no se arregla insistiendo, así
       * que se cierra y se cuenta en la pantalla.
       */
      if (r.reason === 'maestra-incorrecta' || r.reason === 'espera-activa') {
        set({ errorRestauracion: r.message });
        /*
         * `espera-activa` se queda en el diálogo por la misma razón que la
         * clave equivocada: no hay nada que corregir fuera de él, solo esperar,
         * y cerrarlo obligaría a volver a buscar el respaldo.
         */
        await get().refrescarEsperaMaestra();
      } else set({ restauracion: null, avisoRestauracion: { ok: false, texto: r.message } });
      return;
    }

    const apartado =
      r.replaced === null
        ? ''
        : ` El almacén que tenía antes no se ha borrado: está al lado, como «${r.replaced}».`;
    set({
      restauracion: null,
      maestraRestauracion: '',
      avisoRestauracion: {
        ok: true,
        texto:
          (r.accounts === null
            ? r.message
            : `${r.message} Se restauraron ${r.accounts} ${r.accounts === 1 ? 'subcuenta' : 'subcuentas'}.`) +
          apartado
      }
    });
  } catch (e) {
    set({ errorRestauracion: textoDeError(e) });
    if (get().restauracion === null) {
      set({ avisoRestauracion: { ok: false, texto: textoDeError(e) } });
    }
  } finally {
    set({ restaurando: false });
  }
}

const CLAVE_TEMA = 'pcb.tema';

const temaInicial = (): 'light' | 'dark' => {
  const guardado = localStorage.getItem(CLAVE_TEMA);
  if (guardado === 'light' || guardado === 'dark') return guardado;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

const CLAVE_COLORES = 'pcb.colores-estado';

/** `#rrggbb` en minúsculas o mayúsculas. Es lo único que devuelve un `<input type="color">`. */
const esHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);

/**
 * Los tres colores de estado guardados, o los de fábrica.
 *
 * Se guardan en `localStorage` y no en disco por el proceso principal, igual
 * que el tema: no hay backend detrás de una preferencia visual, y montarle
 * canal IPC, esquema y archivo a tres cadenas sería más maquinaria que dato.
 *
 * Cada color se valida por separado. Un `localStorage` a medias —editado a
 * mano, o escrito por una versión anterior— no debe poder dejar la matriz sin
 * un color: lo que no sea un hex de seis dígitos vuelve al de fábrica y el
 * resto se conserva.
 */
const coloresIniciales = (): Record<ClaveColorEstado, string> => {
  const salida = { ...ESTADO_ACCION_FABRICA };
  try {
    const crudo: unknown = JSON.parse(localStorage.getItem(CLAVE_COLORES) ?? '{}');
    if (crudo === null || typeof crudo !== 'object') return salida;
    for (const clave of Object.keys(salida) as ClaveColorEstado[]) {
      const valor = (crudo as Record<string, unknown>)[clave];
      if (esHex(valor)) salida[clave] = valor;
    }
  } catch {
    /* JSON ilegible: se arranca con los de fábrica en vez de con la pantalla rota. */
  }
  return salida;
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

/**
 * El tic de la cuenta atrás de la maestra.
 *
 * Vive fuera del store por lo mismo que `cancelarCuentas`: es un recurso del
 * navegador, no un dato de la pantalla, y dejarlo en el estado haría que cada
 * segundo se comparase un número de temporizador contra el anterior.
 *
 * Solo corre mientras hay espera. Un `setInterval` permanente para enseñar un
 * cero es un render por segundo durante toda la sesión.
 */
let ticEspera: ReturnType<typeof setInterval> | null = null;

export interface EstadoPanel {
  /* ---- sesión ---- */
  pantalla: 'login' | 'panel';
  contrasena: string;
  errorContrasena: string;
  /**
   * Milisegundos que faltan para poder volver a probar la contraseña maestra.
   *
   * Lo manda el proceso principal —que es quien impone la espera y la guarda en
   * disco— y aquí solo se descuenta para pintar la cuenta atrás. Poner esto a
   * cero desde las herramientas del navegador no abre nada: el siguiente
   * intento se lo encuentra igual. Ver `shared/espera-maestra.ts`.
   */
  esperaMaestraMs: number;
  numeroPanel: number;
  ocupado: boolean;
  tema: 'light' | 'dark';
  /** Los tres colores de estado de acción, en hex. Los elige el operador. */
  coloresEstado: Record<ClaveColorEstado, string>;
  coloresAbierto: boolean;
  /**
   * Mercado contra el que opera este panel. Lo dice el proceso principal.
   *
   * Arranca en `real` a propósito, y hasta el 03/09/2026 arrancaba en
   * `simulado` — con este mismo comentario justificándolo, que decía: «de los
   * dos errores posibles, el que no se puede cometer es enseñar el mercado de
   * pruebas cuando se está operando con dinero de verdad».
   *
   * El principio era el correcto y el valor hacía justo lo contrario. Mientras
   * la consulta al proceso principal no responda, el distintivo dice MERCADO
   * REAL: una falsa alarma dura lo que tarda una llamada local —y hace mirar
   * dos veces—, mientras que una falsa tranquilidad puede costar una orden con
   * dinero de verdad enviada creyendo que era de pruebas.
   *
   * Se vio en vivo el 03/09/2026: con la red caída, un panel arrancado contra
   * el mercado real enseñaba SIMULADO. Ver `iniciar`.
   */
  mercado: 'real' | 'simulado';

  /* ---- activos ---- */
  /**
   * Las ocho casillas del selector, con sus huecos. `null` es casilla vacía.
   *
   * Es la lista tal como está en el proceso principal: la posición importa
   * porque el operador edita cada casilla por su número. `activos` es esta
   * misma lista compactada, y es la que usa todo lo que no dibuja el selector.
   */
  ranuras: (Asset | null)[];
  activos: Asset[];
  precios: Record<string, Decimal>;
  activoId: string;
  /* ---- buscador de activos ---- */
  /** Casilla que se está editando, o `null` si el buscador está cerrado. */
  ranuraEditando: number | null;
  catalogo: Asset[];
  cargaCatalogo: EstadoCarga;
  motivoCatalogo: string | null;
  filtroCatalogo: string;
  /** Guardando la casilla: bloquea un segundo clic sobre otro activo. */
  fijandoRanura: boolean;

  /* ---- barra lateral ---- */
  alcance: AlcanceLado;
  valores: ValoresHerramientas;
  valoresFijos: boolean;
  tipoOrden: 'market' | 'limit';
  /**
   * Aislado o cruzado, para la próxima apertura.
   *
   * Arranca en aislado y no en cruzado a propósito: es el modo en el que
   * funcionan las seis funciones del panel —en cruzado Bitget no admite agregar
   * margen— y el que el operador usa. Vive aquí, en la pantalla, porque es una
   * decisión de trading que se toma en cada operación, igual que el lado o el
   * tipo de orden.
   */
  modoMargen: MarginMode;
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
  /** Hay un respaldo escribiéndose. Frena la segunda pulsación del botón. */
  respaldando: boolean;
  /** Por `accountId`: el historial se pide al desplegar el acordeón de cada cuenta. */
  cargaHistorial: Record<string, EstadoCarga>;

  /* ---- acordeones ---- */
  cmpAbierto: Record<string, boolean>;
  histAbierto: Record<string, boolean>;
  histSubAbierto: Record<string, boolean>;

  /* ---- pantallas superpuestas ---- */
  apisAbierto: boolean;
  /** Pantalla de saldos por subcuenta (traspasos, Fase 2). */
  saldosAbierto: boolean;
  /**
   * La casilla abierta en el detalle, y sobre qué activo.
   *
   * `assetId` forma parte de la identidad porque el detalle enfrenta las dos
   * puntas de **una** posición: una casilla con BTC y ETH abiertos tiene cuatro
   * puntas, y sin el activo el modal mezclaría el long de una con el short de
   * la otra y enseñaría una distancia L/S que no existe.
   */
  detalle: { accountId: string; subAccountId: string; assetId: string } | null;
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
  /*
   * No hay cola de operaciones encadenadas.
   *
   * La hubo para «Aplicar todo», que planificaba Take Profit, margen y
   * apalancamiento uno detrás de otro. Los dos primeros ya no existen sueltos
   * —salen dentro de la apertura— y el tercero solo no es una cadena.
   */

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

  /* ---- baja de una API key ---- */
  /**
   * La ficha que se está dando de baja, o `null`.
   *
   * Mientras esto no sea `null` hay un diálogo abierto y **no se ha borrado
   * nada**: la baja sale con `confirmarBajaApi`, y solo con la contraseña de
   * paso. `hayPaso` dice si este panel tiene alguna configurada; sin ella el
   * proceso principal no deja borrar, y el diálogo lo explica en vez de gastar
   * los tres intentos en una clave que no existe.
   */
  bajaApi: { id: string; etiqueta: string; cuenta: string; hayPaso: boolean } | null;
  pinBaja: string;
  errorBaja: string;
  intentosBaja: number;

  /* ---- respaldo y restauración ---- */

  /** Lo que el panel encontró solo en Documentos, o `null` si no hay nada. */
  respaldoDetectado: BackupInfo | null;
  /**
   * La confirmación de reemplazo, abierta solo cuando **hay algo que perder**.
   *
   * En un panel recién estrenado se restaura de un clic: no hay almacén que
   * destruir y pedir una contraseña ahí sería ceremonia sin motivo.
   */
  restauracion: {
    nombre: string;
    creadoEn: string;
    cuentas: number | null;
    desdeArchivo: boolean;
  } | null;
  maestraRestauracion: string;
  errorRestauracion: string;
  restaurando: boolean;
  /** El desenlace de la última restauración, para que la pantalla lo enseñe. */
  avisoRestauracion: { ok: boolean; texto: string } | null;

  /* ---- avisos ---- */
  avisos: Aviso[];

  /* ---- acciones ---- */
  iniciar: () => Promise<void>;
  escribirContrasena: (v: string) => void;
  desbloquear: () => Promise<void>;
  /**
   * Pregunta al proceso principal cuánta espera queda y arranca la cuenta atrás.
   *
   * Se llama al arrancar —no solo tras fallar— porque la espera sobrevive a
   * cerrar el panel: quien lo reabra a los dos minutos tiene que ver el minuto
   * que le queda antes de teclear, en vez de gastar un intento para enterarse.
   */
  refrescarEsperaMaestra: () => Promise<void>;
  bloquear: () => void;
  fijarTema: (t: 'light' | 'dark') => void;
  fijarNumeroPanel: (n: number) => Promise<void>;

  abrirColores: () => void;
  cerrarColores: () => void;
  fijarColorEstado: (clave: ClaveColorEstado, hex: string) => void;
  restablecerColores: () => void;

  fijarActivo: (id: string) => void;
  /** Abre el buscador sobre una casilla concreta y trae el catálogo. */
  abrirBuscadorActivos: (indice: number) => Promise<void>;
  cerrarBuscadorActivos: () => void;
  escribirFiltroCatalogo: (v: string) => void;
  /** Pone un activo en la casilla que se está editando, o la vacía con `null`. */
  fijarRanura: (simbolo: string | null) => Promise<void>;
  fijarAlcance: (a: AlcanceLado) => void;
  fijarValor: (clave: keyof ValoresHerramientas, v: string) => void;
  alternarValoresFijos: () => void;
  fijarTipoOrden: (t: 'market' | 'limit') => void;
  fijarModoMargen: (m: MarginMode) => void;
  fijarLimitPrice: (v: string) => void;

  contarSeleccion: () => number;
  objetivosSeleccionados: () => { subAccountId: string; side: Side }[];
  alternarCuenta: (accountId: string) => void;
  alternarCasilla: (accountId: string, lado: 'selLong' | 'selShort', indice: number) => void;
  seleccionarTodo: () => void;
  limpiarSeleccion: () => void;

  /** Calcula qué pasaría. No envía nada. */
  planear: (kind: PlanKind) => Promise<void>;
  /** Aprueba el plan en pantalla y lo envía. */
  confirmarPlan: () => Promise<void>;
  /** Envía un plan, opcionalmente acotado a unas casillas: el reintento. */
  enviarPlan: (plan: BatchPlan, soloEstos?: BatchTarget[]) => Promise<void>;
  cancelarPlan: () => void;
  cerrarLote: () => void;
  escribirPin: (v: string) => void;

  abrirApis: () => void;
  cerrarApis: () => void;
  abrirSaldos: () => void;
  cerrarSaldos: () => void;
  escribirFormulario: (clave: keyof FormularioApiKey, v: string) => void;
  refrescarApis: () => Promise<void>;
  /** Guarda todas las subcuentas en un archivo dentro de Documentos. */
  respaldarCuentas: () => Promise<void>;
  abrirCarpetaRespaldos: () => Promise<void>;
  /** Sondea Documentos en busca de un respaldo. No restaura nada. */
  buscarRespaldo: () => Promise<void>;
  /**
   * Restaura, o pide confirmación antes si hay un almacén que reemplazar.
   *
   * `desdeArchivo` abre el selector del sistema en vez de usar el detectado.
   */
  pedirRestauracion: (desdeArchivo: boolean) => Promise<void>;
  escribirMaestraRestauracion: (v: string) => void;
  confirmarRestauracion: () => Promise<void>;
  cancelarRestauracion: () => void;
  guardarApi: () => Promise<void>;
  probarApi: (id: string) => Promise<void>;
  /** Abre la confirmación de la baja. No borra: para eso está `confirmarBajaApi`. */
  pedirBajaApi: (id: string) => Promise<void>;
  escribirPinBaja: (v: string) => void;
  confirmarBajaApi: () => Promise<void>;
  cancelarBajaApi: () => void;

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
  abrirDetalle: (accountId: string, subAccountId: string, assetId: string) => void;
  cerrarDetalle: () => void;
  reintentarConexion: (accountId: string, subAccountId: string) => void;

  avisar: (tipo: TipoAviso, titulo: string, cuerpo: string, meta?: string) => void;
  cerrarAviso: (id: string) => void;
  /** Vacía la pila entera. Ningún aviso se cierra solo; ver `avisar`. */
  cerrarAvisos: () => void;
}

/** Cómo se llama cada operación en los avisos y en el diálogo. */
const TITULOS: Record<PlanKind, string> = {
  open: 'Abrir posiciones',
  close: 'Cerrar posiciones',
  tp: 'Poner Take Profit',
  'tp-remove': 'Quitar Take Profit',
  'margin-add': 'Agregar margen',
  'margin-remove': 'Quitar margen',
  leverage: 'Apalancamiento'
};

/**
 * Qué campo del formulario necesita cada operación, o `null` si ninguno.
 *
 * Cerrar y quitar el Take Profit no llevan valor: actúan sobre lo que ya hay.
 * Los campos `tp` y `mga` no aparecen aquí porque no son operaciones: viajan
 * dentro de la apertura, y los lee `planear('open')`. Los que sí aparecen son
 * sus gemelos de ajuste —`tpAjuste` y `mgAjuste`—, que actúan sobre posiciones
 * ya abiertas y por eso son campos aparte. Ver `ValoresHerramientas`.
 */
const CAMPO_DE: Record<PlanKind, keyof ValoresHerramientas | null> = {
  open: 'mgi',
  close: null,
  tp: 'tpAjuste',
  'tp-remove': null,
  'margin-add': 'mgAjuste',
  'margin-remove': 'mgAjuste',
  leverage: 'ap'
};

/**
 * Las operaciones que piden además la contraseña de paso.
 *
 * --------------------------------------------------------------------------
 * Solo abrir
 * --------------------------------------------------------------------------
 * Del 26/08/2026 al 01/10/2026 también la pedía cerrar. El cliente pidió el
 * 01/10/2026 quitarla del cierre: cerrar tiene que ser inmediato, y la clave
 * queda para la única operación que compromete dinero nuevo.
 *
 * Las demás no entran: ajustar el Take Profit, el margen o el
 * apalancamiento no realiza ningún resultado, y pedir la clave en cada ajuste
 * la convertiría en un trámite que se teclea sin leer, que es exactamente como
 * se pierde un freno de este tipo.
 *
 * Se exporta porque el diálogo necesita la misma regla para decidir si enseña
 * el campo: dos listas que hay que acordarse de tocar a la vez acaban
 * separándose, y aquí separarse significa enseñar el campo y no comprobarlo.
 */
export const PIDE_PASO = new Set<PlanKind>(['open']);

/**
 * Las operaciones tras las cuales la selección se deshace sola.
 *
 * --------------------------------------------------------------------------
 * Abrir y cerrar, no solo abrir
 * --------------------------------------------------------------------------
 * Hasta el 11/09/2026 solo la apertura. El argumento de entonces —«solo abrir
 * cambia lo que hay en la casilla»— era el correcto, pero se aplicó a medias:
 * cerrar es la otra operación que cambia lo que la casilla contiene, porque la
 * vacía. El cliente lo reportó teniendo que destildar a mano tras cada cierre.
 *
 * El peligro es el mismo en espejo. Tras abrir, esas casillas tienen posición y
 * la siguiente acción caería sobre ellas; tras cerrar están vacías, y la
 * siguiente apertura abriría cuarenta posiciones que nadie pidió. Destildar
 * cuarenta casillas a mano es justamente lo que nadie hace.
 *
 * Las otras cinco no entran: ajustar el Take Profit, el margen o el
 * apalancamiento no cambia lo que hay en la casilla, y encadenar dos ajustes
 * sobre la misma selección —poner el Take Profit y luego subir el
 * apalancamiento— es un uso legítimo que desmarcar rompería.
 *
 * Lista aparte de `PIDE_PASO` —que hoy solo tiene la apertura—: son
 * dos reglas distintas —una frena, la otra ordena— y fundirlas haría que una
 * operación futura que pida clave heredase el desmarcado sin que nadie lo
 * decidiera.
 */
const DESMARCA_TRAS = new Set<PlanKind>(['open', 'close']);

/**
 * Qué campos se vacían tras enviar, salvo que estén fijados.
 *
 * El apalancamiento nunca se borra: el operador lo deja puesto porque casi
 * siempre repite el mismo. Los importes sí, para que un lote no herede por
 * descuido la cantidad del anterior.
 */
const LIMPIA_TRAS: Record<PlanKind, Partial<ValoresHerramientas>> = {
  /* Los tres campos de la apertura salieron con ella; no se heredan al siguiente lote. */
  open: { mgi: '', tp: '', mga: '' },
  close: {},
  /*
   * Los dos de ajuste se vacían por lo mismo que los de la apertura, y aquí
   * importa más: un importe de margen que se queda escrito es un importe que se
   * vuelve a enviar con la siguiente pulsación sobre las mismas casillas.
   */
  tp: { tpAjuste: '' },
  'tp-remove': {},
  'margin-add': { mgAjuste: '' },
  'margin-remove': { mgAjuste: '' },
  leverage: {}
};

export const usarPanel = create<EstadoPanel>()((set, get) => ({
  pantalla: 'login',
  contrasena: '',
  errorContrasena: '',
  esperaMaestraMs: 0,
  numeroPanel: 1,
  ocupado: false,
  tema: temaInicial(),
  coloresEstado: coloresIniciales(),
  coloresAbierto: false,
  /* Hasta saberlo de verdad, se avisa. Ver la declaración del campo. */
  mercado: 'real',

  ranuras: [],
  activos: [],
  precios: {},
  activoId: 'BTC',
  ranuraEditando: null,
  catalogo: [],
  cargaCatalogo: 'inicial',
  motivoCatalogo: null,
  filtroCatalogo: '',
  fijandoRanura: false,

  alcance: 'ambos',
  /* Los dos campos de ajuste arrancan vacíos: nada se aplica sin teclearlo. */
  valores: { tp: '1.5', mgi: '100', mga: '50', ap: '10', tpAjuste: '', mgAjuste: '' },
  valoresFijos: false,
  tipoOrden: 'market',
  modoMargen: 'isolated',
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
  respaldando: false,
  respaldoDetectado: null,
  restauracion: null,
  maestraRestauracion: '',
  errorRestauracion: '',
  restaurando: false,
  avisoRestauracion: null,
  cargaHistorial: {},

  cmpAbierto: {},
  histAbierto: {},
  histSubAbierto: {},

  apisAbierto: false,
  saldosAbierto: false,
  detalle: null,
  batch: null,
  reintentarFallidas: null,
  plan: null,
  planCargando: false,
  enviando: false,

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

  bajaApi: null,
  pinBaja: '',
  errorBaja: '',
  intentosBaja: 0,

  avisos: [],

  /* ---------------- sesión ---------------- */

  iniciar: async () => {
    /*
     * --------------------------------------------------------------------
     * Las dos lecturas van por separado, y no en un `Promise.all`
     * --------------------------------------------------------------------
     * Estuvieron juntas hasta el 03/09/2026, y eso convertia un corte de red
     * en una mentira sobre el mercado. `getSystemInfo` es local -version,
     * numero de panel y contra que mercado opera-, pero `listAssetSlots` sale
     * a Bitget; un `Promise.all` rechaza entero en cuanto falla una, asi que
     * un `ENOTFOUND` en el catalogo se llevaba por delante el `set` completo y
     * `mercado` se quedaba en su valor inicial.
     *
     * El sintoma se vio con la red caida: el panel arrancado con
     * `--mode staging-real` -mercado real, ordenes con dinero de verdad-
     * enseñaba la insignia SIMULADO. Es el peor fallo posible de ese
     * distintivo: no es que no informe, es que tranquiliza al operador
     * justo cuando no debe.
     *
     * Separadas, la insignia depende solo de una llamada que no puede fallar
     * por red, y el catalogo puede caerse sin arrastrar nada mas.
     */
    /*
     * La espera pendiente, antes que nada. Es lo único de la pantalla de
     * desbloqueo que puede venir de una sesión anterior, y enseñarla tarde
     * significa que el operador ya habrá tecleado para descubrirla.
     */
    void get().refrescarEsperaMaestra();

    try {
      const info = await panelService.getSystemInfo();
      set({ numeroPanel: info.panelNumber, mercado: info.market });
    } catch {
      /*
       * Si ni siquiera esto responde, el IPC esta roto. `mercado` se queda
       * como estaba, y su valor inicial es el de la alarma, no el de la
       * tranquilidad: ver la declaracion del estado.
       */
    }

    try {
      const ranuras = await panelService.listAssetSlots();
      const activos = llenas(ranuras);
      const primero = activos[0];
      set((estado) => ({
        ranuras,
        activos,
        activoId: primero?.id ?? 'BTC',
        valores: {
          ...estado.valores,
          ap: primero === undefined ? estado.valores.ap : String(primero.maxLeverage)
        }
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

  refrescarEsperaMaestra: async () => {
    let ms: number;
    try {
      ms = await panelService.masterCooldownMs();
    } catch {
      /*
       * Sin respuesta no se inventa una espera: el freno de verdad está al otro
       * lado y el siguiente intento se lo encontrará igual. Enseñar aquí una
       * cuenta atrás que nadie ha confirmado sería peor que no enseñar ninguna.
       */
      return;
    }

    set({ esperaMaestraMs: ms });

    if (ticEspera !== null) {
      clearInterval(ticEspera);
      ticEspera = null;
    }
    if (ms <= 0) return;

    ticEspera = setInterval(() => {
      const quedan = Math.max(0, get().esperaMaestraMs - 1_000);
      set({ esperaMaestraMs: quedan });
      if (quedan === 0 && ticEspera !== null) {
        clearInterval(ticEspera);
        ticEspera = null;
      }
    }, 1_000);
  },

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
        set({
          errorContrasena: resultado.reason ?? 'No se pudo abrir el almacén de credenciales.'
        });
        /*
         * El tercer fallo abre una espera, y la pantalla tiene que empezar a
         * contarla en ese mismo momento: el mensaje dice «dentro de 3 minutos»
         * una vez, y sin la cuenta atrás el operador no sabe cuánto lleva.
         */
        await get().refrescarEsperaMaestra();
        return;
      }

      set({ pantalla: 'panel', contrasena: '', errorContrasena: '', esperaMaestraMs: 0 });
      if (ticEspera !== null) {
        clearInterval(ticEspera);
        ticEspera = null;
      }
      avisar(
        'ok',
        'Sesión iniciada',
        'Verificando las API keys registradas de las subcuentas.',
        `PCB #${numeroPanel}`
      );

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
         * El motivo se guarda además de avisar: el aviso lo cierra el operador
         * -a veces sin leerlo- y la matriz se queda vacía el resto de la sesión.
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
          avisar(
            'error',
            `Sin conexión con ${a.subAccountLabel}`,
            'La credencial no responde.',
            `Cuenta ${a.accountName}`
          )
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
      saldosAbierto: false,
      seguridadAbierta: false,
      /*
       * El buscador se cierra, pero las ocho casillas se quedan: son la
       * configuración del panel, no datos de la sesión, y el catálogo del
       * mercado es público. Lo que no puede quedarse abierto sobre la pantalla
       * de desbloqueo es un diálogo.
       */
      ranuraEditando: null,
      filtroCatalogo: '',
      detalle: null,
      /* Incluida la baja a medio confirmar: no se hereda a la siguiente sesión. */
      bajaApi: null,
      pinBaja: '',
      errorBaja: '',
      intentosBaja: 0,
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

  abrirColores: () => set({ coloresAbierto: true }),
  cerrarColores: () => set({ coloresAbierto: false }),

  /*
   * El color se guarda en cuanto se toca, sin botón de aceptar.
   *
   * Es el mismo criterio que el interruptor de tema: el resultado se ve en la
   * matriz que hay detrás del diálogo mientras se elige, así que un «guardar»
   * solo añadiría una forma de perder lo que ya se estaba viendo aplicado.
   * Deshacerlo es *Restablecer*, o volver a elegir.
   */
  fijarColorEstado: (clave, hex) => {
    const coloresEstado = { ...get().coloresEstado, [clave]: hex };
    localStorage.setItem(CLAVE_COLORES, JSON.stringify(coloresEstado));
    set({ coloresEstado });
  },

  restablecerColores: () => {
    localStorage.removeItem(CLAVE_COLORES);
    set({ coloresEstado: { ...ESTADO_ACCION_FABRICA } });
  },

  /**
   * Cambia el número del panel y lo manda guardar.
   *
   * Se aplica en pantalla antes de que el disco conteste porque es un rótulo:
   * no decide nada y esperar por él haría que el campo fuera a tirones al
   * teclear. Si la escritura falla, el número **se queda a la vista** y se dice
   * que no se guardó: revertirlo mientras el operador teclea sería aún más
   * confuso, y al reiniciar volverá el anterior de todas formas.
   */
  fijarNumeroPanel: async (n) => {
    set({ numeroPanel: n });
    try {
      await panelService.setPanelNumber(n);
    } catch (e) {
      get().avisar(
        'aviso',
        'El número de panel no se guardó',
        `${textoDeError(e)} Se ve el ${n} en la cabecera, pero al reiniciar volverá el anterior.`,
        'PCB'
      );
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

  /**
   * Abre el buscador sobre una casilla. El catálogo se pide una sola vez.
   *
   * Son los 754 contratos del mercado y no cambian mientras el panel está
   * abierto, así que volver a pedirlos cada vez que se abre el buscador sería
   * una espera por nada. El proceso principal ya lo cachea; esto evita incluso
   * el viaje por IPC.
   */
  abrirBuscadorActivos: async (indice) => {
    set({ ranuraEditando: indice, filtroCatalogo: '' });
    if (get().cargaCatalogo === 'listo') return;

    set({ cargaCatalogo: 'cargando', motivoCatalogo: null });
    try {
      set({
        catalogo: await panelService.listAssetCatalog(),
        cargaCatalogo: 'listo',
        motivoCatalogo: null
      });
    } catch (e) {
      set({ cargaCatalogo: 'error', motivoCatalogo: textoDeError(e) });
    }
  },

  cerrarBuscadorActivos: () => set({ ranuraEditando: null, filtroCatalogo: '' }),
  escribirFiltroCatalogo: (filtroCatalogo) => set({ filtroCatalogo }),

  /**
   * Cambia el activo de la casilla que se está editando.
   *
   * --------------------------------------------------------------------------
   * Lo que hay que arreglar además de la casilla
   * --------------------------------------------------------------------------
   * Quitar un activo de su casilla puede dejar `activoId` apuntando a algo que
   * ya no está en el selector, y con él se planifica: sin esto, «Abrir» iría
   * contra un activo que la pantalla ya no enseña. Cuando pasa, la selección
   * cae en el primer activo que quede —y arrastra el tope de apalancamiento,
   * como cualquier cambio de activo, salvo con «valores fijos» puestos—.
   *
   * El proceso principal es quien valida y quien guarda; aquí solo se refleja
   * lo que devolvió. Un rechazo —símbolo inexistente, activo repetido— se
   * enseña como aviso y **no cambia nada**: las casillas siguen como estaban.
   */
  fijarRanura: async (simbolo) => {
    const { ranuraEditando, avisar, fijandoRanura } = get();
    if (ranuraEditando === null || fijandoRanura) return;

    set({ fijandoRanura: true });
    try {
      const ranuras = await panelService.setAssetSlot(ranuraEditando, simbolo);
      const activos = llenas(ranuras);

      set((s) => {
        const sigueViva = activos.some((a) => a.id === s.activoId);
        const primero = activos[0];
        const activoId = sigueViva ? s.activoId : (primero?.id ?? '');
        const ap =
          sigueViva || s.valoresFijos || primero === undefined
            ? s.valores.ap
            : String(primero.maxLeverage);

        return {
          ranuras,
          activos,
          activoId,
          valores: { ...s.valores, ap },
          ranuraEditando: null,
          filtroCatalogo: ''
        };
      });

      const puesto = ranuras[ranuraEditando];
      avisar(
        'ok',
        `Casilla ${ranuraEditando + 1} actualizada`,
        puesto === null || puesto === undefined
          ? 'La casilla quedó vacía. El activo que tenía ya no se puede elegir desde el panel.'
          : `${puesto.label} ocupa ahora la casilla ${ranuraEditando + 1}.`,
        'Activos'
      );
    } catch (e) {
      avisar('aviso', 'No se cambió la casilla', textoDeError(e), 'Activos');
    } finally {
      set({ fijandoRanura: false });
    }
  },
  /*
   * Cambiar el alcance reconcilia lo que ya estaba marcado.
   *
   * No es una comodidad: sin esto, el alcance solo filtraba y la selección
   * guardaba lados que la pantalla no enseñaba como suyos. Ver `reconciliar`.
   */
  fijarAlcance: (alcance) =>
    set((s) => ({
      alcance,
      seleccion: Object.fromEntries(
        Object.entries(s.seleccion).map(([id, sel]) => [id, reconciliar(sel, alcance)])
      )
    })),
  fijarValor: (clave, v) => set((s) => ({ valores: { ...s.valores, [clave]: v } })),
  alternarValoresFijos: () => set((s) => ({ valoresFijos: !s.valoresFijos })),
  fijarTipoOrden: (tipoOrden) => set({ tipoOrden }),
  fijarModoMargen: (modoMargen) => set({ modoMargen }),
  fijarLimitPrice: (limitPrice) => set({ limitPrice }),

  /* ---------------- selección ---------------- */

  /*
   * El filtro por alcance sigue aquí aunque `reconciliar` ya lo garantice.
   *
   * Es redundante a propósito, y en la dirección segura: si algún camino
   * dejara una marca fuera del alcance, el filtro hace que **no se envíe** —se
   * vería una casilla tildada de menos en el recuento— en vez de que salga una
   * orden que el operador no pidió.
   */
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
        if (alcance !== 'short' && sel.selLong[i])
          objetivos.push({ subAccountId: sub.id, side: 'long' });
        if (alcance !== 'long' && sel.selShort[i])
          objetivos.push({ subAccountId: sub.id, side: 'short' });
      });
    }
    return objetivos;
  },

  /* «Todas» marca solo los lados que el alcance opera; el otro se queda vacío. */
  alternarCuenta: (accountId) =>
    set((s) => {
      const cuenta = s.cuentas.find((c) => c.id === accountId);
      if (!cuenta) return s;
      const n = cuenta.subAccounts.length;
      const actual = s.seleccion[accountId] ?? {
        selLong: seleccionVacia(n),
        selShort: seleccionVacia(n)
      };
      const todas =
        (!operaLong(s.alcance) || actual.selLong.every(Boolean)) &&
        (!operaShort(s.alcance) || actual.selShort.every(Boolean));
      const marcar = !todas;
      return {
        seleccion: {
          ...s.seleccion,
          [accountId]: {
            selLong: seleccionVacia(n).map(() => marcar && operaLong(s.alcance)),
            selShort: seleccionVacia(n).map(() => marcar && operaShort(s.alcance))
          }
        }
      };
    }),

  /**
   * Marca o desmarca una casilla. En «Ambos», la columna entera.
   *
   * Las dos puntas de una columna van juntas porque el alcance ya dijo que se
   * opera en las dos: pedir «Ambos» y tener que acertar dos clics —uno en la
   * fila LONG y otro en la SHORT, sobre casillas de 20 px— es donde se colaba
   * media posición sin que nadie lo notara.
   *
   * Y la casilla del lado que no se opera no se marca: en «Long» la fila SHORT
   * no responde. Marcarla no habría enviado nada, pero se quedaba tildada
   * esperando a que un cambio de alcance la convirtiera en una orden.
   */
  alternarCasilla: (accountId, lado, indice) =>
    set((s) => {
      const enAlcance = lado === 'selLong' ? operaLong(s.alcance) : operaShort(s.alcance);
      if (!enAlcance) return s;

      const cuenta = s.cuentas.find((c) => c.id === accountId);
      const n = cuenta?.subAccounts.length ?? 20;
      const actual = s.seleccion[accountId] ?? {
        selLong: seleccionVacia(n),
        selShort: seleccionVacia(n)
      };
      const marcar = actual[lado][indice] !== true;
      const aplicar = (lista: boolean[]): boolean[] =>
        lista.map((v, i) => (i === indice ? marcar : v));

      return {
        seleccion: {
          ...s.seleccion,
          [accountId]:
            s.alcance === 'ambos'
              ? { selLong: aplicar(actual.selLong), selShort: aplicar(actual.selShort) }
              : { ...actual, [lado]: aplicar(actual[lado]) }
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
            /* Solo los lados del alcance: en «Long» no se marcan las short por debajo. */
            selLong: c.subAccounts.map(() => operaLong(s.alcance)),
            selShort: c.subAccounts.map(() => operaShort(s.alcance))
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
    const { objetivosSeleccionados, avisar, valores, activoId, activos, tipoOrden, limitPrice } =
      get();
    const targets = objetivosSeleccionados();
    const titulo = TITULOS[kind];

    if (targets.length === 0) {
      avisar(
        'aviso',
        'Ninguna casilla seleccionada',
        'Marque al menos una casilla sobre los números 1–20 antes de continuar.',
        `PCB · ${titulo}`
      );
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
      avisar(
        'error',
        'Sin activo',
        'No hay ningún activo seleccionado. Vuelva a abrir el panel si la lista está vacía.',
        `PCB · ${titulo}`
      );
      return;
    }
    if (!activo.tradable) {
      avisar(
        'aviso',
        'Activo suspendido',
        `Bitget tiene ${activo.label} suspendido ahora mismo: no admite órdenes.`,
        `PCB · ${titulo}`
      );
      return;
    }

    /* El campo que hace falta según la operación. Vacío, no se planifica. */
    const campo = CAMPO_DE[kind];
    const valor = campo === null ? '' : valores[campo].trim();
    if (campo !== null && valor === '') {
      avisar(
        'aviso',
        'Campo vacío',
        `Escriba un valor en ${titulo} antes de continuar.`,
        `PCB · ${titulo}`
      );
      return;
    }

    /*
     * Los tres ajustes sobre una posición abierta exigen un número **sin signo**.
     *
     * El canal lo rechaza igualmente —el esquema de `margen:planificar` no
     * acepta el menos—, pero un `-5` escrito en el campo tiene que responder
     * aquí y en castellano: quien lo teclea está pensando «quitar 5», y el
     * botón que pulsa ya dice si se agrega o se retira. Dejar que el signo
     * también opine sería tener dos mandos para lo mismo, y con ellos la
     * posibilidad de que se contradigan.
     */
    if (
      (kind === 'tp' || kind === 'margin-add' || kind === 'margin-remove') &&
      !/^\d+(\.\d+)?$/.test(valor)
    ) {
      avisar(
        'aviso',
        'Valor no válido',
        'Escriba un número positivo y sin signo. Si quiere retirar margen, use el botón «Quitar margen»: ' +
          'el sentido lo decide el botón, no un menos delante del número.',
        `PCB · ${titulo}`
      );
      return;
    }

    /*
     * Los tres campos de la apertura que viajan como texto y acaban en un
     * decimal del proceso principal.
     *
     * Un punto suelto —lo que queda al teclear el separador y borrar la cifra—
     * llegaba hasta el planificador y lo reventaba con un `DecimalError` crudo:
     * no se abría nada, pero el aviso no decía qué campo estaba mal ni se
     * parecía a un mensaje del panel. Incidencia del 05/09/2026. El proceso
     * principal ya no se cae por esto —descarta la casilla con su motivo—, pero
     * decirlo aquí ahorra la consulta de precio y saldo de cada casilla marcada
     * para llegar a la misma respuesta.
     */
    if (kind === 'open') {
      const malo = (
        [
          ['Margen inicial', valores.mgi],
          ['Margen adicional', valores.mga],
          ['Take Profit %', valores.tp]
        ] as const
      ).find(([, v]) => v.trim() !== '' && !/^\d+(\.\d+)?$/.test(v.trim()));

      if (malo !== undefined) {
        avisar(
          'aviso',
          `${malo[0]}: valor no válido`,
          `«${malo[1].trim()}» no es un número. Escriba una cifra positiva y sin signo, con el punto ` +
            'como separador decimal —por ejemplo 10 o 10.5—. No se envió nada.',
          `PCB · ${titulo}`
        );
        return;
      }
    }

    const apalancamiento = Number.parseFloat(valores.ap);
    if ((kind === 'open' || kind === 'leverage') && !Number.isFinite(apalancamiento)) {
      avisar(
        'aviso',
        'Apalancamiento inválido',
        'Escriba el apalancamiento antes de continuar.',
        `PCB · ${titulo}`
      );
      return;
    }

    /*
     * Margen adicional en cruzado: no se planifica siquiera.
     *
     * El proceso principal lo rechaza igualmente —es él quien tiene la última
     * palabra sobre lo que sale a Bitget—, pero decirlo aquí ahorra una consulta
     * de precios y saldos por cada casilla marcada para llegar a la misma
     * respuesta. En cruzado el margen sale del saldo total de la cuenta y lo
     * reparte el propio exchange: no hay nada que agregar por posición.
     */
    const margenAdicional =
      kind === 'open' && valores.mga.trim() !== '' ? valores.mga.trim() : null;
    if (kind === 'open' && margenAdicional !== null && get().modoMargen === 'crossed') {
      avisar(
        'aviso',
        'No se abre: margen adicional en CRUZADO',
        'En margen cruzado Bitget no admite agregar margen —lo toma del saldo total de la cuenta—. ' +
          'Cambie el modo a AISLADO o deje vacío el campo «Margen adicional». No se envió nada.',
        `PCB · ${titulo}`
      );
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
            leverage: apalancamiento,
            marginMode: get().modoMargen,
            /*
             * El margen adicional escrito sale con esta misma orden, como el
             * Take Profit. Si no cabe en el saldo, la casilla se descarta antes
             * de abrir: abrir sin el margen aprobado deja la posición con menos
             * colchón del que el operador cree que tiene.
             */
            additionalMargin: margenAdicional,
            /*
             * El Take Profit escrito sale con esta misma orden. Antes había que
             * pulsar además «Take Profit %» y aprobar un segundo plan, y el
             * porcentaje se enseñaba aquí rotulado «se pone aparte»: el operador
             * lo leía como que ya salía, y las posiciones quedaban sin él.
             */
            takeProfitPercent: valores.tp.trim() === '' ? null : valores.tp.trim()
          })
        : kind === 'close'
          ? panelService.planClose({ targets, assetId: activoId })
          : kind === 'tp'
            ? /*
               * El porcentaje sale de `tpAjuste`, no de `tp`: este se aplica
               * sobre lo que ya está abierto y aquel viaja con la apertura. Son
               * dos campos justamente para que este botón no pueda reenviar el
               * valor que se tecleó para abrir. Ver `ValoresHerramientas`.
               */
              panelService.planTakeProfit({ targets, assetId: activoId, percent: valor })
            : kind === 'tp-remove'
              ? panelService.planRemoveTakeProfit({ targets, assetId: activoId })
              : kind === 'margin-add' || kind === 'margin-remove'
                ? panelService.planMargin({
                    targets,
                    assetId: activoId,
                    amount: valor,
                    /* La dirección la decide el botón pulsado, nunca un signo tecleado. */
                    direction: kind === 'margin-remove' ? 'quitar' : 'agregar'
                  })
                : panelService.planLeverage({
                    targets,
                    assetId: activoId,
                    leverage: apalancamiento
                  }));

      /*
       * Un plan sin ninguna casilla viable no se enseña como plan: sería un
       * diálogo con una lista vacía y un botón de confirmar que no haría nada.
       * Se dice por qué no salió ninguna, que es la información útil.
       *
       * Salvo que venga impedido. Entonces el diálogo **sí** se abre aunque no
       * quede ninguna casilla viable, porque el cliente pidió justo eso: ver el
       * motivo en la confirmación, con las casillas que lo causan nombradas una
       * a una, en lugar de un aviso suelto que solo cabe la primera razón.
       */
      if (plan.entries.length === 0 && plan.blocker === null) {
        set({ planCargando: false, plan: null, mensaje: '' });
        avisar(
          'aviso',
          'Ninguna casilla puede recibir esta acción',
          plan.discards[0]?.reason ??
            'Las casillas seleccionadas no admiten esta operación ahora mismo.',
          `PCB · ${titulo}`
        );
        return;
      }

      set({ plan, planCargando: false, mensaje: '', pinPaso: '', errorPaso: '', intentosPaso: 0 });
    } catch (e) {
      set({ planCargando: false, plan: null, mensaje: '' });
      avisar(
        'error',
        `No se pudo preparar ${titulo.toLowerCase()}`,
        textoDeError(e),
        `PCB · ${titulo}`
      );
    }
  },

  /**
   * Envía el plan aprobado. Es la segunda fase y la única que toca Bitget.
   *
   * Abrir pide además la contraseña de paso —ver `PIDE_PASO`—. Tres
   * intentos fallidos cancelan la operación **sin haber enviado nada**.
   */
  confirmarPlan: async () => {
    const { plan, pinPaso, intentosPaso, avisar } = get();
    if (!plan) return;

    /*
     * Un plan impedido no llega ni a pedir la contraseña.
     *
     * El diálogo ya lo enseña bloqueado, así que esto solo se alcanza si algo
     * lo saltó —un Enter en el campo, una pulsación mientras se recalculaba—.
     * Se comprueba igualmente porque es barato y porque la otra mitad del
     * freno, la que de verdad cuenta, está en el proceso principal: él rechaza
     * el plan al ejecutarlo, así que ni un fallo de esta pantalla puede sacar
     * una orden.
     */
    if (plan.blocker !== null) {
      set({ errorPaso: plan.blocker.message });
      return;
    }

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
          avisar(
            'error',
            `${plan.title}: cancelado`,
            `Se introdujo la contraseña de paso incorrecta ${INTENTOS_PASO} veces. No se envió ninguna orden a Bitget.`,
            'Seguridad'
          );
          return;
        }
        set({
          pinPaso: '',
          errorPaso: `Contraseña de paso incorrecta. Intento ${intentos} de ${INTENTOS_PASO}.`,
          intentosPaso: intentos
        });
        return;
      }
    }

    set({
      plan: null,
      pinPaso: '',
      errorPaso: '',
      intentosPaso: 0,
      enviando: true,
      mensaje: 'Enviando a Bitget…'
    });
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

    /*
     * Un lote nuevo deja sin valor el informe del anterior.
     *
     * Solo cuando es un lote nuevo: un reintento -que llega con `soloEstos`-
     * tiene que conservar visible la lista de fallidas hasta que salga bien.
     *
     * Sin esto, un envío que revienta dejaba en pantalla la banda del lote
     * anterior —no es un modal, no bloquea nada— con su botón «Reintentar solo
     * las fallidas» activo y ligado por closure a aquel plan. El operador leía
     * «No se pudo enviar» y pulsaba el botón que tenía al lado creyendo que
     * reintentaba lo que acababa de fallar: reenviaba el lote de antes, sobre
     * una casilla que ya no estaba mirando.
     */
    if (soloEstos === undefined) set({ batch: null, reintentarFallidas: null });

    try {
      const r = await panelService.executePlan(plan, soloEstos);

      /*
       * Lo que de verdad se puede reenviar.
       *
       * Queda fuera lo indeterminado —reintentarlo a ciegas es lo único que
       * puede duplicar una posición— y también las filas derivadas de la
       * apertura: un «Sub-01 · TP» fallido comparte cuenta y lado con la
       * apertura, así que reintentarlo reenviaba la orden entera y le colocaba
       * un segundo Take Profit con identificadores nuevos. Ver
       * `BatchFailure.retryable`.
       */
      const reintentables = r.failures.filter((f) => f.retryable);

      set({
        batch: r,
        enviando: false,
        mensaje: '',
        reintentarFallidas:
          reintentables.length > 0
            ? async () =>
                get().enviarPlan(
                  plan,
                  reintentables.map((f) => ({ subAccountId: f.subAccountId, side: f.side }))
                )
            : null
      });

      /*
       * La caja registradora: una vez por lote que mueva posiciones de verdad.
       *
       * `open` y `close`, y no las otras cinco, porque son las dos que estrenan
       * o liquidan posición —el cierre lo pidió el cliente el 17/09/2026, y es
       * donde el «ka-ching» encaja mejor: es el momento en que el resultado se
       * realiza—. Ajustar apalancamiento, mover margen o cambiar el Take Profit
       * no son lo que este sonido anuncia.
       *
       * `r.ok > 0` y no `r.failures.length === 0` porque un lote a medias
       * también movió dinero: si veinte casillas entraron y tres fallaron, hay
       * diecisiete mil dólares en el mercado que no estaban hace un segundo, y
       * el aviso de error que sale justo debajo ya cuenta la otra mitad.
       *
       * Y `ok`, no `ok + skipped`: una casilla que se cierra sin tener posición
       * abierta vuelve con `22002 · no había ninguna posición que cerrar` y cae
       * en `skipped`. Sonaría la caja sin haberse cerrado nada, que es justo la
       * confirmación que el operador no debe recibir.
       *
       * Las indeterminadas no suenan por sí solas: no se sabe si entraron, y
       * ese caso se resuelve mirando Bitget, no oyendo el panel.
       *
       * Vale igual para el reintento de fallidas, que vuelve a pasar por aquí:
       * si el reintento entra, se movió una posición, y suena.
       */
      if ((plan.kind === 'open' || plan.kind === 'close') && r.ok > 0) {
        reproducirCajaRegistradora();
      }

      if (r.undetermined.length > 0) {
        avisar(
          'aviso',
          'Hay casillas sin confirmar',
          `${casillas(r.undetermined.length)} se enviaron y no se pudo averiguar si entraron. Compruébelas en Bitget antes de repetir: reintentarlas a ciegas podría duplicarlas.`,
          `PCB · ${plan.title}`
        );
      } else if (r.failures.length === 0) {
        avisar(
          'ok',
          `${plan.title}: correcto`,
          `${casillas(r.ok)} completadas.`,
          `PCB · ${plan.title}`
        );
      } else {
        avisar(
          'error',
          `${plan.title}: con errores`,
          `${r.ok} correctas y ${r.failures.length} con error. El detalle está sobre la matriz.`,
          `PCB · ${plan.title}`
        );
      }

      /* El apalancamiento se conserva; el resto se limpia salvo «valores fijos». */
      if (!get().valoresFijos) {
        set((s) => ({
          valores: { ...s.valores, ...LIMPIA_TRAS[plan.kind] },
          limitPrice: plan.kind === 'open' ? '' : s.limitPrice
        }));
      }

      /*
       * Va después del informe y no antes: el resultado del lote se lee sobre la
       * matriz, y vaciar la selección mientras se dibuja el informe haría
       * parpadear las casillas que se están mirando. El porqué de la lista, en
       * `DESMARCA_TRAS`.
       *
       * Desmarca aunque el lote haya salido a medias. Las fallidas se recuperan
       * con «Reintentar solo las fallidas», que se alimenta del informe y no de
       * la selección; y `BatchResult` no sabe cuáles salieron bien —`ok` y
       * `skipped` son recuentos sin identidad—, así que desmarcar solo esas
       * sería adivinar sobre una matriz que mueve dinero real.
       */
      if (DESMARCA_TRAS.has(plan.kind)) get().limpiarSeleccion();
    } catch (e) {
      set({ enviando: false, mensaje: '' });
      avisar(
        'error',
        `No se pudo enviar ${plan.title.toLowerCase()}`,
        textoDeError(e),
        `PCB · ${plan.title}`
      );
    }
  },

  cancelarPlan: () => set({ plan: null, pinPaso: '', errorPaso: '', intentosPaso: 0 }),

  cerrarLote: () => set({ batch: null, reintentarFallidas: null }),

  escribirPin: (v) => set({ pinPaso: v, errorPaso: '' }),

  /* ---------------- API keys ---------------- */

  /* Al abrir, la casilla propuesta es la primera libre de la cuenta de partida. */
  abrirApis: () =>
    set((s) => ({
      apisAbierto: true,
      formulario: { ...s.formulario, casilla: primeraCasillaLibre(s.cuentas, s.formulario.cuenta) }
    })),
  /*
   * La pantalla de saldos no precarga nada aquí: se lee sola al montarse.
   *
   * Es distinta del resto porque su lectura gasta una petición de un cupo de una
   * cada diez segundos, así que quien decide cuándo se pide es la propia
   * pantalla —al abrirse y al pulsar Actualizar—, y no el store cada vez que
   * alguien toca este interruptor.
   */
  abrirSaldos: () => set({ saldosAbierto: true }),
  cerrarSaldos: () => set({ saldosAbierto: false }),

  /* Cerrar la pantalla cancela la baja a medio confirmar: su diálogo vive sobre ella. */
  cerrarApis: () =>
    set({
      apisAbierto: false,
      ultimaValidacion: null,
      bajaApi: null,
      pinBaja: '',
      errorBaja: '',
      intentosBaja: 0
    }),

  /*
   * Cambiar de cuenta principal arrastra la casilla propuesta.
   *
   * La casilla 3 de la cuenta A y la 3 de la B no tienen nada que ver, así que
   * conservar el número al cambiar de cuenta proponía una casilla ocupada tan a
   * menudo como una libre. Lo que el operador escribe a mano se respeta: esto
   * solo salta cuando cambia la cuenta.
   */
  escribirFormulario: (clave, v) =>
    set((s) => ({
      formulario: {
        ...s.formulario,
        [clave]: v,
        ...(clave === 'cuenta' ? { casilla: primeraCasillaLibre(s.cuentas, v) } : {})
      },
      ultimaValidacion: null
    })),

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

  /*
   * Respaldar es una acción sobre todas las claves y no toca ninguna: no entra
   * en `ocupado`, que frena las operaciones que mueven dinero. Su propio
   * `respaldando` es lo que impide la doble pulsación.
   */
  respaldarCuentas: async () => {
    if (get().respaldando) return;
    set({ respaldando: true });
    try {
      const r = await panelService.backupAccounts();
      if (r.ok) {
        const cuantas =
          r.accounts === null
            ? 'Sus credenciales están'
            : `Sus ${r.accounts} ${r.accounts === 1 ? 'subcuenta está' : 'subcuentas están'}`;
        get().avisar(
          'ok',
          'Respaldo guardado',
          `${cuantas} en «${r.fileName ?? ''}», dentro de ${r.folder ?? 'Documentos'}. ` +
            'Para pasarlas a otra versión del panel, esa carpeta es la que hay que tener a mano. ' +
            'Recuerde que la contraseña maestra no va dentro del archivo.',
          'Respaldo'
        );
      } else {
        get().avisar('error', 'No se pudo respaldar', r.message, 'Respaldo');
      }
    } catch (e) {
      get().avisar('error', 'No se pudo respaldar', textoDeError(e), 'Respaldo');
    } finally {
      set({ respaldando: false });
    }
  },

  abrirCarpetaRespaldos: async () => {
    try {
      await panelService.openBackupFolder();
    } catch (e) {
      get().avisar('error', 'No se pudo abrir la carpeta', textoDeError(e), 'Respaldo');
    }
  },

  /* Sondear no puede fallar hacia el operador: sin respaldo, la pantalla sigue igual. */
  buscarRespaldo: async () => {
    try {
      set({ respaldoDetectado: await panelService.findBackup() });
    } catch {
      set({ respaldoDetectado: null });
    }
  },

  /*
   * El diálogo aparece **solo cuando hay algo que perder**.
   *
   * En un panel recién estrenado no hay almacén que destruir: se restaura de un
   * clic, sin preguntar nada. Con almacén hace falta la maestra de *este*
   * panel, que es lo que demuestra que lo que se va a apartar es suyo.
   */
  pedirRestauracion: async (desdeArchivo) => {
    if (get().restaurando) return;
    set({ avisoRestauracion: null, errorRestauracion: '' });

    let hayVault: boolean;
    try {
      hayVault = !(await panelService.isFirstRun());
    } catch (e) {
      set({ avisoRestauracion: { ok: false, texto: textoDeError(e) } });
      return;
    }

    if (!hayVault) {
      await ejecutarRestauracion(set, get, desdeArchivo, undefined);
      return;
    }

    const detectado = get().respaldoDetectado;
    set({
      restauracion: {
        nombre: desdeArchivo ? '' : (detectado?.fileName ?? ''),
        creadoEn: desdeArchivo ? '' : (detectado?.createdAt ?? ''),
        cuentas: desdeArchivo ? null : (detectado?.accounts ?? null),
        desdeArchivo
      },
      maestraRestauracion: '',
      errorRestauracion: ''
    });
  },

  escribirMaestraRestauracion: (v) => set({ maestraRestauracion: v, errorRestauracion: '' }),

  confirmarRestauracion: async () => {
    const { restauracion, maestraRestauracion, restaurando } = get();
    if (restauracion === null || restaurando) return;
    if (maestraRestauracion === '') {
      set({ errorRestauracion: 'Escriba la contraseña maestra de este panel.' });
      return;
    }
    await ejecutarRestauracion(set, get, restauracion.desdeArchivo, maestraRestauracion);
  },

  cancelarRestauracion: () =>
    set({ restauracion: null, maestraRestauracion: '', errorRestauracion: '' }),

  guardarApi: async () => {
    const { formulario, ocupado, avisar, refrescarApis } = get();
    if (ocupado) return;
    if (
      !formulario.subcuenta ||
      !formulario.apiKey ||
      !formulario.secretKey ||
      !formulario.passphrase
    ) {
      avisar(
        'aviso',
        'Faltan datos',
        'Complete subcuenta, API Key, Secret Key y Passphrase antes de guardar.',
        'Gestión de API keys'
      );
      return;
    }

    /*
     * Sin casilla no se sale a la red. Pasa cuando la cuenta principal elegida
     * tiene sus veinte ocupadas: `primeraCasillaLibre` devuelve vacío en vez de
     * proponer una que va a chocar, y el aviso dice qué hacer.
     */
    const casilla = Number.parseInt(formulario.casilla, 10);
    if (!Number.isInteger(casilla) || casilla < 1 || casilla > SUBCUENTAS_POR_GRUPO) {
      avisar(
        'aviso',
        'Elija una casilla',
        `Indique en qué casilla —de 1 a ${SUBCUENTAS_POR_GRUPO}— va esta subcuenta. Si la cuenta principal ${formulario.cuenta} las tiene todas ocupadas, use otra o dé de baja una subcuenta.`,
        'Gestión de API keys'
      );
      return;
    }

    set({ ocupado: true });
    try {
      const resultado: ValidationResult = await panelService.registerApiKey({
        subAccountLabel: formulario.subcuenta,
        accountName: formulario.cuenta,
        slot: casilla,
        apiKey: formulario.apiKey,
        secretKey: formulario.secretKey,
        passphrase: formulario.passphrase
      });

      if (!resultado.ok) {
        avisar(
          'error',
          resultado.verdict === 'rechazada' ? 'Credenciales rechazadas' : 'Credenciales inválidas',
          resultado.reason ?? 'Bitget no aceptó la credencial.',
          `Cuenta ${formulario.cuenta}`
        );
        return;
      }

      /*
       * Se vacía el formulario menos la cuenta principal, y la casilla avanza a
       * la siguiente libre. Dar de alta veinte subcuentas seguidas es el uso
       * real de esta pantalla, y volver a «A · casilla 1» después de cada una
       * obligaba a reelegir las dos cosas veinte veces. Los tres secretos sí se
       * borran: eso no se hereda de un alta a la siguiente.
       */
      set((s) => ({
        formulario: {
          ...FORMULARIO_VACIO,
          cuenta: formulario.cuenta,
          casilla: primeraCasillaLibre(s.cuentas, formulario.cuenta, casilla)
        },
        ultimaValidacion: {
          etiqueta: formulario.subcuenta,
          uid: resultado.uid ?? '',
          uidPadre: resultado.parentUid ?? ''
        }
      }));
      await refrescarApis();
      avisar(
        'ok',
        'API key guardada',
        `${formulario.subcuenta} se registró en la casilla ${formulario.casilla} de la cuenta ${formulario.cuenta}.`,
        'Gestión de API keys'
      );
      /*
       * Lo que dice de los permisos no se puede ir solo a los cuatro segundos.
       *
       * Los avisos normales se cierran con un temporizador; los de tipo `error`
       * se quedan hasta que alguien los cierra a mano. Desde que el panel
       * acepta claves con permiso de retiro —decisión del cliente del
       * 29/08/2026, ver src/main/bitget/verificacion.ts— «esta clave puede
       * sacar fondos» tiene que quedarse en pantalla: es lo único que separa
       * guardarla a sabiendas de guardarla sin enterarse.
       */
      resultado.warnings.forEach((w) => {
        if (w.code === 'permiso-retiro') {
          avisar('error', 'Esta API Key puede sacar fondos', w.message, formulario.subcuenta);
        } else if (w.code.startsWith('permiso-')) {
          avisar('aviso', 'Permisos de la API Key', w.message, formulario.subcuenta);
        } else {
          avisar('aviso', 'Revise la configuración de la cuenta', w.message, formulario.subcuenta);
        }
      });
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
        avisar(
          'error',
          'Credenciales rechazadas',
          resultado.reason ?? 'Bitget no aceptó la credencial.',
          `Cuenta ${fila.accountName}`
        );
        return;
      }
      avisar(
        'ok',
        'Conexión válida',
        `${fila.subAccountLabel} responde correctamente a la API oficial de Bitget.`,
        `Cuenta ${fila.accountName}`
      );
    } catch (e) {
      avisar('error', 'No se pudo probar', textoDeError(e), `Cuenta ${fila.accountName}`);
    }
  },

  /*
   * ==========================================================================
   * La baja de una API key, en dos fases y con contraseña de paso
   * ==========================================================================
   * Lo pidió el cliente el 31/08/2026. Hasta entonces «Eliminar» borraba en el
   * acto, sin preguntar nada: un clic de más en la fila equivocada —o alguien
   * que se sienta ante un panel desbloqueado— dejaba una subcuenta fuera del
   * sistema, y recuperarla es ir a Bitget, generar otra API Key y teclear tres
   * claves de 64 caracteres.
   *
   * Es la misma clave que piden abrir y cerrar (ver `PIDE_PASO`) y por el mismo
   * motivo: lo que no se deshace pulsando otra vez se aprueba escribiendo algo.
   * Aquí no se comprueba con `verifyStepPassword`: la clave viaja **con** la
   * baja y la comprueba el proceso principal, que es el único que puede
   * garantizar que no se borra nada sin ella.
   */
  pedirBajaApi: async (id) => {
    const fila = get().apiKeys.find((a) => a.id === id);
    if (!fila) return;

    set({
      bajaApi: { id, etiqueta: fila.subAccountLabel, cuenta: fila.accountName, hayPaso: true },
      pinBaja: '',
      errorBaja: '',
      intentosBaja: 0
    });

    /*
     * Si este panel no tiene contraseña de paso, el proceso principal no va a
     * dejar borrar —`comprobarPaso` responde «no», nunca «sí»—. Se dice aquí y
     * no después de tres intentos fallidos contra una clave que no existe.
     *
     * La respuesta llega después de abrir el diálogo, y por eso se comprueba que
     * siga siendo la misma ficha: entre una cosa y otra el operador ha podido
     * cancelar y pedir la baja de otra.
     */
    try {
      const hayPaso = await panelService.hasStepPassword();
      const { bajaApi } = get();
      if (hayPaso || bajaApi === null || bajaApi.id !== id) return;
      set({
        bajaApi: { ...bajaApi, hayPaso: false },
        errorBaja:
          'Este panel todavía no tiene contraseña de paso. Fíjela en Seguridad —la misma que pide abrir posiciones— antes de dar de baja una API key.'
      });
    } catch {
      /*
       * No poder preguntarlo no abre la puerta: el diálogo sigue pidiendo la
       * clave y quien decide si vale es el proceso principal.
       */
    }
  },

  escribirPinBaja: (v) => set({ pinBaja: v, errorBaja: '' }),

  cancelarBajaApi: () => set({ bajaApi: null, pinBaja: '', errorBaja: '', intentosBaja: 0 }),

  confirmarBajaApi: async () => {
    const { bajaApi, pinBaja, intentosBaja, ocupado, avisar, refrescarApis } = get();
    if (bajaApi === null || ocupado) return;

    if (!bajaApi.hayPaso) {
      set({
        errorBaja: 'Fije la contraseña de paso en Seguridad antes de dar de baja una API key.'
      });
      return;
    }
    /* La cadena vacía no se manda: el canal la rechazaría, y como error de red. */
    if (pinBaja === '') {
      set({ errorBaja: 'Escriba la contraseña de paso para dar de baja esta API key.' });
      return;
    }

    set({ ocupado: true });
    try {
      const desenlace = await panelService.deleteApiKey(bajaApi.id, pinBaja);

      /* Tres intentos fallidos cancelan la baja, y la credencial sigue donde estaba. */
      if (desenlace === 'paso-incorrecto') {
        const intentos = intentosBaja + 1;
        if (intentos >= INTENTOS_PASO) {
          set({ bajaApi: null, pinBaja: '', errorBaja: '', intentosBaja: 0 });
          avisar(
            'error',
            'Baja cancelada',
            `Se introdujo la contraseña de paso incorrecta ${INTENTOS_PASO} veces. ${bajaApi.etiqueta} sigue registrada.`,
            'Seguridad'
          );
          return;
        }
        set({
          pinBaja: '',
          errorBaja: `Contraseña de paso incorrecta. Intento ${intentos} de ${INTENTOS_PASO}.`,
          intentosBaja: intentos
        });
        return;
      }

      set({ bajaApi: null, pinBaja: '', errorBaja: '', intentosBaja: 0 });
      await refrescarApis();

      /* Ya no estaba: la lista de esta pantalla se había quedado vieja. */
      if (desenlace === 'no-estaba') {
        avisar(
          'aviso',
          'No había nada que dar de baja',
          `${bajaApi.etiqueta} ya no figuraba en el registro de este panel.`,
          `Cuenta ${bajaApi.cuenta}`
        );
        return;
      }
      avisar(
        'aviso',
        'API key eliminada',
        `${bajaApi.etiqueta} ya no recibirá órdenes desde este panel.`,
        `Cuenta ${bajaApi.cuenta}`
      );
    } catch (e) {
      set({ bajaApi: null, pinBaja: '', errorBaja: '', intentosBaja: 0 });
      avisar('error', 'No se pudo eliminar', textoDeError(e), `Cuenta ${bajaApi.cuenta}`);
    } finally {
      set({ ocupado: false });
    }
  },

  /* ---------------- seguridad ---------------- */

  abrirSeguridad: () =>
    set({
      seguridadAbierta: true,
      etapaSeguridad: 'maestra',
      maestraSeguridad: '',
      errorSeguridad: '',
      pasoNuevo: '',
      pasoNuevo2: ''
    }),
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
        /*
         * Aquí `false` significa dos cosas —clave equivocada, o espera en
         * curso— y hay que separarlas antes de escribir nada: decirle «no es
         * correcta» a quien acaba de teclear la buena es como se empieza a
         * dudar de una contraseña que estaba bien.
         */
        await get().refrescarEsperaMaestra();
        const espera = get().esperaMaestraMs;
        set({
          maestraSeguridad: '',
          errorSeguridad:
            espera > 0
              ? `Demasiados intentos seguidos. Vuelva a intentarlo dentro de ${textoEspera(espera)}.`
              : 'La contraseña maestra no es correcta.'
        });
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
    set(
      campo === 'pasoNuevo'
        ? { pasoNuevo: v, errorSeguridad: '' }
        : { pasoNuevo2: v, errorSeguridad: '' }
    ),

  guardarPaso: async () => {
    const { pasoNuevo, pasoNuevo2, avisar } = get();
    if (pasoNuevo.length < MINIMO_PASO) {
      set({
        errorSeguridad: `La contraseña de paso debe tener al menos ${MINIMO_PASO} caracteres.`
      });
      return;
    }
    if (pasoNuevo !== pasoNuevo2) {
      set({ errorSeguridad: 'Las dos contraseñas de paso no coinciden.' });
      return;
    }
    try {
      await panelService.setStepPassword(pasoNuevo);
      set({ seguridadAbierta: false, errorSeguridad: '', pasoNuevo: '', pasoNuevo2: '' });
      avisar(
        'ok',
        'Contraseña de paso actualizada',
        'Se pedirá esta clave cada vez que se abra una posición.',
        'Seguridad'
      );
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

  alternarCmp: (accountId) =>
    set((s) => ({ cmpAbierto: { ...s.cmpAbierto, [accountId]: !s.cmpAbierto[accountId] } })),

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

  alternarHistSub: (subAccountId) =>
    set((s) => ({
      histSubAbierto: { ...s.histSubAbierto, [subAccountId]: !s.histSubAbierto[subAccountId] }
    })),

  abrirDetalle: (accountId, subAccountId, assetId) =>
    set({ detalle: { accountId, subAccountId, assetId } }),
  cerrarDetalle: () => set({ detalle: null }),

  reintentarConexion: (accountId, subAccountId) => {
    const { cuentas, avisar } = get();
    const cuenta = cuentas.find((c) => c.id === accountId);
    const sub = cuenta?.subAccounts.find((s) => s.id === subAccountId);
    if (!cuenta || !sub) return;
    avisar(
      'ok',
      'Reintentando conexión',
      `Se envió una nueva solicitud de sincronización a ${sub.label}.`,
      cuenta.name
    );
    set({ detalle: null });
  },

  /* ---------------- avisos ---------------- */

  /**
   * ==========================================================================
   * Ningún aviso se va solo. Los cierra el operador.
   * ==========================================================================
   * Hasta el 31/08/2026 solo los de error esperaban; los demás se iban a los
   * 4,2 segundos. Lo pidió el cliente el 31/08/2026 y el caso que lo motivó es
   * el alta de una credencial: guardar una API key deja en pantalla el «API key
   * guardada» **y**, detrás, los avisos de permisos de esa clave —incluido el de
   * que puede sacar fondos—. Cuatro segundos no dan para leer eso, y lo que se
   * fue no se puede volver a mirar: no hay historial de avisos.
   *
   * Que el temporizador cubriera unos tipos y no otros era además al revés de lo
   * razonable: el aviso amarillo -«esta clave tiene permisos de más»- importa
   * bastante más que el azul, y era el que se llevaba el temporizador por
   * delante. O esperan todos o no espera ninguno.
   *
   * La contrapartida es que la pila crece hasta que alguien la vacía, y por eso
   * `Avisos` ofrece «Cerrar todos» en cuanto hay más de uno.
   */
  avisar: (tipo, titulo, cuerpo, meta = '') => {
    const id = `t${++secuenciaAviso}`;
    set((s) => ({ avisos: [...s.avisos, { id, tipo, titulo, cuerpo, meta }] }));
  },

  cerrarAviso: (id) => set((s) => ({ avisos: s.avisos.filter((a) => a.id !== id) })),

  cerrarAvisos: () => set({ avisos: [] })
}));
