/**
 * Motor de lotes: una accion del operador sobre muchas cuentas.
 *
 * --------------------------------------------------------------------------
 * Dos tiempos, no uno
 * --------------------------------------------------------------------------
 * `planificar()` no toca ninguna cuenta: consulta el catalogo y el precio,
 * calcula la cantidad de cada objetivo y devuelve el plan con **precios y
 * cantidades reales**. `ejecutar()` envia ese plan y nada mas.
 *
 * La separacion es lo que hace posible la confirmacion que exige el contrato:
 * el operador no aprueba «abrir 100 USDT a 10x», aprueba «0,0158 BTC en estas
 * 34 cuentas, y estas 3 no pueden por saldo». Ademas, todo lo que puede fallar
 * por los parametros falla en la planificacion, **antes de que salga una sola
 * orden**.
 *
 * --------------------------------------------------------------------------
 * Que garantiza cada pieza
 * --------------------------------------------------------------------------
 * **No se duplica una posicion.** El `clientOid` se deriva del identificador
 * del plan y del objetivo, asi que es el mismo cada vez que se ejecuta el mismo
 * plan. Reintentar las fallidas reenvia exactamente los mismos identificadores,
 * y Bitget rechaza el repetido. Duplicar exigiria planificar dos veces a
 * proposito.
 *
 * **Dos ejecuciones del mismo plan no se pisan.** Un plan en vuelo queda
 * marcado; el segundo intento se rechaza en el acto en lugar de correr en
 * paralelo con el primero. Es la carrera realista: el operador pulsa dos veces.
 *
 * **Un fallo no arrastra a los demas.** Cada objetivo es independiente: el que
 * falla queda registrado con su motivo y su cuenta, y los otros 99 terminan.
 * Lo que sale mal en una cuenta nunca deshace lo que salio bien en otra —
 * cerrar 31 posiciones validas porque 3 fallaron seria un dano mayor que el
 * problema original—.
 *
 * **No se satura la API.** Los envios van por bloques y cada uno pasa por el
 * limitador de peticiones, que ya reparte el cupo por IP y por cuenta. Sin los
 * bloques, un lote de 300 cuentas encolaria 300 promesas de golpe.
 *
 * **Lo enviado sin respuesta no se reintenta: se consulta.** Un corte despues
 * de enviar deja la orden `indeterminada`, y se resuelve preguntando por su
 * `clientOid`. Reintentar a ciegas es la forma de acabar con el doble de
 * posicion. docs/03 seccion 10.
 */
import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import { CONCURRENCIA_MAXIMA } from '@shared/constants';
import type { AccionLote, Job, Lado, Lote } from '@shared/types';
import { ErrorBitget } from '../bitget/errors';
import type { Mercado } from '../bitget/mercado';
import type { ClienteBitget } from '../bitget/rest/client';
import type { Credencial } from '../bitget/rest/signer';
import {
  abrirPosicion,
  cerrarPosicion,
  consultarOrden,
  type ModoMargenApi
} from '../bitget/rest/endpoints/ordenes';
import {
  buscarPosicion,
  obtenerPosiciones,
  type PosicionBitget
} from '../bitget/rest/endpoints/posiciones';
import {
  ajustarMargen,
  fijarApalancamiento,
  obtenerCuentaSimbolo
} from '../bitget/rest/endpoints/cuenta';
import { obtenerContratos, obtenerTicker, type Contrato } from '../bitget/rest/endpoints/simbolos';
import {
  buscarTakeProfit,
  cancelarPlan,
  colocarTakeProfit,
  planesPendientes,
  type PlanPendiente
} from '../bitget/rest/endpoints/tpsl';
import { dimensionarApertura, type MotivoRechazo } from '../domain/dimension-orden';
import { precioTakeProfit, type MotivoRechazoTp } from '../domain/precio-take-profit';

/* ---------------- lo que el motor necesita saber de cada cuenta ---------------- */

/**
 * Apalancamiento que el panel cree que tiene la cuenta.
 *
 * En margen cruzado Bitget usa uno solo para los dos lados; en aislado, uno por
 * lado. `null` significa «no se sabe», que no es lo mismo que cero y por eso no
 * se sustituye por un valor por defecto.
 */
export interface ApalancamientoCuenta {
  long: number | null;
  short: number | null;
  cruzado: number | null;
}

export interface CuentaEjecutable {
  cuentaId: string;
  etiqueta: string;
  credencial: Credencial;
  /** Saldo disponible en la moneda de margen del mercado. */
  saldoDisponible: string;
  modoMargen: ModoMargenApi;
  /** Ultimo apalancamiento conocido, de la ultima verificacion de la credencial. */
  apalancamiento?: ApalancamientoCuenta;
}

/** El apalancamiento que de verdad aplicaria a ese lado, o `null` si no se sabe. */
export function apalancamientoVigente(cuenta: CuentaEjecutable, lado: Lado): number | null {
  const a = cuenta.apalancamiento;
  if (a === undefined) return null;
  if (cuenta.modoMargen === 'crossed') return a.cruzado;
  return lado === 'long' ? a.long : a.short;
}

/**
 * De donde salen las credenciales y los saldos.
 *
 * Es una interfaz y no la `Sesion` directamente para que el motor se pueda
 * probar con trescientas cuentas de mentira sin vault, sin disco y sin red.
 */
export interface FuenteCuentas {
  cuentaEjecutable(cuentaId: string): CuentaEjecutable | null;
}

/* ---------------- lo que comparten todos los lotes ---------------- */

/**
 * Lo minimo que el ejecutor necesita de un objetivo, sea de la accion que sea.
 *
 * Las cinco funciones del panel actuan sobre «una cuenta y un lado» y llevan su
 * identificador de orden; lo que cambia de una a otra son los datos propios de
 * la operacion, que cada plan anade por su cuenta.
 */
export interface EntradaLote {
  cuentaId: string;
  etiqueta: string;
  lado: Lado;
  clientOid: string;
}

export interface PlanBase<E extends EntradaLote> {
  id: string;
  mercado: Mercado;
  simbolo: string;
  entradas: E[];
  descartes: DescartePlan[];
  creadoEn: string;
}

/** Desenlace de un envio, ya sea directo o averiguado despues de un corte. */
export interface Desenlace {
  ordenId: string | null;
  mensaje: string | null;
}

/**
 * Lo unico que distingue una accion de otra dentro del motor.
 *
 * `enviar` hace la operacion. `resolver` averigua que paso cuando se envio y no
 * llego respuesta, y cada accion lo averigua de forma distinta: la apertura
 * pregunta por la orden, el cierre mira si la posicion sigue ahi.
 */
export interface Maniobra<E extends EntradaLote> {
  enviar(cuenta: CuentaEjecutable, entrada: E): Promise<Desenlace>;
  resolver(
    cuenta: CuentaEjecutable,
    entrada: E
  ): Promise<{ estado: 'exito' | 'fallo'; ordenId: string | null; mensaje: string }>;
}

/* ---------------- peticion y plan ---------------- */

export interface ObjetivoApertura {
  cuentaId: string;
  lado: Lado;
}

export interface PeticionApertura {
  mercado: Mercado;
  simbolo: string;
  objetivos: ObjetivoApertura[];
  /** Margen por objetivo, en moneda de margen. */
  margenInicial: string;
  apalancamiento: number;
  /** `null` para orden a mercado. */
  precioLimite: string | null;
}

/** Un objetivo que va a salir: ya tiene cantidad calculada y credencial. */
export interface EntradaPlan extends EntradaLote {
  size: string;
  nocional: string;
  margenReal: string;
  modoMargen: ModoMargenApi;
}

