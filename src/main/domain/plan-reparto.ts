/**
 * Reparto y recogida masiva. Fase 4 del presupuesto de traspasos.
 *
 * Dos operaciones que son, por dentro, una lista de traspasos individuales:
 *
 *   **Reparto**   la cuenta madre distribuye un importe total entre las
 *                 subcuentas elegidas, a partes iguales o igualando sus saldos.
 *   **Recogida**  las subcuentas elegidas devuelven su saldo a la madre, para
 *                 volver a repartirlo después.
 *
 * ==========================================================================
 * Por qué la aritmética de este archivo importa tanto
 * ==========================================================================
 * Repartir 100 entre 3 no da tres cifras exactas. Si cada parte se redondea por
 * su cuenta, la suma deja de ser 100: sobra o falta dinero, y sobre cien
 * subcuentas ese resto deja de ser un céntimo. Aquí el reparto se calcula de
 * modo que **la suma de las partes sea exactamente el total pedido**, ni un
 * céntimo más ni uno menos, y el sobrante se reparte de una unidad en una unidad
 * en vez de perderse.
 *
 * Nada de esto usa coma flotante. Todo pasa por decimal.js, como el resto del
 * dinero del proyecto. docs/03-modelo-de-datos.md §14.
 */
import { Decimal } from 'decimal.js';
import type { FilaSaldo } from './saldos-subcuentas';

/**
 * Decimales con los que se calcula un importe.
 *
 * Ocho es la precisión con la que Bitget devuelve los saldos de futuros en USDT.
 * **Sin confirmar contra un traspaso real**: si el exchange rechazara importes
 * con tanta cola, el sitio donde bajarlo es esta constante y nada más.
 */
export const DECIMALES = 8;

export type ModoReparto = 'iguales' | 'igualar';

export type MotivoDescarte = 'sin-datos' | 'sin-transferible' | 'importe-cero' | 'ya-por-encima';

/** Una subcuenta que se queda fuera del reparto, y por qué. */
export interface DescarteReparto {
  uid: string;
  etiqueta: string;
  motivo: MotivoDescarte;
  mensaje: string;
}

/** Un traspaso de la lista, ya calculado. */
export interface MovimientoReparto {
  uidOrigen: string;
  etiquetaOrigen: string;
  uidDestino: string;
  etiquetaDestino: string;
  importe: string;
  /** Saldo de la subcuenta antes y después. La madre no lleva estos dos. */
  antes: string;
  despues: string;
  clientOid: string;
}

export interface PlanReparto {
  id: string;
  uidMadre: string;
  tipo: 'reparto' | 'recogida';
  /** `null` en una recogida: no hay nada que repartir. */
  modo: ModoReparto | null;
  moneda: string;
  /** Suma exacta de los importes de `movimientos`. */
  total: string;
  movimientos: MovimientoReparto[];
  descartes: DescarteReparto[];
  creadoEn: string;
}

export class ErrorReparto extends Error {
  readonly motivo: string;

  constructor(motivo: string, mensaje: string) {
    super(mensaje);
    this.name = 'ErrorReparto';
    this.motivo = motivo;
  }
}

/** Cantidad válida y no negativa, o `null`. */
function cantidad(v: string | null): Decimal | null {
  if (v === null || v.trim() === '') return null;
  try {
    const d = new Decimal(v);
    return d.isFinite() && d.gte(0) ? d : null;
  } catch {
    return null;
  }
}

/** La unidad más pequeña con la que se opera: 1e-8. */
const UNIDAD = new Decimal(1).dividedBy(new Decimal(10).pow(DECIMALES));

/**
 * Reparte `total` en `n` partes cuya suma es **exactamente** `total`.
 *
 * Divide, trunca hacia abajo y reparte el sobrante de unidad en unidad entre las
 * primeras partes. Truncar y no redondear es deliberado: redondear cada parte
 * hacia arriba haría que la suma superase el total, es decir, que el panel
 * intentara mover más dinero del que el operador aprobó.
 */
export function partesIguales(total: Decimal, n: number): Decimal[] {
  if (n <= 0) return [];

  const base = total.dividedBy(n).toDecimalPlaces(DECIMALES, Decimal.ROUND_DOWN);
  const partes = Array.from({ length: n }, () => base);

  /* Lo que la división dejó fuera, en unidades enteras de 1e-8. */
  let resto = total.minus(base.times(n));
  for (let i = 0; i < n && resto.gte(UNIDAD); i += 1) {
    partes[i] = (partes[i] ?? base).plus(UNIDAD);
    resto = resto.minus(UNIDAD);
  }

  return partes;
}

