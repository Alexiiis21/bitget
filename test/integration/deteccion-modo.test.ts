/**
 * Deteccion del modelo de cuenta, contra el exchange simulado.
 *
 * ==========================================================================
 * La prueba que importa es la del error reintentable
 * ==========================================================================
 * Las otras tres ramas son mecanicas. La cuarta -«un corte de red **no**
 * concluye nada»- es la que protege de un fallo caro y silencioso: si una caida
 * de red se leyera como «cuenta clasica», una subcuenta UTA quedaria enrutada a
 * V2 -donde no la conocen- hasta la siguiente verificacion buena, y en pantalla
 * se veria como una cuenta caida sin motivo aparente.
 *
 * Por eso `detectarModo` **lanza** ahi en vez de devolver un modo, y por eso esa
 * distincion tiene prueba propia.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectarModo } from '@main/bitget/deteccion-modo';
import { ErrorBitget, ClienteBitget } from '@main/bitget/rest/client';
import { iniciarExchangeSimulado, sobreError, type ExchangeSimulado } from '../mock-exchange/servidor';

const CREDENCIAL = { apiKey: 'bg_prueba', secretKey: 'secreto', passphrase: 'frase' };

/** Ajustes tal como los documenta Bitget para una cuenta UTA. */
const ajustes = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  uid: '1111111111',
  accountMode: 'unified',
  assetMode: 'multi_assets',
  accountLevel: 'advanced',
  holdMode: 'one_way_mode',
  symbolConfigList: [
    { category: 'USDT-FUTURES', symbol: 'BTCUSDT', marginMode: 'crossed', leverage: '20' }
  ],
  ...extra
});

let exchange: ExchangeSimulado;
let cliente: ClienteBitget;

beforeEach(async () => {
  exchange = await iniciarExchangeSimulado();
  cliente = new ClienteBitget({ host: exchange.url });
});

afterEach(async () => {
  await cliente.cerrar();
  await exchange.cerrar();
});

describe('cuenta clasica', () => {
  it('un rechazo de negocio en V3 la declara clasica', async () => {
    /* El exchange simulado es clasico por defecto: rechaza todo /api/v3/*. */
    const r = await detectarModo(cliente, CREDENCIAL);

    expect(r.modo).toBe('classic');
    expect(r.holdMode).toBeNull();
    /*
     * El codigo queda registrado aunque no se use para decidir. Es lo que hara
     * falta catalogar para el reintento cruzado del Paquete E.
     */
    expect(r.codigoRechazo).toBe('40404');
  });

  it('no le importa **cual** sea el codigo de rechazo', async () => {
    /*
     * Es la propiedad que permite construir esto antes de haber capturado el
     * codigo real con que V3 rechaza una key clasica: cualquier fallo de
     * negocio significa «esta key no vive en V3».
     */
    exchange.responderV3({ cuerpo: sobreError('43011', 'inventado') });

    const r = await detectarModo(cliente, CREDENCIAL);

    expect(r.modo).toBe('classic');
    expect(r.codigoRechazo).toBe('43011');
  });
});

describe('cuenta UTA', () => {
  it('lee el modo, el hold mode y la configuracion por simbolo', async () => {
    exchange.simularUta(ajustes({ holdMode: 'hedge_mode' }));

    const r = await detectarModo(cliente, CREDENCIAL);

    expect(r.modo).toBe('uta');
    expect(r.holdMode).toBe('hedge_mode');
    expect(r.uid).toBe('1111111111');
    expect(r.nivel).toBe('advanced');
    expect(r.configSimbolos).toHaveLength(1);
    expect(r.configSimbolos[0]?.symbol).toBe('BTCUSDT');
  });

  it('un holdMode que no se reconoce sale null, no un modo inventado', async () => {
    /*
     * `holdMode` decide si `posSide` es obligatorio, y omitirlo en una cuenta de
     * cobertura cruza los lados. Ante un valor desconocido, «no se sabe» es la
     * unica respuesta segura.
     */
    exchange.simularUta(ajustes({ holdMode: 'modo_nuevo_de_bitget' }));

    const r = await detectarModo(cliente, CREDENCIAL);

    expect(r.modo).toBe('uta');
    expect(r.holdMode).toBeNull();
  });
});

