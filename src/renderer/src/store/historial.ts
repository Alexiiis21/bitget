/**
 * Estado de la pantalla de historial por periodo.
 *
 * Aparte de `store/panel.ts` porque es una pantalla de solo lectura con su
 * propio ciclo: no toca la matriz ni los lotes, y lo que guarda —la subcuenta
 * elegida, el periodo, lo último leído— solo le importa a ella.
 *
 * ==========================================================================
 * Tres lecturas, tres velocidades
 * ==========================================================================
 *   consultar     lee del disco del equipo. Instantánea: es lo que se pinta
 *                 al elegir subcuenta o cambiar fechas.
 *   sincronizar   trae de Bitget lo nuevo. Tarda; corre por detrás y, al
 *                 terminar, vuelve a consultar.
 *   saldo         lee de Bitget el saldo de ahora.
 *
 * ==========================================================================
 * Respuestas que llegan tarde
 * ==========================================================================
 * El operador cambia de subcuenta o de fechas más rápido de lo que contesta
 * Bitget. Cada lectura se apunta con la subcuenta y un turno, y al volver solo
 * se pinta si sigue siendo la que toca. Sin esto, la suma de la subcuenta
 * anterior podía aparecer encima de la tabla de la nueva: el error exacto que
 * esta pantalla no se puede permitir.
 */
import { create } from 'zustand';
import {
  NO_FILTER,
  type ExportResult,
  type HistoryFilter,
  type HistoryPeriod,
  type HistorySyncProgress,
  type HistorySyncResult,
  type LiveBalance,
  type TradeHistory
} from '@shared/domain/panel-view';
import { panelService } from '@/services/panel-service';

const textoDe = (e: unknown, defecto: string): string => {
  if (!(e instanceof Error)) return defecto;
  /*
   * Electron antepone «Error invoking remote method '…': » y el nombre del
   * error. Se quita también si el nombre es de los del proceso principal
   * —`ErrorBitget`, `ErrorHistorial`, `ErrorPeriodo`—, que empiezan por
   * «Error» en vez de terminar en él.
   */
  return e.message.replace(/^Error invoking remote method '[^']*': (?:\w*Error\w*: )?/, '');
};

