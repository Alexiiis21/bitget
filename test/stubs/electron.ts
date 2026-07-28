/**
 * Sustituto de `electron` para las pruebas unitarias.
 *
 * Importar el modulo real arrastra la resolucion del binario y anade ~30 s al
 * arranque de la suite. La logica del proceso principal no debe depender de
 * Electron salvo en los bordes; alli donde lo haga, este doble deja explicito
 * que se esta tocando un borde.
 */
export const app = {
  getPath: (nombre: string): string => `/stub/${nombre}`,
  getVersion: (): string => '0.0.0-test',
  requestSingleInstanceLock: (): boolean => true,
  on: (): void => undefined,
  whenReady: (): Promise<void> => Promise.resolve(),
  quit: (): void => undefined,
  commandLine: { appendSwitch: (): void => undefined }
};

export const ipcMain = {
  handle: (): void => undefined
};

export const contextBridge = {
  exposeInMainWorld: (): void => undefined
};

export const ipcRenderer = {
  invoke: (): Promise<never> => Promise.reject(new Error('IPC no disponible en pruebas')),
  on: (): void => undefined,
  off: (): void => undefined
};

export const shell = {
  openExternal: (): Promise<void> => Promise.resolve()
};

export class BrowserWindow {
  static getAllWindows(): BrowserWindow[] {
    return [];
  }
}
