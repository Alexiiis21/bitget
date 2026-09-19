/**
 * Respaldo y restauracion de las credenciales en un solo archivo.
 *
 * ==========================================================================
 * El problema que resuelve
 * ==========================================================================
 * `importar-credenciales.ts` ya trae las credenciales de una instalacion
 * anterior, pero depende de dos cosas que fallan justo cuando hacen falta: que
 * la carpeta vieja siga existiendo, y que el operador sepa encontrarla. Si
 * borra el panel anterior no hay nada que señalar, y el mensaje de error de
 * aquel modulo -«la carpeta que se llama datos-staging, no el acceso directo
 * ni el .exe»- ya delata lo dificil que es acertar.
 *
 * Esto es la otra mitad: un archivo `.pcbak` **fuera** de la carpeta del panel,
 * que el operador crea con un boton y que la version nueva encuentra sola.
 *
 * ==========================================================================
 * Lo que NO cambia, y es lo importante
 * ==========================================================================
 * Aqui no se descifra nada. El `.pcbak` lleva `vault.enc` byte a byte, en
 * base64: sigue siendo AES-256-GCM y sigue necesitando la contraseña maestra.
 * Por eso `crearRespaldo` funciona con el panel bloqueado y por eso el respaldo
 * automatico no puede filtrar un secreto ni equivocandose.
 *
 * La consecuencia hay que decirla sin adornos: el respaldo vive en Documentos,
 * que en Windows 11 suele estar sincronizado a OneDrive y entra en cualquier
 * herramienta de copia de seguridad. El vault cifrado puede acabar en un
 * servidor de Microsoft y en el disco externo del operador. Es un intercambio
 * deliberado -el requisito es sobrevivir al borrado de la carpeta- y lo que lo
 * sostiene es que **la contraseña maestra no esta dentro del archivo**. Esa
 * frase no es tranquilizadora: es la frontera de seguridad, y por eso se repite
 * en la interfaz y dentro del propio `.pcbak`.
 *
 * Propiedad conocida y no mitigada aqui: los respaldos fechados que se
 * conservan son almacenes anteriores, cada uno abrible con la maestra que
 * estuviera vigente cuando se hizo. Cambiar la maestra no los invalida. Lo
 * mismo ya ocurre con `vault.enc.bak`.
 *
 * ==========================================================================
 * Esto relaja la regla 1 de `importar-credenciales.ts`, y asi se compensa
 * ==========================================================================
 * Aquel modulo dice «nunca se pisa un almacen existente». Restaurar si puede,
 * porque su caso es otro: no es «señalo la carpeta vieja, aqui no hay nada»,
 * sino «este archivo manda, posiblemente sobre lo que hay». La compensacion es
 * que el almacen anterior **no se borra**: se aparta como
 * `vault.enc.reemplazado-<sello>` en la misma carpeta. Sigue sin existir
 * ninguna escritura irreversible sobre las API keys.
 *
 * Y como alli, el orden de escritura no es casual: `vault.enc` va **el ultimo**.
 * Un fallo a mitad deja el panel viendose como recien instalado -que es la
 * verdad- en lugar de con credenciales a medias.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { VERSION_ACTUAL as VERSION_REGISTRO } from '../domain/registro-cuentas';
import { VERSION_ACTUAL as VERSION_VAULT } from '../security/vault';
import { escribirAtomico, existe } from './atomic-write';
import type { DestinoImportacion } from './importar-credenciales';

export const FORMATO_RESPALDO = 'pcb-respaldo';
export const VERSION_RESPALDO = 1;

/** Cuantos respaldos fechados sobreviven a la poda. */
export const RESPALDOS_CONSERVADOS = 10;

/**
 * El nombre estable, siempre igual al fechado mas reciente.
 *
 * Existe para que la deteccion automatica no tenga que ordenar por `mtime` -que
 * se reescribe o se falsea segun como copie el operador la carpeta- ni parsear
 * fechas de nombres de archivo.
 */
export const NOMBRE_ALIAS = 'respaldo-pcb-ultimo.pcbak';

/**
 * Lo unico que la poda puede borrar. Nada mas de esa carpeta se toca jamas.
 *
 * La carpeta esta en Documentos, o sea en territorio del operador: puede tener
 * ahi sus propias cosas y no es asunto del panel.
 */