/** Motivo por el que un objetivo no llega a enviarse. */
export type MotivoDescarte =
  | MotivoRechazo
  | MotivoRechazoTp
  | 'cuenta-desconocida'
  /** No hay posicion abierta de ese lado: no habia nada que cerrar. */
  | 'sin-posicion'
  /** No se pudo consultar que tiene abierto, asi que no se toca. */
  | 'posiciones-ilegibles'
  /** Bitget solo permite agregar margen en aislado. */
  | 'margen-cruzado'
  /** No hay ningun Take Profit puesto: no habia nada que quitar. */
  | 'sin-take-profit'
  /** No se pudo consultar que Take Profit hay puestos, asi que no se toca. */
  | 'planes-ilegibles';

/** Un objetivo que no va a salir, y por que. */
export interface DescartePlan {
  cuentaId: string;
  etiqueta: string;
  lado: Lado;
  motivo: MotivoDescarte;
  mensaje: string;
}

/**
 * Algo que el operador debe saber antes de confirmar, pero que no impide enviar.
 *
 * La diferencia con un descarte es deliberada: un descarte es «esto no se puede
 * hacer», un aviso es «esto se puede hacer y no va a salir como crees».
 */
export interface AvisoPlan {
  cuentaId: string;
  etiqueta: string;
  lado: Lado;
  codigo: 'apalancamiento-distinto' | 'apalancamiento-desconocido';
  mensaje: string;
}

export interface PlanApertura extends PlanBase<EntradaPlan> {
  apalancamiento: number;
  precioLimite: string | null;
  /** Precio de marca con el que se calcularon las cantidades. */
  precioReferencia: string;
  margenInicial: string;
  /** Lo que conviene mirar antes de confirmar. Ver `AvisoPlan`. */
  avisos: AvisoPlan[];
}

/* ---------------- cierre de operaciones ---------------- */

export interface PeticionCierre {
  mercado: Mercado;
  simbolo: string;
  objetivos: ObjetivoApertura[];
}

/**
 * Una posicion que se va a cerrar.
 *
 * `size` y `precioEntrada` son lo que habia **cuando se planifico**, y estan
 * para que el operador vea que va a cerrar. No se envian: el cierre le pide a
 * Bitget que cierre lo que haya en ese momento. Ver `cerrarPosicion`.
 */
export interface EntradaCierre extends EntradaLote {
  size: string;
  precioEntrada: string | null;
  /** Margen que quedara libre al cerrar, si Bitget lo informa. */
  margenLiberado: string | null;
}

export type PlanCierre = PlanBase<EntradaCierre>;

/* ---------------- take profit ---------------- */

export interface PeticionTakeProfitLote {
  mercado: Mercado;
  simbolo: string;
  objetivos: ObjetivoApertura[];
  /** Ganancia sobre el margen inicial, en porcentaje. P. ej. `35`. */
  porcentaje: string;
}

/**
 * Un Take Profit que se va a colocar.
 *
 * Lleva de donde sale el precio -entrada y apalancamiento de esa posicion- para
 * que la confirmacion pueda ensenarlo: el operador aprueba precios concretos,
 * no un porcentaje.
 */
export interface EntradaTakeProfit extends EntradaLote {
  precioDisparo: string;
  precioEntrada: string;
  apalancamiento: number;
  /** Cuanto tiene que moverse el precio, en %. Util para ver si es alcanzable. */
  movimientoPorcentaje: string;
}

export interface PlanTakeProfit extends PlanBase<EntradaTakeProfit> {
  porcentaje: string;
}

/* ---------------- quitar el take profit ---------------- */

export interface PeticionQuitarTakeProfit {
  mercado: Mercado;
  simbolo: string;
  objetivos: ObjetivoApertura[];
}

/**
 * Un Take Profit que se va a quitar.
 *
 * Lleva el precio al que estaba puesto porque es lo que el operador reconoce:
 * aprueba «quitar el Take Profit de 0,0000026306», no «cancelar el plan
 * 1310432...». El `orderId` es lo que se envia.
 */
export interface EntradaQuitarTakeProfit extends EntradaLote {
  /** Identificador del plan en Bitget. Es lo unico que sirve para cancelarlo. */
  orderId: string;
  /** Precio de disparo que tenia puesto, para poder ensenarlo. */
  precioDisparo: string;
}

export type PlanQuitarTakeProfit = PlanBase<EntradaQuitarTakeProfit>;

/* ---------------- agregar margen ---------------- */

export interface PeticionMargen {
  mercado: Mercado;
  simbolo: string;
  objetivos: ObjetivoApertura[];
  /** Margen a anadir a cada posicion, en moneda de margen. */
  cantidad: string;
}

export interface EntradaMargen extends EntradaLote {
  cantidad: string;
  /** Margen que tiene la posicion ahora. */
  margenActual: string;
  /** El que tendra si el envio sale bien. Es lo que comprueba el resolutor. */
  margenResultante: string;
}

export interface PlanMargen extends PlanBase<EntradaMargen> {
  cantidad: string;
  /** Suma de lo que se va a comprometer. Es dinero nuevo saliendo del saldo. */
  totalComprometido: string;
}

/* ---------------- ajuste de apalancamiento ---------------- */

export interface PeticionApalancamiento {
  mercado: Mercado;
  simbolo: string;
  objetivos: ObjetivoApertura[];
  apalancamiento: number;
}

export interface EntradaApalancamiento extends EntradaLote {
  apalancamiento: number;
  /** El que el panel cree que tiene ahora, si lo sabe. */
  apalancamientoActual: number | null;
}

export interface PlanApalancamiento extends PlanBase<EntradaApalancamiento> {
  apalancamiento: number;
}

/** El plan entero es inviable: no sale ni una orden. */
export class ErrorPlan extends Error {
  readonly motivo: string;

  constructor(motivo: string, mensaje: string) {
    super(mensaje);
    this.name = 'ErrorPlan';
    this.motivo = motivo;
  }
}

export interface OpcionesMotor {
  /** Objetivos que se envian a la vez. Por defecto, la concurrencia del limitador. */
  tamanoBloque?: number;
  /** Reintentos automaticos ante un fallo transitorio. docs/01 seccion 9. */
  reintentosMaximos?: number;
  ahora?: () => Date;
  /** Espera entre reintentos. Se inyecta en las pruebas. */
  dormir?: (ms: number) => Promise<void>;
  /** Se invoca cada vez que un trabajo cambia de estado. */
  alProgresar?: (lote: Lote) => void;
}

/** Espera creciente entre reintentos: 300 ms, 900 ms, 2,7 s. */
const esperaReintento = (intento: number): number => 300 * 3 ** (intento - 1);

/**
 * Identificador de orden, derivado y no aleatorio.
 *
 * Bitget acepta hasta 64 caracteres. Se usa el id del plan y el indice del
 * objetivo: dos ejecuciones del mismo plan producen los mismos identificadores,
 * que es justo lo que impide duplicar.
 */
export const clientOidDe = (planId: string, indice: number, lado: Lado): string =>
  `pcb${planId}${indice}${lado === 'long' ? 'l' : 's'}`;

export class MotorLotes {
  private readonly cliente: ClienteBitget;
  private readonly fuente: FuenteCuentas;
  private readonly tamanoBloque: number;
  private readonly reintentosMaximos: number;
  private readonly ahora: () => Date;
  private readonly dormir: (ms: number) => Promise<void>;
  private readonly alProgresar: (lote: Lote) => void;
  /** Catalogo por mercado. Publico y casi inmutable: pedirlo por lote seria gasto puro. */
  private readonly catalogos = new Map<string, Map<string, Contrato>>();
  /** Planes en vuelo. Es el cerrojo contra el doble clic. */
  private readonly enVuelo = new Set<string>();

