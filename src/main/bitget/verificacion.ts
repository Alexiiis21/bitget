/**
 * Verificacion de una credencial antes de darla de alta.
 *
 * Responde a tres preguntas, en este orden, y la primera que falla corta:
 *
 *   1. ¿Bitget la acepta?          -> firma, passphrase, IP, key viva
 *   2. ¿Tiene los permisos justos? -> ni de menos, ni de mas
 *   3. ¿La cuenta puede operar la estrategia? -> cobertura y margen aislado
 *
 * Cumple RF-001: «verificar automaticamente que las credenciales sean validas
 * antes de permitir su utilizacion».
 *
 * ==========================================================================
 * EL PANEL YA NO RECHAZA POR PERMISOS. Decision del cliente, 29/08/2026.
 * ==========================================================================
 * Hasta esa fecha, este archivo era la pieza que sostenia la clausula de
 * credenciales del presupuesto firmado:
 *
 *   «El sistema no solicitara, almacenara ni utilizara permisos de retiro de
 *   fondos.»
 *
 * y la promesa de la Fase 1: «quien obtuviera esas claves no podria sacar un
 * solo dolar de sus cuentas». Eso **ya no es cierto**, y se cambio a peticion
 * expresa del cliente, sabiendo lo que costaba: la funcion de traspasos entre
 * subcuentas -docs/cotizacion-traspasos-entre-subcuentas.md- necesita una clave
 * de la cuenta madre con permiso de traspaso, y el cliente pidio ademas admitir
 * el de retiro.
 *
 * Queda escrito aqui, y no solo en el historial de git, porque quien lea este
 * archivo dentro de un ano tiene que poder distinguir «esto se relajo por
 * descuido» de «esto se relajo porque lo pidieron». Para volver atras basta con
 * `NIVELES_ACEPTADOS` y `ACEPTAR_DESCONOCIDOS`, mas abajo: son las dos lineas
 * que gobiernan toda la politica.
 *
 * --------------------------------------------------------------------------
 * Por que el catalogo sobrevive al cambio
 * --------------------------------------------------------------------------
 * Bitget declara los permisos como codigos opacos de cuatro letras -una key de
 * solo futuros devuelve `["coow","cpow"]`- y no publica su significado. El
 * catalogo nacio para poder rechazar lo que no se entendia; ahora que no se
 * rechaza, sigue sirviendo para **decir en voz alta que puede hacer una clave**.
 * Cada codigo declara su nivel:
 *
 *   `operacion`  opera futuros y lee. No saca un dolar de ningun sitio.
 *   `traspaso`   mueve saldo entre cuentas propias.
 *   `retiro`     saca dinero a un destino externo.
 *
 * Los tres se aceptan. Los dos ultimos, y cualquier codigo sin catalogar,
 * generan una **advertencia** que llega a la pantalla en el momento del alta.
 * Aceptar en silencio seria lo unico peor que rechazar: el operador tiene que
 * enterarse de que acaba de guardar una clave que puede vaciar la cuenta.
 */
import type { ModoMargen, ModoPosicion } from '@shared/types';
import { ErrorBitget } from './errors';
import { MERCADO_REAL, type Mercado } from './mercado';
import type { ClienteBitget } from './rest/client';
import type { Credencial } from './rest/signer';
import { obtenerCuentaSimbolo, obtenerInfoCuenta } from './rest/endpoints/cuenta';

/**
 * Codigos de permiso confirmados contra la API real.
 *
 * Estado: `coow` y `cpow` capturados el 28/07/2026 de una key creada **desde la
 * web** solo con permiso de Futuros. El catalogo se amplia conforme se observen
 * otras combinaciones; lo no listado se acepta con advertencia, y catalogarlo
 * solo mejora lo que se le dice al operador.
 *
 * --------------------------------------------------------------------------
 * `ttow`: por que se cataloga sin que Bitget publique su significado
 * --------------------------------------------------------------------------
 * Observado el 08/08/2026 en diez subcuentas virtuales creadas **por API** con
 * `permList: ["contract_trade"]` y nada mas. Las diez devolvieron
 * `[coow, ttow, cpow]`, mientras que la key equivalente creada a mano en la web
 * devuelve solo `[coow, cpow]`. Es decir: `ttow` es parte de lo que Bitget
 * entiende por «operar futuros» cuando el alta va por API, no un permiso que se
 * haya pedido de mas.
 *
 * Dos comprobaciones independientes sostienen que es inocuo:
 *
 *   1. En la peticion de alta no se pidio transferencia, retiro ni spot. El
 *      unico permiso solicitado fue `contract_trade`.
 *   2. Esas keys se crearon **sin lista blanca de IP**, y Bitget no concede el
 *      permiso de retiro a una key sin IP ligada. Aunque se hubiera pedido, no
 *      habria podido concederse.
 *
 * Sigue siendo una confirmacion por construccion, no una definicion publicada.
 * Antes de operar con dinero real conviene contrastarlo con soporte de Bitget
 * -api@bitget.com- y anotar aqui la respuesta. Ver scripts/ver-permisos.mjs
 * para reproducir la observacion.
 */