const PATRON_FECHADO = /^respaldo-pcb-\d{4}-\d{2}-\d{2}-\d{6}\.pcbak$/;

/** La frase que el operador lee si abre el `.pcbak` con el Bloc de notas. */
const AVISO =
  'Este archivo NO contiene la contrasena maestra. Sin ella no se puede abrir. ' +
  'Las credenciales van cifradas tal cual estaban en el panel.';

/* ---------- forma del archivo ---------- */

const esquemaArchivoIncluido = z.object({
  bytes: z.number().int().nonnegative(),
  sha256: z.string(),
  contenido: z.string()
});

/**
 * Lo minimo para saber **que es** y **si se puede leer**.
 *
 * Va aparte del esquema completo a proposito: un respaldo de una version futura
 * puede haber cambiado la forma de `archivos`, y aun asi hay que poder decirle
 * al operador «esto lo hizo un panel mas nuevo» en lugar de «archivo ilegible».
 */
const esquemaCabecera = z.object({
  formato: z.literal(FORMATO_RESPALDO),
  version: z.number().int().positive(),
  creadoEn: z.string().optional(),
  appVersion: z.string().optional(),
  mercado: z.enum(['real', 'simulado']).optional(),
  panelOrigen: z.number().int().optional(),
  cuentas: z.number().int().nullable().optional(),
  esquemas: z
    .object({
      vault: z.number().int().positive(),
      cuentas: z.number().int().positive().nullable().optional()
    })
    .optional()
});

const esquemaRespaldo = esquemaCabecera.extend({
  archivos: z.object({
    'vault.enc': esquemaArchivoIncluido,
    'cuentas.json': esquemaArchivoIncluido.optional(),
    'activos.json': esquemaArchivoIncluido.optional()
  })
});

/**
 * El sobre del vault, sin la contrasena. Mismo criterio que el importador:
 * basta para distinguir una carpeta de datos del panel de una carpeta
 * cualquiera con un archivo que se llama igual.
 */
const esquemaSobreVault = z.object({
  formato: z.literal('pcb-vault'),
  version: z.number().int().positive()
});

/* ---------- crear ---------- */

/** Lo que se copia del sistema vivo, ya resuelto. */
export interface OrigenRespaldo {
  vault: string;
  cuentas: string;
  activos: string;
}

export interface OpcionesRespaldo {
  appVersion: string;
  entorno: string;
  mercado: 'real' | 'simulado';
  /** Solo se enseña; nunca se restaura. Ver la nota sobre `instancia.json`. */
  panelOrigen: number;
  /** Sobrescribible solo en pruebas. */
  conservar?: number;
  ahora?: () => Date;
}

export type MotivoRespaldo = 'sin-vault' | 'vault-ilegible' | 'no-se-pudo-escribir';

export interface MetaRespaldo {
  /** Nombre del fechado, para poder nombrarlo en el aviso. */
  nombre: string;
  carpeta: string;
  creadoEn: string;
  cuentas: number | null;
  bytes: number;
}

export interface ResultadoRespaldo {
  ok: boolean;
  motivo: MotivoRespaldo | null;
  /** En castellano y con lo que hay que hacer, no con lo que fallo por dentro. */
  mensaje: string;
  meta: MetaRespaldo | null;
}

const falloRespaldo = (motivo: MotivoRespaldo, mensaje: string): ResultadoRespaldo => ({
  ok: false,
  motivo,
  mensaje,
  meta: null
});

const sha256 = (dato: Buffer): string => createHash('sha256').update(dato).digest('hex');

const incluir = (dato: Buffer) => ({
  bytes: dato.byteLength,
  sha256: sha256(dato),
  contenido: dato.toString('base64')
});

/** `AAAA-MM-DD-HHMMSS` en hora local: es la que el operador reconoce. */
function sello(cuando: Date): string {
  const p = (n: number, ancho = 2): string => String(n).padStart(ancho, '0');
  return (
    `${p(cuando.getFullYear(), 4)}-${p(cuando.getMonth() + 1)}-${p(cuando.getDate())}-` +
    `${p(cuando.getHours())}${p(cuando.getMinutes())}${p(cuando.getSeconds())}`
  );
}