  constructor(cliente: ClienteBitget, fuente: FuenteCuentas, opciones: OpcionesMotor = {}) {
    this.cliente = cliente;
    this.fuente = fuente;
    this.tamanoBloque = opciones.tamanoBloque ?? CONCURRENCIA_MAXIMA;
    this.reintentosMaximos = opciones.reintentosMaximos ?? 3;
    this.ahora = opciones.ahora ?? (() => new Date());
    this.dormir =
      opciones.dormir ??
      ((ms) =>
        new Promise((r) => {
          setTimeout(r, ms);
        }));
    this.alProgresar = opciones.alProgresar ?? (() => undefined);
  }

  /* ---------------- catalogo ---------------- */

  private async contrato(mercado: Mercado, simbolo: string): Promise<Contrato> {
    let catalogo = this.catalogos.get(mercado.productType);
    if (catalogo === undefined) {
      const r = await obtenerContratos(this.cliente, mercado);
      catalogo = new Map(r.datos.map((c) => [c.symbol, c]));
      this.catalogos.set(mercado.productType, catalogo);
    }

    const contrato = catalogo.get(simbolo);
    if (contrato === undefined) {
      throw new ErrorPlan(
        'simbolo-desconocido',
        `El activo ${simbolo} no existe en el mercado ${mercado.productType} de Bitget.`
      );
    }
    return contrato;
  }

  /** Vacia el catalogo. Solo para pruebas y para un cambio de mercado en caliente. */
  olvidarCatalogo(): void {
    this.catalogos.clear();
  }

  /* ---------------- planificacion ---------------- */

  /**
   * Calcula que saldria y que no. **No envia nada.**
   *
   * Lo que depende de los parametros -activo inexistente, precio ilegible-
   * lanza `ErrorPlan` y aborta el lote entero: si el problema es la orden en si,
   * no debe salir ni una. Lo que depende de cada cuenta -saldo, minimos- no
   * aborta nada: queda como descarte con su motivo.
   */
  async planificar(peticion: PeticionApertura): Promise<PlanApertura> {
    if (peticion.objetivos.length === 0) {
      throw new ErrorPlan('sin-objetivos', 'No hay ninguna casilla seleccionada.');
    }

    const contrato = await this.contrato(peticion.mercado, peticion.simbolo);

    const ticker = await obtenerTicker(this.cliente, peticion.mercado, peticion.simbolo);
    const precio = ticker.datos[0]?.markPrice ?? '';
    if (precio === '' || Number(precio) <= 0) {
      throw new ErrorPlan(
        'sin-precio',
        `Bitget no devolvió un precio válido para ${peticion.simbolo}. No se envió ninguna orden.`
      );
    }

    const id = randomUUID().replace(/-/g, '').slice(0, 12);
    const entradas: EntradaPlan[] = [];
    const descartes: DescartePlan[] = [];
    const avisos: AvisoPlan[] = [];

    peticion.objetivos.forEach((objetivo, indice) => {
      const cuenta = this.fuente.cuentaEjecutable(objetivo.cuentaId);
      if (cuenta === null) {
        descartes.push({
          cuentaId: objetivo.cuentaId,
          etiqueta: objetivo.cuentaId,
          lado: objetivo.lado,
          motivo: 'cuenta-desconocida',
          mensaje: 'La subcuenta ya no está registrada o no tiene credencial.'
        });
        return;
      }

      const calculo = dimensionarApertura({
        contrato,
        precio,
        margenInicial: peticion.margenInicial,
        apalancamiento: peticion.apalancamiento,
        saldoDisponible: cuenta.saldoDisponible,
        aMercado: peticion.precioLimite === null
      });

      if (!calculo.ok) {
        descartes.push({
          cuentaId: cuenta.cuentaId,
          etiqueta: cuenta.etiqueta,
          lado: objetivo.lado,
          motivo: calculo.motivo,
          mensaje: calculo.mensaje
        });
        return;
      }

      entradas.push({
        cuentaId: cuenta.cuentaId,
        etiqueta: cuenta.etiqueta,
        lado: objetivo.lado,
        clientOid: clientOidDe(id, indice, objetivo.lado),
        size: calculo.dimension.size,
        nocional: calculo.dimension.nocional,
        margenReal: calculo.dimension.margenReal,
        modoMargen: cuenta.modoMargen
      });

      /*
       * El apalancamiento se fija una vez y queda fijo; la apertura no lo
       * cambia. Pero el margen que se compromete depende de el: la misma
       * cantidad a 20x consume la mitad de margen que a 10x. Si la cuenta esta
       * en otro apalancamiento del que el operador escribio, el margen que se
       * le enseña no seria el que se compromete, y eso es lo primero que hay
       * que decirle. No bloquea el envio: avisa.
       */
      const vigente = apalancamientoVigente(cuenta, objetivo.lado);
      if (vigente !== null && vigente !== peticion.apalancamiento) {
        const margenEfectivo = new Decimal(calculo.dimension.nocional).dividedBy(vigente);
        avisos.push({
          cuentaId: cuenta.cuentaId,
          etiqueta: cuenta.etiqueta,
          lado: objetivo.lado,
          codigo: 'apalancamiento-distinto',
          mensaje:
            `La cuenta está a ${vigente}x y la operación se calculó a ${peticion.apalancamiento}x: ` +
            `comprometería ${margenEfectivo.toFixed(2)} en vez de ${Number(calculo.dimension.margenReal).toFixed(2)}. ` +
            'Ajuste el apalancamiento de la cuenta o cambie el valor del campo.'
        });
      }
    });

    return {
      id,
      mercado: peticion.mercado,
      simbolo: peticion.simbolo,
      apalancamiento: peticion.apalancamiento,
      precioLimite: peticion.precioLimite,
      precioReferencia: precio,
      margenInicial: peticion.margenInicial,
      entradas,
      descartes,
      avisos,
      creadoEn: this.ahora().toISOString()
    };
  }
  /* ---------------- planificacion del cierre ---------------- */

