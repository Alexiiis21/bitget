/**
 * Verificacion de una credencial antes de darla de alta.
 *
 * Responde a tres preguntas, en este orden, y la primera que falla corta:
 *
 *   1. ¿Bitget la acepta?          -> firma, passphrase, IP, key viva
 *   2. ¿Tiene los permisos justos? -> ni de menos, ni de mas
 *   3. ¿La cuenta puede operar la estrategia? -> cobertura y margen aislado
 *
 * Cumple RF-001 («verificar automaticamente que las credenciales sean validas
 * antes de permitir su utilizacion») y la clausula de credenciales del
 * presupuesto: el sistema no utiliza ni acepta permisos de retiro.
 *
 * --------------------------------------------------------------------------
 * Sobre el permiso de retiro: por que lista blanca y no lista negra
 * --------------------------------------------------------------------------
 * docs/03 §5 preveia «consultar el permiso y rechazar cualquier key con
 * permiso de retiro habilitado». Al implementarlo aparecio que Bitget declara
 * los permisos como codigos opacos de cuatro letras -una key de solo futuros
 * devuelve `["coow","cpow"]`- y no publica su significado.
 *
 * Con codigos que no se pueden interpretar, una lista negra **falla abierta**:
 * un codigo de retiro que no estuviera en la lista pasaria la verificacion sin
 * que nadie se enterase. Por eso se invierte: solo se aceptan los codigos
 * confirmados como inocuos, y **cualquier codigo desconocido rechaza la
 * credencial**. Falla cerrado.
 *
 * Es la misma regla que ya gobierna bitget/errors.ts: ante lo desconocido, la
 * respuesta segura, nunca la comoda. El coste es que una key con permisos
 * legitimos aun no catalogados se rechaza y hay que anadir su codigo aqui; el
 * beneficio es que ninguna key con permiso de retiro entra por descuido.
 */
import type { ModoMargen, ModoPosicion } from '@shared/types';
import { trazaSaldo } from '../debug-saldo';
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
 * otras combinaciones; hasta entonces, lo no listado se rechaza.
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
const PERMISOS_ACEPTADOS: Record<string, string> = {
  coow: 'Futuros: ordenes',
  cpow: 'Futuros: posiciones',
  ttow: 'Futuros: operar (alta por API)',
  chow: 'Subcuentas: administrar'
};

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
  'sin-ip-ligada' | 'margen-cruzado' | 'modo-unilateral' | 'sin-saldo' | 'reloj-desviado';

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
  const desconocidos = permisos.filter((p) => !(p in PERMISOS_ACEPTADOS));
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

  if (desconocidos.length > 0) {
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
    /* DEPURACIÓN TEMPORAL · ver src/main/debug-saldo.ts */
    trazaSaldo('1·consulta', {
      uid: parcial.uid,
      mercado: mercado.clave,
      simbolo,
      productType: mercado.productType,
      marginCoin: mercado.marginCoin
    });
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
    /* DEPURACIÓN TEMPORAL */
    trazaSaldo('1·consulta FALLÓ', {
      uid: parcial.uid,
      codigo: err.codigo,
      motivo: err.message
    });
    return {
      ...parcial,
      motivo: `Autentica, pero no se pudo leer la cuenta de futuros: ${err.message}`,
      codigoBitget: err.codigo,
      latenciaMs: Date.now() - inicio
    };
  }

  /* DEPURACIÓN TEMPORAL · lo que Bitget respondio, antes de interpretarlo */
  trazaSaldo('2·respuesta', {
    uid: parcial.uid,
    available: cuenta.datos.available,
    accountEquity: cuenta.datos.accountEquity,
    marginCoin: cuenta.datos.marginCoin,
    marginMode: cuenta.datos.marginMode,
    posMode: cuenta.datos.posMode
  });

  const modoPosicion: ModoPosicion =
    cuenta.datos.posMode === 'hedge_mode' ? 'cobertura' : 'unilateral';
  const modoMargen: ModoMargen = cuenta.datos.marginMode === 'isolated' ? 'aislado' : 'cruzado';

  const advertencias: Advertencia[] = [];

  if (modoPosicion !== 'cobertura') {
    advertencias.push({
      codigo: 'modo-unilateral',
      mensaje:
        'La cuenta esta en modo unilateral: no admite LONG y SHORT a la vez. ' +
        'Cambialo a modo cobertura en Bitget, con la cuenta sin posiciones abiertas.'
    });
  }

  if (modoMargen !== 'aislado') {
    advertencias.push({
      codigo: 'margen-cruzado',
      mensaje:
        'La cuenta esta en margen cruzado: la funcion de agregar margen no estara ' +
        'disponible, porque Bitget solo la permite en margen aislado.'
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
  return PERMISOS_ACEPTADOS[codigo] ?? `Permiso desconocido (${codigo})`;
}
