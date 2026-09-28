/**
 * La bitácora: una línea por petición a Bitget, para poder diagnosticar.
 *
 * ==========================================================================
 * Por qué existe, dicho sin rodeos
 * ==========================================================================
 * `docs/03` sección 11 preveía este archivo y `paths.ts` ya calculaba su ruta
 * —`rutas().logs` y `archivoLogDeHoy`— desde hace fases. **Nunca se escribió
 * nada en él.** `electron-log` figuraba en las dependencias sin un solo import.
 *
 * El coste apareció el 09/09/2026: una API Key de una cuenta UTA fue rechazada
 * con el código `40085` y no había forma de saber **qué petición** lo había
 * producido —la de V3 que decide el modo, o la de V2 que se intenta después—,
 * ni con qué había contestado V3 antes. Sin eso, el operador solo ve un número
 * que no significa nada y quien mantiene el panel no puede ayudarle.
 *
 * ==========================================================================
 * Qué se anota y qué NO
 * ==========================================================================
 * Se anota lo que permite reconstruir la conversación: ruta, método,
 * superficie, estado HTTP, código de negocio, duración y qué cuenta la firmó.
 *
 * **No se anota ni un secreto.** Nunca las cabeceras —ahí viajan `ACCESS-KEY`,
 * `ACCESS-SIGN` y `ACCESS-PASSPHRASE`—. El cuerpo enviado sí se anota, y la
 * respuesta de las peticiones que cambian algo, porque sin ellos no se puede
 * saber qué tamaño, lado o apalancamiento salió de verdad; ambos pasan por
 * `redactar` (por nombre de campo y por valor) y se recortan. La cuenta se
 * identifica con la API Key **enmascarada**, que es lo mismo que ya se enseña
 * en pantalla. RNF-001.
 *
 * El mensaje de Bitget sí se anota, recortado y pasado por `redactarTexto`: es
 * el dato que traduce un código a algo accionable, y el redactor cubre el caso
 * de que el exchange devuelva un valor sensible dentro de su propio texto.
 *
 * ==========================================================================
 * No puede tumbar el panel
 * ==========================================================================
 * Todo lo de aquí se traga sus errores. Un disco lleno, una carpeta sin
 * permisos o un antivirus bloqueando el archivo **no pueden** impedir que una
 * orden salga: un panel sin log es un panel con menos diagnóstico, y un panel
 * que se cae por el log es un panel que no opera. Por eso tampoco se espera a
 * que la escritura termine.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { enmascararApiKey, redactar, redactarTexto } from '../security/redact';
import { archivoLogDeHoy, rutas } from '../storage/paths';

/** Lo que se anota de una petición ya resuelta, bien o mal. */
export interface AnotacionPeticion {
  metodo: string;
  /** Ruta con su cadena de consulta. No lleva secretos: van en cabeceras. */
  ruta: string;
  /** `v2` o `v3`, deducido de la ruta. Es la mitad del diagnóstico de esta migración. */
  superficie: string;
  /** API Key enmascarada de quien firmó, o `publica` si no iba firmada. */
  cuenta: string;
  httpStatus: number | null;
  /** Código de negocio de Bitget: `00000` si fue bien. */
  codigo: string | null;
  ms: number;
  /** Mensaje del exchange, recortado y redactado. `null` si no hubo. */
  mensaje: string | null;
  /**
   * Cuerpo enviado, tal cual salió hacia Bitget. `null` en las peticiones sin
   * cuerpo (los GET llevan sus parámetros en `ruta`). Se redacta por nombre de
   * campo y por valor antes de escribirse.
   */
  cuerpo?: string | null;
  /**
   * `data` con que contestó Bitget. Solo se pasa en las peticiones que cambian
   * algo -órdenes, apalancamiento, traspasos-: las consultas de sondeo
   * devuelven listas largas y llenarían el archivo sin ayudar a diagnosticar.
   */
  respuesta?: unknown;
}

/** Un hecho que no es una petición: una detección de modo, un veredicto. */
export interface AnotacionEvento {
  evento: string;
  /** Cualquier dato plano. Quien llama es responsable de no meter secretos. */
  datos: Record<string, string | number | boolean | null>;
}

/**
 * Cuánto del mensaje de Bitget se conserva.
 *
 * Suficiente para leerlo entero en la práctica y acotado para que una respuesta
 * degenerada no llene el disco.
 */
const MAX_MENSAJE = 300;

/** Tope del cuerpo enviado y de la respuesta, ya serializados. */
const MAX_CARGA = 2_000;

