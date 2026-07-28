import { contextBridge } from 'electron';
import { api } from './api';

/**
 * Unico punto de contacto entre los dos mundos.
 *
 * Con `contextIsolation: true` el objeto viaja por el puente y el renderer
 * recibe una copia congelada: no puede alcanzar nada del proceso principal que
 * no este declarado en el contrato de IPC.
 */
if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('pcb', api);
} else {
  /*
   * No deberia ocurrir nunca: contextIsolation esta forzado en la creacion de
   * la ventana. Si ocurre, es preferible fallar de forma ruidosa que exponer la
   * API sin aislamiento.
   */
  throw new Error('contextIsolation deshabilitado: el preload no se expone.');
}