  /**
   * Calcula que se va a cerrar. **No envia nada.**
   *
   * A diferencia de la apertura, aqui no hay nada que calcular a partir de un
   * margen: se cierra lo que hay. Por eso el plan consulta las posiciones
   * abiertas de cada cuenta, y por eso una casilla sin posicion no es un fallo
   * sino un descarte: no habia nada que cerrar.
   *
   * Se agrupa por cuenta antes de consultar: una sola peticion devuelve los dos
   * lados, asi que cerrar long y short de la misma subcuenta no cuesta dos.
   */
  async planificarCierre(peticion: PeticionCierre): Promise<PlanCierre> {
    if (peticion.objetivos.length === 0) {
      throw new ErrorPlan('sin-objetivos', 'No hay ninguna casilla seleccionada.');
    }

    const id = randomUUID().replace(/-/g, '').slice(0, 12);
    const entradas: EntradaCierre[] = [];
    const descartes: DescartePlan[] = [];

    const porCuenta = new Map<string, ObjetivoApertura[]>();
    for (const objetivo of peticion.objetivos) {
      const lista = porCuenta.get(objetivo.cuentaId) ?? [];
      lista.push(objetivo);
      porCuenta.set(objetivo.cuentaId, lista);
    }

    let indice = 0;
    for (const [cuentaId, objetivos] of porCuenta) {
      const cuenta = this.fuente.cuentaEjecutable(cuentaId);
      if (cuenta === null) {
        for (const objetivo of objetivos) {
          descartes.push({
            cuentaId,
            etiqueta: cuentaId,
            lado: objetivo.lado,
            motivo: 'cuenta-desconocida',
            mensaje: 'La subcuenta ya no está registrada o no tiene credencial.'
          });
        }
        continue;
      }

      let abiertas: PosicionBitget[];
      try {
        const r = await obtenerPosiciones(this.cliente, cuenta.credencial, peticion.mercado);
        abiertas = r.datos;
      } catch (e) {
        /*
         * No se pudo leer que tiene abierto. No se descarta ni se cierra a
         * ciegas: se marca como no comprobable y el operador decide. Cerrar sin
         * saber que hay es justo lo que esta funcion no debe hacer.
         */
        for (const objetivo of objetivos) {
          descartes.push({
            cuentaId,
            etiqueta: cuenta.etiqueta,
            lado: objetivo.lado,
            motivo: 'posiciones-ilegibles',
            mensaje: `No se pudo consultar qué tiene abierto: ${e instanceof Error ? e.message : String(e)}`
          });
        }
        continue;
      }

      for (const objetivo of objetivos) {
        const posicion = buscarPosicion(abiertas, peticion.simbolo, objetivo.lado);
        if (posicion === null) {
          descartes.push({
            cuentaId,
            etiqueta: cuenta.etiqueta,
            lado: objetivo.lado,
            motivo: 'sin-posicion',
            mensaje: `No hay ninguna posición ${objetivo.lado} abierta en ${peticion.simbolo}.`
          });
          continue;
        }

        entradas.push({
          cuentaId,
          etiqueta: cuenta.etiqueta,
          lado: objetivo.lado,
          clientOid: clientOidDe(id, indice, objetivo.lado),
          size: posicion.total,
          precioEntrada: posicion.openPriceAvg ?? null,
          margenLiberado: posicion.marginSize ?? null
        });
        indice += 1;
      }
    }

    return {
      id,
      mercado: peticion.mercado,
      simbolo: peticion.simbolo,
      entradas,
      descartes,
      creadoEn: this.ahora().toISOString()
    };
  }

  /* ---------------- planificacion del take profit ---------------- */

  /**
   * Calcula donde queda el Take Profit de cada posicion. **No coloca nada.**
   *
   * El porcentaje no define un precio por si solo: hace falta el precio de
   * entrada de esa posicion y su apalancamiento. Por eso hay que leer las
   * posiciones, igual que en el cierre, y por eso el mismo 35% da un precio
   * distinto en cada cuenta si sus entradas fueron distintas.
   *
   * El apalancamiento se toma **de la posicion**, no de la cuenta: es el que de
   * verdad se aplico al abrirla, y es el unico que hace que el porcentaje
   * signifique lo que el operador espera.
   */
  async planificarTakeProfit(peticion: PeticionTakeProfitLote): Promise<PlanTakeProfit> {
    if (peticion.objetivos.length === 0) {
      throw new ErrorPlan('sin-objetivos', 'No hay ninguna casilla seleccionada.');
    }

    const contrato = await this.contrato(peticion.mercado, peticion.simbolo);

    const id = randomUUID().replace(/-/g, '').slice(0, 12);
    const entradas: EntradaTakeProfit[] = [];
    const descartes: DescartePlan[] = [];

    const porCuenta = new Map<string, ObjetivoApertura[]>();
    for (const objetivo of peticion.objetivos) {
      const lista = porCuenta.get(objetivo.cuentaId) ?? [];
      lista.push(objetivo);
      porCuenta.set(objetivo.cuentaId, lista);
    }

    let indice = 0;
    for (const [cuentaId, objetivos] of porCuenta) {
      const cuenta = this.fuente.cuentaEjecutable(cuentaId);
      if (cuenta === null) {
        for (const objetivo of objetivos) {
          descartes.push({
            cuentaId,
            etiqueta: cuentaId,
            lado: objetivo.lado,
            motivo: 'cuenta-desconocida',
            mensaje: 'La subcuenta ya no está registrada o no tiene credencial.'
          });
        }
        continue;
      }

      let abiertas: PosicionBitget[];
      try {
        const r = await obtenerPosiciones(this.cliente, cuenta.credencial, peticion.mercado);
        abiertas = r.datos;
      } catch (e) {
        for (const objetivo of objetivos) {
          descartes.push({
            cuentaId,
            etiqueta: cuenta.etiqueta,
            lado: objetivo.lado,
            motivo: 'posiciones-ilegibles',
            mensaje: `No se pudo consultar qué tiene abierto: ${e instanceof Error ? e.message : String(e)}`
          });
        }
        continue;
      }

      for (const objetivo of objetivos) {
        const posicion = buscarPosicion(abiertas, peticion.simbolo, objetivo.lado);
        if (posicion === null) {
          descartes.push({
            cuentaId,
            etiqueta: cuenta.etiqueta,
            lado: objetivo.lado,
            motivo: 'sin-posicion',
            mensaje: `No hay ninguna posición ${objetivo.lado} abierta a la que ponerle Take Profit.`
          });
          continue;
        }

        const apalancamiento =
          Number(posicion.leverage ?? 0) || (apalancamientoVigente(cuenta, objetivo.lado) ?? 0);

        const calculo = precioTakeProfit({
          contrato,
          precioEntrada: posicion.openPriceAvg ?? '',
          lado: objetivo.lado,
          apalancamiento,
          porcentaje: peticion.porcentaje
        });

        if (!calculo.ok) {
          descartes.push({
            cuentaId,
            etiqueta: cuenta.etiqueta,
            lado: objetivo.lado,
            motivo: calculo.motivo,
            mensaje: calculo.mensaje
          });
          continue;
        }

        entradas.push({
          cuentaId,
          etiqueta: cuenta.etiqueta,
          lado: objetivo.lado,
          clientOid: clientOidDe(id, indice, objetivo.lado),
          precioDisparo: calculo.disparo.precioDisparo,
          precioEntrada: posicion.openPriceAvg ?? '',
          apalancamiento,
          movimientoPorcentaje: calculo.disparo.movimientoPorcentaje
        });
        indice += 1;
      }
    }

    return {
      id,
      mercado: peticion.mercado,
      simbolo: peticion.simbolo,
      porcentaje: peticion.porcentaje,
      entradas,
      descartes,
      creadoEn: this.ahora().toISOString()
    };
  }

  /* ---------------- planificacion de quitar el take profit ---------------- */