/**
 * Cuerpo o respuesta, listo para la línea del log: se parsea si es JSON para
 * que `redactar` pueda enmascarar por nombre de campo (`passphrase`,
 * `secretKey`...), y se recorta.
 */
export function cargaParaLog(valor: unknown): unknown {
  if (valor === undefined || valor === null || valor === '') return null;
  let objeto = valor;
  if (typeof valor === 'string') {
    try {
      objeto = JSON.parse(valor);
    } catch {
      return redactarTexto(valor).slice(0, MAX_CARGA);
    }
  }
  const texto = JSON.stringify(redactar(objeto));
  return texto.length <= MAX_CARGA ? JSON.parse(texto) : `${texto.slice(0, MAX_CARGA)}…`;
}

/** `true` cuando la bitácora está encendida. Ver `iniciarBitacora`. */
let activa = false;
let carpeta = '';

/**
 * Cola de escritura.
 *
 * Las anotaciones se encadenan sobre una sola promesa para que dos peticiones
 * que terminan a la vez no entrelacen sus líneas en el archivo. No bloquea a
 * nadie: quien anota no espera.
 */
let cola: Promise<void> = Promise.resolve();

/**
 * Enciende la bitácora.
 *
 * Se llama una vez al arrancar el proceso principal. Si la carpeta no se puede
 * crear, la bitácora se queda apagada y el panel funciona igual.
 */
export async function iniciarBitacora(carpetaDestino?: string): Promise<void> {
  try {
    /*
     * El destino se puede imponer, y solo lo hacen las pruebas: `rutas()` se
     * apoya en `app.getPath`, que en la suite es un doble y devolveria una ruta
     * inventada del disco real.
     */
    carpeta = carpetaDestino ?? rutas().logs;
    await mkdir(carpeta, { recursive: true });
    activa = true;
    anotarEvento({ evento: 'arranque', datos: { version: process.env['npm_package_version'] ?? '' } });
  } catch {
    activa = false;
  }
}

/** Apaga la bitácora. La usan las pruebas y el cierre del panel. */
export function detenerBitacora(): void {
  activa = false;
}

/**
 * La superficie a la que pertenece una ruta.
 *
 * Se deduce de la propia ruta y no del sello de la credencial a propósito: lo
 * que interesa saber en el log es **a dónde se llamó de verdad**, que es
 * precisamente lo que se pone en duda cuando una cuenta migrada falla.
 */
export function superficieDeRuta(ruta: string): string {
  if (ruta.startsWith('/api/v3/')) return 'v3';
  if (ruta.startsWith('/api/v2/')) return 'v2';
  return 'otra';
}

/** La cuenta, enmascarada. `publica` cuando la petición no iba firmada. */
export function cuentaDe(apiKey: string | null | undefined): string {
  if (apiKey === null || apiKey === undefined || apiKey === '') return 'publica';
  return enmascararApiKey(apiKey);
}

/** Anota una petición resuelta. No espera a que se escriba. */
export function anotarPeticion(a: AnotacionPeticion): void {
  escribir({
    tipo: 'peticion',
    metodo: a.metodo,
    ruta: a.ruta,
    superficie: a.superficie,
    cuenta: a.cuenta,
    httpStatus: a.httpStatus,
    codigo: a.codigo,
    ms: a.ms,
    mensaje: a.mensaje === null ? null : redactarTexto(a.mensaje).slice(0, MAX_MENSAJE),
    ...(a.cuerpo === undefined || a.cuerpo === null || a.cuerpo === ''
      ? {}
      : { cuerpo: cargaParaLog(a.cuerpo) }),
    ...(a.respuesta === undefined ? {} : { respuesta: cargaParaLog(a.respuesta) })
  });
}

/** Anota un hecho del panel que no es una petición. */
export function anotarEvento(a: AnotacionEvento): void {
  escribir({ tipo: 'evento', evento: a.evento, ...a.datos });
}

function escribir(registro: Record<string, unknown>): void {
  if (!activa) return;

  const linea = `${JSON.stringify({ ts: new Date().toISOString(), ...registro })}\n`;
  const destino = join(carpeta, archivoLogDeHoy());

  cola = cola
    .then(() => appendFile(destino, linea, 'utf8'))
    .catch(() => {
      /*
       * Se apaga en vez de reintentar. Si el disco no admite la escritura, cada
       * petición siguiente produciría otro fallo, y un log que llena la consola
       * de errores estorba más de lo que ayuda.
       */
      activa = false;
    });
}
