/**
 * Apalancamiento con dos cuentas: por que cambia en una y no en la otra.
 *
 * ==========================================================================
 * De donde sale este archivo
 * ==========================================================================
 * Un cliente reporto que, operando con dos cuentas principales, al aplicar el
 * apalancamiento **solo cambiaba en la A**. No se sabia si era un fallo del
 * panel o una lectura equivocada suya, asi que estas pruebas estan escritas
 * para **discriminar**, no para confirmar: cada una nombra que hipotesis deja
 * viva y cual mata.
 *
 * El bucle multicuenta no era el culpable -`correrLote` recorre todas las
 * entradas con `Promise.all` por bloques-. Lo que separa a la A de la B es la
 * **ficha** `modoMargen` que `FuenteCuentas` le entrega al motor: la ficha
 * guarda el modo del **primer simbolo del mercado** y solo se refresca al
 * verificar la credencial, asi que dos cuentas con el mismo modo real en el
 * simbolo que se opera pueden llegar aqui con fichas distintas.
 *
 * De ahi que no hagan falta dos cuentas de Bitget para reproducirlo: basta con
 * dos fichas.
 *
 * ==========================================================================
 * Que hace Bitget con la forma equivocada: lo medido y lo supuesto
 * ==========================================================================
 * Con la ficha equivocada se manda la forma equivocada, y hay dos maneras de
 * que eso salga mal, con sintomas **distintos**:
 *
 *   `00000` sin efecto  -> la casilla sale en EXITO sin haber cambiado nada.
 *   rechazo             -> la casilla sale en FALLO.
 *
 * El primero se observo contra la API real el 05/09/2026 -simbolo cruzado,
 * peticion con `holdSide`- y es el que el motor aprendio a detectar releyendo
 * el campo del modo que Bitget declara.
 *
 * El segundo es el que ESTE archivo simula, y hay que ser exacto sobre su
 * estatus: **no se ha reproducido contra Bitget**. La tabla de verdad que
 * levanta `test/fisica/apalancamiento-dos-cuentas.test.ts` se rellena entera
 * -los dos modos por las dos formas- y el 10/09/2026, sobre la cuenta demo en
 * SBTCSUSDT y en modo cobertura, las cuatro celdas salieron «aceptada y
 * cambia». Aqui se simula igualmente porque el rechazo puede llegar por otras
 * vias -un 429 agotado, un corte, una superficie V3 que pide otra cosa- y
 * porque un bucle que no sobrevive a el es un bucle que no prueba la segunda
 * forma, que era el defecto.
 *
 * Dicho de otro modo: el caso 6 vigila una propiedad del motor, no un
 * comportamiento conocido del exchange.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClienteBitget } from '@main/bitget/rest/client';
import { LimitadorPeticiones } from '@main/execution/rate-limiter';
import { MERCADO_SIMULADO } from '@main/bitget/mercado';
import type { Job, Lado, Lote } from '@shared/types';
import {
  MotorLotes,
  resumirLote,
  type CuentaEjecutable,
  type FuenteCuentas
} from '@main/execution/motor-lotes';
import {
  iniciarExchangeSimulado,
  sobreError,
  sobreOk,
  type ExchangeSimulado,
  type Respuesta
} from '../mock-exchange/servidor';

const SIMBOLO = 'SBTCSUSDT';
const OBJETIVO = 125;

const CONTRATO = {
  symbol: SIMBOLO,
  baseCoin: 'SBTC',
  quoteCoin: 'SUSDT',
  minTradeNum: '0.0001',
  volumePlace: '4',
  pricePlace: '1',
  priceEndStep: '1',
  sizeMultiplier: '0.0001',
  minTradeUSDT: '5',
  minLever: '1',
  maxLever: '125',
  maxMarketOrderQty: '220',
  maxOrderQty: '1200',
  symbolStatus: 'normal'
};

type ModoMargen = 'isolated' | 'crossed';

/**
 * Cuentas con ficha propia.
 *
 * La ficha es lo unico que las distingue: las tres comparten mercado, simbolo
 * y objetivo. Si el resultado del lote depende de ella, el problema esta en la
 * ficha y no en la cuenta.
 */