  /**
   * Averigua que Take Profit hay puesto en cada casilla. **No quita nada.**
   *
   * --------------------------------------------------------------------------
   * Por que se lee lo que hay en vez de recordar lo que se puso
   * --------------------------------------------------------------------------
   * El panel podria guardar el `clientOid` de cada Take Profit que coloco y
   * cancelar por ahi. Seria mas barato y estaria mal: el operador tambien pone
   * y quita Take Profit desde la app de Bitget, y esos planes el panel no los
   * conoce. Quitar «el que yo puse» dejaria puesto el otro, que es exactamente
   * el que el operador esta viendo en la pantalla cuando pide quitarlo.
   *
   * Asi que la verdad es la lista de planes de Bitget, y de ahi sale el
   * `orderId` que se cancela. Como efecto util, planificar ensena el precio al
   * que estaba puesto cada uno: el operador aprueba quitar algo concreto.
   *
   * Que no haya Take Profit no es un fallo, es un descarte: no habia nada que
   * quitar.
   */
  async planificarQuitarTakeProfit(
    peticion: PeticionQuitarTakeProfit
  ): Promise<PlanQuitarTakeProfit> {
    if (peticion.objetivos.length === 0) {
      throw new ErrorPlan('sin-objetivos', 'No hay ninguna casilla seleccionada.');
    }

    const id = randomUUID().replace(/-/g, '').slice(0, 12);
    const entradas: EntradaQuitarTakeProfit[] = [];
    const descartes: DescartePlan[] = [];

    const porCuenta = new Map<string, ObjetivoApertura[]>();
    for (const objetivo of peticion.objetivos) {
      const lista = porCuenta.get(objetivo.cuentaId) ?? [];
      lista.push(objetivo);
      porCuenta.set(objetivo.cuentaId, lista);
    }

    let indice = 0;
    for (const [cuentaId, objetivos] of porCuenta) {
      const cuenta = this.fuente.cuentaEjecutable(cuentaId);
      if (cuenta === null) {
        for (const objetivo of objetivos) {
          descartes.push({
            cuentaId,
            etiqueta: cuentaId,
            lado: objetivo.lado,
            motivo: 'cuenta-desconocida',
            mensaje: 'La subcuenta ya no está registrada o no tiene credencial.'
          });
        }
        continue;
      }

      let puestos: PlanPendiente[];
      try {
        puestos = await planesPendientes(this.cliente, cuenta.credencial, peticion.mercado);
      } catch (e) {
        for (const objetivo of objetivos) {
          descartes.push({
            cuentaId,
            etiqueta: cuenta.etiqueta,
            lado: objetivo.lado,
            motivo: 'planes-ilegibles',
            mensaje: `No se pudo consultar qué Take Profit tiene puestos: ${e instanceof Error ? e.message : String(e)}`
          });
        }
        continue;
      }

      for (const objetivo of objetivos) {
        const puesto = buscarTakeProfit(puestos, peticion.simbolo, objetivo.lado);

        if (puesto === null) {
          descartes.push({
            cuentaId,
            etiqueta: cuenta.etiqueta,
            lado: objetivo.lado,
            motivo: 'sin-take-profit',
            mensaje: `La posición ${objetivo.lado} no tiene ningún Take Profit puesto.`
          });
          continue;
        }

        entradas.push({
          cuentaId,
          etiqueta: cuenta.etiqueta,
          lado: objetivo.lado,
          clientOid: clientOidDe(id, indice, objetivo.lado),
          orderId: puesto.orderId ?? '',
          precioDisparo: puesto.triggerPrice ?? ''
        });
        indice += 1;
      }
    }

    return {
      id,
      mercado: peticion.mercado,
      simbolo: peticion.simbolo,
      entradas,
      descartes,
      creadoEn: this.ahora().toISOString()
    };
  }

  /* ---------------- planificacion de agregar margen ---------------- */

  /**
   * Calcula cuanto margen se anade a cada posicion. **No envia nada.**
   *
   * Es la funcion mas delicada de las cinco y por eso comprueba mas cosas antes
   * de enviar. El cliente lo dijo sin rodeos: de todo lo que puede salir mal, el
   * margen es lo critico. Aqui eso se traduce en tres puertas:
   *
   *  1. Que exista la posicion. Anadir margen a lo que no existe no es un fallo
   *     que haya que arreglar: es que no habia nada.
   *  2. Que la posicion este en **margen aislado**. Bitget lo exige, y decirlo
   *     aqui evita una peticion y un mensaje incomprensible.
   *  3. Que la cuenta tenga saldo. Es dinero nuevo saliendo del disponible, y
   *     enterarse a mitad de un lote de cien es enterarse tarde.
   */
  async planificarMargen(peticion: PeticionMargen): Promise<PlanMargen> {
    if (peticion.objetivos.length === 0) {
      throw new ErrorPlan('sin-objetivos', 'No hay ninguna casilla seleccionada.');
    }

    const cantidad = new Decimal(peticion.cantidad || '0');
    if (!cantidad.isFinite() || cantidad.lessThanOrEqualTo(0)) {
      throw new ErrorPlan(
        'cantidad-invalida',
        'El margen a agregar debe ser un número mayor que cero.'
      );
    }

    const id = randomUUID().replace(/-/g, '').slice(0, 12);
    const entradas: EntradaMargen[] = [];
    const descartes: DescartePlan[] = [];

    const porCuenta = new Map<string, ObjetivoApertura[]>();
    for (const objetivo of peticion.objetivos) {
      const lista = porCuenta.get(objetivo.cuentaId) ?? [];
      lista.push(objetivo);
      porCuenta.set(objetivo.cuentaId, lista);
    }

    let indice = 0;
    for (const [cuentaId, objetivos] of porCuenta) {
      const cuenta = this.fuente.cuentaEjecutable(cuentaId);
      if (cuenta === null) {
        for (const objetivo of objetivos) {
          descartes.push({
            cuentaId,
            etiqueta: cuentaId,
            lado: objetivo.lado,
            motivo: 'cuenta-desconocida',
            mensaje: 'La subcuenta ya no está registrada o no tiene credencial.'
          });
        }
        continue;
      }

      let abiertas: PosicionBitget[];
      try {
        const r = await obtenerPosiciones(this.cliente, cuenta.credencial, peticion.mercado);
        abiertas = r.datos;
      } catch (e) {
        for (const objetivo of objetivos) {
          descartes.push({
            cuentaId,
            etiqueta: cuenta.etiqueta,
            lado: objetivo.lado,
            motivo: 'posiciones-ilegibles',
            mensaje: `No se pudo consultar qué tiene abierto: ${e instanceof Error ? e.message : String(e)}`
          });
        }
        continue;
      }

      /*
       * El saldo se reparte entre las casillas de esta cuenta. Con long y short
       * de la misma subcuenta, el saldo tiene que dar para las dos, no para una.
       */
      let disponible = new Decimal(cuenta.saldoDisponible || '0');

      for (const objetivo of objetivos) {
        const posicion = buscarPosicion(abiertas, peticion.simbolo, objetivo.lado);
        if (posicion === null) {
          descartes.push({
            cuentaId,
            etiqueta: cuenta.etiqueta,
            lado: objetivo.lado,
            motivo: 'sin-posicion',
            mensaje: `No hay ninguna posición ${objetivo.lado} abierta a la que agregarle margen.`
          });
          continue;
        }

        if ((posicion.marginMode ?? cuenta.modoMargen) !== 'isolated') {
          descartes.push({
            cuentaId,
            etiqueta: cuenta.etiqueta,
            lado: objetivo.lado,
            motivo: 'margen-cruzado',
            mensaje:
              'La posición está en margen cruzado y Bitget solo permite agregar margen en aislado.'
          });
          continue;
        }

        if (disponible.lessThan(cantidad)) {
          descartes.push({
            cuentaId,
            etiqueta: cuenta.etiqueta,
            lado: objetivo.lado,
            motivo: 'margen-insuficiente',
            mensaje: `Saldo insuficiente: quedan ${disponible.toFixed()} y hacen falta ${cantidad.toFixed()}.`
          });
          continue;
        }
        disponible = disponible.minus(cantidad);

        const actual = new Decimal(posicion.marginSize ?? '0');
        entradas.push({
          cuentaId,
          etiqueta: cuenta.etiqueta,
          lado: objetivo.lado,
          clientOid: clientOidDe(id, indice, objetivo.lado),
          cantidad: cantidad.toFixed(),
          margenActual: actual.toFixed(),
          margenResultante: actual.plus(cantidad).toFixed()
        });
        indice += 1;
      }
    }

    return {
      id,
      mercado: peticion.mercado,
      simbolo: peticion.simbolo,
      cantidad: cantidad.toFixed(),
      totalComprometido: cantidad.times(entradas.length).toFixed(),
      entradas,
      descartes,
      creadoEn: this.ahora().toISOString()
    };
  }