/**
 * Que puede hacer un permiso con el dinero. Ver la cabecera del archivo.
 */
export type NivelPermiso = 'operacion' | 'traspaso' | 'retiro';

interface PermisoCatalogado {
  /** Texto para la pantalla de cuentas. */
  descripcion: string;
  nivel: NivelPermiso;
}

const CATALOGO_PERMISOS: Record<string, PermisoCatalogado> = {
  coow: { descripcion: 'Futuros: ordenes', nivel: 'operacion' },
  cpow: { descripcion: 'Futuros: posiciones', nivel: 'operacion' },
  ttow: { descripcion: 'Futuros: operar (alta por API)', nivel: 'operacion' },
  chow: { descripcion: 'Subcuentas: administrar', nivel: 'operacion' }

  /*
   * Los codigos de traspaso y de retiro todavia no se conocen, y **no se
   * inventan**: la clave de la cuenta madre, consultada el 29/08/2026 con
   * `node scripts/ver-permisos.mjs --env MADRE`, devuelve `[coow, cpow, chow]`
   * -hoy no tiene ninguno de los dos, que es justo por lo que el traspaso de
   * prueba fallo con `40014 · need transfer write permissions`-.
   *
   * Desde el cambio de politica **eso ya no bloquea nada**: una clave con esos
   * permisos entra igual, avisando de que trae codigos sin catalogar. Anadirlos
   * aqui cuando aparezcan no cambia quien entra; cambia que la advertencia diga
   * «puede sacar fondos» en vez de «trae un permiso que no reconozco».
   */
};

/**
 * Niveles que el panel acepta.
 *
 * Los tres, por decision del cliente del 29/08/2026. Quitar `retiro` de esta
 * linea vuelve a rechazar las claves que puedan sacar fondos, y quitar tambien
 * `traspaso` deja el panel como estaba antes de la funcion de traspasos.
 */
const NIVELES_ACEPTADOS: ReadonlySet<NivelPermiso> = new Set<NivelPermiso>([
  'operacion',
  'traspaso',
  'retiro'
]);

/**
 * Que hacer con un codigo que no esta en el catalogo.
 *
 * --------------------------------------------------------------------------
 * Por que dejo de rechazar
 * --------------------------------------------------------------------------
 * La lista blanca existia por un argumento concreto: «un codigo que no se sabe
 * interpretar **podria ser el de retiro**, asi que no pasa». Ese argumento se
 * cae solo en cuanto el retiro se acepta a proposito. Ningun permiso de Bitget
 * es peor que sacar el dinero de la cuenta, de modo que seguir rechazando lo
 * desconocido ya no protegia de nada: solo dejaba fuera claves legitimas -la
 * de traspaso, sin ir mas lejos, cuyo codigo nadie ha visto todavia-.
 *
 * Se acepta, pero nunca en silencio: los codigos sin catalogar salen nombrados
 * en una advertencia. Poner esto en `false` restaura el comportamiento de
 * fallar cerrado tal como estaba hasta el 29/08/2026.
 */
const ACEPTAR_DESCONOCIDOS = true;

/**
 * El `parentId` de Bitget, normalizado a cadena.
 *
 * Verificado el 19/08/2026 contra la API real: una subcuenta devuelve
 * `userId: '5476143713'` -cadena- y `parentId: 1513226215` -numero-. Los dos
 * son UIDs y tienen que compararse entre si, asi que aqui se igualan al tipo
 * del primero. Un cero o un ausente significan «no es subcuenta de nadie».
 */
function uidPadreDe(parentId: number | null | undefined): string | null {
  if (typeof parentId !== 'number' || !Number.isFinite(parentId) || parentId <= 0) return null;
  return String(parentId);
}

export type VeredictoCredencial = 'valida' | 'rechazada' | 'invalida';

export type CodigoAdvertencia =
  | 'sin-ip-ligada'
  | 'margen-cruzado'
  | 'modo-unilateral'
  | 'sin-saldo'
  | 'reloj-desviado'
  | 'permiso-traspaso'
  | 'permiso-retiro'
  | 'permiso-desconocido';

