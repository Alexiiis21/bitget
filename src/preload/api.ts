import { ipcRenderer } from 'electron';
import type { ApiPcb, CanalEvento, EstadoApp, EventosIpc, InfoSistema } from '@shared/ipc-contract';
import type { Cuenta, FilaMonitor, Grupo } from '@shared/types';

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
  cuentasListar: () =>
    ipcRenderer.invoke('cuentas:listar') as Promise<{ grupos: Grupo[]; cuentas: Cuenta[] }>,
  monitorInstantanea: () => ipcRenderer.invoke('monitor:instantanea') as Promise<FilaMonitor[]>,

  suscribir<C extends CanalEvento>(canal: C, cb: (dato: EventosIpc[C]) => void): () => void {
    const escucha = (_e: unknown, dato: EventosIpc[C]): void => cb(dato);
    ipcRenderer.on(canal, escucha);
    return () => {
      ipcRenderer.off(canal, escucha);
    };
  }
};