  /* ---------------- planificacion del apalancamiento ---------------- */

  /**
   * Prepara el ajuste de apalancamiento. **No envia nada.**
   *
   * A diferencia de las otras cuatro, **no hace falta que haya posicion**: es
   * configuracion de la cuenta y se deja puesta antes de operar. Por eso
   * tampoco consulta posiciones, y un lote de cien cuentas son cien peticiones
   * y ninguna consulta previa.
   *
   * Lo unico que se comprueba es el rango del simbolo, que sale del catalogo ya
   * cacheado: fuera de rango Bitget responde «Leverage ratio exceeded the set
   * limit», y es una peticion que no hace falta gastar para saber la respuesta.
   */
  async planificarApalancamiento(peticion: PeticionApalancamiento): Promise<PlanApalancamiento> {
    if (peticion.objetivos.length === 0) {
      throw new ErrorPlan('sin-objetivos', 'No hay ninguna casilla seleccionada.');
    }

    const contrato = await this.contrato(peticion.mercado, peticion.simbolo);
    const minimo = Number(contrato.minLever);
    const maximo = Number(contrato.maxLever);

    if (
      !Number.isFinite(peticion.apalancamiento) ||
      peticion.apalancamiento < minimo ||
      peticion.apalancamiento > maximo
    ) {
      throw new ErrorPlan(
        'apalancamiento-fuera-de-rango',
        `El apalancamiento de ${peticion.simbolo} debe estar entre ${contrato.minLever}x y ${contrato.maxLever}x.`
      );
    }

    const id = randomUUID().replace(/-/g, '').slice(0, 12);
    const entradas: EntradaApalancamiento[] = [];
    const descartes: DescartePlan[] = [];

    peticion.objetivos.forEach((objetivo, indice) => {
      const cuenta = this.fuente.cuentaEjecutable(objetivo.cuentaId);
      if (cuenta === null) {
        descartes.push({
          cuentaId: objetivo.cuentaId,
          etiqueta: objetivo.cuentaId,
          lado: objetivo.lado,
          motivo: 'cuenta-desconocida',
          mensaje: 'La subcuenta ya no está registrada o no tiene credencial.'
        });
        return;
      }

      entradas.push({
        cuentaId: cuenta.cuentaId,
        etiqueta: cuenta.etiqueta,
        lado: objetivo.lado,
        clientOid: clientOidDe(id, indice, objetivo.lado),
        apalancamiento: peticion.apalancamiento,
        apalancamientoActual: apalancamientoVigente(cuenta, objetivo.lado)
      });
    });

    return {
      id,
      mercado: peticion.mercado,
      simbolo: peticion.simbolo,
      apalancamiento: peticion.apalancamiento,
      entradas,
      descartes,
      creadoEn: this.ahora().toISOString()
    };
  }

  /* ---------------- ejecucion ---------------- */

  /**
   * Envia un plan de apertura ya aprobado.
   *
   * `soloEstos` permite reintentar exclusivamente las cuentas que fallaron,
   * reutilizando sus `clientOid`: si alguna habia entrado sin que llegara la
   * respuesta, Bitget rechaza el repetido y no se duplica nada.
   */
  async ejecutar(plan: PlanApertura, soloEstos?: readonly string[]): Promise<Lote> {
    return this.correrLote(plan, 'abrir', soloEstos, {
      enviar: async (cuenta, entrada) => {
        const r = await abrirPosicion(this.cliente, cuenta.credencial, {
          mercado: plan.mercado,
          simbolo: plan.simbolo,
          lado: entrada.lado,
          modoMargen: entrada.modoMargen,
          size: entrada.size,
          precioLimite: plan.precioLimite,
          clientOid: entrada.clientOid
        });
        return { ordenId: r.datos.orderId, mensaje: null };
      },

      /*
       * Se envio y no se sabe si entro. Se pregunta por el `clientOid`:
       * reintentar podria duplicar la posicion y descartar podria dejar una
       * posicion abierta que nadie vigila.
       */
      resolver: async (cuenta, entrada) => {
        const detalle = await consultarOrden(
          this.cliente,
          cuenta.credencial,
          plan.mercado,
          plan.simbolo,
          entrada.clientOid
        );

        if (detalle === null) {
          return {
            estado: 'fallo',
            ordenId: null,
            mensaje:
              'Se cortó la conexión al enviar y Bitget no registró la orden: no se abrió nada. Se puede reintentar.'
          };
        }

        return {
          estado: 'exito',
          ordenId: detalle.orderId,
          mensaje: 'Se cortó la conexión al enviar, pero la orden sí había entrado.'
        };
      }
    });
  }

  /**
   * Envia un plan de cierre ya aprobado.
   *
   * Dos diferencias con la apertura, y las dos importan:
   *
   * **Reintentar un cierre es inofensivo.** Si la primera orden entro, la
   * segunda encuentra la posicion cerrada y Bitget responde «no hay nada que
   * cerrar», que aqui es un exito y no un fallo. Lo contrario -no reintentar-
   * si es peligroso: deja abierta una posicion que el operador cree cerrada.
   *
   * **Lo indeterminado se resuelve mirando la posicion, no la orden.** Es la
   * verdad de fondo: si ya no hay posicion, el cierre ocurrio, sin importar que
   * numero de orden le pusiera el exchange.
   */
  async ejecutarCierre(plan: PlanCierre, soloEstos?: readonly string[]): Promise<Lote> {
    return this.correrLote(plan, 'cerrar', soloEstos, {
      enviar: async (cuenta, entrada) => {
        const r = await cerrarPosicion(this.cliente, cuenta.credencial, {
          mercado: plan.mercado,
          simbolo: plan.simbolo,
          lado: entrada.lado,
          clientOid: entrada.clientOid
        });

        /*
         * El endpoint responde con dos listas. Que la peticion tenga codigo de
         * exito no basta: si la posicion cayo en `failureList`, no se cerro, y
         * darla por buena dejaria al operador creyendo que ya no tiene riesgo.
         */
        const fallo = r.datos.failureList?.[0];
        if (fallo !== undefined) {
          throw new ErrorBitget(fallo.errorMsg ?? 'Bitget rechazó el cierre de esta posición.', {
            clase: 'fatal-cuenta',
            codigo: fallo.errorCode ?? null,
            mensajeOriginal: fallo.errorMsg ?? null,
            httpStatus: null,
            reintentarEnMs: null
          });
        }

        return { ordenId: r.datos.successList?.[0]?.orderId ?? null, mensaje: null };
      },

      resolver: async (cuenta, entrada) => {
        const r = await obtenerPosiciones(this.cliente, cuenta.credencial, plan.mercado);
        const sigueAbierta = buscarPosicion(r.datos, plan.simbolo, entrada.lado);

        if (sigueAbierta === null) {
          return {
            estado: 'exito',
            ordenId: null,
            mensaje: 'Se cortó la conexión al enviar, pero la posición quedó cerrada.'
          };
        }

        return {
          estado: 'fallo',
          ordenId: null,
          mensaje: 'Se cortó la conexión al enviar y la posición sigue abierta. Se puede reintentar.'
        };
      }
    });
  }

