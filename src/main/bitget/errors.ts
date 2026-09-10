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
  /*
   * Dos causas distintas bajo el mismo codigo, capturadas las dos.
   *
   *   28/07/2026  falta el permiso de trading en una cuenta clasica.
   *   09/09/2026  «Incorrect permissions, need UTA manage read or UTA manage
   *               write permissions» al llamar a /api/v3/account/settings.
   *
   * El mensaje nombra las dos a proposito, igual que el de `40012`: decir solo
   * «permiso de trading» mandaba a revisar una casilla que ya estaba marcada,
   * teniendo sin marcar la de UTA -que ni siquiera existe en una cuenta
   * clasica-.
   */
  '40014': {
    clase: 'fatal-cuenta',
    mensaje:
      'La API Key no tiene los permisos que pide esta operacion. Revisa en Bitget que ' +
      'tenga Trading y, si la cuenta esta migrada a UTA, tambien «UTA manage read».'
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
  /*
   * Verificado contra la API real el 12/08/2026: el texto de Bitget es «No
   * position to close», no un problema de saldo. Se corrige la traduccion, que
   * venia de la documentacion publica y era enganosa justo en el informe de un
   * cierre. La clase es `omitida` porque no hay nada que arreglar: esa cuenta
   * no tenia posicion abierta, y contarlo como fallo haria que el operador
   * buscara un problema que no existe.
   */
  '22002': { clase: 'omitida', mensaje: 'No habia ninguna posicion abierta que cerrar.' },
  '40754': {
    clase: 'fatal-cuenta',
    mensaje: 'La cuenta no tiene habilitado el trading de futuros.'
  },
  /*
   * Verificado el 13/08/2026 llamando a set-margin sobre una cuenta en margen
   * cruzado: «Parameter verification exception margin mode == FIXED». Bitget
   * solo permite agregar margen en margen aislado, y el texto original no lo
   * dice de forma que un operador pueda actuar.
   */
  '40808': {
    clase: 'fatal-cuenta',
    mensaje:
      'Solo se puede agregar margen en margen aislado, y esta cuenta esta en cruzado. ' +
      'Cambiala a aislado en Bitget.'
  },

  /* ---- parametros: el problema es del lote entero ---- */
  '40034': { clase: 'fatal-lote', mensaje: 'El activo indicado no existe en Bitget.' },
  '40019': { clase: 'fatal-lote', mensaje: 'Falta un parametro obligatorio.' },
  '45110': { clase: 'fatal-lote', mensaje: 'El monto es menor al minimo que exige Bitget.' },
  /*
   * Bitget reutiliza este codigo para dos cosas distintas segun el endpoint:
   * «falta el precio de disparo» en un Take Profit y «apalancamiento por encima
   * del maximo» en set-leverage. Ambas son del parametro, no de la cuenta, asi
   * que la clase es la misma y el mensaje se queda en lo comun.
   */
  '400172': { clase: 'fatal-lote', mensaje: 'Bitget rechazo un parametro de la operacion.' }
};

/**
 * Codigos que significan lo mismo en las dos superficies, por construccion.
 *
 * ==========================================================================
 * Por que existen: un rechazo no siempre es una respuesta
 * ==========================================================================
 * La deteccion de modo pregunta a `/api/v3/account/settings` y lee el rechazo
 * como «esta key no vive en V3, es clasica». Eso es correcto **solo si el
 * rechazo viene de la logica de negocio**. Estos codigos no: se producen antes,
 * al validar el sobre de autenticacion, que es **identico en V2 y en V3** -misma
 * firma, mismas cuatro cabeceras, docs de integracion seccion 2-.
 *
 * Un `40018` no dice nada sobre si la cuenta es UTA: dice que esta IP no puede
 * usar esa clave, en ninguna de las dos APIs. Leerlo como «classic» y seguir a
 * V2 produce un segundo rechazo y un diagnostico que manda al operador a buscar
 * un problema de migracion teniendo un problema de lista blanca.
 *
 * Es exactamente lo que paso el 09/09/2026: la sonda devolvio
 * `40018 · Invalid IP` y tanto el script como el panel lo tomaron por el codigo
 * de superficie equivocada que buscaba la Fase A. No lo era.
 *
 * La lista es **corta a proposito**. Solo entran codigos cuya causa esta en el
 * sobre, no en la cuenta:
 *
 *   40001 40002 40003   falta una cabecera de autenticacion
 *   40005               la passphrase no coincide
 *   40006 40009         la firma no valida
 *   40018               la IP no esta autorizada para esa clave
 *
 * **No** entran `40012`, `40014` ni `40037` aunque lo parezcan: «la key no
 * existe» o «sin permiso» si podrian ser la forma en que V3 rechaza a una clave
 * clasica, y meterlos aqui haria que una cuenta Classic perfectamente valida se
 * diera por invalida. Ante la duda, se prefiere el diagnostico peor al rechazo
 * falso.
 */
