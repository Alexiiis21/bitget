/**
 * Lo que el operador aprueba antes de que se mueva un dólar.
 *
 * Fase 3 de docs/presupuesto-traspaso-subcuentas.md, que exige *"confirmación
 * previa que muestra origen, destino, importe y saldos resultantes"*. Este
 * archivo calcula exactamente eso, y **no envía nada**: separar el cálculo del
 * envío es lo que permite enseñar el resultado y que cancelar no cueste nada.
 *
 * ==========================================================================
 * Por qué se valida aquí y no se deja fallar a Bitget
 * ==========================================================================
 * Bitget rechazaría igualmente un traspaso por encima del máximo transferible,
 * pero lo haría **después** de aceptar la confirmación del operador, con un
 * código en inglés y con el movimiento ya intentado. Comprobarlo antes convierte
 * el error más común -pedir más de lo que puede salir- en un aviso en la
 * pantalla, en castellano y sin gastar una petición.
 *
 * Lo que no se hace es lo contrario: **inventar el máximo transferible**. Ese
 * número lo da Bitget (`maxTransferOut`) y aquí solo se compara contra él. Una
 * estimación propia -saldo menos margen, por ejemplo- acabaría autorizando
 * traspasos que el exchange rechaza, que es justo lo que esta validación evita.
 */
import { Decimal } from 'decimal.js';
import type { FilaSaldo } from './saldos-subcuentas';

/** Por qué no se puede planificar un traspaso. Cada uno se explica distinto. */
export type MotivoRechazo =
  | 'importe-invalido'
  | 'importe-cero'
  | 'mismo-origen-y-destino'
  | 'origen-desconocido'
  | 'destino-desconocido'
  | 'origen-sin-datos'
  | 'sin-transferible'
  | 'supera-transferible';

export class ErrorTraspaso extends Error {
  readonly motivo: MotivoRechazo;

  constructor(motivo: MotivoRechazo, mensaje: string) {
    super(mensaje);
    this.name = 'ErrorTraspaso';
    this.motivo = motivo;
  }
}

/** Una punta del traspaso, tal como se enseña en la confirmación. */
export interface PuntaTraspaso {
  uid: string;
  etiqueta: string;
  /** Saldo antes del movimiento. */
  antes: string;
  /** Cómo queda si el traspaso sale bien. */
  despues: string;
}

export interface PlanTraspaso {
  id: string;
  uidMadre: string;
  origen: PuntaTraspaso;
  destino: PuntaTraspaso;
  importe: string;
  moneda: string;
  /**
   * Lo que como máximo puede salir del origen, según Bitget.
   *
   * Va en el plan, y no solo en la validación, porque la pantalla lo enseña
   * junto al importe: es la diferencia entre «te queda margen» y «estás moviendo
   * todo lo que se puede».
   */
  maxTransferible: string;
  /** Identificador único del envío. Impide que un reenvío duplique el movimiento. */
  clientOid: string;
  creadoEn: string;
}

/**
 * Cantidad válida de dinero, o `null`.
 *
 * Acepta solo lo que es un número decimal finito y no negativo. Un `NaN` o un
 * `Infinity` colándose hasta la resta produciría un saldo resultante absurdo en
 * la pantalla de confirmación, que es donde el operador deja de mirar.
 */
function cantidad(v: string): Decimal | null {
  if (v.trim() === '') return null;
  try {
    const d = new Decimal(v);
    return d.isFinite() && d.gte(0) ? d : null;
  } catch {
    return null;
  }
}

export interface PeticionTraspaso {
  uidOrigen: string;
  uidDestino: string;
  importe: string;
  uidMadre: string;
  /** Cómo se llama la cuenta principal en la confirmación. */
  etiquetaMadre: string;
  /**
   * Saldo de futuros de la cuenta principal, o `null` si no se pudo leer.
   *
   * Solo sirve para **enseñar** su antes y su después. No autoriza ni frena
   * nada: el tope de lo que puede salir de una cuenta lo da `maxTransferOut`,
   * que Bitget no informa para la madre, y aquí no se inventa. Ver la cabecera
   * de este archivo.
   */
  disponibleMadre?: string | null;
  moneda: string;
  clientOid: string;
  id: string;
  ahora: string;
}

/**
 * Una punta del traspaso ya resuelta: la cuenta principal, o una subcuenta.
 *
 * --------------------------------------------------------------------------
 * De la cuenta principal no se conoce el saldo, y eso cambia dos cosas
 * --------------------------------------------------------------------------
 * `filas` son las subcuentas que la madre reporta; la madre no se reporta a sí
 * misma, así que su saldo y su máximo transferible no están en ninguna parte
 * del panel. Es lo mismo que ya pasa en el reparto, donde el movimiento sale de
 * la madre y solo se enseña el antes y el después de la subcuenta.
 *
 * De ahí que una punta madre vaya con el antes y el después **vacíos** —no
 * inventados— y que, cuando es el origen, la comprobación del máximo
 * transferible la haga Bitget al recibir el traspaso y no el panel antes de
 * enviarlo.
 */
type Punta =
  | { madre: true; uid: string; etiqueta: string }
  | { madre: false; fila: FilaSaldo };

