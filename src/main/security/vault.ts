/**
 * Almacen cifrado de credenciales (`vault.enc`).
 *
 * Es el unico sitio donde reposan `secretKey` y `passphrase`. Fuera de aqui
 * solo circula la API Key enmascarada, y hacia el renderer ni eso completo.
 * RNF-001 y docs/03-modelo-de-datos.md seccion 5.
 *
 * --------------------------------------------------------------------------
 * El verificador, y por que no basta con AES-GCM
 * --------------------------------------------------------------------------
 * GCM ya autentica: con la clave equivocada, descifrar falla. El problema es
 * que falla **igual** que con un archivo corrupto, y el operador no sabria si
 * escribio mal la contrasena o si acaba de perder las credenciales de 100
 * cuentas. Por eso se cifra aparte una constante conocida:
 *
 *   verificador falla            -> contrasena incorrecta
 *   verificador abre, payload no -> archivo danado, se ofrece el respaldo
 *
 * Cuesta 60 bytes y convierte un susto en un mensaje claro.
 */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { registrarSecreto } from './redact';
import { borrar, derivarClave, nuevosParametros, type ParametrosKdf } from './kdf';
import { escribirAtomico, existe, rotarRespaldo } from '../storage/atomic-write';

const FORMATO = 'pcb-vault';
const VERSION_ACTUAL = 1;
const ALGORITMO = 'aes-256-gcm';
/** Texto que cifra el verificador. Su contenido da igual; que sea fijo, no. */
const TESTIGO = 'pcb-ok';

/* ---------- forma del archivo ---------- */

const esquemaKdf = z.object({
  algoritmo: z.literal('scrypt'),
  N: z.number().int().positive(),
  r: z.number().int().positive(),
  p: z.number().int().positive(),
  longitudClave: z.number().int().positive(),
  salt: z.string()
});

const esquemaSobreCifrado = z.object({
  algoritmo: z.literal(ALGORITMO),
  iv: z.string(),
  tag: z.string()
});

const esquemaArchivo = z.object({
  formato: z.literal(FORMATO),
  version: z.number().int().positive(),
  kdf: esquemaKdf,
  cifrado: esquemaSobreCifrado,
  verificador: z.object({ iv: z.string(), tag: z.string(), dato: z.string() }),
  payload: z.string(),
  desbloqueoRapido: z.unknown().nullish(),
  actualizadoEn: z.string()
});

/* ---------- contenido descifrado ---------- */

export const esquemaPermisos = z.object({
  verificadoEn: z.string(),
  authorities: z.array(z.string()),
  ipsPermitidas: z.array(z.string())
});

export const esquemaCredencialGuardada = z.object({
  id: z.string(),
  cuentaId: z.string(),
  apiKey: z.string(),
  secretKey: z.string(),
  passphrase: z.string(),
  altaEn: z.string(),
  permisos: esquemaPermisos.nullable()
});

export type CredencialGuardada = z.infer<typeof esquemaCredencialGuardada>;

/**
 * La contrasena de paso, guardada como derivacion y nunca en claro.
 *
 * Vive **dentro del payload cifrado** y no en un archivo aparte, y eso es una
 * decision de seguridad, no de comodidad: la contrasena de paso protege el
 * envio de ordenes, que solo es posible con el almacen abierto. Guardarla fuera
 * la dejaria legible con el panel bloqueado, es decir, expuesta justo cuando no
 * hay nadie delante.
 *
 * Se deriva con los mismos parametros scrypt que la maestra. Es cara a
 * proposito -~0,5 s-, que para una contrasena corta es la unica defensa real
 * contra probarlas todas.
 */
const esquemaPaso = z.object({
  /**
   * Los parametros con los que se derivo, guardados enteros.
   *
   * No basta con el salt: si el almacen cambiara de coste -otra version, otra
   * maquina- comprobar con los parametros de hoy contra una derivacion hecha
   * con los de ayer daria «contrasena incorrecta» sin que nadie entendiera por
   * que. Guardandolos, la comprobacion siempre reproduce lo que se hizo.
   */
  kdf: esquemaKdf,
  derivada: z.string(),
  fijadaEn: z.string()
});