/** Cuantas subcuentas trae un `cuentas.json`, o `null` si no se puede saber. */
function contarCuentas(crudo: Buffer): number | null {
  try {
    const archivo: unknown = JSON.parse(crudo.toString('utf8'));
    const lista = (archivo as { cuentas?: unknown }).cuentas;
    return Array.isArray(lista) ? lista.length : null;
  } catch {
    return null;
  }
}

/** La version de schema declarada en `cuentas.json`, o `null` si no se sabe. */
function versionDeCuentas(crudo: Buffer): number | null {
  try {
    const archivo: unknown = JSON.parse(crudo.toString('utf8'));
    const v = (archivo as { version?: unknown }).version;
    return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

const leerSiEsta = async (ruta: string): Promise<Buffer | null> =>
  (await existe(ruta)) ? readFile(ruta) : null;

/**
 * Escribe un respaldo nuevo en `carpetaRespaldos`.
 *
 * No abre dialogos, no conoce Electron y no necesita la contrasena maestra: es
 * una copia de bytes. Asi se puede probar entera sin levantar la aplicacion.
 */
export async function crearRespaldo(
  origen: OrigenRespaldo,
  carpetaRespaldos: string,
  opciones: OpcionesRespaldo
): Promise<ResultadoRespaldo> {
  const crudoVault = await leerSiEsta(origen.vault);
  if (crudoVault === null) {
    return falloRespaldo(
      'sin-vault',
      'Todavía no hay credenciales que respaldar en este panel. Registre al menos una API key.'
    );
  }

  /* Que sea un vault de verdad se comprueba antes de escribir nada. */
  try {
    esquemaSobreVault.parse(JSON.parse(crudoVault.toString('utf8')));
  } catch {
    return falloRespaldo(
      'vault-ilegible',
      'El almacén de credenciales de este panel no tiene el formato esperado. No se ha creado ningún respaldo.'
    );
  }

  const crudoCuentas = await leerSiEsta(origen.cuentas);
  const crudoActivos = await leerSiEsta(origen.activos);

  const cuando = (opciones.ahora ?? (() => new Date()))();
  const cuentas = crudoCuentas === null ? null : contarCuentas(crudoCuentas);

  const archivo = {
    formato: FORMATO_RESPALDO,
    version: VERSION_RESPALDO,
    aviso: AVISO,
    creadoEn: cuando.toISOString(),
    appVersion: opciones.appVersion,
    entorno: opciones.entorno,
    mercado: opciones.mercado,
    panelOrigen: opciones.panelOrigen,
    cuentas,
    esquemas: {
      vault: VERSION_VAULT,
      cuentas: crudoCuentas === null ? null : versionDeCuentas(crudoCuentas)
    },
    archivos: {
      'vault.enc': incluir(crudoVault),
      ...(crudoCuentas === null ? {} : { 'cuentas.json': incluir(crudoCuentas) }),
      ...(crudoActivos === null ? {} : { 'activos.json': incluir(crudoActivos) })
    }
  };

  /*
   * Con sangria a proposito: el operador va a abrir esto con el Bloc de notas
   * para ver que es, y asi la cabecera -el `aviso` incluido- queda legible y el
   * base64 se queda en su propia linea.
   */
  const contenido = Buffer.from(`${JSON.stringify(archivo, null, 2)}\n`, 'utf8');
  const nombre = `respaldo-pcb-${sello(cuando)}.pcbak`;

  try {
    /*
     * El fechado primero y el alias despues, copiando **el mismo buffer**.
     *
     * No es un detalle: si el alias falla -OneDrive teniendolo abierto es un
     * fallo real en Windows- el archivo que importa ya aterrizo, con un nombre
     * nuevo que nadie tenia abierto, y la deteccion cae sobre el.
     */
    await escribirAtomico(join(carpetaRespaldos, nombre), contenido);
    await escribirAtomico(join(carpetaRespaldos, NOMBRE_ALIAS), contenido);
  } catch (e) {
    return falloRespaldo('no-se-pudo-escribir', mensajeDeEscritura(e, carpetaRespaldos));
  }

  await podar(carpetaRespaldos, opciones.conservar ?? RESPALDOS_CONSERVADOS);

  return {
    ok: true,
    motivo: null,
    mensaje:
      `Respaldo guardado como «${nombre}». Recuerde que la contraseña maestra no va dentro ` +
      'del archivo: sin ella el respaldo no sirve de nada.',
    meta: {
      nombre,
      carpeta: carpetaRespaldos,
      creadoEn: archivo.creadoEn,
      cuentas,
      bytes: contenido.byteLength
    }
  };
}

/** Un fallo de escritura en Documentos casi siempre es lo mismo. Se nombra. */
function mensajeDeEscritura(e: unknown, carpeta: string): string {
  const codigo = (e as { code?: unknown }).code;
  if (codigo === 'EPERM' || codigo === 'EBUSY' || codigo === 'EACCES') {
    return (
      `No se pudo escribir en «${carpeta}». Suele pasar cuando OneDrive está sincronizando ` +
      'esa carpeta o el archivo está abierto en otro programa. Inténtelo de nuevo en unos segundos.'
    );
  }
  return `No se pudo escribir el respaldo en «${carpeta}». ${e instanceof Error ? e.message : ''}`.trim();
}

/**
 * Deja solo los `conservar` fechados mas recientes, y el alias.
 *
 * Los fechados existen porque el respaldo automatico dispara tambien en cada
 * **baja**: si solo hubiera un archivo rotatorio, una baja equivocada se
 * propagaria al respaldo en tres segundos y la credencial se habria ido de los
 * dos sitios. Por eso se conserva historia, y por eso la poda es la ultima
 * operacion: un fallo aqui no puede dejar sin respaldo al que acaba de pedirlo.
 */
async function podar(carpeta: string, conservar: number): Promise<void> {
  try {
    const todos = await readdir(carpeta);
    /* El nombre ordena cronologicamente por construccion: no hace falta `stat`. */
    const fechados = todos.filter((n) => PATRON_FECHADO.test(n)).sort();
    const sobran = fechados.slice(0, Math.max(0, fechados.length - conservar));
    for (const n of sobran) await unlink(join(carpeta, n)).catch(() => undefined);
  } catch {
    /* Podar es higiene, no parte del respaldo. Si falla, no se dice nada. */
  }
}

/* ---------- descubrir ---------- */

export interface RespaldoEncontrado {
  /** Ruta completa. **No cruza el IPC**: solo la usa el proceso principal. */
  archivo: string;
  nombre: string;
  carpeta: string;
  creadoEn: string;
  appVersion: string;
  mercado: 'real' | 'simulado' | null;
  panelOrigen: number | null;
  cuentas: number | null;
  esquemas: { vault: number | null; cuentas: number | null };
  /** `true` si este ejecutable no sabe leerlo: se enseña, no se ofrece restaurar. */
  demasiadoNuevo: boolean;
  bytes: number;
}

/**
 * Lee la cabecera de un `.pcbak`. `null` si no lo es o no se puede leer.
 *
 * `creadoEn` sale **de la cabecera**, nunca del `mtime`: copiar la carpeta a
 * mano reescribe las fechas del sistema de archivos y la pantalla mentiria.
 */
export async function leerCabecera(archivo: string): Promise<RespaldoEncontrado | null> {
  let crudo: Buffer;
  try {
    crudo = await readFile(archivo);
  } catch {
    return null;
  }

  let cabecera: z.infer<typeof esquemaCabecera>;
  try {
    cabecera = esquemaCabecera.parse(JSON.parse(crudo.toString('utf8')));
  } catch {
    return null;
  }

  const esquemas = {
    vault: cabecera.esquemas?.vault ?? null,
    cuentas: cabecera.esquemas?.cuentas ?? null
  };

  const nombre = archivo.slice(Math.max(archivo.lastIndexOf('\\'), archivo.lastIndexOf('/')) + 1);

  return {
    archivo,
    nombre,
    carpeta: archivo.slice(0, archivo.length - nombre.length - 1),
    creadoEn: cabecera.creadoEn ?? '',
    appVersion: cabecera.appVersion ?? '',
    mercado: cabecera.mercado ?? null,
    panelOrigen: cabecera.panelOrigen ?? null,
    cuentas: cabecera.cuentas ?? null,
    esquemas,
    demasiadoNuevo:
      cabecera.version > VERSION_RESPALDO ||
      (esquemas.vault !== null && esquemas.vault > VERSION_VAULT) ||
      (esquemas.cuentas !== null && esquemas.cuentas > VERSION_REGISTRO),
    bytes: crudo.byteLength
  };
}

/**
 * El respaldo que se ofrecera restaurar: el alias, o el fechado mas reciente.
 *
 * Nunca lanza. Una carpeta que no existe -el caso normal en un panel recien
 * estrenado- es `null`, no un error.
 */
export async function buscarRespaldo(carpetaRespaldos: string): Promise<RespaldoEncontrado | null> {
  let nombres: string[];
  try {
    nombres = await readdir(carpetaRespaldos);
  } catch {
    return null;
  }

  if (nombres.includes(NOMBRE_ALIAS)) {
    const alias = await leerCabecera(join(carpetaRespaldos, NOMBRE_ALIAS));
    if (alias !== null) return alias;
    /* Alias ilegible -escritura interrumpida, sincronizacion a medias-: se cae al fechado. */
  }

  /* De mas reciente a mas antiguo. Se ignora todo lo que no sea un fechado nuestro. */
  const fechados = nombres
    .filter((n) => PATRON_FECHADO.test(n))
    .sort()
    .reverse();
  for (const n of fechados) {
    const cabecera = await leerCabecera(join(carpetaRespaldos, n));
    if (cabecera !== null) return cabecera;
  }
  return null;
}

/* ---------- restaurar ---------- */

export type MotivoRestauracion =
  | 'no-existe'
  | 'ilegible'
  | 'version-futura'
  | 'esquema-futuro'
  | 'integridad'
  | 'ya-hay-vault'
  | 'no-se-pudo-escribir';

export interface ResultadoRestauracion {
  ok: boolean;
  motivo: MotivoRestauracion | null;
  mensaje: string;
  cuentas: number | null;
  /** Nombre del almacen apartado, o `null` si no habia ninguno. */
  vaultApartado: string | null;
}

export interface OpcionesRestauracion {
  /**
   * Reemplazar un almacen existente.
   *
   * Solo lo pone el manejador de IPC, y solo tras comprobar la contrasena
   * maestra del panel **actual**: es lo que demuestra que el almacen que se va
   * a apartar es de quien lo esta apartando.
   */
  sobrescribir?: boolean;
  ahora?: () => Date;
}

const falloRestauracion = (motivo: MotivoRestauracion, mensaje: string): ResultadoRestauracion => ({
  ok: false,
  motivo,
  mensaje,
  cuentas: null,
  vaultApartado: null
});

/**
 * Vuelca un `.pcbak` sobre la carpeta de datos de este panel.
 *
 * **Todo el rechazo ocurre antes de escribir un solo byte.** Si algo falla en
 * la validacion, el destino queda exactamente como estaba: descubrir que el
 * respaldo era de un panel mas nuevo *despues* de haber reemplazado el vault
 * propio seria el peor desenlace posible.
 */
export async function restaurarRespaldo(
  archivo: string,
  destino: DestinoImportacion,
  opciones: OpcionesRestauracion = {}
): Promise<ResultadoRestauracion> {
  let crudo: Buffer;
  try {
    crudo = await readFile(archivo);
  } catch {
    return falloRestauracion(
      'no-existe',
      'No se encontró ese archivo de respaldo. Puede que se haya movido o borrado.'
    );
  }

  let respaldo: z.infer<typeof esquemaRespaldo>;
  try {
    respaldo = esquemaRespaldo.parse(JSON.parse(crudo.toString('utf8')));
  } catch {
    /*
     * Puede ser un respaldo de una version futura con otra forma. Se distingue,
     * porque «actualice el panel» y «ese archivo no es un respaldo» son dos
     * cosas distintas para quien las lee.
     */
    const cabecera = await leerCabecera(archivo);
    if (cabecera !== null && cabecera.demasiadoNuevo) {
      return falloRestauracion('version-futura', mensajeVersionFutura(cabecera.appVersion));
    }
    return falloRestauracion(
      'ilegible',
      'Ese archivo no es un respaldo del panel, o llegó dañado. No se ha tocado nada.'
    );
  }

  if (respaldo.version > VERSION_RESPALDO) {
    return falloRestauracion('version-futura', mensajeVersionFutura(respaldo.appVersion ?? ''));
  }

  /*
   * Es `vault.ts:323` aplicado un paso antes. El vault rechaza un archivo de
   * version futura al abrirlo; aqui hay que rechazarlo antes de **escribirlo**,
   * porque para cuando el operador lo descubriera ya se habria reemplazado el
   * suyo.
   */
  const esquemaVault = respaldo.esquemas?.vault;
  const esquemaCuentas = respaldo.esquemas?.cuentas;
  if (
    (esquemaVault !== undefined && esquemaVault > VERSION_VAULT) ||
    (esquemaCuentas !== undefined && esquemaCuentas !== null && esquemaCuentas > VERSION_REGISTRO)
  ) {
    return falloRestauracion('esquema-futuro', mensajeVersionFutura(respaldo.appVersion ?? ''));
  }

  /* Integridad, antes de tocar el disco. Ver la cabecera: GCM llega tarde. */
  const decodificados = new Map<string, Buffer>();
  for (const [nombre, incluido] of Object.entries(respaldo.archivos)) {
    if (incluido === undefined) continue;
    const dato = Buffer.from(incluido.contenido, 'base64');
    if (dato.byteLength !== incluido.bytes || sha256(dato) !== incluido.sha256) {
      return falloRestauracion(
        'integridad',
        `El respaldo llegó incompleto o dañado: «${nombre}» no coincide con lo que decía el archivo. ` +
          'No se ha restaurado nada. Pruebe con otro respaldo de la misma carpeta.'
      );
    }
    decodificados.set(nombre, dato);
  }

  const vaultNuevo = decodificados.get('vault.enc');
  /* No deberia poder pasar -el esquema lo exige-, pero el `get` es opcional. */
  if (vaultNuevo === undefined) {
    return falloRestauracion(
      'ilegible',
      'Ese respaldo no contiene ningún almacén de credenciales.'
    );
  }

  /* ---- a partir de aqui se escribe ---- */

  let vaultApartado: string | null = null;
  if (await existe(destino.vault)) {
    if (opciones.sobrescribir !== true) {
      return falloRestauracion(
        'ya-hay-vault',
        'Este panel ya tiene credenciales guardadas. Para reemplazarlas por las del respaldo hace ' +
          'falta confirmar con la contraseña maestra de este panel.'
      );
    }

    const marca = sello((opciones.ahora ?? (() => new Date()))());
    try {
      /*
       * `rename` y no `copyFile`: es el mismo volumen, es atomico y no deja un
       * instante con dos vaults validos compitiendo. Y apartar en vez de borrar
       * es lo que compensa relajar la regla 1 del importador.
       */
      vaultApartado = `vault.enc.reemplazado-${marca}`;
      await rename(destino.vault, `${destino.vault}.reemplazado-${marca}`);

      /*
       * El `.bak` del almacen viejo se va con el suyo.
       *
       * Si se quedara, sobreviviria junto al vault nuevo -otra sal, otra
       * contrasena- y el consejo de `vault.ts` «pruebe con el respaldo .bak»
       * apuntaria a un archivo de otro almacen, que falla con «contrasena
       * incorrecta». Es una trampa silenciosa y cuesta una linea evitarla.
       */
      if (await existe(destino.vaultBak)) {
        await rename(destino.vaultBak, `${destino.vaultBak}.reemplazado-${marca}`);
      }
    } catch (e) {
      return falloRestauracion('no-se-pudo-escribir', mensajeDeEscritura(e, destino.base));
    }
  }

  try {
    /* Accesorios primero y el vault el ultimo. Ver la cabecera. */
    const cuentas = decodificados.get('cuentas.json');
    const activos = decodificados.get('activos.json');
    if (cuentas !== undefined) await escribirAtomico(destino.cuentas, cuentas);
    if (activos !== undefined) await escribirAtomico(destino.activos, activos);
    await escribirAtomico(destino.vault, vaultNuevo);
  } catch (e) {
    return falloRestauracion('no-se-pudo-escribir', mensajeDeEscritura(e, destino.base));
  }

  return {
    ok: true,
    motivo: null,
    mensaje:
      'Credenciales restauradas. Desbloquee con la contraseña maestra que usaba en esa instalación: ' +
      'el archivo viene cifrado tal cual y esa contraseña no ha cambiado.',
    cuentas: respaldo.cuentas ?? null,
    vaultApartado
  };
}

const mensajeVersionFutura = (appVersion: string): string =>
  `Ese respaldo lo hizo una versión más nueva del panel${appVersion === '' ? '' : ` (${appVersion})`}. ` +
  'Actualice el panel antes de restaurarlo. No se ha tocado nada.';