/**
 * Calcula el traspaso y comprueba que se pueda hacer. No envía nada.
 *
 * `filas` son los saldos recién leídos, no una copia guardada: el máximo
 * transferible cambia en cuanto se abre o se cierra una posición, y validar
 * contra un número viejo autorizaría lo que Bitget ya no admite.
 */
export function planificarTraspaso(
  peticion: PeticionTraspaso,
  filas: readonly FilaSaldo[]
): PlanTraspaso {
  const importe = cantidad(peticion.importe);
  if (importe === null) {
    throw new ErrorTraspaso(
      'importe-invalido',
      'El importe no es una cantidad válida. Escribe un número, con punto decimal.'
    );
  }
  if (importe.isZero()) {
    throw new ErrorTraspaso('importe-cero', 'El importe tiene que ser mayor que cero.');
  }

  if (peticion.uidOrigen === peticion.uidDestino) {
    throw new ErrorTraspaso(
      'mismo-origen-y-destino',
      'El origen y el destino son la misma cuenta.'
    );
  }

  /** La cuenta principal es una punta válida; el resto tiene que estar en `filas`. */
  const resolver = (uid: string, cual: 'origen' | 'destino'): Punta => {
    if (uid !== '' && uid === peticion.uidMadre) {
      return {
        madre: true,
        uid,
        etiqueta: peticion.etiquetaMadre === '' ? 'Cuenta principal' : peticion.etiquetaMadre
      };
    }

    const fila = filas.find((f) => f.uid === uid);
    if (fila === undefined) {
      throw new ErrorTraspaso(
        cual === 'origen' ? 'origen-desconocido' : 'destino-desconocido',
        `La subcuenta de ${cual} no está entre las que reporta esta cuenta principal.`
      );
    }
    return { madre: false, fila };
  };

  const origen = resolver(peticion.uidOrigen, 'origen');
  const destino = resolver(peticion.uidDestino, 'destino');

  /*
   * Sin datos no se calcula nada.
   *
   * Una subcuenta que la madre no reporta podria tener saldo o no tenerlo: no se
   * sabe. Dejar pasar el traspaso «a ver que dice Bitget» significaria enseñar
   * al operador un saldo resultante inventado en la pantalla de confirmacion.
   *
   * La madre es la excepcion, y no por comodidad: su saldo **no existe en el
   * panel**, asi que exigirlo dejaria la cuenta principal fuera para siempre.
   * Su salida la valida Bitget, igual que en el reparto.
   */
  let maximo: Decimal | null = null;
  /* Saliendo de la madre, su saldo se enseña si se conoce; el tope sigue sin conocerse. */
  let saldoOrigen: Decimal | null = origen.madre
    ? cantidad(peticion.disponibleMadre ?? '')
    : null;

  if (!origen.madre) {
    if (origen.fila.sinDatos || origen.fila.disponible === null) {
      throw new ErrorTraspaso(
        'origen-sin-datos',
        'No se conoce el saldo de la subcuenta de origen. Actualiza los saldos antes de traspasar.'
      );
    }

    if (origen.fila.maxTransferible === null) {
      throw new ErrorTraspaso(
        'sin-transferible',
        'Bitget no informa de cuánto puede salir de la subcuenta de origen. Actualiza los saldos.'
      );
    }

    maximo = cantidad(origen.fila.maxTransferible);
    if (maximo === null) {
      throw new ErrorTraspaso(
        'sin-transferible',
        'El máximo transferible de la subcuenta de origen no es una cantidad legible.'
      );
    }

    if (importe.gt(maximo)) {
      throw new ErrorTraspaso(
        'supera-transferible',
        `De ${origen.fila.etiqueta} solo pueden salir ${maximo.toString()} ${peticion.moneda}: ` +
          'el resto está comprometido en posiciones abiertas. Bitget rechazaría el traspaso.'
      );
    }

    saldoOrigen = cantidad(origen.fila.disponible) ?? new Decimal(0);
  }

  /*
   * Un destino sin datos no impide el traspaso: el dinero llega igual. Lo que no
   * se puede es decir cómo queda, así que su saldo resultante se deja vacío en
   * vez de sumarle el importe a un cero que nadie ha confirmado.
   */
  const saldoDestino = destino.madre
    ? cantidad(peticion.disponibleMadre ?? '')
    : destino.fila.disponible === null
      ? null
      : cantidad(destino.fila.disponible);

  return {
    id: peticion.id,
    uidMadre: peticion.uidMadre,
    origen: {
      uid: origen.madre ? origen.uid : origen.fila.uid,
      etiqueta: origen.madre ? origen.etiqueta : origen.fila.etiqueta,
      antes: saldoOrigen === null ? '' : saldoOrigen.toString(),
      despues: saldoOrigen === null ? '' : saldoOrigen.minus(importe).toString()
    },
    destino: {
      uid: destino.madre ? destino.uid : destino.fila.uid,
      etiqueta: destino.madre ? destino.etiqueta : destino.fila.etiqueta,
      antes: saldoDestino === null ? '' : saldoDestino.toString(),
      despues: saldoDestino === null ? '' : saldoDestino.plus(importe).toString()
    },
    importe: importe.toString(),
    moneda: peticion.moneda,
    /* Vacío cuando sale de la madre: el panel no conoce ese tope. */
    maxTransferible: maximo === null ? '' : maximo.toString(),
    clientOid: peticion.clientOid,
    creadoEn: peticion.ahora
  };
}