type PasoGuardado = z.infer<typeof esquemaPaso>;

const esquemaPayload = z.object({
  version: z.number().int().positive(),
  credenciales: z.array(esquemaCredencialGuardada),
  /** Ausente en almacenes creados antes de que existiera la contrasena de paso. */
  paso: esquemaPaso.nullish()
});

/* ---------- errores ---------- */

export type MotivoVault =
  'contrasena-incorrecta' | 'archivo-danado' | 'version-futura' | 'no-existe' | 'ya-existe';

export class ErrorVault extends Error {
  readonly motivo: MotivoVault;

  constructor(motivo: MotivoVault, mensaje: string) {
    super(mensaje);
    this.name = 'ErrorVault';
    this.motivo = motivo;
  }
}

/* ---------- estado ---------- */

export type EstadoVault = 'sin-inicializar' | 'bloqueado' | 'desbloqueado';

export async function estadoEnDisco(ruta: string): Promise<'sin-inicializar' | 'bloqueado'> {
  return (await existe(ruta)) ? 'bloqueado' : 'sin-inicializar';
}

/** Datos de alta de una credencial. Sin `id` ni `altaEn`: los pone el vault. */
export interface AltaCredencial {
  cuentaId: string;
  apiKey: string;
  secretKey: string;
  passphrase: string;
  permisos?: z.infer<typeof esquemaPermisos> | null;
}

/** Vista sin secretos, apta para cruzar el IPC. */
export interface CredencialPublica {
  id: string;
  cuentaId: string;
  apiKeyEnmascarada: string;
  altaEn: string;
  permisos: z.infer<typeof esquemaPermisos> | null;
}

/* ---------- el almacen ---------- */

export interface OpcionesVault {
  /** Solo para pruebas: baja el coste de scrypt de medio segundo a nada. */
  parametrosKdf?: Partial<Omit<ParametrosKdf, 'algoritmo'>>;
}

/**
 * Almacen abierto en memoria.
 *
 * Se obtiene con `crear()` o `abrir()`. Mientras vive, la clave derivada y las
 * credenciales en claro estan en memoria del proceso principal; `cerrar()` las
 * sobrescribe.
 */
export class Vault {
  private readonly ruta: string;
  private clave: Buffer | null;
  private kdf: ParametrosKdf;
  private credenciales: CredencialGuardada[];
  private paso: PasoGuardado | null;
  private cerrado = false;

  private constructor(
    ruta: string,
    clave: Buffer,
    kdf: ParametrosKdf,
    credenciales: CredencialGuardada[],
    paso: PasoGuardado | null = null
  ) {
    this.ruta = ruta;
    this.clave = clave;
    this.kdf = kdf;
    this.credenciales = credenciales;
    this.paso = paso;
    for (const c of credenciales) this.marcarSecretos(c);
  }

  /** Registra los secretos para que ningun log pueda escupirlos. */
  private marcarSecretos(c: CredencialGuardada): void {
    registrarSecreto(c.secretKey);
    registrarSecreto(c.passphrase);
  }

  private exigirAbierto(): Buffer {
    if (this.cerrado || this.clave === null) {
      throw new ErrorVault('archivo-danado', 'El almacen esta cerrado.');
    }
    return this.clave;
  }

  /* ---- creacion y apertura ---- */

  /** Crea un almacen vacio. Falla si ya existe: nunca sobrescribe. */
  static async crear(
    ruta: string,
    contrasena: string,
    opciones: OpcionesVault = {}
  ): Promise<Vault> {
    if (await existe(ruta)) {
      throw new ErrorVault('ya-existe', 'Ya hay un almacen en esta carpeta.');
    }
    const kdf = nuevosParametros(opciones.parametrosKdf ?? {});
    const clave = await derivarClave(contrasena, kdf);
    const vault = new Vault(ruta, clave, kdf, []);
    await vault.guardar();
    return vault;
  }

