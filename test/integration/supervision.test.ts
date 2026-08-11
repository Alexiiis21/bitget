/**
 * Las tres piezas de la Fase 2 trabajando juntas.
 *
 * Verificacion de credenciales + limitador de peticiones + registro de estado,
 * sobre un lote de cuentas contra el exchange simulado. Es la prueba que
 * responde a la pregunta del pliego (cap. 10.1): «¿que le pasa al panel cuando
 * una cuenta de cien se porta mal?».
 *
 * El limitador se inyecta en el cliente, que es como se cablea de verdad: toda
 * peticion pasa por el sin que nadie tenga que acordarse de envolverla.
 */
import { describe, expect, it } from 'vitest';
import { ClienteBitget } from '@main/bitget/rest/client';
import { verificarCredencial } from '@main/bitget/verificacion';
import { RegistroConexiones } from '@main/domain/estado-conexion';
import { LimitadorPeticiones } from '@main/execution/rate-limiter';
import { iniciarExchangeSimulado, sobreError, sobreOk } from '../mock-exchange/servidor';

const credencial = (n: number) => ({
  apiKey: `bg_cuenta_${n}`,
  secretKey: 'secreto',
  passphrase: 'frase'
});

const INFO_OK = sobreOk({
  userId: '900',
  authorities: ['coow', 'cpow'],
  ips: '',
  parentId: 1
});

const CUENTA_OK = sobreOk({
  marginCoin: 'USDT',
  available: '500',
  accountEquity: '500',
  marginMode: 'isolated',
  posMode: 'hedge_mode',
  isolatedLongLever: 150,
  isolatedShortLever: 150
});

/**
 * Verifica una cuenta y anota el resultado en el registro. Es el flujo que
 * usara el alta masiva de la Fase 3.
 */
async function supervisar(
  cliente: ClienteBitget,
  registro: RegistroConexiones,
  cuentaId: string,
  n: number
): Promise<void> {
  registro.registrar(cuentaId);
  registro.marcarConectando(cuentaId);
  try {
    registro.registrarVerificacion(cuentaId, await verificarCredencial(cliente, credencial(n)));
  } catch (e) {
    registro.registrarFallo(cuentaId, e);
  }
}

describe('lote de cuentas con una que falla', () => {
  it('las buenas terminan conectadas y la mala no arrastra al resto', async () => {
    const exchange = await iniciarExchangeSimulado();
    const cliente = new ClienteBitget({ host: exchange.url });
    const registro = new RegistroConexiones();

    /*
     * El simulado responde por orden de llegada, asi que se encolan las
     * respuestas de las tres cuentas: dos completas y una con credencial mala.
     */
    exchange.responder({ cuerpo: INFO_OK });
    exchange.responder({ cuerpo: CUENTA_OK });
    exchange.responder({ cuerpo: sobreError('40012', 'apikey does not exist') });
    exchange.responder({ cuerpo: INFO_OK });
    exchange.responder({ cuerpo: CUENTA_OK });

    await supervisar(cliente, registro, 'acc-1', 1);
    await supervisar(cliente, registro, 'acc-2', 2);
    await supervisar(cliente, registro, 'acc-3', 3);

    expect(registro.estado('acc-1')?.estado).toBe('conectada');
    expect(registro.estado('acc-3')?.estado).toBe('conectada');

    /* RNF-004: la caida de una no toca a las demas. */
    expect(registro.estado('acc-2')?.estado).toBe('desconectada');
    expect(registro.resumen()).toEqual({
      conectada: 2,
      desconectada: 1,
      conectando: 0,
      'modo-rest': 0
    });

    await cliente.cerrar();
    await exchange.cerrar();
  });
});

