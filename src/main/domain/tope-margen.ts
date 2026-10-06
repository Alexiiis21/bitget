/**
 * Tope de margen inicial: el freno contra el «dedo gordo».
 *
 * --------------------------------------------------------------------------
 * Que problema resuelve
 * --------------------------------------------------------------------------
 * Ningun otro control del panel sabe cuanto quiere arriesgar el operador. Si
 * escribe 5 donde queria 0,5, el saldo alcanza, Bitget acepta la cantidad y la
 * confirmacion ensena una cifra correcta -la que escribio-. Con cien casillas y
 * apalancamiento alto, ese digito de mas se multiplica por las dos cosas.
 *
 * El tope es un numero que el operador fija **antes** de operar, en frio, y que
 * aplica a todo el panel: ninguna apertura puede llevar mas margen inicial por
 * casilla que el tope.
 *
 * --------------------------------------------------------------------------
 * Las reglas, tal como las pidio el cliente
 * --------------------------------------------------------------------------
 *  1. Sin tope no se abre nada. Un panel recien instalado lo pide al entrar.
 *  2. Una vez fijado, **no se puede cambiar durante 24 horas**: ni subir ni
 *     bajar. Esa rigidez es la proteccion: un tope que se puede tocar a mitad
 *     de sesion no frena el error, solo lo retrasa un clic.
 *  3. Pasadas las 24 horas el tope vence, y el panel vuelve a pedirlo antes de
 *     dejar abrir nada.
 *  4. No aplica a «agregar margen»: solo a la apertura.
 *
 * Este modulo es puro -ni red, ni disco, ni reloj propio- para poder razonar
 * sobre el sin levantar nada. Quien lo usa le pasa la hora; de que hora se
 * fia, y por que, se explica en `Sesion.fijarTopeMargen`.
 */
import Decimal from 'decimal.js';
import { TOPE_MARGEN_VIGENCIA_MS } from '@shared/constants';

/** Lo que se guarda, dentro del almacen cifrado. */
export interface TopeMargen {
  /** Margen inicial maximo por casilla, en moneda de margen. Decimal en texto. */
  valor: string;
  /** Instante en que se fijo, en ISO 8601, con la hora de Bitget. */
  fijadoEn: string;
}

export type EstadoTope =
  | { estado: 'sin-tope' }
  | { estado: 'vigente' | 'vencido'; valor: string; fijadoEn: string; venceEn: string };

/** En que punto de su vida esta el tope a una hora dada. */
export function estadoTope(tope: TopeMargen | null, ahoraMs: number): EstadoTope {
  if (tope === null) return { estado: 'sin-tope' };

  const fijadoMs = Date.parse(tope.fijadoEn);
  /*
   * Una fecha ilegible no puede venir de un almacen sano -va cifrado y
   * autenticado-, pero si llegara, se trata como vencido: el panel pide un tope
   * nuevo y no opera con uno del que no sabe nada.
   */
  if (!Number.isFinite(fijadoMs)) {
    return {
      estado: 'vencido',
      valor: tope.valor,
      fijadoEn: tope.fijadoEn,
      venceEn: tope.fijadoEn
    };
  }

  const venceMs = fijadoMs + TOPE_MARGEN_VIGENCIA_MS;
  /*
   * Un reloj que va hacia atras -ahora antes de `fijadoEn`- deja el tope
   * vigente mas tiempo, nunca menos. Es el sentido seguro del error.
   */
  return {
    estado: ahoraMs < venceMs ? 'vigente' : 'vencido',
    valor: tope.valor,
    fijadoEn: tope.fijadoEn,
    venceEn: new Date(venceMs).toISOString()
  };
}

export type ResultadoValor = { ok: true; valor: string } | { ok: false; mensaje: string };

/** Mas decimales que esto no tiene sentido en USDT y suele ser un error de tecleo. */
const DECIMALES_MAX = 8;

/**
 * Valida el numero que escribe el operador como tope.
 *
 * Es estricta a proposito: el tope queda fijo 24 horas, asi que aceptar algo
 * ambiguo -«1.000», «0,5», «1e3»- es aceptar un tope que el operador quiza no
 * quiso. Solo digitos y un punto decimal. La pantalla convierte la coma en
 * punto antes de enviarlo.
 */
export function validarValorTope(texto: string): ResultadoValor {
  const limpio = texto.trim();
  if (!/^\d+(\.\d+)?$/.test(limpio)) {
    return { ok: false, mensaje: 'Escriba el tope como un número, por ejemplo 0.5 o 10.' };
  }

  const valor = new Decimal(limpio);
  if (valor.lessThanOrEqualTo(0)) {
    return { ok: false, mensaje: 'El tope debe ser mayor que cero.' };
  }
  if (valor.decimalPlaces() > DECIMALES_MAX) {
    return { ok: false, mensaje: `El tope admite como mucho ${DECIMALES_MAX} decimales.` };
  }

  return { ok: true, valor: valor.toFixed() };
}

export type MotivoTope = 'sin-tope' | 'tope-vencido' | 'margen-invalido' | 'sobre-tope';

/** Fijar el tope no fue posible. El motivo distingue los casos para la pantalla. */
export class ErrorTope extends Error {
  readonly motivo: 'valor-invalido' | 'tope-vigente' | 'sin-hora';

  constructor(motivo: ErrorTope['motivo'], mensaje: string) {
    super(mensaje);
    this.name = 'ErrorTope';
    this.motivo = motivo;
  }
}

export type ResultadoContraTope = { ok: true } | { ok: false; motivo: MotivoTope; mensaje: string };

/**
 * ¿Puede salir una apertura con este margen inicial por casilla?
 *
 * Lo que falla aqui falla para **todo el lote**, no por casilla: el tope es del
 * panel, asi que si el margen lo supera en una cuenta lo supera en todas.
 */
export function comprobarContraTope(
  margenInicial: string,
  estado: EstadoTope
): ResultadoContraTope {
  if (estado.estado === 'sin-tope') {
    return {
      ok: false,
      motivo: 'sin-tope',
      mensaje: 'Antes de abrir posiciones hay que fijar el margen inicial máximo de este panel.'
    };
  }
  if (estado.estado === 'vencido') {
    return {
      ok: false,
      motivo: 'tope-vencido',
      mensaje:
        'El tope de margen inicial venció: pasaron 24 horas desde que se fijó. ' +
        'Fije uno nuevo antes de abrir posiciones.'
    };
  }

  let margen: Decimal;
  try {
    margen = new Decimal(margenInicial.trim());
  } catch {
    return {
      ok: false,
      motivo: 'margen-invalido',
      mensaje: 'El margen inicial debe ser un número.'
    };
  }
  if (!margen.isFinite()) {
    return {
      ok: false,
      motivo: 'margen-invalido',
      mensaje: 'El margen inicial debe ser un número.'
    };
  }

  if (margen.greaterThan(estado.valor)) {
    return {
      ok: false,
      motivo: 'sobre-tope',
      mensaje:
        `Escribió ${margen.toFixed()} de margen inicial y el tope de este panel es ${estado.valor}. ` +
        'No se envió ninguna orden. El tope no se puede cambiar hasta que pasen 24 horas desde que se fijó.'
    };
  }

  return { ok: true };
}
