import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { MOSAICO_ALTO_MIN, MOSAICO_ANCHO_MIN } from '@shared/constants';
import type { EstadoApp, InfoSistema } from '@shared/ipc-contract';
import type { Cuenta, FilaMonitor, Grupo } from '@shared/types';
import { carpetaDatos, esPortable } from './storage/paths';

let ventana: BrowserWindow | null = null;

function crearVentana(): void {
  ventana = new BrowserWindow({
    width: MOSAICO_ANCHO_MIN,
    height: MOSAICO_ALTO_MIN,
    minWidth: 1280,
    minHeight: 720,
    show: false,
    backgroundColor: '#ECEEF2',
    title: 'Panel de Control Bitget',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),

      /*
       * Configuracion de seguridad no negociable. docs/01 seccion 2.
       * El renderer no puede tocar Node ni el sistema de archivos: todo pasa
       * por el contrato de IPC.
       */
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false
    }
  });

  ventana.on('ready-to-show', () => ventana?.show());

  /* Ningun enlace abre una ventana de Electron: siempre el navegador del sistema. */
  ventana.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  /* Bloquea cualquier navegacion fuera de la propia aplicacion. */
  ventana.webContents.on('will-navigate', (evento, url) => {
    const permitida = process.env['ELECTRON_RENDERER_URL'];
    if (!permitida || !url.startsWith(permitida)) evento.preventDefault();
  });

  const urlDev = process.env['ELECTRON_RENDERER_URL'];
  if (urlDev) void ventana.loadURL(urlDev);
  else void ventana.loadFile(join(__dirname, '../renderer/index.html'));
}

/* ---------------- manejadores de IPC ---------------- */

function registrarIpc(): void {
  ipcMain.handle('sistema:info', (): InfoSistema => ({
    appVersion: app.getVersion(),
    instanciaId: 'inst-pendiente',
    instanciaNombre: 'Sistema 1',
    portable: esPortable(),
    carpetaDatos: carpetaDatos(),
    electron: process.versions.electron,
    node: process.versions.node
  }));

  ipcMain.handle('sistema:estado', (): EstadoApp => ({
    vault: 'sin-inicializar',
    pinIntentosRestantes: null,
    cuentasRegistradas: 0,
    cuentasConectadas: 0,
    socketsCalientes: 0
  }));

  ipcMain.handle('cuentas:listar', (): { grupos: Grupo[]; cuentas: Cuenta[] } => ({
    grupos: [],
    cuentas: []
  }));

  ipcMain.handle('monitor:instantanea', (): FilaMonitor[] => []);
}

/* ---------------- ciclo de vida ---------------- */

/*
 * Una sola instancia por carpeta de datos: dos procesos escribiendo el mismo
 * vault.enc es la unica forma realista de corromperlo. docs/03 seccion 3.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!ventana) return;
    if (ventana.isMinimized()) ventana.restore();
    ventana.focus();
  });

  void app.whenReady().then(() => {
    registrarIpc();
    crearVentana();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) crearVentana();
    });
  });

  app.on('window-all-closed', () => app.quit());
}

/* Sin telemetria, sin llamadas de red fuera de Bitget. docs/01 seccion 7. */
app.commandLine.appendSwitch('disable-features', 'MediaRouter');