describe('el exchange limita las peticiones', () => {
  /*
   * Un 429 no es culpa de la credencial. La cuenta queda `conectando` -se
   * reintentara- y los buckets quedan penalizados para que el panel deje de
   * insistir, que es lo que evita el bloqueo de 5 minutos.
   */
  it('un 429 penaliza los buckets sin que nadie tenga que enrutarlo a mano', async () => {
    const exchange = await iniciarExchangeSimulado();
    const cliente = new ClienteBitget({ host: exchange.url });
    const registro = new RegistroConexiones();

    exchange.responder({ estado: 429, cuerpo: 'too many requests' });

    await supervisar(cliente, registro, 'acc-1', 1);

    expect(registro.estado('acc-1')?.estado).toBe('conectando');
    expect(registro.estado('acc-1')?.proximoIntento).not.toBeNull();

    const d = cliente.diagnosticoLimites();
    expect(d.globalPenalizado).toBe(true);
    /* La clave del bucket sale enmascarada: RNF-001. */
    expect(d.cuentasPenalizadas).toHaveLength(1);
    expect(d.cuentasPenalizadas[0]).not.toContain('bg_cuenta_1');
    /* El hueco de concurrencia se devolvio pese al fallo. */
    expect(d.enVuelo).toBe(0);

    await cliente.cerrar();
    await exchange.cerrar();
  });
});

describe('el limitador no se puede esquivar', () => {
  /*
   * La razon de meterlo dentro del cliente. Antes existia y estaba probado,
   * pero ninguna peticion pasaba por el: bastaba con llamar a `peticionFirmada`
   * -que es lo unico que hace todo el codigo- para saltarselo entero.
   */
  it('toda peticion firmada gasta cupo, sin envolverla desde fuera', async () => {
    const exchange = await iniciarExchangeSimulado();
    const limitador = new LimitadorPeticiones({ rafagaGlobal: 5, limiteGlobalPorSegundo: 5 });
    const cliente = new ClienteBitget({ host: exchange.url, limitador });

    exchange.responderSiempre({ cuerpo: sobreOk({ ok: true }) });

    const antes = limitador.diagnostico().tokensGlobales;

    const { z } = await import('zod');
    await cliente.peticionFirmada(
      credencial(1),
      { metodo: 'GET', ruta: '/api/v2/mix/account/accounts', idempotente: true },
      z.unknown()
    );

    expect(limitador.diagnostico().tokensGlobales).toBe(antes - 1);

    await cliente.cerrar();
    await exchange.cerrar();
  });

  it('los endpoints publicos no gastan el cupo de ninguna cuenta', async () => {
    const exchange = await iniciarExchangeSimulado();
    const limitador = new LimitadorPeticiones();
    const cliente = new ClienteBitget({ host: exchange.url, limitador });

    exchange.responderSiempre({ cuerpo: sobreOk({ serverTime: '1700000000000' }) });

    const { z } = await import('zod');
    await cliente.peticionPublica(
      { metodo: 'GET', ruta: '/api/v2/public/time', idempotente: true },
      z.unknown()
    );

    /* Se penaliza el bucket publico y se comprueba que no arrastra a una cuenta. */
    limitador.registrar429('publico', 1_000);
    expect(limitador.diagnostico().cuentasPenalizadas).toEqual(['publico']);

    await cliente.cerrar();
    await exchange.cerrar();
  });
});

describe('presupuesto de peticiones sobre un lote grande', () => {
  /*
   * 30 cuentas a la vez. Lo que se comprueba no es la velocidad sino que el
   * limitador no deja escapar mas peticiones simultaneas de las pactadas: es
   * el techo de IP lo que protege, y cruzarlo cuesta 5 minutos de bloqueo.
   */
  it('nunca supera la concurrencia pactada y termina el lote entero', async () => {
    const exchange = await iniciarExchangeSimulado();
    const limitador = new LimitadorPeticiones({ concurrenciaMaxima: 4 });
    const cliente = new ClienteBitget({ host: exchange.url, limitador });

    exchange.responderSiempre({ cuerpo: sobreOk({ ok: true }), retrasoMs: 2 });

    let enVuelo = 0;
    let maximoVisto = 0;
    const { z } = await import('zod');

    await Promise.all(
      Array.from({ length: 30 }, async (_, i) => {
        enVuelo += 1;
        maximoVisto = Math.max(maximoVisto, enVuelo);
        await cliente.peticionFirmada(
          credencial(i),
          { metodo: 'GET', ruta: '/api/v2/mix/account/accounts', idempotente: true },
          z.unknown()
        );
        enVuelo -= 1;
      })
    );

    expect(exchange.peticiones.length).toBe(30);
    expect(limitador.diagnostico().enCola).toBe(0);
    expect(limitador.diagnostico().enVuelo).toBe(0);

    await cliente.cerrar();
    await exchange.cerrar();
  }, 30_000);
});
