import { ipcRenderer } from 'electron';
import type {
  AltaCuenta,
  AltaMadre,
  ApiPcb,
  CanalEvento,
  MadreIpc,
  MovimientoTraspasoIpc,
  PlanRepartoIpc,
  PlanTraspasoIpc,
  ResultadoAltaMadre,
  ResultadoReparto,
  ResultadoTraspaso,
  SaldosPantalla,
  CuentaPanel,
  EstadoApp,
  EstadoVault,
  ResultadoImportacionIpc,
  RespaldoDisponibleIpc,
  ResultadoRespaldoIpc,
  ResultadoRestauracionIpc,
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
  ResultadoBaja,
  ResultadoPrueba,
  ResultadoVault
} from '@shared/ipc-contract';
import type { Lote, PosicionMonitor } from '@shared/types';

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
  sistemaFijarNumeroPanel: (numero) =>
    ipcRenderer.invoke('sistema:numero-panel', numero) as Promise<void>,

  /* Sin argumentos: la carpeta la elige el operador en un dialogo del proceso principal. */
  credencialesImportar: () =>
    ipcRenderer.invoke('credenciales:importar') as Promise<ResultadoImportacionIpc>,

  /* Mismo criterio: ninguna ruta viaja desde aqui. La decide el proceso principal. */
  respaldoCrear: () => ipcRenderer.invoke('respaldo:crear') as Promise<ResultadoRespaldoIpc>,
  respaldoBuscar: () =>
    ipcRenderer.invoke('respaldo:buscar') as Promise<RespaldoDisponibleIpc | null>,
  respaldoAbrirCarpeta: () => ipcRenderer.invoke('respaldo:abrir-carpeta') as Promise<void>,
  respaldoRestaurar: (contrasenaMaestra) =>
    ipcRenderer.invoke(
      'respaldo:restaurar',
      contrasenaMaestra
    ) as Promise<ResultadoRestauracionIpc>,
  respaldoRestaurarArchivo: (contrasenaMaestra) =>
    ipcRenderer.invoke(
      'respaldo:restaurar-archivo',
      contrasenaMaestra
    ) as Promise<ResultadoRestauracionIpc>,

  vaultEstado: () => ipcRenderer.invoke('vault:estado') as Promise<EstadoVault>,
  vaultCrear: (contrasena) =>
    ipcRenderer.invoke('vault:crear', contrasena) as Promise<ResultadoVault>,
  vaultAbrir: (contrasena) =>
    ipcRenderer.invoke('vault:abrir', contrasena) as Promise<ResultadoVault>,
  vaultCerrar: () => ipcRenderer.invoke('vault:cerrar') as Promise<void>,
  vaultComprobar: (contrasena) =>
    ipcRenderer.invoke('vault:comprobar', contrasena) as Promise<boolean>,
  vaultEspera: () => ipcRenderer.invoke('vault:espera') as Promise<number>,

  cuentasListar: () => ipcRenderer.invoke('cuentas:listar') as Promise<FilaCuenta[]>,
  cuentasAgregar: (alta: AltaCuenta) =>
    ipcRenderer.invoke('cuentas:agregar', alta) as Promise<ResultadoAlta>,
  cuentasEliminar: (cuentaId, contrasenaPaso) =>
    ipcRenderer.invoke('cuentas:eliminar', cuentaId, contrasenaPaso) as Promise<ResultadoBaja>,
  cuentasVerificar: (cuentaId) =>
    ipcRenderer.invoke('cuentas:verificar', cuentaId) as Promise<ResultadoPrueba>,

  panelCuentas: () => ipcRenderer.invoke('panel:cuentas') as Promise<CuentaPanel[]>,

  mercadoRanuras: () => ipcRenderer.invoke('mercado:ranuras') as Promise<(ActivoIpc | null)[]>,
  mercadoCatalogo: () => ipcRenderer.invoke('mercado:catalogo') as Promise<ActivoIpc[]>,
  mercadoFijarRanura: (indice, simbolo) =>
    ipcRenderer.invoke('mercado:fijar-ranura', indice, simbolo) as Promise<(ActivoIpc | null)[]>,
  mercadoPrecios: () => ipcRenderer.invoke('mercado:precios') as Promise<Record<string, string>>,

  pasoHay: () => ipcRenderer.invoke('paso:hay') as Promise<boolean>,
  pasoComprobar: (contrasena) =>
    ipcRenderer.invoke('paso:comprobar', contrasena) as Promise<boolean>,
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
  tpEjecutar: (planId, soloEstos) =>
    ipcRenderer.invoke('tp:ejecutar', planId, soloEstos) as Promise<Lote>,
  tpPlanificarQuitar: (peticion) =>
    ipcRenderer.invoke('tp:planificar-quitar', peticion) as Promise<PlanQuitarTpIpc>,
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

  monitorInstantanea: () => ipcRenderer.invoke('monitor:instantanea') as Promise<PosicionMonitor[]>,

  madresListar: () => ipcRenderer.invoke('madres:listar') as Promise<MadreIpc[]>,
  madresAgregar: (alta: AltaMadre) =>
    ipcRenderer.invoke('madres:agregar', alta) as Promise<ResultadoAltaMadre>,
  madresEliminar: (uidMadre, contrasenaPaso) =>
    ipcRenderer.invoke('madres:eliminar', uidMadre, contrasenaPaso) as Promise<ResultadoBaja>,
  saldosLeer: (uidMadre) => ipcRenderer.invoke('saldos:leer', uidMadre) as Promise<SaldosPantalla>,
  traspasoPlanificar: (peticion) =>
    ipcRenderer.invoke('traspaso:planificar', peticion) as Promise<PlanTraspasoIpc>,
  traspasoEjecutar: (planId, contrasenaPaso) =>
    ipcRenderer.invoke('traspaso:ejecutar', planId, contrasenaPaso) as Promise<ResultadoTraspaso>,
  traspasoHistorial: (limite) =>
    ipcRenderer.invoke('traspaso:historial', limite) as Promise<MovimientoTraspasoIpc[]>,
  repartoPlanificar: (peticion) =>
    ipcRenderer.invoke('reparto:planificar', peticion) as Promise<PlanRepartoIpc>,
  recogidaPlanificar: (peticion) =>
    ipcRenderer.invoke('recogida:planificar', peticion) as Promise<PlanRepartoIpc>,
  repartoEjecutar: (planId, contrasenaPaso) =>
    ipcRenderer.invoke('reparto:ejecutar', planId, contrasenaPaso) as Promise<ResultadoReparto>,

  suscribir<C extends CanalEvento>(canal: C, cb: (dato: EventosIpc[C]) => void): () => void {
    const escucha = (_e: unknown, dato: EventosIpc[C]): void => cb(dato);
    ipcRenderer.on(canal, escucha);
    return () => {
      ipcRenderer.off(canal, escucha);
    };
  }
};