/**
 * Reparte `total` de modo que los saldos queden lo más iguales posible.
 *
 * --------------------------------------------------------------------------
 * Cómo se calcula, y por qué no es «total entre n»
 * --------------------------------------------------------------------------
 * Es el problema de llenar vasos de distinta altura hasta un mismo nivel. Se
 * busca el nivel `L` tal que la suma de lo que le falta a cada subcuenta para
 * llegar a `L` sea exactamente el total disponible.
 *
 * Se ordenan los saldos de menor a mayor y se prueba a llenar los `k` más bajos:
 * si el nivel resultante no supera al siguiente saldo, ese es el nivel. Las
 * subcuentas que ya están por encima **no reciben nada** —y tampoco se les quita:
 * este reparto solo añade—, lo que se dice en los descartes en vez de dejarlas
 * en la lista con un cero al lado.
 *
 * Devuelve, por cada saldo de entrada y en su mismo orden, lo que recibe.
 */
export function partesIgualando(total: Decimal, saldos: readonly Decimal[]): Decimal[] {
  const n = saldos.length;
  if (n === 0) return [];

  /* Índices ordenados por saldo ascendente, sin perder la posición original. */
  const orden = saldos
    .map((saldo, indice) => ({ saldo, indice }))
    .sort((a, b) => a.saldo.comparedTo(b.saldo));

  let nivel: Decimal | null = null;
  let cuantos = n;
  let acumulado = new Decimal(0);

  for (let k = 1; k <= n; k += 1) {
    acumulado = acumulado.plus(orden[k - 1]?.saldo ?? 0);
    const candidato = acumulado.plus(total).dividedBy(k);
    const siguiente = orden[k]?.saldo;

    /* El nivel vale si no rebasa al siguiente vaso: si lo rebasa, ese también entra. */
    if (siguiente === undefined || candidato.lte(siguiente)) {
      nivel = candidato;
      cuantos = k;
      break;
    }
  }

  const partes = saldos.map(() => new Decimal(0));
  if (nivel === null) return partes;

  /*
   * Se calcula lo que le falta a cada uno y luego se ajusta el resto, igual que
   * en `partesIguales`: truncar cada diferencia por separado dejaría sin
   * repartir unas pocas unidades del total.
   */
  let repartido = new Decimal(0);
  for (let k = 0; k < cuantos; k += 1) {
    const entrada = orden[k];
    if (entrada === undefined) continue;
    const falta = nivel.minus(entrada.saldo).toDecimalPlaces(DECIMALES, Decimal.ROUND_DOWN);
    const parte = falta.gt(0) ? falta : new Decimal(0);
    partes[entrada.indice] = parte;
    repartido = repartido.plus(parte);
  }

  let resto = total.minus(repartido);
  for (let k = 0; k < cuantos && resto.gte(UNIDAD); k += 1) {
    const entrada = orden[k];
    if (entrada === undefined) continue;
    partes[entrada.indice] = (partes[entrada.indice] ?? new Decimal(0)).plus(UNIDAD);
    resto = resto.minus(UNIDAD);
  }

  return partes;
}

export interface PeticionReparto {
  id: string;
  uidMadre: string;
  etiquetaMadre: string;
  moneda: string;
  ahora: string;
  /** UIDs de las subcuentas elegidas por el operador. */
  destinos: readonly string[];
  total: string;
  modo: ModoReparto;
}

/** El identificador de cada envío, derivado del plan y de su posición. */
const oidDe = (planId: string, indice: number): string => `pcbrp${planId}${indice}`;

/**
 * Calcula el reparto de la madre hacia las subcuentas elegidas. No envía nada.
 */
