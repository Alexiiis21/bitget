/**
 * Errores de Bitget: clasificacion y traduccion.
 *
 * Este archivo responde a una sola pregunta, y de su respuesta depende que no
 * se abran posiciones duplicadas con dinero real:
 *
 *   ante este fallo, ¿se puede reintentar?
 *
 * Cuatro clases, no dos. docs/01 seccion 9.
 *
 *   retryable      fallo transitorio y seguro. Reintento automatico, max. 3.
 *   fatal-cuenta   esa cuenta no puede continuar. El lote sigue con las demas.
 *   fatal-lote     el problema esta en los parametros. No sale ni una orden.
 *   omitida        no aplicable a esa cuenta. No cuenta como fallo.
 *   indeterminada  se envio y no hubo respuesta. NUNCA se reintenta: se consulta.
 *
 * Dos reglas de las que no se puede salir:
 *
 *  1. Ante un codigo desconocido, la respuesta por defecto es `fatal-cuenta`,
 *     jamas `retryable`. Reintentar algo que no entendemos es la forma de
 *     duplicar una orden. Falla esa cuenta, el operador lo ve, y el codigo se
 *     anade al catalogo.
 *  2. Un corte despues de enviar solo es `retryable` si la peticion era
 *     idempotente -una consulta-. Si era una orden, es `indeterminada`, y se
 *     resuelve preguntando por su clientOid.
 */

export type ClaseError = 'retryable' | 'fatal-cuenta' | 'fatal-lote' | 'omitida' | 'indeterminada';

/** Codigo que devuelve Bitget cuando todo fue bien. */
export const CODIGO_EXITO = '00000';

export interface DatosErrorBitget {
  clase: ClaseError;
  /** Codigo crudo del exchange, o `null` si el fallo fue de transporte. */
  codigo: string | null;
  /** Texto crudo del exchange, sin traducir. Va al log, no a la pantalla. */
  mensajeOriginal: string | null;
  /** Estado HTTP, o `null` si la respuesta no llego a existir. */
  httpStatus: number | null;
  /** Segundos que pide esperar el exchange ante un 429. */
  reintentarEnMs: number | null;
}

/**
 * Error de una peticion a Bitget, ya clasificado.
 *
 * `message` va en espanol y es lo que ve el operador: describe que hacer, no
 * que fallo por dentro.
 */
export class ErrorBitget extends Error {
  readonly clase: ClaseError;
  readonly codigo: string | null;
  readonly mensajeOriginal: string | null;
  readonly httpStatus: number | null;
  readonly reintentarEnMs: number | null;

  constructor(mensaje: string, datos: DatosErrorBitget) {
    super(mensaje);
    this.name = 'ErrorBitget';
    this.clase = datos.clase;
    this.codigo = datos.codigo;
    this.mensajeOriginal = datos.mensajeOriginal;
    this.httpStatus = datos.httpStatus;
    this.reintentarEnMs = datos.reintentarEnMs;
  }

  get reintentable(): boolean {
    return this.clase === 'retryable';
  }
}

/**
 * Catalogo de codigos conocidos.
 *
 * Estado de verificacion: construido a partir de la documentacion publica de
 * Bitget. Cada entrada se confirma contra la API real conforme se ejercitan
 * los endpoints, y el catalogo se amplia en la fase 5 con lo que aparezca en
 * pruebas. Un codigo ausente de esta tabla no rompe nada: cae en el default
 * seguro (`fatal-cuenta`) y queda registrado con su texto original.
 */