class CuentasConFicha implements FuenteCuentas {
  private readonly mapa = new Map<string, CuentaEjecutable>();

  constructor(fichas: Record<string, ModoMargen>) {
    for (const [id, modo] of Object.entries(fichas)) {
      this.mapa.set(id, {
        cuentaId: id,
        etiqueta: id.toUpperCase(),
        credencial: { apiKey: `key_${id}`, secretKey: 'secreto', passphrase: 'frase' },
        saldoDisponible: '3000',
        modoMargen: modo,
        apalancamiento: { long: 10, short: 10, cruzado: 10 }
      });
    }
  }

  /** Cuentas que existen pero que Bitget esta migrando a UTA. */
  private readonly migrando = new Set<string>();

  cuentaEjecutable(cuentaId: string): CuentaEjecutable | null {
    if (this.migrando.has(cuentaId)) return null;
    return this.mapa.get(cuentaId) ?? null;
  }

  motivoNoEjecutable(cuentaId: string): 'transicion' | 'bloqueada' | 'desconocida' {
    return this.migrando.has(cuentaId) ? 'transicion' : 'desconocida';
  }

  enTransicion(cuentaId: string): void {
    this.migrando.add(cuentaId);
  }

  objetivos(lado: Lado = 'long'): { cuentaId: string; lado: Lado }[] {
    return [...this.mapa.keys()].map((cuentaId) => ({ cuentaId, lado }));
  }
}

/** Una peticion de `set-leverage` tal y como salio, con la cuenta que la firmo. */
interface Envio {
  cuenta: string;
  holdSide: string | undefined;
  leverage: string;
}

let exchange: ExchangeSimulado;
let cliente: ClienteBitget;
let envios: Envio[];

/**
 * Un exchange que se comporta como Bitget para un simbolo en el modo indicado.
 *
 * Las cuatro celdas de la tabla de verdad estan aqui, y son lo unico que estas
 * pruebas dan por sabido del exchange. El caso cruzado -acepta con `holdSide`
 * y no cambia el cruzado- se verifico contra la API el 05/09/2026. El rechazo
 * en aislado **no** se ha observado: ver la cabecera. Lo que lo mantiene
 * honesto es que `test/fisica/apalancamiento-dos-cuentas.test.ts` rellena la
 * tabla de verdad contra Bitget cada vez que se corre, e imprime lo que salga.
 */
