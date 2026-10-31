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
import type { AccountMode, HoldMode, ModoMargen, ModoPosicion } from '@shared/types';
import { anotarEvento, cuentaDe } from '../diagnostico/bitacora';
import { detectarModo, type ResultadoDeteccion } from './deteccion-modo';
import { clasificarCodigo, ErrorBitget } from './errors';
import { MERCADO_REAL, type Mercado } from './mercado';
import type { ClienteBitget } from './rest/client';
import type { Credencial } from './rest/signer';
import { obtenerCuentaSimbolo, obtenerInfoCuenta } from './rest/endpoints/cuenta';
import { obtenerActivosCuenta, saldoDeFotoCompleta } from './rest/endpoints/ajustes-v3';

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
  chow: { descripcion: 'Subcuentas: administrar', nivel: 'operacion' },

  /*
   * --------------------------------------------------------------------------
   * `wtow` y `stow`: catalogados el 05/09/2026, y por observacion directa
   * --------------------------------------------------------------------------
   * Estuvieron sin catalogar mientras no hubo forma de saber que eran: Bitget no
   * publica el significado de estos codigos, y la clave de la madre no tenia
   * permiso de traspaso -devolvia `[coow, cpow, chow]`- asi que no habia con que
   * comparar.
   *
   * Ese dia el operador amplio los permisos de esa misma clave y capturo la
   * pantalla de Bitget junto a la respuesta de la API. Las dos listas, una al
   * lado de la otra:
   *
   *   API    [coow, wtow, cpow, chow, stow]
   *   Web     Futures|Orders · Futures|Holdings · Spot|Trade ·
   *           Sub-accounts|Manage · Wallet|Transfer
   *
   * Los tres conocidos ya ocupaban Futures y Sub-accounts, asi que los dos
   * nuevos solo pueden ser los dos que se anadieron. Y el traspaso, que hasta
   * entonces fallaba con `40014 · need transfer write permissions`, empezo a
   * funcionar ese mismo dia: `wtow` es el de mover saldo.
   *
   * `stow` es spot, que el panel no usa: se cataloga igual, para que la
   * advertencia diga que permiso trae de mas en vez de callarlo.
   *
   * **El retiro sigue sin catalogar, y esta bien que asi sea.** No aparecio
   * ningun codigo nuevo porque esa casilla no se marco, que es justo lo que el
   * presupuesto promete: el sistema no solicitara ni utilizara permisos de
   * retiro. El dia que alguien cree una clave con retiro saldra un sexto codigo
   * desconocido y el panel lo dira; inventarlo hoy seria arriesgarse a etiquetar
   * de inocuo el unico permiso que no lo es.
   */
  wtow: { descripcion: 'Monedero: traspasos entre cuentas propias', nivel: 'traspaso' },
  stow: { descripcion: 'Spot: operar (el panel no lo usa)', nivel: 'operacion' }
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
  | 'permiso-desconocido'
  /** Cuenta UTA: se opera por V3 y hay datos que esa API todavia no da. */
  | 'cuenta-uta';

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
  /**
   * Con que API habla la cuenta, segun la deteccion.
   *
   * `null` cuando no se pudo concluir -un corte de red durante la
   * verificacion-. Es distinto de `'classic'`: quien persista esto tiene que
   * ignorar el `null` en vez de degradar la cuenta, o una caida de red
   * convertiria una cuenta UTA en clasica y la dejaria muda.
   */
  accountMode: AccountMode | null;
  /** Solo lo informa V3. `null` en cuentas clasicas. */
  holdMode: HoldMode | null;
  /**
   * `true` si Bitget declara la cuenta a mitad del cambio a UTA.
   *
   * Se distingue del resto de rechazos porque **se arregla solo**: no hay nada
   * que corregir, solo esperar. Quien lo reciba debe dejar de operar esa
   * subcuenta y volver a preguntar, no pedirle al operador que revise la clave.
   */
  enTransicion: boolean;
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
 * Verificacion de una cuenta UTA, por V3.
 *
 * ==========================================================================
 * Por que es mas corta que la clasica, y que se pierde
 * ==========================================================================
 * La verificacion clasica responde tres preguntas leyendo dos endpoints de V2.
 * En V3 solo se puede responder la primera y media:
 *
 *   ¿la acepta Bitget?   si: `account/settings` respondio, o no estariamos aqui.
 *   ¿permisos justos?    **no se puede saber**. `authorities` e `ips` salen hoy
 *                        de `/api/v2/spot/account/info`, y V3 no publica
 *                        equivalente conocido. Es el hueco 2.4 del Paquete A.
 *   ¿puede operar?       si: `holdMode` y `symbolConfigList` lo dicen, y con
 *                        mas precision que V2 -la lista trae todos los simbolos
 *                        en vez de uno por peticion-.
 *
 * De modo que la cuenta se acepta, pero **nunca en silencio**: sale con una
 * advertencia `cuenta-uta` que nombra lo que no se ha podido comprobar. Callarlo
 * daria por auditada una clave cuyos permisos nadie ha visto.
 */