const CATALOGO: Record<string, { clase: ClaseError; mensaje: string }> = {
  /* ---- credenciales y permisos: fallan la cuenta, no el lote ---- */
  '40001': { clase: 'fatal-cuenta', mensaje: 'Falta la API Key en la peticion.' },
  '40002': { clase: 'fatal-cuenta', mensaje: 'Falta la firma en la peticion.' },
  '40003': { clase: 'fatal-cuenta', mensaje: 'Falta la marca de tiempo en la peticion.' },
  '40005': { clase: 'fatal-cuenta', mensaje: 'La passphrase no coincide con la API Key.' },
  '40006': { clase: 'fatal-cuenta', mensaje: 'Firma invalida. Revisa la Secret Key.' },
  '40009': { clase: 'fatal-cuenta', mensaje: 'Firma invalida. Revisa la Secret Key.' },
  /*
   * Verificado contra la API real el 28/07/2026: Bitget devuelve 40012 tanto
   * para una key inexistente como para una **passphrase equivocada**. El
   * mensaje nombra las dos causas a proposito; decir solo «no existe» mandaba
   * al operador a buscar una key borrada teniendo el problema en otro campo.
   */
  '40012': {
    clase: 'fatal-cuenta',
    mensaje: 'La API Key no existe, o la passphrase no coincide con ella.'
  },
  '40014': {
    clase: 'fatal-cuenta',
    mensaje: 'La API Key no tiene permiso de trading. Habilitalo en Bitget.'
  },
  '40018': {
    clase: 'fatal-cuenta',
    mensaje: 'Esta IP no esta autorizada para la API Key. Anadela a la lista blanca en Bitget.'
  },
  '40037': { clase: 'fatal-cuenta', mensaje: 'La API Key no existe.' },

  /* ---- reloj: se corrige solo, conviene reintentar ---- */
  '40008': {
    clase: 'retryable',
    mensaje: 'La marca de tiempo expiro. Se reintenta con el reloj corregido.'
  },

  /* ---- limites del exchange: transitorios ---- */
  '429': { clase: 'retryable', mensaje: 'El exchange esta limitando las peticiones.' },
  '40725': { clase: 'retryable', mensaje: 'El servicio de Bitget esta ocupado.' },
  '45001': { clase: 'retryable', mensaje: 'Fallo temporal del exchange.' },

  /* ---- estado de la cuenta: fallan esa cuenta ---- */
  '43012': { clase: 'fatal-cuenta', mensaje: 'Saldo insuficiente en la cuenta.' },
  '22002': { clase: 'fatal-cuenta', mensaje: 'Saldo insuficiente en la cuenta.' },
  '40754': {
    clase: 'fatal-cuenta',
    mensaje: 'La cuenta no tiene habilitado el trading de futuros.'
  },

  /* ---- parametros: el problema es del lote entero ---- */
  '40034': { clase: 'fatal-lote', mensaje: 'El activo indicado no existe en Bitget.' },
  '40019': { clase: 'fatal-lote', mensaje: 'Falta un parametro obligatorio.' },
  '45110': { clase: 'fatal-lote', mensaje: 'El monto es menor al minimo que exige Bitget.' }
};

/** Traduccion y clase de un codigo del exchange. */
export function clasificarCodigo(codigo: string): { clase: ClaseError; mensaje: string } {
  return (
    CATALOGO[codigo] ?? {
      clase: 'fatal-cuenta',
      mensaje: `Bitget rechazo la operacion (codigo ${codigo}).`
    }
  );
}

/** Construye el error a partir de una respuesta con codigo distinto de 00000. */
export function errorDeRespuesta(
  codigo: string,
  mensajeOriginal: string,
  httpStatus: number,
  reintentarEnMs: number | null = null
): ErrorBitget {
  const { clase, mensaje } = clasificarCodigo(codigo);
  return new ErrorBitget(mensaje, {
    clase,
    codigo,
    mensajeOriginal,
    httpStatus,
    reintentarEnMs
  });
}

/**
 * Codigos de undici y del sistema que indican un fallo **antes** de que la
 * peticion saliera. Estos son siempre seguros de reintentar, incluso una orden:
 * no se envio nada.
 */
const FALLOS_ANTES_DE_ENVIAR = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'CERT_HAS_EXPIRED',
  'UND_ERR_DESTROYED'
]);

/**
 * Codigos que aparecen cuando la conexion se corta con la peticion ya en vuelo.
 * Aqui esta la frontera del dinero: la orden pudo haber entrado.
 */
const FALLOS_DESPUES_DE_ENVIAR = new Set([
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_ABORTED'
]);

/**
 * Clasifica un fallo de transporte -sin respuesta del exchange-.
 *
 * `idempotente` lo declara quien llama: `true` en consultas, `false` en toda
 * orden de trading. No se infiere del metodo HTTP, porque un POST puede ser
 * una consulta y confundirlos costaria una posicion duplicada.
 */