function exchangeConSimboloEn(
  modoInicial: ModoMargen,
  opciones: { rechazarSiempre?: boolean; soloRechazaA?: string } = {}
): { cambiarModoA(modo: ModoMargen): void } {
  /* El estado del simbolo, que es lo que las respuestas tienen que reflejar. */
  const nivel: Record<string, { aislado: number; cruzado: number }> = {};
  const de = (cuenta: string): { aislado: number; cruzado: number } =>
    (nivel[cuenta] ??= { aislado: 10, cruzado: 10 });
  let modoReal = modoInicial;

  exchange.responderCon((p) => {
    const apiKey = String(p.cabeceras['access-key'] ?? '');
    const cuenta = apiKey.replace(/^key_/, '');

    if (p.url.startsWith('/api/v2/mix/market/contracts')) return { cuerpo: sobreOk([CONTRATO]) };

    if (p.url.startsWith('/api/v2/mix/account/account')) {
      const n = de(cuenta);
      return {
        cuerpo: sobreOk({
          marginCoin: 'SUSDT',
          available: '3000',
          accountEquity: '3000',
          marginMode: modoReal,
          posMode: 'hedge_mode',
          isolatedLongLever: n.aislado,
          isolatedShortLever: n.aislado,
          crossedMarginLeverage: n.cruzado
        })
      };
    }

    if (!p.url.startsWith('/api/v2/mix/account/set-leverage')) return null;

    const cuerpo = JSON.parse(p.cuerpo) as Record<string, unknown>;
    const holdSide = cuerpo['holdSide'] as string | undefined;
    const leverage = String(cuerpo['leverage']);
    envios.push({ cuenta, holdSide, leverage });

    if (opciones.rechazarSiempre === true) {
      return { cuerpo: sobreError('40019', 'param holdSide error') } as Respuesta;
    }
    if (opciones.soloRechazaA === cuenta) {
      return { cuerpo: sobreError('40019', 'param holdSide error') } as Respuesta;
    }

    const n = de(cuenta);

    if (modoReal === 'isolated') {
      /*
       * En aislado `holdSide` es obligatorio. Sin el, Bitget **rechaza**: es la
       * celda que explica el fallo, porque un rechazo lanza y se llevaba por
       * delante el intento de la otra forma.
       */
      if (holdSide === undefined) {
        return { cuerpo: sobreError('40019', 'param holdSide error') } as Respuesta;
      }
      n.aislado = Number(leverage);
    } else {
      /*
       * En cruzado hay un solo apalancamiento y no tiene lado. Mandar
       * `holdSide` se acepta con `00000` y fija el del lado aislado, que en
       * cruzado no se aplica: exito aparente, cero efecto.
       */
      if (holdSide === undefined) n.cruzado = Number(leverage);
      else n.aislado = Number(leverage);
    }

    return {
      cuerpo: sobreOk({
        symbol: SIMBOLO,
        marginCoin: 'SUSDT',
        longLeverage: String(n.aislado),
        shortLeverage: String(n.aislado),
        crossMarginLeverage: String(n.cruzado),
        marginMode: modoReal
      })
    };
  });

  return {
    cambiarModoA: (modo) => {
      modoReal = modo;
    }
  };
}

function motorCon(fichas: Record<string, ModoMargen>): {
  motor: MotorLotes;
  cuentas: CuentasConFicha;
} {
  const cuentas = new CuentasConFicha(fichas);
  return { motor: new MotorLotes(cliente, cuentas, { dormir: async () => undefined }), cuentas };
}

const peticion = (cuentas: CuentasConFicha) => ({
  mercado: MERCADO_SIMULADO,
  simbolo: SIMBOLO,
  objetivos: cuentas.objetivos(),
  apalancamiento: OBJETIVO
});

/** Los envios de una cuenta, para poder afirmar cuantas formas se probaron. */
const enviosDe = (cuenta: string): Envio[] => envios.filter((e) => e.cuenta === cuenta);

/** La casilla de esa cuenta en el informe. Falla la prueba si no salio. */
function jobDe(lote: Lote, cuentaId: string): Job {
  const job = lote.jobs.find((j) => j.cuentaId === cuentaId);
  expect(job, `la casilla de ${cuentaId} no salió en el informe`).toBeDefined();
  return job as Job;
}

beforeEach(async () => {
  envios = [];
  exchange = await iniciarExchangeSimulado();
  cliente = new ClienteBitget({
    host: exchange.url,
    limitador: new LimitadorPeticiones({ dormir: async () => undefined })
  });
});

afterEach(async () => {
  await cliente.cerrar();
  await exchange.cerrar();
});