export function planificarReparto(
  peticion: PeticionReparto,
  filas: readonly FilaSaldo[]
): PlanReparto {
  const total = cantidad(peticion.total);
  if (total === null || total.isZero()) {
    throw new ErrorReparto(
      'importe-invalido',
      'El importe a repartir tiene que ser un número mayor que cero.'
    );
  }
  if (peticion.destinos.length === 0) {
    throw new ErrorReparto('sin-destinos', 'Elige al menos una subcuenta que reciba el reparto.');
  }

  const descartes: DescarteReparto[] = [];
  const elegidas: { fila: FilaSaldo; saldo: Decimal }[] = [];

  for (const uid of peticion.destinos) {
    const fila = filas.find((f) => f.uid === uid);
    if (fila === undefined) continue;

    const saldo = cantidad(fila.disponible);
    /*
     * Sin saldo conocido no se puede igualar: haría falta saber de dónde parte.
     * En reparto a partes iguales sí se podría, pero se descarta igual para no
     * tener dos criterios distintos según el modo -y porque una subcuenta que la
     * madre no reporta es una anomalía que conviene mirar antes de meterle
     * dinero-.
     */
    if (fila.sinDatos || saldo === null) {
      descartes.push({
        uid: fila.uid,
        etiqueta: fila.etiqueta,
        motivo: 'sin-datos',
        mensaje: 'La cuenta principal no informa de su saldo. Actualiza los saldos.'
      });
      continue;
    }

    elegidas.push({ fila, saldo });
  }

  if (elegidas.length === 0) {
    throw new ErrorReparto(
      'sin-destinos-validos',
      'Ninguna de las subcuentas elegidas tiene saldo conocido.'
    );
  }

  const partes =
    peticion.modo === 'iguales'
      ? partesIguales(total, elegidas.length)
      : partesIgualando(
          total,
          elegidas.map((e) => e.saldo)
        );

  const movimientos: MovimientoReparto[] = [];
  let indice = 0;

  for (const [i, elegida] of elegidas.entries()) {
    const parte = partes[i] ?? new Decimal(0);

    if (parte.lte(0)) {
      descartes.push({
        uid: elegida.fila.uid,
        etiqueta: elegida.fila.etiqueta,
        motivo: peticion.modo === 'igualar' ? 'ya-por-encima' : 'importe-cero',
        mensaje:
          peticion.modo === 'igualar'
            ? 'Ya está por encima del nivel que alcanzan las demás: no recibe nada.'
            : 'Le tocaría una cantidad menor que la unidad mínima.'
      });
      continue;
    }

    movimientos.push({
      uidOrigen: peticion.uidMadre,
      etiquetaOrigen: peticion.etiquetaMadre,
      uidDestino: elegida.fila.uid,
      etiquetaDestino: elegida.fila.etiqueta,
      importe: parte.toString(),
      antes: elegida.saldo.toString(),
      despues: elegida.saldo.plus(parte).toString(),
      clientOid: oidDe(peticion.id, indice)
    });
    indice += 1;
  }

  if (movimientos.length === 0) {
    throw new ErrorReparto(
      'nada-que-repartir',
      'Con ese importe no le toca nada a ninguna de las subcuentas elegidas.'
    );
  }

  const repartido = movimientos.reduce((s, m) => s.plus(m.importe), new Decimal(0));

  return {
    id: peticion.id,
    uidMadre: peticion.uidMadre,
    tipo: 'reparto',
    modo: peticion.modo,
    moneda: peticion.moneda,
    total: repartido.toString(),
    movimientos,
    descartes,
    creadoEn: peticion.ahora
  };
}

export interface PeticionRecogida {
  id: string;
  uidMadre: string;
  etiquetaMadre: string;
  moneda: string;
  ahora: string;
  /** UIDs de las subcuentas cuyo saldo se recoge. */
  origenes: readonly string[];
}

/**
 * Calcula la recogida de las subcuentas elegidas hacia la madre. No envía nada.
 *
 * De cada una sale **su máximo transferible**, no su saldo: el margen
 * comprometido en posiciones abiertas no se puede mover, y pedirlo entero haría
 * que Bitget rechazara justamente las subcuentas que están operando.
 */
export function planificarRecogida(
  peticion: PeticionRecogida,
  filas: readonly FilaSaldo[]
): PlanReparto {
  if (peticion.origenes.length === 0) {
    throw new ErrorReparto('sin-origenes', 'Elige al menos una subcuenta de la que recoger.');
  }

  const descartes: DescarteReparto[] = [];
  const movimientos: MovimientoReparto[] = [];
  let indice = 0;

  for (const uid of peticion.origenes) {
    const fila = filas.find((f) => f.uid === uid);
    if (fila === undefined) continue;

    if (fila.sinDatos) {
      descartes.push({
        uid: fila.uid,
        etiqueta: fila.etiqueta,
        motivo: 'sin-datos',
        mensaje: 'La cuenta principal no informa de su saldo. Actualiza los saldos.'
      });
      continue;
    }

    const transferible = cantidad(fila.maxTransferible);
    if (transferible === null) {
      descartes.push({
        uid: fila.uid,
        etiqueta: fila.etiqueta,
        motivo: 'sin-transferible',
        mensaje: 'Bitget no informa de cuánto puede salir de esta subcuenta.'
      });
      continue;
    }

    if (transferible.lte(0)) {
      descartes.push({
        uid: fila.uid,
        etiqueta: fila.etiqueta,
        motivo: 'importe-cero',
        mensaje: 'No tiene saldo transferible: todo está comprometido o está a cero.'
      });
      continue;
    }

    const saldo = cantidad(fila.disponible) ?? transferible;

    movimientos.push({
      uidOrigen: fila.uid,
      etiquetaOrigen: fila.etiqueta,
      uidDestino: peticion.uidMadre,
      etiquetaDestino: peticion.etiquetaMadre,
      importe: transferible.toString(),
      antes: saldo.toString(),
      despues: saldo.minus(transferible).toString(),
      clientOid: oidDe(peticion.id, indice)
    });
    indice += 1;
  }

  if (movimientos.length === 0) {
    throw new ErrorReparto(
      'nada-que-recoger',
      'Ninguna de las subcuentas elegidas tiene saldo que se pueda mover.'
    );
  }

  const total = movimientos.reduce((s, m) => s.plus(m.importe), new Decimal(0));

  return {
    id: peticion.id,
    uidMadre: peticion.uidMadre,
    tipo: 'recogida',
    modo: null,
    moneda: peticion.moneda,
    total: total.toString(),
    movimientos,
    descartes,
    creadoEn: peticion.ahora
  };
}