export function errorDeTransporte(causa: unknown, idempotente: boolean): ErrorBitget {
  const codigo = extraerCodigoSistema(causa);
  const detalle = causa instanceof Error ? causa.message : String(causa);

  if (codigo !== null && FALLOS_ANTES_DE_ENVIAR.has(codigo)) {
    return new ErrorBitget('No se pudo conectar con Bitget. Se reintenta.', {
      clase: 'retryable',
      codigo,
      mensajeOriginal: detalle,
      httpStatus: null,
      reintentarEnMs: null
    });
  }

  const enVuelo = codigo !== null && FALLOS_DESPUES_DE_ENVIAR.has(codigo);

  if (enVuelo && !idempotente) {
    return new ErrorBitget(
      'Se envio la orden y no llego respuesta. Hay que verificar si entro antes de repetirla.',
      {
        clase: 'indeterminada',
        codigo,
        mensajeOriginal: detalle,
        httpStatus: null,
        reintentarEnMs: null
      }
    );
  }

  if (enVuelo) {
    return new ErrorBitget('Se corto la conexion con Bitget. Se reintenta la consulta.', {
      clase: 'retryable',
      codigo,
      mensajeOriginal: detalle,
      httpStatus: null,
      reintentarEnMs: null
    });
  }

  /*
   * Fallo no reconocido. Si era una orden no se toca; si era una consulta,
   * reintentar es inocuo.
   */
  return new ErrorBitget(
    idempotente
      ? 'Fallo la comunicacion con Bitget. Se reintenta la consulta.'
      : 'Fallo la comunicacion con Bitget. Hay que verificar si la orden entro.',
    {
      clase: idempotente ? 'retryable' : 'indeterminada',
      codigo,
      mensajeOriginal: detalle,
      httpStatus: null,
      reintentarEnMs: null
    }
  );
}

/** Clasifica una respuesta HTTP que no trae cuerpo interpretable. */
export function errorDeHttp(httpStatus: number, cuerpo: string, idempotente: boolean): ErrorBitget {
  if (httpStatus === 429) {
    return new ErrorBitget('El exchange esta limitando las peticiones.', {
      clase: 'retryable',
      codigo: '429',
      mensajeOriginal: cuerpo,
      httpStatus,
      reintentarEnMs: null
    });
  }

  if (httpStatus >= 500) {
    return new ErrorBitget('Bitget devolvio un error de servidor.', {
      clase: idempotente ? 'retryable' : 'indeterminada',
      codigo: String(httpStatus),
      mensajeOriginal: cuerpo,
      httpStatus,
      reintentarEnMs: null
    });
  }

  if (httpStatus === 401 || httpStatus === 403) {
    return new ErrorBitget('Bitget rechazo las credenciales de esta cuenta.', {
      clase: 'fatal-cuenta',
      codigo: String(httpStatus),
      mensajeOriginal: cuerpo,
      httpStatus,
      reintentarEnMs: null
    });
  }

  return new ErrorBitget(`Bitget respondio con un error HTTP ${httpStatus}.`, {
    clase: 'fatal-cuenta',
    codigo: String(httpStatus),
    mensajeOriginal: cuerpo,
    httpStatus,
    reintentarEnMs: null
  });
}

/** Error de forma: la respuesta no encaja con el esquema esperado. */
export function errorDeEsquema(ruta: string, detalle: string): ErrorBitget {
  return new ErrorBitget(
    'Bitget respondio en un formato inesperado. Puede haber cambiado su API.',
    {
      clase: 'fatal-cuenta',
      codigo: 'ESQUEMA',
      mensajeOriginal: `${ruta}: ${detalle}`,
      httpStatus: null,
      reintentarEnMs: null
    }
  );
}

function extraerCodigoSistema(causa: unknown): string | null {
  if (typeof causa !== 'object' || causa === null) return null;

  const directo = (causa as { code?: unknown }).code;
  if (typeof directo === 'string') return directo;

  /* undici anida el motivo real en `cause`. */
  const anidada = (causa as { cause?: unknown }).cause;
  if (anidada !== undefined && anidada !== causa) return extraerCodigoSistema(anidada);

  return null;
}
