import { join } from 'node:path';
import { app } from 'electron';
import { esStaging } from '@shared/entorno';

/**
 * Ubicacion de la carpeta de datos de esta instancia.
 *
 * Modo portable  ->  <carpeta del .exe>\datos\
 * Modo instalado ->  %APPDATA%\Panel de Control Bitget\
 *
 * Cada sistema es independiente: no hay archivo compartido, ni registro de
 * Windows, ni sincronizacion. Copiar la carpeta copia el sistema completo.
 * docs/03-modelo-de-datos.md seccion 3.
 *
 * **Cada entorno es un sistema distinto**, con el mismo criterio y por el mismo
 * mecanismo: staging escribe en `datos-staging\` (portable) o en
 * `...\Panel de Control Bitget-staging\` (instalado). No es comodidad de
 * desarrollo. En staging el vault guarda credenciales reales de Bitget; si
 * compartiera carpeta con el entorno de desarrollo, cualquier prueba que borre
 * o reescriba el vault se llevaria por delante las claves con las que se opera.
 * El diseño ya preveia justamente esto: «dos sistemas en la misma maquina = dos
 * carpetas distintas».
 */

/** electron-builder define esta variable solo en el ejecutable portable. */
export const esPortable = (): boolean =>
  typeof process.env['PORTABLE_EXECUTABLE_DIR'] === 'string' &&
  process.env['PORTABLE_EXECUTABLE_DIR'].length > 0;

/**
 * Nombre de la carpeta de datos junto al `.exe` portable.
 *
 * En dev conserva el nombre historico `datos`, sin sufijo: renombrarlo dejaria
 * huerfanos los vaults que ya existen en las carpetas de los operadores.
 */
const nombreCarpetaPortable = (): string => (esStaging() ? 'datos-staging' : 'datos');

/**
 * Aparta la carpeta de Electron cuando el entorno es staging.
 *
 * Se llama una sola vez, antes de que Electron toque el disco. Mueve `userData`
 * entero -no solo nuestros archivos- porque ahi viven tambien el cerrojo de
 * instancia unica y la cache de Chromium: sin moverlo, abrir el panel de
 * staging con el de desarrollo ya abierto haria que el segundo se cerrase solo
 * por `requestSingleInstanceLock`, y el operador no tendria como saber por que.
 *
 * En modo portable no hace falta: alli la carpeta la decide la ubicacion del
 * `.exe`, y dos entornos son dos copias en carpetas distintas.
 */
export function fijarCarpetaDeEntorno(): void {
  if (!esStaging() || esPortable()) return;
  app.setPath('userData', `${app.getPath('userData')}-staging`);
}

export const carpetaDatos = (): string => {
  const dirPortable = process.env['PORTABLE_EXECUTABLE_DIR'];
  return dirPortable ? join(dirPortable, nombreCarpetaPortable()) : app.getPath('userData');
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