/**
 * Mensaje de una credencial que rechazaron **las dos** superficies.
 *
 * El de V2 es el que manda —es el que llevaba el veredicto hasta ahora— y se le
 * anade lo que dijo V3, que es la mitad que faltaba. Cuando V3 respondio bien
 * pero su respuesta no encajo con el esquema, se dice explicitamente: esa cuenta
 * **es** UTA y el panel la esta tratando como clasica por un nombre de campo,
 * que es un problema del panel y no de la clave.
 */
function motivoDobleRechazo(err: ErrorBitget, codigoV3: string | null): string {
  if (codigoV3 === 'ESQUEMA') {
    return (
      'Esta cuenta parece ser UTA: la API V3 respondió correctamente, pero el panel no supo ' +
      'leer su respuesta y la trató como cuenta clásica. Es un fallo del panel, no de la ' +
      `clave. (V2 respondió: ${err.message})`
    );
  }

  if (codigoV3 === null) return err.message;

  return (
    `${err.message} La API V3 también la rechazó (código ${codigoV3}), así que el panel la ` +
    'tomó por cuenta clásica. Si la cuenta ya está migrada a UTA, revise que la clave sea de ' +
    'esa subcuenta y que su IP esté autorizada.'
  );
}

async function verificarUta(
  cliente: ClienteBitget,
  credencial: Credencial,
  deteccion: ResultadoDeteccion,
  mercado: Mercado,
  simbolo: string,
  inicio: number
): Promise<ResultadoVerificacion> {
  const advertencias: Advertencia[] = [
    {
      codigo: 'cuenta-uta',
      mensaje:
        'Esta cuenta esta en modo UTA y se opera por la API V3. El panel no puede leer sus ' +
        'permisos ni su IP ligada por esa via, asi que compruebalos en Bitget: la clave deberia ' +
        'tener solo Futuros, sin retiro.'
    }
  ];

  /*
   * `holdMode` es el `posMode` de V2 con otro nombre, y decide lo mismo: si la
   * cuenta admite LONG y SHORT a la vez. Un `null` -V3 no lo informo- se trata
   * como cobertura, que es como opera el panel; suponer unilateral haria que
   * las ordenes salieran sin `posSide` y cruzaria los lados.
   */
  const modoPosicion: ModoPosicion =
    deteccion.holdMode === 'one_way_mode' ? 'unilateral' : 'cobertura';

  const config =
    deteccion.configSimbolos.find((c) => c.symbol === simbolo) ?? deteccion.configSimbolos[0];
  const modoMargen: ModoMargen = config?.marginMode === 'isolated' ? 'aislado' : 'cruzado';

  /*
   * El saldo se lee aparte y su fallo **no invalida la credencial**: es un dato
   * informativo que el barrido refresca cada 45 s. Tumbar el alta de una cuenta
   * buena porque el balance no se pudo leer seria desproporcionado.
   */
  let saldoDisponible: string | null = null;
  try {
    const activos = await obtenerActivosCuenta(cliente, { ...credencial, superficie: 'v3' });
    saldoDisponible = saldoDeFotoCompleta(activos.datos, mercado.marginCoin);
  } catch (e) {
    if (e instanceof ErrorBitget && e.reintentable) throw e;
    /* Se sigue sin saldo: la credencial ya demostro que autentica. */
  }

  if (modoPosicion !== 'cobertura') {
    advertencias.push({
      codigo: 'modo-unilateral',
      mensaje:
        'La cuenta esta en modo unilateral: no admite LONG y SHORT a la vez. ' +
        'Cambialo a modo cobertura en Bitget, con la cuenta sin posiciones abiertas.'
    });
  }

  if (saldoDisponible !== null && Number(saldoDisponible) === 0) {
    advertencias.push({
      codigo: 'sin-saldo',
      mensaje: 'La cuenta no tiene saldo disponible: las ordenes se rechazaran por fondos.'
    });
  }

  return {
    veredicto: 'valida',
    uid: deteccion.uid,
    /* V3 no declara `parentId`. Se rellenara si algun dia lo publica. */
    uidPadre: null,
    esSubcuenta: false,
    permisos: [],
    permisosDesconocidos: [],
    ipsLigadas: [],
    modoPosicion,
    modoMargen,
    apalancamientoLong: null,
    apalancamientoShort: null,
    apalancamientoCruzado: config?.leverage == null ? null : Number(config.leverage),
    saldoDisponible,
    advertencias,
    motivo: null,
    codigoBitget: null,
    accountMode: 'uta',
    holdMode: deteccion.holdMode,
    enTransicion: false,
    latenciaMs: Date.now() - inicio
  };
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
  let r: ResultadoVerificacion;
  try {
    r = await verificarSinAnotar(cliente, credencial, opciones);
  } catch (e) {
    anotarEvento({
      evento: 'verificacion-credencial',
      datos: {
        cuenta: cuentaDe(credencial.apiKey),
        veredicto: 'error-reintentable',
        codigoBitget: e instanceof ErrorBitget ? e.codigo : null,
        mensaje: e instanceof Error ? e.message.slice(0, 200) : null
      }
    });
    throw e;
  }

  /*
   * El toast del panel solo enseña el codigo. Esta linea es la que dice, sin
   * reproducir el fallo, por que superficie se fue y en que paso se corto.
   */
  anotarEvento({
    evento: 'verificacion-credencial',
    datos: {
      cuenta: cuentaDe(credencial.apiKey),
      veredicto: r.veredicto,
      accountMode: r.accountMode,
      holdMode: r.holdMode,
      enTransicion: r.enTransicion,
      codigoBitget: r.codigoBitget,
      motivo: r.motivo?.slice(0, 300) ?? null,
      advertencias: r.advertencias.map((a) => a.codigo).join(','),
      latenciaMs: r.latenciaMs
    }
  });
  return r;
}