export interface Advertencia {
  codigo: CodigoAdvertencia;
  /** Texto para el operador. Describe la consecuencia, no el sintoma. */
  mensaje: string;
}

export interface ResultadoVerificacion {
  /**
   * `valida`     lista para operar.
   * `rechazada`  Bitget la acepta, pero no cumple nuestras reglas de seguridad.
   * `invalida`   Bitget no la acepta.
   */
  veredicto: VeredictoCredencial;
  /** Presente salvo que la credencial ni siquiera autentique. */
  uid: string | null;
  /**
   * UID de la cuenta principal, tal como lo declara Bitget (`parentId`).
   *
   * `null` cuando la credencial no autentica o cuando la cuenta no es subcuenta
   * de nadie. Se guarda **como cadena** aunque Bitget lo envie como numero: es
   * un identificador, no una cantidad, y mezclar los dos tipos haria que
   * `'1513226215' === 1513226215` diera falso justo donde se comparan cuentas.
   */
  uidPadre: string | null;
  esSubcuenta: boolean;
  permisos: string[];
  /** Codigos fuera del catalogo. Si hay alguno, el veredicto es `rechazada`. */
  permisosDesconocidos: string[];
  ipsLigadas: string[];
  modoPosicion: ModoPosicion | null;
  modoMargen: ModoMargen | null;
  apalancamientoLong: number | null;
  apalancamientoShort: number | null;
  /**
   * Apalancamiento en margen cruzado, que es uno solo para los dos lados.
   *
   * Se guarda aparte porque en cruzado Bitget ignora los dos anteriores, y
   * confundirlos daria por bueno un apalancamiento que la cuenta no usa.
   */
  apalancamientoCruzado: number | null;
  saldoDisponible: string | null;
  advertencias: Advertencia[];
  /** Motivo en espanol cuando el veredicto no es `valida`. */
  motivo: string | null;
  /** Codigo crudo del exchange cuando el veredicto es `invalida`. */
  codigoBitget: string | null;
  latenciaMs: number;
}

export interface OpcionesVerificacion {
  /**
   * Mercado en el que se comprueba la cuenta.
   *
   * --------------------------------------------------------------------------
   * Por que no puede quedarse implicito
   * --------------------------------------------------------------------------
   * La verificacion no solo dice si la credencial vale: trae el **saldo** y el
   * **apalancamiento**, y el panel los usa despues para decidir si una apertura
   * cabe. Real y simulado son mercados distintos con saldos distintos, asi que
   * verificar contra `USDT-FUTURES` estando el panel en `SUSDT-FUTURES` guarda
   * un saldo de cero y toda apertura se descarta por «saldo insuficiente»
   * aunque la cuenta tenga fondos simulados de sobra.
   *
   * Detectado el 20/08/2026 por la prueba de QA `test/fisica/qa-panel.test.ts`,
   * que recorre el panel entero: las pruebas del motor no lo veian porque le
   * pasan el mercado a mano.
   */
  mercado?: Mercado;
  /**
   * Simbolo con el que se leen modo de posicion y apalancamiento.
   *
   * Por defecto, el primero del mercado indicado. Solo hace falta darlo para
   * comprobar un activo concreto.
   */
  simbolo?: string;
}

/**
 * Verifica una credencial contra Bitget.
 *
 * No lanza por credencial invalida: eso es un resultado, no una excepcion. Un
 * alta masiva de 100 credenciales necesita seguir con las 99 restantes cuando
 * una falla. Solo propaga errores de transporte reintentables, que no son un
 * veredicto sobre la credencial sino sobre la red.
 */
