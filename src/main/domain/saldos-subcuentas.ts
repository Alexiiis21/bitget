/**
 * La pantalla de saldos: que se puede mover, y desde donde.
 *
 * Fase 2 de docs/presupuesto-traspaso-subcuentas.md. Cruza dos listas que no
 * tienen por que coincidir:
 *
 *   - lo que **Bitget** reporta como subcuentas de la madre;
 *   - lo que el **panel** tiene dado de alta con credencial propia.
 *
 * ==========================================================================
 * Por que las dos listas se muestran, y no solo su interseccion
 * ==========================================================================
 * Un traspaso se firma con la clave de la **madre** e identifica origen y
 * destino por UID. No necesita la credencial de la subcuenta. De ahi una
 * consecuencia que conviene tener presente antes de disenar la pantalla: se
 * puede mover saldo a una subcuenta que el panel no opera, y esconderla seria
 * ocultar dinero que existe.
 *
 * Al reves tambien importa: una cuenta dada de alta en el panel que la madre no
 * reporta es una anomalia -cuelga de otra madre, o la clave quedo huerfana- y
 * se muestra marcada en vez de desaparecer sin decir nada. Una fila que falta es
 * la clase de error que nadie ve.
 */
import { Decimal } from 'decimal.js';
import type { Cuenta } from '@shared/types';
import type { SaldosSubcuentas } from '../bitget/rest/endpoints/subcuentas';

/** Moneda con la que opera el panel. El contrato acota los traspasos a USDT. */
export const MONEDA_TRASPASOS = 'USDT';

export interface FilaSaldo {
  /** Identidad real de la subcuenta en Bitget. Es la clave de todo esto. */
  uid: string;
  /** Cuenta del panel con ese UID, si esta dada de alta. */
  cuentaId: string | null;
  /** Etiqueta del panel, o el UID cuando la cuenta no esta dada de alta. */
  etiqueta: string;
  /** Saldo disponible. `null` cuando la madre no reporto esta cuenta. */
  disponible: string | null;
  /**
   * Lo que de verdad puede salir, segun Bitget.
   *
   * No es el disponible: el margen comprometido en posiciones abiertas no se
   * puede transferir. Es el numero contra el que hay que validar un traspaso.
   */
  maxTransferible: string | null;
  equity: string | null;
  /** La reporta Bitget, pero el panel no la tiene dada de alta. */
  soloEnBitget: boolean;
  /** Esta dada de alta en el panel, pero la madre no la reporto. */
  sinDatos: boolean;
}

export interface ResumenSaldos {
  filas: FilaSaldo[];
  /** Suma de los disponibles conocidos. */
  totalDisponible: string;
  /** Suma de los maximos transferibles conocidos. */
  totalTransferible: string;
  /** Cuantas filas vienen de Bitget con datos. */
  conDatos: number;
}

/**
 * Extrae de `assetList` la entrada de la moneda que interesa.
 *
 * Bitget devuelve una entrada por moneda de margen; el panel solo opera USDT
 * (seccion 2 del presupuesto: "se opera exclusivamente con USDT"). Si esa
 * entrada no viene, la subcuenta se trata como sin datos en lugar de asumir
 * cero: cero significaria "no tiene nada", y lo cierto seria "no se sabe".
 */
type ActivoSubcuenta = NonNullable<SaldosSubcuentas[number]['assetList']>[number];

function activoDe(
  assetList: SaldosSubcuentas[number]['assetList'],
  moneda: string
): ActivoSubcuenta | null {
  if (!assetList) return null;
  return assetList.find((a) => a.marginCoin === moneda) ?? null;
}

/**
 * Cruza saldos de Bitget con las cuentas del panel.
 *
 * `cuentas` son las del grupo/cuenta madre que se esta mirando; pasar todas las
 * del panel mezclaria subcuentas de dos madres distintas en la misma pantalla.
 */
export function resumirSaldos(
  saldos: SaldosSubcuentas,
  cuentas: readonly Cuenta[],
  moneda: string = MONEDA_TRASPASOS
): ResumenSaldos {
  const porUid = new Map<string, (typeof saldos)[number]>();
  for (const s of saldos) porUid.set(s.userId, s);

  const filas: FilaSaldo[] = [];
  const vistos = new Set<string>();

  /* Primero las del panel, en su orden: es el orden que el operador conoce. */
  for (const cuenta of cuentas) {
    const reporte = porUid.get(cuenta.uid);
    vistos.add(cuenta.uid);
    const activo = reporte ? activoDe(reporte.assetList, moneda) : null;

    filas.push({
      uid: cuenta.uid,
      cuentaId: cuenta.id,
      etiqueta: cuenta.etiqueta,
      disponible: activo?.available ?? null,
      maxTransferible: activo?.maxTransferOut ?? null,
      equity: activo?.accountEquity ?? null,
      soloEnBitget: false,
      sinDatos: activo === null
    });
  }

  /* Y despues lo que Bitget reporta y el panel no conoce. */
  for (const reporte of saldos) {
    const uid = reporte.userId;
    if (vistos.has(uid)) continue;
    const activo = activoDe(reporte.assetList, moneda);

    filas.push({
      uid,
      cuentaId: null,
      etiqueta: uid,
      disponible: activo?.available ?? null,
      maxTransferible: activo?.maxTransferOut ?? null,
      equity: activo?.accountEquity ?? null,
      soloEnBitget: true,
      sinDatos: activo === null
    });
  }

  let totalDisponible = new Decimal(0);
  let totalTransferible = new Decimal(0);
  let conDatos = 0;

  for (const f of filas) {
    if (f.disponible !== null) {
      totalDisponible = totalDisponible.plus(new Decimal(f.disponible));
      conDatos += 1;
    }
    if (f.maxTransferible !== null) {
      totalTransferible = totalTransferible.plus(new Decimal(f.maxTransferible));
    }
  }

  return {
    filas,
    totalDisponible: totalDisponible.toString(),
    totalTransferible: totalTransferible.toString(),
    conDatos
  };
}