describe('apalancamiento en dos cuentas · que puede producir «en la A sí y en la B no»', () => {
  /*
   * Lo primero es descartar lo obvio, porque si el bucle multicuenta se
   * comiera la segunda casilla no haria falta mirar nada mas. No se la come.
   */
  it('caso 1 · con las dos fichas correctas, las dos quedan fijadas', async () => {
    exchangeConSimboloEn('isolated');
    const { motor, cuentas } = motorCon({ cta_a: 'isolated', cta_b: 'isolated' });

    const lote = await motor.ejecutarApalancamiento(
      await motor.planificarApalancamiento(peticion(cuentas))
    );

    expect(resumirLote(lote).exito).toBe(2);
    expect(enviosDe('cta_a')).toHaveLength(1);
    expect(enviosDe('cta_b')).toHaveLength(1);
  });

  /*
   * Las dos cuentas estan en el **mismo modo real** -aislado- y operan el mismo
   * simbolo; lo unico que cambia es la ficha de la B, que quedo con el modo de
   * otro simbolo.
   *
   * Lo que se fija aqui es que eso ya no cambia **nada**: ni el resultado ni el
   * numero de peticiones. Antes, con este exchange, la B salia en fallo con una
   * sola peticion; ahora el modo se lee del simbolo al planificar y la ficha no
   * decide nada, asi que la B se resuelve a la primera.
   */
  it('caso 2 · en AISLADO, la ficha equivocada ya no cambia el resultado', async () => {
    exchangeConSimboloEn('isolated');
    const { motor, cuentas } = motorCon({ cta_a: 'isolated', cta_b: 'crossed' });

    const lote = await motor.ejecutarApalancamiento(
      await motor.planificarApalancamiento(peticion(cuentas))
    );

    expect(jobDe(lote, 'cta_a').estado).toBe('exito');
    expect(jobDe(lote, 'cta_b').estado).toBe('exito');
    expect(resumirLote(lote).exito).toBe(2);

    /* Y la casilla desalineada no paga ni una peticion de mas. */
    expect(enviosDe('cta_a')).toHaveLength(1);
    expect(enviosDe('cta_b')).toHaveLength(1);
    expect(enviosDe('cta_b')[0]?.holdSide).toBe('long');
  });

  /*
   * El mismo desalineamiento sobre un simbolo cruzado. Antes ya funcionaba
   * -Bitget aceptaba con `00000` sin efecto y el motor lo detectaba releyendo
   * el campo del modo declarado, incidencia del 05/09/2026- pero costaba dos
   * peticiones. Ahora tambien cuesta una.
   *
   * Tenerlos juntos deja a la vista que el fallo nunca fue «con dos cuentas»,
   * sino «en aislado».
   */
  it('caso 3 · en CRUZADO tampoco, y ademas deja de costar dos peticiones', async () => {
    exchangeConSimboloEn('crossed');
    const { motor, cuentas } = motorCon({ cta_a: 'crossed', cta_b: 'isolated' });

    const lote = await motor.ejecutarApalancamiento(
      await motor.planificarApalancamiento(peticion(cuentas))
    );

    expect(resumirLote(lote).exito).toBe(2);
    expect(enviosDe('cta_a')).toHaveLength(1);
    expect(enviosDe('cta_b')).toHaveLength(1);
    expect(enviosDe('cta_b')[0]?.holdSide).toBeUndefined();
  });

  /*
   * Lo que sigue justificando el bucle de dos formas ahora que el modo se lee.
   *
   * Entre planificar y enviar hay una ventana -la confirmacion del operador- y
   * en ella el modo puede cambiar desde la app de Bitget. Leerlo al planificar
   * estrecha la ventana, no la cierra, asi que la segunda forma sigue haciendo
   * falta. Sin ella, el cambio de modo a mitad de lote volveria a producir
   * exactamente el sintoma que se acaba de arreglar.
   */
  it('caso 4 · si el modo cambia entre planificar y enviar, la segunda forma salva la casilla', async () => {
    const control = exchangeConSimboloEn('isolated');
    const { motor, cuentas } = motorCon({ cta_a: 'isolated' });

    const plan = await motor.planificarApalancamiento(peticion(cuentas));
    /* El operador lo puso en cruzado desde Bitget mientras leia la confirmacion. */
    control.cambiarModoA('crossed');
    const lote = await motor.ejecutarApalancamiento(plan);

    expect(jobDe(lote, 'cta_a').estado).toBe('exito');
    expect(enviosDe('cta_a')).toHaveLength(2);
    expect(enviosDe('cta_a')[1]?.holdSide).toBeUndefined();
  });

  /*
   * Y la otra mitad: si no se puede leer el modo, no se pide el apalancamiento.
   *
   * Degradar a la ficha seria volver a adivinar con el modo de otro simbolo,
   * que es el defecto que se acaba de quitar. Descartar no cuesta nada -aqui
   * no se mueve dinero- y la casilla sale en el informe con el motivo.
   */
  it('caso 5 · si no se puede leer el modo, la casilla se descarta en vez de adivinarlo', async () => {
    exchange.responderCon((p) => {
      if (p.url.startsWith('/api/v2/mix/market/contracts')) return { cuerpo: sobreOk([CONTRATO]) };
      if (p.url.startsWith('/api/v2/mix/account/account')) {
        return { cuerpo: sobreError('40012', 'apikey does not exist') } as Respuesta;
      }
      return null;
    });
    const { motor, cuentas } = motorCon({ cta_a: 'isolated' });

    const plan = await motor.planificarApalancamiento(peticion(cuentas));

    expect(plan.entradas).toHaveLength(0);
    expect(plan.descartes[0]?.motivo).toBe('modo-margen-ilegible');
    expect(plan.descartes[0]?.mensaje).toContain('reintentar');
    /* Lo que importa: no salio ni una peticion de apalancamiento a ciegas. */
    expect(envios).toHaveLength(0);
  });

  /*
   * Probar la segunda forma no puede convertirse en tragarse el motivo real.
   * Si las dos se rechazan, lo que el operador tiene que leer es lo que dijo
   * Bitget, no un «no se pudo» generico.
   */
  it('caso 6 · si las dos formas se rechazan, el mensaje conserva el motivo de Bitget', async () => {
    exchangeConSimboloEn('isolated', { rechazarSiempre: true });
    const { motor, cuentas } = motorCon({ cta_a: 'isolated' });

    const lote = await motor.ejecutarApalancamiento(
      await motor.planificarApalancamiento(peticion(cuentas))
    );

    expect(jobDe(lote, 'cta_a').estado).toBe('fallo');
    expect(enviosDe('cta_a')).toHaveLength(2);
    expect(jobDe(lote, 'cta_a').mensaje ?? '').not.toBe('');
    expect(jobDe(lote, 'cta_a').codigoBitget).toBe('40019');
  });

  /*
   * Una casilla rechazada no puede tumbar el lote. No habia ninguna prueba que
   * lo garantizara -`enviarUna` no tiene rama `fatal-lote`- y todo lo anterior
   * lo da por hecho, asi que conviene dejarlo escrito.
   */
  /*
   * La tercera manera de que una casilla «no cambie»: que no llegue a salir.
   *
   * Una cuenta en mitad del cambio a UTA se descarta a proposito, pero el
   * mensaje decia «ya no está registrada o no tiene credencial», que manda al
   * operador a revisar un alta que no tiene ningun problema. Es exactamente el
   * tipo de pista falsa que alarga un diagnostico como el de este archivo.
   */
  it('caso 7 · una cuenta migrando a UTA se descarta diciendo que está migrando', async () => {
    exchangeConSimboloEn('isolated');
    const { motor, cuentas } = motorCon({ cta_a: 'isolated', cta_b: 'isolated' });
    cuentas.enTransicion('cta_b');

    const plan = await motor.planificarApalancamiento(peticion(cuentas));

    expect(plan.entradas).toHaveLength(1);
    expect(plan.descartes[0]?.cuentaId).toBe('cta_b');
    expect(plan.descartes[0]?.motivo).toBe('cuenta-en-transicion');
    expect(plan.descartes[0]?.mensaje).toContain('UTA');
    expect(plan.descartes[0]?.mensaje).not.toContain('ya no está registrada');
  });

  it('caso 8 · una casilla rechazada no se lleva por delante a las demas', async () => {
    exchangeConSimboloEn('isolated', { soloRechazaA: 'cta_b' });
    const { motor, cuentas } = motorCon({
      cta_a: 'isolated',
      cta_b: 'isolated',
      cta_c: 'isolated'
    });

    const lote = await motor.ejecutarApalancamiento(
      await motor.planificarApalancamiento(peticion(cuentas))
    );

    expect(jobDe(lote, 'cta_a').estado).toBe('exito');
    expect(jobDe(lote, 'cta_c').estado).toBe('exito');
    expect(jobDe(lote, 'cta_b').estado).toBe('fallo');
    expect(resumirLote(lote).exito).toBe(2);
  });
});