  /**
   * Abre un almacen existente.
   *
   * Distingue contrasena incorrecta de archivo danado, que es la unica razon
   * de ser del verificador.
   */
  static async abrir(ruta: string, contrasena: string): Promise<Vault> {
    if (!(await existe(ruta))) {
      throw new ErrorVault('no-existe', 'No hay ningun almacen en esta carpeta.');
    }

    let archivo;
    try {
      archivo = esquemaArchivo.parse(JSON.parse(await readFile(ruta, 'utf8')));
    } catch {
      throw new ErrorVault('archivo-danado', 'El archivo de credenciales no se puede leer.');
    }

    if (archivo.version > VERSION_ACTUAL) {
      /*
       * Datos nuevos con ejecutable viejo. Adivinar aqui es la forma mas rapida
       * de destruirlos, asi que no se toca el archivo. docs/03 seccion 15.
       */
      throw new ErrorVault(
        'version-futura',
        `El almacen es de una version mas nueva (${archivo.version}). Actualiza el panel.`
      );
    }

    const clave = await derivarClave(contrasena, archivo.kdf);

    const testigo = descifrar(
      clave,
      Buffer.from(archivo.verificador.iv, 'base64'),
      Buffer.from(archivo.verificador.tag, 'base64'),
      Buffer.from(archivo.verificador.dato, 'base64')
    );
    if (testigo === null || testigo.toString('utf8') !== TESTIGO) {
      borrar(clave);
      throw new ErrorVault('contrasena-incorrecta', 'La contrasena no es correcta.');
    }

    const claro = descifrar(
      clave,
      Buffer.from(archivo.cifrado.iv, 'base64'),
      Buffer.from(archivo.cifrado.tag, 'base64'),
      Buffer.from(archivo.payload, 'base64')
    );
    if (claro === null) {
      borrar(clave);
      throw new ErrorVault(
        'archivo-danado',
        'La contrasena es correcta pero el contenido esta danado. Prueba con el respaldo .bak.'
      );
    }

    let payload;
    try {
      payload = esquemaPayload.parse(JSON.parse(claro.toString('utf8')));
    } catch {
      borrar(clave, claro);
      throw new ErrorVault(
        'archivo-danado',
        'El contenido del almacen no tiene el formato previsto.'
      );
    }
    borrar(claro);

    return new Vault(ruta, clave, archivo.kdf, payload.credenciales, payload.paso ?? null);
  }

  /**
   * Comprueba una contrasena sin abrir el almacen.
   *
   * Solo descifra el verificador, que es lo unico que hace falta para saber si
   * la contrasena es la buena. No toca el estado del almacen ya abierto ni
   * descifra las credenciales: sirve para confirmar identidad antes de una
   * accion sensible, no para dar acceso.
   */
  static async comprobarContrasena(ruta: string, contrasena: string): Promise<boolean> {
    if (!(await existe(ruta))) return false;

    let archivo;
    try {
      archivo = esquemaArchivo.parse(JSON.parse(await readFile(ruta, 'utf8')));
    } catch {
      return false;
    }

    const clave = await derivarClave(contrasena, archivo.kdf);
    const testigo = descifrar(
      clave,
      Buffer.from(archivo.verificador.iv, 'base64'),
      Buffer.from(archivo.verificador.tag, 'base64'),
      Buffer.from(archivo.verificador.dato, 'base64')
    );
    borrar(clave);

    return testigo !== null && testigo.toString('utf8') === TESTIGO;
  }

  /* ---- consulta ---- */

  /** Listado sin secretos. Es lo unico que puede cruzar el IPC. */
  listar(): CredencialPublica[] {
    this.exigirAbierto();
    return this.credenciales.map((c) => ({
      id: c.id,
      cuentaId: c.cuentaId,
      apiKeyEnmascarada: enmascarar(c.apiKey),
      altaEn: c.altaEn,
      permisos: c.permisos
    }));
  }