  /**
   * Coloca los Take Profit de un plan ya aprobado.
   *
   * Reintentar es seguro por partida doble: el `clientOid` impide que un
   * reenvio deje dos Take Profit sobre la misma posicion, y lo indeterminado se
   * resuelve mirando **los planes que Bitget tiene puestos**, que es la verdad
   * de fondo y no depende de que respuesta llegara.
   */
  async ejecutarTakeProfit(plan: PlanTakeProfit, soloEstos?: readonly string[]): Promise<Lote> {
    return this.correrLote(plan, 'take-profit', soloEstos, {
      enviar: async (cuenta, entrada) => {
        const r = await colocarTakeProfit(this.cliente, cuenta.credencial, {
          mercado: plan.mercado,
          simbolo: plan.simbolo,
          lado: entrada.lado,
          precioDisparo: entrada.precioDisparo,
          clientOid: entrada.clientOid
        });
        return { ordenId: r.datos.orderId ?? null, mensaje: null };
      },

      resolver: async (cuenta, entrada) => {
        const planes = await planesPendientes(this.cliente, cuenta.credencial, plan.mercado);
        const puesto = planes.find((p) => p.clientOid === entrada.clientOid);

        if (puesto !== undefined) {
          return {
            estado: 'exito',
            ordenId: puesto.orderId ?? null,
            mensaje: 'Se cortó la conexión al enviar, pero el Take Profit sí quedó puesto.'
          };
        }

        return {
          estado: 'fallo',
          ordenId: null,
          mensaje:
            'Se cortó la conexión al enviar y el Take Profit no aparece en Bitget: la posición sigue sin él. Se puede reintentar.'
        };
      }
    });
  }

  /**
   * Quita los Take Profit de un plan aprobado.
   *
   * --------------------------------------------------------------------------
   * Aqui el codigo de exito de Bitget no significa nada
   * --------------------------------------------------------------------------
   * Verificado el 18/08/2026: cancelar un plan que ya no existe responde
   * `00000 success` con las dos listas vacias. Si se diera por bueno, el
   * operador veria «quitado» sin que se hubiera quitado nada, que es la peor de
   * las respuestas posibles cuando lo que decide es si esa posicion tiene o no
   * proteccion.
   *
   * Por eso las tres respuestas se distinguen:
   *
   *   en `successList`   se quito
   *   en `failureList`   Bitget lo rechazo, y dice por que
   *   en ninguna lista   ya no estaba puesto -> omitida, no exito
   *
   * Reintentar es inofensivo: quitar dos veces el mismo Take Profit deja la
   * posicion igual, y lo indeterminado se resuelve mirando **si el plan sigue
   * en Bitget**, que es la verdad de fondo.
   */
  async ejecutarQuitarTakeProfit(
    plan: PlanQuitarTakeProfit,
    soloEstos?: readonly string[]
  ): Promise<Lote> {
    return this.correrLote(plan, 'quitar-take-profit', soloEstos, {
      enviar: async (cuenta, entrada) => {
        const r = await cancelarPlan(this.cliente, cuenta.credencial, {
          mercado: plan.mercado,
          simbolo: plan.simbolo,
          orderId: entrada.orderId
        });

        const fallo = r.datos.failureList?.[0];
        if (fallo !== undefined) {
          throw new ErrorBitget(fallo.errorMsg ?? 'Bitget rechazó quitar este Take Profit.', {
            clase: 'fatal-cuenta',
            codigo: fallo.errorCode ?? null,
            mensajeOriginal: fallo.errorMsg ?? null,
            httpStatus: null,
            reintentarEnMs: null
          });
        }

        const quitado = r.datos.successList?.[0];
        if (quitado === undefined) {
          throw new ErrorBitget('Ese Take Profit ya no estaba puesto.', {
            clase: 'omitida',
            codigo: null,
            mensajeOriginal: null,
            httpStatus: null,
            reintentarEnMs: null
          });
        }

        return { ordenId: quitado.orderId ?? entrada.orderId, mensaje: 'Take Profit quitado' };
      },

      resolver: async (cuenta, entrada) => {
        const puestos = await planesPendientes(this.cliente, cuenta.credencial, plan.mercado);
        const sigue = puestos.some((p) => p.orderId === entrada.orderId);

        if (!sigue) {
          return {
            estado: 'exito',
            ordenId: entrada.orderId,
            mensaje: 'Se cortó la conexión al enviar, pero el Take Profit sí quedó quitado.'
          };
        }

        return {
          estado: 'fallo',
          ordenId: null,
          mensaje:
            'Se cortó la conexión al enviar y el Take Profit sigue puesto. Se puede reintentar.'
        };
      }
    });
  }

  /**
   * Agrega el margen de un plan aprobado.
   *
   * --------------------------------------------------------------------------
   * La unica de las cinco sin identificador propio
   * --------------------------------------------------------------------------
   * `set-margin` no acepta `clientOid`, asi que aqui **no existe** la red de
   * seguridad que en las otras cuatro impide que un reenvio se ejecute dos
   * veces. Anadir margen dos veces no es catastrofico -aleja la liquidacion-
   * pero compromete el doble de dinero del que el operador aprobo, y eso no
   * puede pasar en silencio.
   *
   * De ahi que lo indeterminado se resuelva **releyendo el margen de la
   * posicion** y comparandolo con el que deberia haber quedado. Es la unica
   * forma de saberlo sin arriesgarse a duplicar.
   */
  async ejecutarMargen(plan: PlanMargen, soloEstos?: readonly string[]): Promise<Lote> {
    return this.correrLote(plan, 'agregar-margen', soloEstos, {
      enviar: async (cuenta, entrada) => {
        await ajustarMargen(this.cliente, cuenta.credencial, {
          simbolo: plan.simbolo,
          productType: plan.mercado.productType,
          marginCoin: plan.mercado.marginCoin,
          cantidad: entrada.cantidad,
          lado: entrada.lado
        });
        return { ordenId: null, mensaje: `Margen ${entrada.margenActual} → ${entrada.margenResultante}` };
      },

      resolver: async (cuenta, entrada) => {
        const r = await obtenerPosiciones(this.cliente, cuenta.credencial, plan.mercado);
        const posicion = buscarPosicion(r.datos, plan.simbolo, entrada.lado);
        const ahora = new Decimal(posicion?.marginSize ?? '0');

        /*
         * Se compara contra el margen esperado y no contra el anterior: entre
         * medias el precio puede haber movido el margen unos centimos, asi que
         * se acepta un margen del tamano esperado o mayor.
         */
        if (ahora.greaterThanOrEqualTo(entrada.margenResultante)) {
          return {
            estado: 'exito',
            ordenId: null,
            mensaje: 'Se cortó la conexión al enviar, pero el margen sí quedó agregado.'
          };
        }

        return {
          estado: 'fallo',
          ordenId: null,
          mensaje:
            `Se cortó la conexión al enviar y el margen sigue en ${ahora.toFixed()}: no se agregó. Se puede reintentar.`
        };
      }
    });
  }