const SOBRE_DE_AUTENTICACION = new Set([
  '40001',
  '40002',
  '40003',
  '40005',
  '40006',
  '40009',
  '40018'
]);

/**
 * `true` si el codigo se refiere al sobre de autenticacion y no a la superficie.
 *
 * Quien lo recibe **no debe concluir un modo de cuenta**: no se pudo llegar a
 * preguntar. Ver `SOBRE_DE_AUTENTICACION`.
 */
export function esErrorDeAutenticacion(codigo: string | null): boolean {
  return codigo !== null && SOBRE_DE_AUTENTICACION.has(codigo);
}

/**
 * `true` si V3 rechazo por falta del permiso de UTA. **Prueba que la cuenta es
 * unificada.**
 *
 * ==========================================================================
 * Se mira el mensaje, no solo el codigo, y hay motivo
 * ==========================================================================
 * `40014` tiene dos causas capturadas: falta el permiso de trading -cuenta
 * clasica, 28/07/2026- y falta el permiso de UTA -09/09/2026, «Incorrect
 * permissions, need UTA manage read or UTA manage write permissions»-. El codigo
 * solo no distingue, y confundirlas cuesta caro en las dos direcciones:
 *
 *   leerlo siempre como UTA     daria por unificada una cuenta clasica a la que
 *                               simplemente le falta el permiso de trading
 *   leerlo siempre como clasica es lo que se hacia, y es el fallo del
 *                               09/09/2026: una subcuenta **ya migrada** se
 *                               enrutaba a V2 para siempre
 *
 * La palabra `UTA` en el mensaje es el unico discriminante disponible, y es
 * fiable en un sentido: Bitget no le habla de permisos de UTA a una clave de
 * cuenta clasica, porque ese ambito no existe alli. Si algun dia cambiara el
 * texto, esto deja de reconocerlo y se vuelve al comportamiento anterior
 * -`classic`-, que es el lado seguro de fallar.
 */
export function esPermisoUtaFaltante(codigo: string | null, mensaje: string | null): boolean {
  return codigo === '40014' && /\buta\b/i.test(mensaje ?? '');
}

/**
 * `true` si el codigo esta en el catalogo de arriba.
 *
 * Lo usa la correccion de superficie del motor de lotes. Un codigo catalogado
 * significa que **se sabe** por que fallo -saldo, permisos, parametro- y por
 * tanto que el problema no es la superficie; uno ausente es candidato a serlo,
 * porque hasta la migracion no existian dos superficies y ningun codigo de los
 * 22 significa «esta clave no habla esta API». Ver §4.1 de
 * `docs/00-uta-fase-1-equivalencias.md`.
 */
export function esCodigoCatalogado(codigo: string): boolean {
  return Object.hasOwn(CATALOGO, codigo);
}

/**
 * `true` si Bitget recibio la peticion y la rechazo, con un codigo suyo.
 *
 * ==========================================================================
 * Es la unica forma segura de saber que una escritura NO se ejecuto
 * ==========================================================================
 * Un rechazo de negocio es una respuesta: el exchange leyo la peticion, dijo que
 * no y no hizo nada. Eso autoriza a reenviarla —corregida— sin riesgo de
 * duplicar.
 *
 * Se excluyen dos cosas que tambien llegan como `fatal-cuenta` y que **no**
 * prueban nada de eso:
 *
 *   `ESQUEMA`   Bitget respondio `00000` y el cuerpo no encajo. La operacion
 *               **pudo ejecutarse**; reenviarla la duplicaria.
 *   los codigos de transporte (`ECONNRESET`, `UND_ERR_SOCKET`...) que no son
 *               numericos: ahi no hubo respuesta y el resultado es desconocido.
 *
 * De ahi que se exija un codigo puramente numerico, que es la forma de todos los
 * codigos de negocio de Bitget y de los estados HTTP.
 */
export function esRechazoDeNegocio(error: ErrorBitget): boolean {
  return error.codigo !== null && /^\d+$/.test(error.codigo);
}

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