  /**
   * Credencial completa para firmar una peticion.
   *
   * Solo la llama el proceso principal, al construir una peticion. El valor
   * devuelto no debe guardarse ni pasarse al renderer.
   */
  credencialDe(cuentaId: string): { apiKey: string; secretKey: string; passphrase: string } | null {
    this.exigirAbierto();
    const c = this.credenciales.find((x) => x.cuentaId === cuentaId);
    if (c === undefined) return null;
    return { apiKey: c.apiKey, secretKey: c.secretKey, passphrase: c.passphrase };
  }

  get cantidad(): number {
    return this.credenciales.length;
  }

  /* ---- alta y baja ---- */

  /**
   * Da de alta una credencial. Una cuenta solo puede tener una: volver a dar
   * de alta la misma la reemplaza, que es lo que hace falta al rotar una key.
   */
  agregar(alta: AltaCredencial): CredencialPublica {
    this.exigirAbierto();

    const registro: CredencialGuardada = {
      id: `cred_${randomUUID().slice(0, 8)}`,
      cuentaId: alta.cuentaId,
      apiKey: alta.apiKey,
      secretKey: alta.secretKey,
      passphrase: alta.passphrase,
      altaEn: new Date().toISOString(),
      permisos: alta.permisos ?? null
    };
    this.marcarSecretos(registro);

    const indice = this.credenciales.findIndex((c) => c.cuentaId === alta.cuentaId);
    if (indice === -1) this.credenciales.push(registro);
    else this.credenciales.splice(indice, 1, registro);

    const publica = this.listar().find((c) => c.id === registro.id);
    if (publica === undefined) throw new Error('No se pudo listar la credencial recien creada');
    return publica;
  }

  /** Baja por cuenta. Devuelve `true` si habia algo que borrar. */
  /* ---- contrasena de paso ---- */

  /** Hay una contrasena de paso fijada. */
  tienePaso(): boolean {
    return this.paso !== null;
  }

  /**
   * Fija o cambia la contrasena de paso. No se guarda en claro en ningun sitio.
   *
   * No persiste por su cuenta: como el resto del almacen, se escribe con
   * `guardar()`. Asi una sola escritura deja el archivo coherente.
   */
  async fijarPaso(contrasena: string): Promise<void> {
    this.exigirAbierto();
    /* El mismo coste que la maestra: mas barata seria el eslabon debil. */
    const kdf = nuevosParametros({
      N: this.kdf.N,
      r: this.kdf.r,
      p: this.kdf.p,
      longitudClave: this.kdf.longitudClave,
      salt: randomBytes(16).toString('base64')
    });
    const derivada = await derivarClave(contrasena, kdf);
    this.paso = { kdf, derivada: derivada.toString('base64'), fijadaEn: new Date().toISOString() };
    borrar(derivada);
  }

  /**
   * ¿Es esta la contrasena de paso?
   *
   * --------------------------------------------------------------------------
   * Sin contrasena fijada, la respuesta es `false`, nunca `true`
   * --------------------------------------------------------------------------
   * La tentacion es dejar pasar cuando no hay ninguna configurada, «porque no
   * hay nada que comprobar». Eso convierte el freno en un adorno: un almacen sin
   * paso enviaria ordenes sin confirmacion alguna. Se responde que no, y quien
   * llama decide si eso significa «configurela primero» o «no aplica».
   *
   * La comparacion es en tiempo constante. Aqui no protege gran cosa -son
   * milisegundos frente a los ~500 ms de la derivacion- pero comparar hashes con
   * `===` es la clase de descuido que se copia a sitios donde si importa.
   */
  async comprobarPaso(contrasena: string): Promise<boolean> {
    this.exigirAbierto();
    if (this.paso === null) return false;

    const derivada = await derivarClave(contrasena, this.paso.kdf);
    const guardada = Buffer.from(this.paso.derivada, 'base64');

    const igual = derivada.length === guardada.length && timingSafeEqual(derivada, guardada);
    borrar(derivada, guardada);
    return igual;
  }

