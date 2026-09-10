/**
 * Firma de peticiones a la API oficial de Bitget (v2).
 *
 * Es el unico lugar del proyecto que toca `secretKey`. Todo lo demas recibe
 * peticiones ya firmadas y nunca ve el secreto.
 *
 * Bitget autentica cada peticion con cuatro cabeceras:
 *
 *   ACCESS-KEY         la API key
 *   ACCESS-SIGN        base64( HMAC-SHA256( secretKey, cadena de prefirma ) )
 *   ACCESS-TIMESTAMP   milisegundos desde epoch, en decimal
 *   ACCESS-PASSPHRASE  la passphrase declarada al crear la key
 *
 * y la cadena de prefirma se compone asi, sin separadores:
 *
 *   timestamp + METODO + ruta + cadenaConsulta + cuerpo
 *
 * Ejemplo real:
 *
 *   1700000000000GET/api/v2/mix/position/all-position?productType=USDT-FUTURES
 *
 * La regla que hace que esto no falle nunca: la cadena de consulta y el cuerpo
 * que se firman son **exactamente los mismos bytes** que viajan en la peticion.
 * No se construyen dos veces. `firmarPeticion` devuelve `rutaCompleta` y
 * `cuerpo` ya resueltos, y el cliente REST esta obligado a enviar esos y no
 * otros. Un `JSON.stringify` de mas en el camino invalida la firma.
 *
 * docs/01-stack-tecnologico.md seccion 8.
 */
import { createHmac } from 'node:crypto';
import type { HoldMode } from '@shared/types';

export type MetodoHttp = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** Valor admisible en la cadena de consulta. `undefined` y `null` se omiten. */
export type ValorConsulta = string | number | boolean | undefined | null;

/**
 * Superficie de la API con la que habla una credencial.
 *
 * --------------------------------------------------------------------------
 * Por que vive en la credencial y no en el mercado
 * --------------------------------------------------------------------------
 * Porque **es una propiedad de la API Key**, no del mercado. Una key emitida
 * sobre una cuenta UTA solo puede consultar `/api/v3/*`; en V2 recibe un
 * rechazo, y al reves. Y como cada key pertenece a exactamente un UID -el mismo
 * razonamiento por el que la clave del limitador es la API Key, ver
 * `client.ts`-, la superficie queda determinada por la credencial.
 *
 * El mercado no sirve para esto: `Mercado` es un singleton por mercado -uno
 * real y uno simulado- mientras que la superficie es **por subcuenta**. En el
 * mismo mercado y a la vez habra cuentas Classic y cuentas UTA.
 *
 * docs/00-uta-fase-1-equivalencias.md seccion 6.
 */
export type Superficie = 'v2' | 'v3';

/**
 * Credenciales de una cuenta. Vive en memoria solo mientras el vault esta
 * abierto; nunca se serializa ni cruza el IPC. docs/03 seccion 5.
 */
export interface Credencial {
  apiKey: string;
  secretKey: string;
  passphrase: string;
  /**
   * Ausente equivale a `'v2'`.
   *
   * El defecto no es pereza: una cuenta cuyo modo todavia no se ha detectado
   * tiene que hablar V2, que es lo que eran todas antes de que UTA existiera.
   * Si se equivoca, recibe un rechazo limpio del exchange. Enrutar a V3 por
   * defecto dejaria muda a toda cuenta clasica ante el menor fallo de
   * deteccion, que es el error caro de los dos.
   */
  superficie?: Superficie;
  /**
   * Modo de posicion de la subcuenta, solo para V3.
   *
   * Viaja aqui —y no como parametro de cada operacion— porque decide un campo
   * del **cuerpo** de casi todas las peticiones de V3 (`posSide`), y las once
   * funciones de `rest/endpoints/*` ya reciben la credencial. Anadirlo como
   * parametro obligaria a atravesar con el las cinco maniobras del motor de
   * lotes, que es el codigo que menos conviene tocar.
   *
   * `null` o ausente es «no se sabe», y se resuelve del lado seguro: se envia
   * `posSide`. Ver `posSideDe` en `bitget/superficie.ts`.
   */
  holdMode?: HoldMode | null;
}

/** La superficie de una credencial, con el defecto seguro aplicado. */
export const superficieDe = (credencial: Credencial): Superficie =>
  credencial.superficie ?? 'v2';

