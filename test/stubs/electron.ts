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
  setPath: (): void => undefined,
  getVersion: (): string => '0.0.0-test',
  requestSingleInstanceLock: (): boolean => true,
  on: (): void => undefined,
  whenReady: (): Promise<void> => Promise.resolve(),
  quit: (): void => undefined,
  commandLine: { appendSwitch: (): void => undefined }
};

/**
 * `ipcMain` que recuerda lo que se le registro.
 *
 * Guardar los manejadores en vez de tirarlos permite probar un canal entero
 * -validacion, guardias y delegacion- sin levantar Electron. Es la unica forma
 * de cubrir las reglas que solo viven en `handlers.ts`, como la que exige el
 * panel bloqueado para restaurar un respaldo.
 */
type Manejador = (evento: unknown, ...args: unknown[]) => unknown;

export const ipcMain = {
  manejadores: new Map<string, Manejador>(),
  handle(canal: string, cb: Manejador): void {
    ipcMain.manejadores.set(canal, cb);
  },
  /** Invoca un canal como lo haria el renderer. Lanza si no esta registrado. */
  invocar(canal: string, ...args: unknown[]): unknown {
    const cb = ipcMain.manejadores.get(canal);
    if (cb === undefined) throw new Error(`Canal no registrado: ${canal}`);
    return cb({}, ...args);
  }
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
  openExternal: (): Promise<void> => Promise.resolve(),
  openPath: (): Promise<string> => Promise.resolve('')
};

/**
 * Los dialogos nativos no se abren en pruebas: cancelar es lo unico honesto.
 *
 * Un doble que devolviera una ruta inventada haria que una prueba creyera haber
 * comprobado el camino en el que el operador elige un archivo, cuando lo que
 * habria comprobado es el doble.
 */
export const dialog = {
  showOpenDialog: (): Promise<{ canceled: boolean; filePaths: string[] }> =>
    Promise.resolve({ canceled: true, filePaths: [] })
};

export class BrowserWindow {
  static getAllWindows(): BrowserWindow[] {
    return [];
  }
}