  eliminar(cuentaId: string): boolean {
    this.exigirAbierto();
    const indice = this.credenciales.findIndex((c) => c.cuentaId === cuentaId);
    if (indice === -1) return false;
    const [fuera] = this.credenciales.splice(indice, 1);
    if (fuera !== undefined) {
      /* Se limpian los secretos del registro que sale, no solo la referencia. */
      fuera.secretKey = '';
      fuera.passphrase = '';
    }
    return true;
  }

  /* ---- persistencia ---- */

  /** Cifra y escribe. Rota el respaldo antes de tocar el archivo bueno. */
  async guardar(): Promise<void> {
    const clave = this.exigirAbierto();

    const payload = Buffer.from(
      JSON.stringify({ version: VERSION_ACTUAL, credenciales: this.credenciales, paso: this.paso }),
      'utf8'
    );

    const cuerpo = cifrar(clave, payload);
    const testigo = cifrar(clave, Buffer.from(TESTIGO, 'utf8'));
    borrar(payload);

    const archivo = {
      formato: FORMATO,
      version: VERSION_ACTUAL,
      kdf: this.kdf,
      cifrado: {
        algoritmo: ALGORITMO,
        iv: cuerpo.iv.toString('base64'),
        tag: cuerpo.tag.toString('base64')
      },
      verificador: {
        iv: testigo.iv.toString('base64'),
        tag: testigo.tag.toString('base64'),
        dato: testigo.datos.toString('base64')
      },
      payload: cuerpo.datos.toString('base64'),
      desbloqueoRapido: null,
      actualizadoEn: new Date().toISOString()
    };

    await rotarRespaldo(this.ruta);
    await escribirAtomico(this.ruta, JSON.stringify(archivo, null, 2));
  }

  /**
   * Cambia la contrasena maestra.
   *
   * Con sal nueva: reutilizarla permitiria a quien tuviera un `vault.enc`
   * viejo comprobar si la contrasena nueva es la misma de antes. El archivo
   * anterior sigue siendo valido hasta que la escritura termina, asi que un
   * fallo a mitad no deja el almacen inaccesible.
   */
  async cambiarContrasena(nueva: string): Promise<void> {
    this.exigirAbierto();
    const kdfNuevo = nuevosParametros({ N: this.kdf.N, r: this.kdf.r, p: this.kdf.p });
    const claveNueva = await derivarClave(nueva, kdfNuevo);

    const claveVieja = this.clave;
    this.clave = claveNueva;
    this.kdf = kdfNuevo;

    try {
      await this.guardar();
      borrar(claveVieja);
    } catch (e) {
      /* Se revierte en memoria: el archivo en disco sigue siendo el de antes. */
      this.clave = claveVieja;
      borrar(claveNueva);
      throw e;
    }
  }

  /** Cierra el almacen y borra de memoria lo que se pueda. */
  cerrar(): void {
    borrar(this.clave);
    this.clave = null;
    for (const c of this.credenciales) {
      c.secretKey = '';
      c.passphrase = '';
    }
    this.credenciales = [];
    this.cerrado = true;
  }

  get estaCerrado(): boolean {
    return this.cerrado;
  }
}

/* ---------- primitivas ---------- */

function cifrar(clave: Buffer, claro: Buffer): { iv: Buffer; tag: Buffer; datos: Buffer } {
  /* 12 bytes es el tamano recomendado para GCM; nunca se reutiliza. */
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITMO, clave, iv);
  const datos = Buffer.concat([cipher.update(claro), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), datos };
}

/** Devuelve `null` si la autenticacion falla, en vez de lanzar. */
function descifrar(clave: Buffer, iv: Buffer, tag: Buffer, datos: Buffer): Buffer | null {
  try {
    const decipher = createDecipheriv(ALGORITMO, clave, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(datos), decipher.final()]);
  } catch {
    return null;
  }
}

/** Primeros 2 y ultimos 4, como exige RNF-001. */
function enmascarar(apiKey: string): string {
  if (apiKey.length <= 6) return '••••';
  return `${apiKey.slice(0, 2)}••••${apiKey.slice(-4)}`;
}
