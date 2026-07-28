import { join } from 'node:path';
import { app } from 'electron';

/**
 * Ubicacion de la carpeta de datos de esta instancia.
 *
 * Modo portable  ->  <carpeta del .exe>\datos\
 * Modo instalado ->  %APPDATA%\PCB\
 *
 * Cada sistema es independiente: no hay archivo compartido, ni registro de
 * Windows, ni sincronizacion. Copiar la carpeta copia el sistema completo.
 * docs/03-modelo-de-datos.md seccion 3.
 */

/** electron-builder define esta variable solo en el ejecutable portable. */
export const esPortable = (): boolean =>
  typeof process.env['PORTABLE_EXECUTABLE_DIR'] === 'string' &&
  process.env['PORTABLE_EXECUTABLE_DIR'].length > 0;

export const carpetaDatos = (): string => {
  const dirPortable = process.env['PORTABLE_EXECUTABLE_DIR'];
  return dirPortable ? join(dirPortable, 'datos') : app.getPath('userData');
};

export const rutas = () => {
  const base = carpetaDatos();
  return {
    base,
    lock: join(base, '.lock'),
    instancia: join(base, 'instancia.json'),
    vault: join(base, 'vault.enc'),
    vaultBak: join(base, 'vault.enc.bak'),
    cuentas: join(base, 'cuentas.json'),
    config: join(base, 'config.json'),
    ordenesPendientes: join(base, 'ordenes', 'pendientes.jsonl'),
    cacheSimbolos: join(base, 'cache', 'simbolos.json'),
    logs: join(base, 'logs')
  } as const;
};

/** Nombre del archivo de log del dia, con rotacion diaria. docs/03 seccion 11. */
export const archivoLogDeHoy = (ahora = new Date()): string => {
  const y = ahora.getFullYear();
  const m = String(ahora.getMonth() + 1).padStart(2, '0');
  const d = String(ahora.getDate()).padStart(2, '0');
  return `session-${y}${m}${d}.jsonl`;
};
