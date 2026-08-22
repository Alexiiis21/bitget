import { ipcRenderer } from 'electron';
import type {
  AltaCuenta,
  ApiPcb,
  CanalEvento,
  CuentaPanel,
  EstadoApp,
  EstadoVault,
  EventosIpc,
  FilaCuenta,
  InfoSistema,
  PlanAperturaIpc,
  PlanApalancamientoIpc,
  PlanCierreIpc,
  PlanMargenIpc,
  ActivoIpc,
  PlanQuitarTpIpc,
  PlanTakeProfitIpc,
  ResultadoAlta,
  ResultadoPrueba,
  ResultadoVault
} from '@shared/ipc-contract';
import type { FilaMonitor, Lote } from '@shared/types';

/**
 * Superficie minima expuesta al renderer.
 *
 * No se expone `ipcRenderer` completo: eso daria al renderer acceso a cualquier
 * canal, incluidos los internos. Cada metodo de aqui es un canal declarado en el
 * contrato, ni uno mas. docs/01 seccion 2.
 */
export const api: ApiPcb = {
  sistemaInfo: () => ipcRenderer.invoke('sistema:info') as Promise<InfoSistema>,
  sistemaEstado: () => ipcRenderer.invoke('sistema:estado') as Promise<EstadoApp>,

  vaultEstado: () => ipcRenderer.invoke('vault:estado') as Promise<EstadoVault>,
  vaultCrear: (contrasena) =>
    ipcRenderer.invoke('vault:crear', contrasena) as Promise<ResultadoVault>,
  vaultAbrir: (contrasena) =>
    ipcRenderer.invoke('vault:abrir', contrasena) as Promise<ResultadoVault>,
  vaultCerrar: () => ipcRenderer.invoke('vault:cerrar') as Promise<void>,
  vaultComprobar: (contrasena) =>
    ipcRenderer.invoke('vault:comprobar', contrasena) as Promise<boolean>,

  cuentasListar: () => ipcRenderer.invoke('cuentas:listar') as Promise<FilaCuenta[]>,
  cuentasAgregar: (alta: AltaCuenta) =>
    ipcRenderer.invoke('cuentas:agregar', alta) as Promise<ResultadoAlta>,
  cuentasEliminar: (cuentaId) => ipcRenderer.invoke('cuentas:eliminar', cuentaId) as Promise<boolean>,
  cuentasVerificar: (cuentaId) =>
    ipcRenderer.invoke('cuentas:verificar', cuentaId) as Promise<ResultadoPrueba>,

  panelCuentas: () => ipcRenderer.invoke('panel:cuentas') as Promise<CuentaPanel[]>,

  mercadoActivos: () => ipcRenderer.invoke('mercado:activos') as Promise<ActivoIpc[]>,
  mercadoPrecios: () => ipcRenderer.invoke('mercado:precios') as Promise<Record<string, string>>,

  pasoHay: () => ipcRenderer.invoke('paso:hay') as Promise<boolean>,
  pasoComprobar: (contrasena) => ipcRenderer.invoke('paso:comprobar', contrasena) as Promise<boolean>,
  pasoFijar: (contrasena) => ipcRenderer.invoke('paso:fijar', contrasena) as Promise<void>,

  aperturaPlanificar: (peticion) =>
    ipcRenderer.invoke('apertura:planificar', peticion) as Promise<PlanAperturaIpc>,
  aperturaEjecutar: (planId, soloEstos) =>
    ipcRenderer.invoke('apertura:ejecutar', planId, soloEstos) as Promise<Lote>,
  cierrePlanificar: (peticion) =>
    ipcRenderer.invoke('cierre:planificar', peticion) as Promise<PlanCierreIpc>,
  cierreEjecutar: (planId, soloEstos) =>
    ipcRenderer.invoke('cierre:ejecutar', planId, soloEstos) as Promise<Lote>,
  tpPlanificar: (peticion) =>
    ipcRenderer.invoke('tp:planificar', peticion) as Promise<PlanTakeProfitIpc>,
  tpPlanificarQuitar: (peticion) =>
    ipcRenderer.invoke('tp:planificar-quitar', peticion) as Promise<PlanQuitarTpIpc>,
  tpEjecutar: (planId, soloEstos) =>
    ipcRenderer.invoke('tp:ejecutar', planId, soloEstos) as Promise<Lote>,
  tpEjecutarQuitar: (planId, soloEstos) =>
    ipcRenderer.invoke('tp:ejecutar-quitar', planId, soloEstos) as Promise<Lote>,
  margenPlanificar: (peticion) =>
    ipcRenderer.invoke('margen:planificar', peticion) as Promise<PlanMargenIpc>,
  margenEjecutar: (planId, soloEstos) =>
    ipcRenderer.invoke('margen:ejecutar', planId, soloEstos) as Promise<Lote>,
  apalancamientoPlanificar: (peticion) =>
    ipcRenderer.invoke('apalancamiento:planificar', peticion) as Promise<PlanApalancamientoIpc>,
  apalancamientoEjecutar: (planId, soloEstos) =>
    ipcRenderer.invoke('apalancamiento:ejecutar', planId, soloEstos) as Promise<Lote>,

  monitorInstantanea: () => ipcRenderer.invoke('monitor:instantanea') as Promise<FilaMonitor[]>,

  suscribir<C extends CanalEvento>(canal: C, cb: (dato: EventosIpc[C]) => void): () => void {
    const escucha = (_e: unknown, dato: EventosIpc[C]): void => cb(dato);
    ipcRenderer.on(canal, escucha);
    return () => {
      ipcRenderer.off(canal, escucha);
    };
  }
};
