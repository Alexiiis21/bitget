import { ipcRenderer } from 'electron';
import type {
  AltaCuenta,
  ApiPcb,
  CanalEvento,
  EstadoApp,
  EstadoVault,
  EventosIpc,
  FilaCuenta,
  InfoSistema,
  ResultadoAlta,
  ResultadoPrueba,
  ResultadoVault
} from '@shared/ipc-contract';
import type { FilaMonitor } from '@shared/types';

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

  monitorInstantanea: () => ipcRenderer.invoke('monitor:instantanea') as Promise<FilaMonitor[]>,

  suscribir<C extends CanalEvento>(canal: C, cb: (dato: EventosIpc[C]) => void): () => void {
    const escucha = (_e: unknown, dato: EventosIpc[C]): void => cb(dato);
    ipcRenderer.on(canal, escucha);
    return () => {
      ipcRenderer.off(canal, escucha);
    };
  }
};
