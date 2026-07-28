import type { ApiPcb } from '@shared/ipc-contract';

declare global {
  interface Window {
    /**
     * Unica superficie del proceso principal visible desde el renderer.
     * La inyecta el preload por contextBridge. No existe nada mas.
     */
    readonly pcb: ApiPcb;
  }
}

export {};