describe('cuenta en transicion', () => {
  it.each(['upgrading', 'switching'])('%s no es un modo: es «no operes»', async (estado) => {
    exchange.simularUta(ajustes({ accountMode: estado }));

    const r = await detectarModo(cliente, CREDENCIAL);

    expect(r.modo).toBe('transicion');
    expect(r.accountModeCrudo).toBe(estado);
    /* No se afirma un holdMode de una cuenta que esta cambiando de modelo. */
    expect(r.holdMode).toBeNull();
  });
});

describe('un rechazo del sobre de autenticacion no es un veredicto', () => {
  /*
   * ==========================================================================
   * El caso real del 09/09/2026
   * ==========================================================================
   * `/api/v3/account/settings` devolvio `40018 · Invalid IP` para una clave cuya
   * cuenta podia perfectamente ser UTA. La deteccion lo leyo como «clasica»
   * -cualquier fallo de negocio lo era-, el panel siguio a V2, cosecho un
   * segundo rechazo y enseño **ese** codigo. El operador se quedo buscando un
   * problema de migracion teniendo uno de lista blanca.
   *
   * La firma y las cuatro cabeceras son identicas en las dos superficies, asi
   * que estos codigos se habrian producido igual en V2: no distinguen nada.
   */
  it.each([
    ['40018', 'Invalid IP,Current request IP 187.243.210.174'],
    ['40006', 'Invalid sign'],
    ['40005', 'passphrase no coincide'],
    ['40002', 'falta la firma']
  ])('%s deja el modo en «indeterminado», no en «classic»', async (codigo, msg) => {
    exchange.responderV3({ cuerpo: sobreError(codigo, msg) });

    const r = await detectarModo(cliente, CREDENCIAL);

    expect(r.modo).toBe('indeterminado');
    expect(r.codigoRechazo).toBe(codigo);
    /* Y no se afirma nada de una cuenta a la que no se pudo preguntar. */
    expect(r.holdMode).toBeNull();
  });

  it('un 40014 que nombra UTA prueba que la cuenta ES unificada', async () => {
    /*
     * ========================================================================
     * El fallo del 09/09/2026, capturado
     * ========================================================================
     * Una subcuenta que el titular sabe migrada devolvio esto, y la deteccion la
     * leyo como `classic`: se enrutaba a V2 para siempre y el operador veia el
     * codigo del segundo rechazo, sin ninguna pista de que su cuenta si era UTA.
     *
     * No se concluye `uta` porque sin esta respuesta no hay `holdMode`, y operar
     * en cobertura sin saberlo cruza los lados. Se corta con un motivo
     * accionable.
     */
    exchange.responderV3({
      cuerpo: sobreError(
        '40014',
        'Incorrect permissions, need UTA manage read or UTA manage write permissions'
      )
    });

    const r = await detectarModo(cliente, CREDENCIAL);

    expect(r.modo).toBe('indeterminado');
    expect(r.esUta).toBe(true);
    expect(r.codigoRechazo).toBe('40014');
    /* Y sigue sin afirmarse nada que no se haya podido leer. */
    expect(r.holdMode).toBeNull();
  });

  it('un 40014 que NO nombra UTA sigue dando clasica', async () => {
    /*
     * `40014` -sin permiso- y `40012` -la key no existe- quedan deliberadamente
     * fuera de la lista: podrian ser la forma en que V3 rechaza a una clave
     * clasica, y tratarlos como «no se sabe» daria por invalida una cuenta
     * Classic que funciona. Ante la duda, mejor un diagnostico pobre que un
     * rechazo falso.
     */
    exchange.responderV3({ cuerpo: sobreError('40014', 'no permission') });

    const r = await detectarModo(cliente, CREDENCIAL);

    expect(r.modo).toBe('classic');
    expect(r.codigoRechazo).toBe('40014');
  });
});

describe('la distincion que protege del enrutamiento mudo', () => {
  it('un 429 se propaga y NO concluye que la cuenta sea clasica', async () => {
    exchange.responderV3({ estado: 429, cuerpo: sobreError('429', 'too many requests') });

    await expect(detectarModo(cliente, CREDENCIAL)).rejects.toBeInstanceOf(ErrorBitget);
  });

  it('un 500 se propaga: la consulta es idempotente y se reintenta, no se decide', async () => {
    exchange.responderV3({ estado: 500, cuerpo: 'gateway' });

    await expect(detectarModo(cliente, CREDENCIAL)).rejects.toMatchObject({
      clase: 'retryable'
    });
  });
});
