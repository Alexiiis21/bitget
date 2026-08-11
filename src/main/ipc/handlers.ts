/**
 * Registro de los canales de IPC.
 *
 * Cada canal declarado en el contrato se ata aqui a una operacion de `Sesion`,
 * y nada mas. Este archivo no tiene logica: si empieza a tenerla, es que se
 * esta filtrando dominio a la capa de transporte.
 *
 * Los argumentos que llegan del renderer se validan antes de usarse. El
 * renderer es nuestro, pero es tambien la unica superficie que un fallo de la
 * pagina podria manipular, y una cadena donde se espera un objeto no debe
 * llegar viva hasta el vault. docs/02-arquitectura.html.
 */
import { app, ipcMain } from 'electron';
import { z } from 'zod';
import type { EstadoApp, InfoSistema } from '@shared/ipc-contract';
import type { FilaMonitor } from '@shared/types';
import { carpetaDatos, esPortable } from '../storage/paths';
import type { Instancia } from '../storage/instancia';
import type { Sesion } from './sesion';

const esquemaContrasena = z.string().min(1).max(1024);

const esquemaAlta = z.object({
  etiqueta: z.string().min(1).max(64),
  grupoNombre: z.string().min(1).max(64),
  apiKey: z.string().min(1).max(256),
  secretKey: z.string().min(1).max(256),
  passphrase: z.string().min(1).max(256)
});

const esquemaId = z.string().min(1).max(128);

export function registrarIpc(sesion: Sesion, instancia: Instancia): void {
  ipcMain.handle(
    'sistema:info',
    (): InfoSistema => ({
      appVersion: app.getVersion(),
      instanciaId: instancia.id,
      instanciaNombre: instancia.nombre,
      numeroPanel: instancia.numero,
      portable: esPortable(),
      carpetaDatos: carpetaDatos(),
      electron: process.versions.electron,
      node: process.versions.node
    })
  );

  ipcMain.handle('sistema:estado', (): Promise<EstadoApp> => sesion.estadoApp());

  ipcMain.handle('vault:estado', () => sesion.estadoVault());
  ipcMain.handle('vault:crear', (_e, contrasena: unknown) =>
    sesion.crear(esquemaContrasena.parse(contrasena))
  );
  ipcMain.handle('vault:abrir', (_e, contrasena: unknown) =>
    sesion.abrir(esquemaContrasena.parse(contrasena))
  );
  ipcMain.handle('vault:cerrar', () => {
    sesion.cerrar();
  });
  ipcMain.handle('vault:comprobar', (_e, contrasena: unknown) =>
    sesion.comprobarMaestra(esquemaContrasena.parse(contrasena))
  );

  ipcMain.handle('cuentas:listar', () => sesion.listar());
  ipcMain.handle('cuentas:agregar', (_e, alta: unknown) => sesion.agregar(esquemaAlta.parse(alta)));
  ipcMain.handle('cuentas:eliminar', (_e, cuentaId: unknown) =>
    sesion.eliminar(esquemaId.parse(cuentaId))
  );
  ipcMain.handle('cuentas:verificar', (_e, cuentaId: unknown) =>
    sesion.verificar(esquemaId.parse(cuentaId))
  );

  /* Las posiciones llegan por WebSocket en la Fase 6. docs/00-entrega-fase-1. */
  ipcMain.handle('monitor:instantanea', (): FilaMonitor[] => []);
}