  /**
   * Fija el apalancamiento de un plan aprobado.
   *
   * La mas benigna de las cinco: fijar 150x dos veces deja 150x, asi que un
   * reenvio no tiene consecuencia y lo indeterminado se resuelve simplemente
   * leyendo como quedo la cuenta.
   */
  async ejecutarApalancamiento(
    plan: PlanApalancamiento,
    soloEstos?: readonly string[]
  ): Promise<Lote> {
    return this.correrLote(plan, 'apalancamiento', soloEstos, {
      enviar: async (cuenta, entrada) => {
        const r = await fijarApalancamiento(this.cliente, cuenta.credencial, {
          simbolo: plan.simbolo,
          productType: plan.mercado.productType,
          marginCoin: plan.mercado.marginCoin,
          apalancamiento: entrada.apalancamiento,
          lado: entrada.lado
        });

        const puesto =
          entrada.lado === 'long' ? r.datos.longLeverage : r.datos.shortLeverage;
        return { ordenId: null, mensaje: `Apalancamiento ${puesto ?? entrada.apalancamiento}x` };
      },

      resolver: async (cuenta, entrada) => {
        const r = await obtenerCuentaSimbolo(
          this.cliente,
          cuenta.credencial,
          plan.simbolo,
          plan.mercado.productType,
          plan.mercado.marginCoin
        );
        const vigente =
          cuenta.modoMargen === 'crossed'
            ? r.datos.crossedMarginLeverage
            : entrada.lado === 'long'
              ? r.datos.isolatedLongLever
              : r.datos.isolatedShortLever;

        if (Number(vigente) === entrada.apalancamiento) {
          return {
            estado: 'exito',
            ordenId: null,
            mensaje: 'Se cortó la conexión al enviar, pero el apalancamiento sí quedó fijado.'
          };
        }

        return {
          estado: 'fallo',
          ordenId: null,
          mensaje: `Se cortó la conexión al enviar y la cuenta sigue a ${vigente ?? '?'}x. Se puede reintentar sin riesgo.`
        };
      }
    });
  }

  /* ---------------- maquinaria comun ---------------- */

  /**
   * El recorrido de un lote, sea de la accion que sea.
   *
   * Bloques, cerrojo contra el doble envio, informe por cuenta, reintento de lo
   * transitorio y resolucion de lo indeterminado son identicos para las cinco
   * funciones del panel. Lo unico que cambia es que se envia y como se averigua
   * el desenlace cuando no llego respuesta, y eso es lo que entra por
   * `maniobra`.
   */
  private async correrLote<E extends EntradaLote>(
    plan: PlanBase<E>,
    accion: AccionLote,
    soloEstos: readonly string[] | undefined,
    maniobra: Maniobra<E>
  ): Promise<Lote> {
    if (this.enVuelo.has(plan.id)) {
      throw new ErrorPlan(
        'plan-en-vuelo',
        'Este lote ya se está enviando. Espere a que termine antes de repetirlo.'
      );
    }
    this.enVuelo.add(plan.id);

    const filtro = soloEstos === undefined ? null : new Set(soloEstos);
    const entradas = filtro === null ? plan.entradas : plan.entradas.filter((e) => filtro.has(e.clientOid));

    const lote: Lote = {
      id: plan.id,
      accion,
      simbolo: plan.simbolo,
      iniciadoEn: this.ahora().toISOString(),
      terminadoEn: null,
      jobs: [
        ...entradas.map(
          (e): Job => ({
            cuentaId: e.cuentaId,
            lado: e.lado,
            etiqueta: e.etiqueta,
            clientOid: e.clientOid,
            estado: 'pendiente',
            codigoBitget: null,
            mensaje: null,
            ordenId: null
          })
        ),
        /*
         * Los descartes entran en el informe como `omitida`. No son fallos
         * -nunca se intentaron- pero tienen que verse: una cuenta que no operó
         * y no aparece en ninguna lista es una cuenta cuyo estado el operador
         * va a suponer, y suponer es justo lo que no debe hacer.
         */
        ...plan.descartes.map(
          (d): Job => ({
            cuentaId: d.cuentaId,
            lado: d.lado,
            etiqueta: d.etiqueta,
            clientOid: '',
            estado: 'omitida',
            codigoBitget: null,
            mensaje: d.mensaje,
            ordenId: null
          })
        )
      ]
    };

    const porOid = new Map(lote.jobs.filter((j) => j.clientOid !== '').map((j) => [j.clientOid, j]));

    try {
      for (let i = 0; i < entradas.length; i += this.tamanoBloque) {
        const bloque = entradas.slice(i, i + this.tamanoBloque);

        for (const entrada of bloque) {
          const job = porOid.get(entrada.clientOid);
          if (job !== undefined) job.estado = 'enviando';
        }
        this.alProgresar(lote);

        await Promise.all(
          bloque.map(async (entrada) => {
            const job = porOid.get(entrada.clientOid);
            if (job === undefined) return;
            await this.enviarUna(entrada, job, maniobra);
            this.alProgresar(lote);
          })
        );
      }
    } finally {
      lote.terminadoEn = this.ahora().toISOString();
      this.enVuelo.delete(plan.id);
    }

    this.alProgresar(lote);
    return lote;
  }

  /**
   * Un objetivo. Nunca lanza: el fallo se escribe en su trabajo.
   *
   * Es lo que sostiene la promesa de que un error en una cuenta no rompe el
   * lote. Si esta funcion pudiera lanzar, un `Promise.all` de un bloque
   * abortaria los demas envios de ese bloque.
   */
  private async enviarUna<E extends EntradaLote>(
    entrada: E,
    job: Job,
    maniobra: Maniobra<E>
  ): Promise<void> {
    const cuenta = this.fuente.cuentaEjecutable(entrada.cuentaId);
    if (cuenta === null) {
      job.estado = 'fallo';
      job.mensaje = 'La subcuenta dejó de estar disponible antes de enviar la orden.';
      return;
    }

    for (let intento = 1; ; intento += 1) {
      try {
        const r = await maniobra.enviar(cuenta, entrada);
        job.estado = 'exito';
        job.ordenId = r.ordenId;
        job.mensaje = r.mensaje;
        return;
      } catch (e) {
        if (!(e instanceof ErrorBitget)) {
          job.estado = 'fallo';
          job.mensaje = e instanceof Error ? e.message : String(e);
          return;
        }

        job.codigoBitget = e.codigo;

        /*
         * `omitida` no es un fallo: es el exchange diciendo que no habia nada
         * que hacer en esa cuenta. El caso tipico es cerrar una posicion que ya
         * estaba cerrada, y contarlo como error mandaria al operador a buscar
         * un problema que no existe.
         */
        if (e.clase === 'omitida') {
          job.estado = 'omitida';
          job.mensaje = e.message;
          return;
        }

        /*
         * Transitorio: Bitget dijo «ahora no» y por tanto la orden **no** entro.
         * Reintentar es seguro porque se reenvia el mismo `clientOid`: si por lo
         * que fuera si hubiera entrado, el exchange rechaza el repetido en vez
         * de ejecutar la operacion dos veces.
         */
        if (e.clase === 'retryable' && intento <= this.reintentosMaximos) {
          await this.dormir(e.reintentarEnMs ?? esperaReintento(intento));
          continue;
        }

        if (e.clase !== 'indeterminada') {
          job.estado = 'fallo';
          job.mensaje = e.message;
          return;
        }

        try {
          const resolucion = await maniobra.resolver(cuenta, entrada);
          job.estado = resolucion.estado;
          job.ordenId = resolucion.ordenId;
          job.mensaje = resolucion.mensaje;
        } catch {
          /*
           * Ni siquiera se pudo comprobar. Queda `indeterminada` a proposito: es
           * la unica etiqueta honesta, y el panel no debe ofrecer reintentarla
           * hasta poder comprobarla.
           */
          job.estado = 'indeterminada';
          job.mensaje =
            'Se envió la orden y no se pudo confirmar el resultado. No se reintenta automáticamente: compruebe la posición en Bitget.';
        }
        return;
      }
    }
  }
}


/** Recuento por estado, para el informe que ve el operador. */
export function resumirLote(lote: Lote): Record<Job['estado'], number> {
  const r: Record<Job['estado'], number> = {
    pendiente: 0,
    enviando: 0,
    exito: 0,
    fallo: 0,
    omitida: 0,
    indeterminada: 0
  };
  for (const job of lote.jobs) r[job.estado] += 1;
  return r;
}