export async function verificarCredencial(
  cliente: ClienteBitget,
  credencial: Credencial,
  opciones: OpcionesVerificacion = {}
): Promise<ResultadoVerificacion> {
  const mercado = opciones.mercado ?? MERCADO_REAL;
  const simbolo = opciones.simbolo ?? mercado.simbolos[0] ?? 'BTCUSDT';
  const inicio = Date.now();

  const base = (): ResultadoVerificacion => ({
    veredicto: 'invalida',
    uid: null,
    uidPadre: null,
    esSubcuenta: false,
    permisos: [],
    permisosDesconocidos: [],
    ipsLigadas: [],
    modoPosicion: null,
    modoMargen: null,
    apalancamientoLong: null,
    apalancamientoShort: null,
    apalancamientoCruzado: null,
    saldoDisponible: null,
    advertencias: [],
    motivo: null,
    codigoBitget: null,
    latenciaMs: 0
  });

  /* ---- 1. ¿la acepta Bitget? ---- */

  let info;
  try {
    info = await obtenerInfoCuenta(cliente, credencial);
  } catch (e) {
    if (e instanceof ErrorBitget && e.reintentable) throw e;
    const err = e as ErrorBitget;
    return {
      ...base(),
      motivo: err.message,
      codigoBitget: err.codigo,
      latenciaMs: Date.now() - inicio
    };
  }

  const permisos = info.datos.authorities;
  const desconocidos = permisos.filter((p) => !(p in CATALOGO_PERMISOS));
  /* Catalogados, pero de un nivel que la politica no admite. Hoy: ninguno. */
  const vetados = permisos.filter((p) => {
    const catalogado = CATALOGO_PERMISOS[p];
    return catalogado !== undefined && !NIVELES_ACEPTADOS.has(catalogado.nivel);
  });
  const ips = info.datos.ips
    ? info.datos.ips
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : [];

  const parcial: ResultadoVerificacion = {
    ...base(),
    uid: info.datos.userId,
    uidPadre: uidPadreDe(info.datos.parentId),
    esSubcuenta: uidPadreDe(info.datos.parentId) !== null,
    permisos,
    permisosDesconocidos: desconocidos,
    ipsLigadas: ips
  };

  /* ---- 2. ¿permisos justos? ---- */

  if (!ACEPTAR_DESCONOCIDOS && desconocidos.length > 0) {
    return {
      ...parcial,
      veredicto: 'rechazada',
      motivo:
        `La API Key tiene permisos que el panel no reconoce (${desconocidos.join(', ')}). ` +
        'Por seguridad no se acepta: crea la key solo con permiso de Futuros, ' +
        'sin Wallet ni retiros.',
      latenciaMs: Date.now() - inicio
    };
  }

  /*
   * Se comprueba **despues** de los desconocidos y con su propio mensaje.
   *
   * Un codigo desconocido y uno vetado se rechazan igual, pero no se arreglan
   * igual: el primero se cataloga aqui tras averiguar que es, y el segundo hay
   * que quitarlo en Bitget. Un solo mensaje para los dos mandaba al operador a
   * la pantalla equivocada.
   *
   * Con la politica de hoy -los tres niveles aceptados- esto no se dispara. Es
   * el freno que vuelve a funcionar en cuanto se quite un nivel de
   * `NIVELES_ACEPTADOS`, sin tener que reescribir nada.
   */
  if (vetados.length > 0) {
    const nombres = vetados.map((p) => `${p} · ${describirPermiso(p)}`).join(', ');
    return {
      ...parcial,
      veredicto: 'rechazada',
      motivo:
        `La API Key permite sacar fondos (${nombres}). El panel no acepta claves con ` +
        'permiso de retiro. Edita la key en Bitget y quitaselo, o crea una nueva sin el.',
      latenciaMs: Date.now() - inicio
    };
  }

  if (permisos.length === 0) {
    return {
      ...parcial,
      veredicto: 'rechazada',
      motivo: 'La API Key no declara ningun permiso: no podria operar.',
      latenciaMs: Date.now() - inicio
    };
  }

  /* ---- 3. ¿la cuenta puede operar la estrategia? ---- */

  let cuenta;
  try {
    cuenta = await obtenerCuentaSimbolo(
      cliente,
      credencial,
      simbolo,
      mercado.productType,
      mercado.marginCoin
    );
  } catch (e) {
    if (e instanceof ErrorBitget && e.reintentable) throw e;
    const err = e as ErrorBitget;
    return {
      ...parcial,
      motivo: `Autentica, pero no se pudo leer la cuenta de futuros: ${err.message}`,
      codigoBitget: err.codigo,
      latenciaMs: Date.now() - inicio
    };
  }

  const modoPosicion: ModoPosicion =
    cuenta.datos.posMode === 'hedge_mode' ? 'cobertura' : 'unilateral';
  const modoMargen: ModoMargen = cuenta.datos.marginMode === 'isolated' ? 'aislado' : 'cruzado';

  const advertencias: Advertencia[] = [];

  /*
   * Un permiso que mueve dinero se acepta, pero no en silencio.
   *
   * Es la contrapartida de haber quitado el rechazo. La clave deja de ser
   * inocua y quien la da de alta tiene que enterarse **en ese momento**, no el
   * dia que alguien pregunte por que una key de subcuenta podia vaciar la
   * cuenta. Las tres advertencias van por separado porque no se responden
   * igual: al traspaso se le pone IP ligada, al retiro se le quita el permiso,
   * y lo desconocido se cataloga.
   */
  const conNivel = (n: NivelPermiso): string[] =>
    permisos.filter((p) => CATALOGO_PERMISOS[p]?.nivel === n);

  const traspaso = conNivel('traspaso');
  if (traspaso.length > 0) {
    advertencias.push({
      codigo: 'permiso-traspaso',
      mensaje:
        `Esta API Key puede mover saldo entre cuentas (${traspaso.join(', ')}). ` +
        'No puede retirar a un destino externo, pero deja de ser una clave de solo operar: ' +
        'usala solo en la cuenta principal y con IP ligada.'
    });
  }

  const retiro = conNivel('retiro');
  if (retiro.length > 0) {
    advertencias.push({
      codigo: 'permiso-retiro',
      mensaje:
        `Esta API Key PUEDE SACAR FONDOS de la cuenta (${retiro.join(', ')}). ` +
        'Queda guardada cifrada en este equipo, pero quien llegue a ella podria retirar ' +
        'dinero a un destino externo. Usala solo con IP ligada y quitale el permiso en ' +
        'Bitget en cuanto deje de hacer falta.'
    });
  }

  if (desconocidos.length > 0) {
    advertencias.push({
      codigo: 'permiso-desconocido',
      mensaje:
        `Esta API Key trae permisos que el panel no sabe interpretar (${desconocidos.join(', ')}). ` +
        'Se acepta, pero no se puede decir que permiten: comprueba en Bitget que la key ' +
        'solo tenga lo que querias darle.'
    });
  }

  if (modoPosicion !== 'cobertura') {
    advertencias.push({
      codigo: 'modo-unilateral',
      mensaje:
        'La cuenta esta en modo unilateral: no admite LONG y SHORT a la vez. ' +
        'Cambialo a modo cobertura en Bitget, con la cuenta sin posiciones abiertas.'
    });
  }

  /*
   * El modo es de **este simbolo**, no de la cuenta.
   *
   * Se lee del primero del mercado -es el que se consulta para saber el saldo-,
   * y el mensaje lo dice con su nombre en vez de hablar de «la cuenta»: en
   * Bitget cada simbolo tiene el suyo, y dar por cruzada una cuenta entera
   * porque BTC lo esta fue lo que llevo a abrir en cruzado activos que el
   * operador tenia en aislado.
   */
  if (modoMargen !== 'aislado') {
    advertencias.push({
      codigo: 'margen-cruzado',
      mensaje:
        `En esta cuenta, ${simbolo} esta en margen cruzado. El modo de margen es por ` +
        'simbolo: el panel abre en el que se elija en pantalla y lo ajusta antes de enviar ' +
        'la orden, pero sobre una posicion ya abierta en cruzado no se puede agregar margen.'
    });
  }

  if (ips.length === 0) {
    advertencias.push({
      codigo: 'sin-ip-ligada',
      mensaje:
        'La API Key no tiene IP ligada. Funciona, pero si se filtrara seria utilizable ' +
        'desde cualquier sitio.'
    });
  }

  if (Number(cuenta.datos.available) === 0) {
    advertencias.push({
      codigo: 'sin-saldo',
      mensaje: 'La cuenta no tiene saldo disponible: las ordenes se rechazaran por fondos.'
    });
  }

  if (cliente.relojDesviado) {
    advertencias.push({
      codigo: 'reloj-desviado',
      mensaje:
        `El reloj del equipo se desvia ${cliente.desfaseActualMs} ms del de Bitget. ` +
        'Se corrige al firmar, pero conviene sincronizar la hora de Windows.'
    });
  }

  return {
    ...parcial,
    veredicto: 'valida',
    modoPosicion,
    modoMargen,
    apalancamientoLong: cuenta.datos.isolatedLongLever ?? null,
    apalancamientoShort: cuenta.datos.isolatedShortLever ?? null,
    apalancamientoCruzado: cuenta.datos.crossedMarginLeverage ?? null,
    saldoDisponible: cuenta.datos.available,
    advertencias,
    latenciaMs: Date.now() - inicio
  };
}

/** Descripcion legible de un codigo de permiso, para la pantalla de cuentas. */
export function describirPermiso(codigo: string): string {
  return CATALOGO_PERMISOS[codigo]?.descripcion ?? `Permiso desconocido (${codigo})`;
}

/**
 * Nivel de un codigo de permiso. `null` si no esta catalogado.
 *
 * La expone la verificacion para que quien tenga que decidir -la pantalla de
 * cuentas, una prueba- no vuelva a interpretar los codigos por su cuenta.
 */
export function nivelDePermiso(codigo: string): NivelPermiso | null {
  return CATALOGO_PERMISOS[codigo]?.nivel ?? null;
}