/** `YYYY-MM-DD` de una fecha, en la hora del equipo. */
export function diaLocal(d: Date): string {
  const a = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${a}-${m}-${dia}`;
}

/** Los últimos siete días, hoy incluido. */
export function periodoPorDefecto(hoy = new Date()): HistoryPeriod {
  const desde = new Date(hoy);
  desde.setDate(desde.getDate() - 6);
  return { from: diaLocal(desde), to: diaLocal(hoy) };
}

const FORMATO_DIA = /^\d{4}-\d{2}-\d{2}$/;

/** El motivo por el que un periodo no se puede consultar, o `null`. */
export function problemaDelPeriodo(p: HistoryPeriod): string | null {
  if (!FORMATO_DIA.test(p.from) || !FORMATO_DIA.test(p.to))
    return 'Elija la fecha inicial y la final.';
  if (p.from > p.to) return 'La fecha inicial es posterior a la final.';
  return null;
}

export interface EstadoHistorial {
  subcuenta: string | null;
  periodo: HistoryPeriod;
  /** Motivo por el que el periodo escrito no se consulta. */
  problemaPeriodo: string | null;
  /** Filtros de la tabla. Se aplican igual al resumen y a la exportación. */
  filtro: HistoryFilter;

  exportando: boolean;
  ultimaExportacion: ExportResult | null;
  errorExportacion: string | null;

  datos: TradeHistory | null;
  consultando: boolean;
  errorConsulta: string | null;

  /** La subcuenta que se está sincronizando, o `null`. */
  sincronizando: string | null;
  progreso: HistorySyncProgress | null;
  ultimaSync: HistorySyncResult | null;
  errorSync: string | null;

  saldo: LiveBalance | null;
  leyendoSaldo: boolean;
  errorSaldo: string | null;

  elegirSubcuenta: (subAccountId: string) => void;
  fijarPeriodo: (periodo: HistoryPeriod) => void;
  fijarFiltro: (filtro: HistoryFilter) => void;
  /** Exporta a CSV lo que se ve: misma subcuenta, periodo y filtro. */
  exportar: () => Promise<void>;
  descartarExportacion: () => void;
  /** Trae lo nuevo de Bitget y relee el saldo. Es el botón «Actualizar». */
  actualizar: () => void;
  /** Escucha el avance de la sincronización. Devuelve con qué dejar de escuchar. */
  escucharProgreso: () => () => void;
  /** Todo a cero. Se llama al bloquear el panel. */
  reiniciar: () => void;
}

const INICIAL = {
  subcuenta: null,
  problemaPeriodo: null,
  filtro: NO_FILTER,
  exportando: false,
  ultimaExportacion: null,
  errorExportacion: null,
  datos: null,
  consultando: false,
  errorConsulta: null,
  sincronizando: null,
  progreso: null,
  ultimaSync: null,
  errorSync: null,
  saldo: null,
  leyendoSaldo: false,
  errorSaldo: null
} satisfies Partial<EstadoHistorial>;

/*
 * Turnos. Fuera del estado porque no se dibujan: solo deciden si una respuesta
 * que acaba de llegar sigue siendo la que toca.
 */
let turnoConsulta = 0;
let turnoSaldo = 0;

export const usarHistorial = create<EstadoHistorial>()((set, get) => {
  const consultar = async (): Promise<void> => {
    const { subcuenta, periodo } = get();
    if (subcuenta === null) return;
    const problema = problemaDelPeriodo(periodo);
    if (problema !== null) {
      /*
       * Lo del periodo anterior se tira: dejarlo a la vista con las fechas
       * nuevas arriba haría pasar su suma por la de un periodo que no se
       * consultó. Se sube el turno para que una consulta en vuelo tampoco lo
       * vuelva a pintar.
       */
      turnoConsulta++;
      set({ problemaPeriodo: problema, datos: null, consultando: false });
      return;
    }
    set({ problemaPeriodo: null });

    const turno = ++turnoConsulta;
    set({ consultando: true });
    try {
      const datos = await panelService.queryHistory(subcuenta, periodo, get().filtro);
      if (turno !== turnoConsulta) return;
      set({ datos, consultando: false, errorConsulta: null });
    } catch (e) {
      if (turno !== turnoConsulta) return;
      set({
        consultando: false,
        errorConsulta: textoDe(e, 'No se pudo leer el historial guardado.')
      });
    }
  };

  const sincronizar = async (): Promise<void> => {
    const { subcuenta, sincronizando } = get();
    if (subcuenta === null || sincronizando === subcuenta) return;

    set({ sincronizando: subcuenta, progreso: null, errorSync: null });
    try {
      const r = await panelService.syncHistory(subcuenta);
      if (get().subcuenta !== subcuenta) return;
      set({ ultimaSync: r });
      await consultar();
    } catch (e) {
      if (get().subcuenta !== subcuenta) return;
      set({ errorSync: textoDe(e, 'No se pudo consultar el historial en Bitget.') });
    } finally {
      /* Solo si sigue siendo la suya: otra subcuenta pudo empezar la suya después. */
      if (get().sincronizando === subcuenta) set({ sincronizando: null, progreso: null });
    }
  };

  const leerSaldo = async (): Promise<void> => {
    const { subcuenta } = get();
    if (subcuenta === null) return;

    const turno = ++turnoSaldo;
    set({ leyendoSaldo: true, errorSaldo: null });
    try {
      const saldo = await panelService.getLiveBalance(subcuenta);
      if (turno !== turnoSaldo) return;
      set({ saldo, leyendoSaldo: false });
    } catch (e) {
      if (turno !== turnoSaldo) return;
      set({ leyendoSaldo: false, errorSaldo: textoDe(e, 'No se pudo leer el saldo.') });
    }
  };

  return {
    ...INICIAL,
    periodo: periodoPorDefecto(),

    elegirSubcuenta: (subAccountId) => {
      if (get().subcuenta === subAccountId) return;
      /*
       * Lo de la anterior se tira antes de pedir nada: mientras llega lo nuevo,
       * la pantalla enseña «cargando», nunca la tabla o el saldo de otra
       * subcuenta con el nombre de esta encima.
       */
      set({
        subcuenta: subAccountId,
        /* El par es de la subcuenta anterior; lado y resultado sí se conservan. */
        filtro: { ...get().filtro, symbol: null },
        ultimaExportacion: null,
        errorExportacion: null,
        datos: null,
        errorConsulta: null,
        ultimaSync: null,
        errorSync: null,
        saldo: null,
        errorSaldo: null
      });
      void consultar();
      void sincronizar();
      void leerSaldo();
    },

    fijarPeriodo: (periodo) => {
      set({ periodo });
      void consultar();
    },

    fijarFiltro: (filtro) => {
      set({ filtro, ultimaExportacion: null, errorExportacion: null });
      void consultar();
    },

    exportar: async () => {
      const { subcuenta, periodo, filtro, problemaPeriodo, exportando } = get();
      if (subcuenta === null || problemaPeriodo !== null || exportando) return;

      set({ exportando: true, ultimaExportacion: null, errorExportacion: null });
      try {
        const r = await panelService.exportHistory(subcuenta, periodo, filtro);
        if (get().subcuenta !== subcuenta) return;
        set({ ultimaExportacion: r.cancelled ? null : r });
      } catch (e) {
        if (get().subcuenta !== subcuenta) return;
        set({ errorExportacion: textoDe(e, 'No se pudo exportar el historial.') });
      } finally {
        set({ exportando: false });
      }
    },

    descartarExportacion: () => set({ ultimaExportacion: null, errorExportacion: null }),

    actualizar: () => {
      void sincronizar();
      void leerSaldo();
    },

    escucharProgreso: () =>
      panelService.subscribeHistorySync((p) => {
        if (get().sincronizando === p.subAccountId) set({ progreso: p });
      }),

    reiniciar: () => {
      turnoConsulta++;
      turnoSaldo++;
      set({ ...INICIAL, periodo: periodoPorDefecto() });
    }
  };
});