async function verificarSinAnotar(
  cliente: ClienteBitget,
  credencial: Credencial,
  opciones: OpcionesVerificacion
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
    accountMode: null,
    holdMode: null,
    enTransicion: false,
    latenciaMs: 0
  });

  /* ---- 0. ¿con que API habla esta cuenta? ---- */

  /*
   * Va primero por necesidad, no por orden estetico: los tres pasos siguientes
   * llaman a endpoints de V2, y una key de cuenta UTA los recibe rechazados.
   * Sin este paso, toda subcuenta migrada se daria de alta como «invalida» y el
   * operador iria a buscar un problema de credenciales que no existe.
   *
   * `detectarModo` lanza ante un fallo reintentable -red, 429-, y aqui se deja
   * subir igual que en los otros dos pasos: no es un veredicto sobre la
   * credencial, es que no se pudo preguntar.
   */
  const deteccion = await detectarModo(cliente, credencial);

  if (deteccion.modo === 'transicion') {
    return {
      ...base(),
      veredicto: 'rechazada',
      uid: deteccion.uid,
      accountMode: null,
      enTransicion: true,
      motivo:
        'La cuenta esta cambiando de modelo en Bitget y no admite operaciones mientras dura ' +
        `el cambio (estado «${deteccion.accountModeCrudo ?? 'desconocido'}»). ` +
        'Vuelve a validarla en unos minutos.',
      latenciaMs: Date.now() - inicio
    };
  }

  /*
   * ==========================================================================
   * No se pudo preguntar: el problema es la clave, no la superficie
   * ==========================================================================
   * `indeterminado` significa que V3 rechazo el **sobre de autenticacion** -IP
   * no autorizada, firma o passphrase-, y eso es identico en las dos
   * superficies. Seguir a V2 gastaria una peticion para cosechar el mismo
   * rechazo con otro codigo y ensenar ese, que es como el operador acaba
   * revisando una migracion teniendo un problema de lista blanca.
   *
   * Se corta aqui y se dice lo que Bitget dijo. `accountMode` queda `null` -no
   * se sabe- y `actualizarModos` ignora los nulos, asi que una cuenta ya
   * detectada como UTA **no se degrada a clasica** por un corte de este tipo.
   */
  if (deteccion.modo === 'indeterminado') {
    const codigo = deteccion.codigoRechazo;
    return {
      ...base(),
      veredicto: 'invalida',
      accountMode: null,
      /*
       * `esUta` cambia por completo lo que hay que decirle al operador: no es
       * que la credencial sea mala, es que su cuenta **si** esta migrada y a la
       * clave le falta el ambito de UTA. Sin esta rama, el mensaje generico le
       * mandaba a revisar la clave entera.
       */
      motivo:
        deteccion.esUta === true
          ? 'Esta subcuenta ya está migrada a UTA, pero la API Key no tiene el permiso ' +
            '«UTA manage read». Habilítelo en Bitget para esa clave y vuelva a validarla.'
          : deteccion.accountModeCrudo !== null
            ? `Bitget informa un tipo de cuenta que el panel no reconoce («${deteccion.accountModeCrudo}»), ` +
              'así que no se opera con ella hasta saber por qué API debe ir.'
            : codigo === null
              ? 'Bitget rechazó la credencial y no se pudo determinar el tipo de cuenta.'
              : `${clasificarCodigo(codigo).mensaje} Afecta por igual a las dos APIs de Bitget, ` +
                'así que no es un problema de la migración a UTA.',
      codigoBitget: codigo,
      latenciaMs: Date.now() - inicio
    };
  }

  if (deteccion.modo === 'uta') {
    return verificarUta(cliente, credencial, deteccion, mercado, simbolo, inicio);
  }

  /* ---- 1. ¿la acepta Bitget? ---- */

  let info;
  try {
    info = await obtenerInfoCuenta(cliente, credencial);
  } catch (e) {
    if (e instanceof ErrorBitget && e.reintentable) throw e;
    const err = e as ErrorBitget;
    return {
      ...base(),
      /* La deteccion ya concluyo: V3 la rechazo, asi que es clasica. */
      accountMode: 'classic',
      /*
       * ======================================================================
       * Las dos superficies la rechazaron: hay que decirlo
       * ======================================================================
       * Aqui se llega cuando V3 dijo que no -por eso se dio por clasica- y V2
       * tambien. Ensenar solo el codigo de V2 manda al operador a revisar una
       * clave que puede estar perfectamente bien y ser de una cuenta UTA que el
       * panel no supo reconocer.
       *
       * Es exactamente lo que paso el 09/09/2026: `40085` a secas, sin ninguna
       * pista de que antes se habia intentado V3 ni de con que contesto.
       */
      motivo: motivoDobleRechazo(err, deteccion.codigoRechazo),
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
    ipsLigadas: ips,
    accountMode: 'classic'
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