export interface PeticionFirmable {
  metodo: MetodoHttp;
  /** Ruta absoluta sin host ni consulta. Ej. `/api/v2/mix/account/accounts`. */
  ruta: string;
  consulta?: Record<string, ValorConsulta>;
  /** Se serializa a JSON compacto. Ausente en GET y DELETE. */
  cuerpo?: unknown;
  /**
   * Reloj en milisegundos. El cliente REST inyecta aqui el reloj corregido con
   * el desfase contra el servidor de Bitget; por defecto usa el local.
   */
  timestampMs?: number;
}

export interface PeticionFirmada {
  metodo: MetodoHttp;
  /** Ruta + consulta, tal cual debe viajar en la linea de peticion. */
  rutaCompleta: string;
  /** Cuerpo serializado. Cadena vacia cuando no hay cuerpo. */
  cuerpo: string;
  cabeceras: Record<string, string>;
}

/**
 * Cadena de consulta canonica.
 *
 * Ordenada alfabeticamente por clave: Bitget solo exige que coincida con la
 * enviada, pero un orden determinista hace que la firma sea reproducible y que
 * un fallo se pueda comparar contra un vector fijo en las pruebas.
 *
 * Devuelve cadena vacia -no `?`- cuando no queda ningun parametro.
 */
export function cadenaConsulta(consulta: Record<string, ValorConsulta> | undefined): string {
  if (!consulta) return '';

  const pares = Object.entries(consulta)
    .filter((par): par is [string, string | number | boolean] => {
      const valor = par[1];
      return valor !== undefined && valor !== null;
    })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([clave, valor]) => `${encodeURIComponent(clave)}=${encodeURIComponent(String(valor))}`);

  return pares.length === 0 ? '' : `?${pares.join('&')}`;
}

/**
 * Serializacion del cuerpo.
 *
 * JSON compacto, sin espacios: cualquier caracter adicional forma parte de la
 * cadena firmada. `undefined` produce cadena vacia, no `"undefined"`.
 */
export function serializarCuerpo(cuerpo: unknown): string {
  return cuerpo === undefined ? '' : JSON.stringify(cuerpo);
}

/** Cadena de prefirma: timestamp + METODO + ruta + consulta + cuerpo. */
export function cadenaPrefirma(datos: {
  timestampMs: number;
  metodo: MetodoHttp;
  rutaCompleta: string;
  cuerpo: string;
}): string {
  return `${datos.timestampMs}${datos.metodo.toUpperCase()}${datos.rutaCompleta}${datos.cuerpo}`;
}

/** HMAC-SHA256 en base64, el formato que espera `ACCESS-SIGN`. */
export function firmar(secretKey: string, prefirma: string): string {
  return createHmac('sha256', secretKey).update(prefirma, 'utf8').digest('base64');
}

/**
 * Firma una peticion completa y devuelve todo lo necesario para enviarla.
 *
 * `locale` fija el idioma de los mensajes de error del exchange. Se pide en
 * ingles a proposito: los codigos y textos crudos se clasifican en
 * bitget/errors.ts y se traducen alli, con nuestra propia redaccion.
 */
export function firmarPeticion(
  credencial: Credencial,
  peticion: PeticionFirmable,
  ahora: () => number = Date.now
): PeticionFirmada {
  const timestampMs = peticion.timestampMs ?? ahora();
  const rutaCompleta = `${peticion.ruta}${cadenaConsulta(peticion.consulta)}`;
  const cuerpo = serializarCuerpo(peticion.cuerpo);

  const sign = firmar(
    credencial.secretKey,
    cadenaPrefirma({ timestampMs, metodo: peticion.metodo, rutaCompleta, cuerpo })
  );

  return {
    metodo: peticion.metodo,
    rutaCompleta,
    cuerpo,
    cabeceras: {
      'ACCESS-KEY': credencial.apiKey,
      'ACCESS-SIGN': sign,
      'ACCESS-TIMESTAMP': String(timestampMs),
      'ACCESS-PASSPHRASE': credencial.passphrase,
      'Content-Type': 'application/json',
      locale: 'en-US'
    }
  };
}

/**
 * Cabeceras de una peticion publica (tickers, contratos, hora del servidor).
 *
 * No llevan firma ni tocan credenciales. Existen como funcion aparte para que
 * sea imposible llamar al endpoint publico pasando una credencial por error.
 */
export function cabecerasPublicas(): Record<string, string> {
  return { 'Content-Type': 'application/json', locale: 'en-US' };
}
