/**
 * Enrutamiento dual: que cada credencial hable con la API que le toca.
 *
 * ==========================================================================
 * Es el criterio de cierre del Paquete B
 * ==========================================================================
 * Todo lo demas de la capa de compatibilidad —la deteccion, la persistencia del
 * modo, las colas— existe para que esto sea cierto: una subcuenta UTA manda sus
 * peticiones a `/api/v3/*` y una clasica a `/api/v2/*`, sin que la logica de
 * negocio sepa cual es cual.
 *
 * Se comprueba mirando las URL que llegaron al exchange simulado, que es la
 * unica forma de demostrar el enrutamiento sin creerse el valor de un campo.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectarModo } from '@main/bitget/deteccion-modo';
import { MERCADO_REAL } from '@main/bitget/mercado';
import { ClienteBitget } from '@main/bitget/rest/client';
import { obtenerPosiciones } from '@main/bitget/rest/endpoints/posiciones';
import {
  obtenerPosicionesV3,
  posicionV3AFormatoV2
} from '@main/bitget/rest/endpoints/posiciones-v3';
import { verificarCredencial } from '@main/bitget/verificacion';
import { iniciarExchangeSimulado, sobreOk, type ExchangeSimulado } from '../mock-exchange/servidor';

const CLASICA = { apiKey: 'bg_v2', secretKey: 'secreto', passphrase: 'frase' } as const;
const UTA = { apiKey: 'bg_v3', secretKey: 'secreto', passphrase: 'frase', superficie: 'v3' } as const;

const AJUSTES_UTA = {
  uid: '1111111111',
  accountMode: 'unified',
  assetMode: 'multi_assets',
  accountLevel: 'advanced',
  holdMode: 'hedge_mode',
  symbolConfigList: [
    { category: 'USDT-FUTURES', symbol: 'BTCUSDT', marginMode: 'isolated', leverage: '20' }
  ]
};

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

/** Las rutas que llegaron al exchange, sin la cadena de consulta. */
const rutas = (): string[] => exchange.peticiones.map((p) => (p.url.split('?')[0] ?? ''));

describe('las dos superficies conviven', () => {
  it('la lectura de posiciones de una clasica va a V2 y la de una UTA a V3', async () => {
    exchange.simularUta(AJUSTES_UTA);
    /* V2 devuelve un array de posiciones; V3, un sobre con `list`. */
    exchange.responderCon((p) => (p.url.startsWith('/api/v2/') ? { cuerpo: sobreOk([]) } : null));
    exchange.responderSiempre({ cuerpo: sobreOk({ list: [] }) });

    await obtenerPosiciones(cliente, CLASICA, MERCADO_REAL);
    await obtenerPosicionesV3(cliente, UTA, MERCADO_REAL);

    expect(rutas()).toEqual([
      '/api/v2/mix/position/all-position',
      '/api/v3/position/current-position'
    ]);
  });

  it('V3 pide `category` donde V2 pedia `productType` y `marginCoin`', async () => {
    exchange.simularUta(AJUSTES_UTA);
    /* V2 devuelve un array de posiciones; V3, un sobre con `list`. */
    exchange.responderCon((p) => (p.url.startsWith('/api/v2/') ? { cuerpo: sobreOk([]) } : null));
    exchange.responderSiempre({ cuerpo: sobreOk({ list: [] }) });

    await obtenerPosiciones(cliente, CLASICA, MERCADO_REAL);
    await obtenerPosicionesV3(cliente, UTA, MERCADO_REAL);

    const [v2, v3] = exchange.peticiones;

    expect(v2?.url).toContain('productType=USDT-FUTURES');
    expect(v2?.url).toContain('marginCoin=USDT');

    expect(v3?.url).toContain('category=USDT-FUTURES');
    /* `marginCoin` desaparece en V3: UTA lo resuelve solo. */
    expect(v3?.url).not.toContain('marginCoin');
  });

  it('el firmado es el mismo en las dos: mismas cuatro cabeceras', async () => {
    exchange.simularUta(AJUSTES_UTA);
    /* V2 devuelve un array de posiciones; V3, un sobre con `list`. */
    exchange.responderCon((p) => (p.url.startsWith('/api/v2/') ? { cuerpo: sobreOk([]) } : null));
    exchange.responderSiempre({ cuerpo: sobreOk({ list: [] }) });

    await obtenerPosiciones(cliente, CLASICA, MERCADO_REAL);
    await obtenerPosicionesV3(cliente, UTA, MERCADO_REAL);

    for (const p of exchange.peticiones) {
      expect(p.cabeceras['access-key']).toBeDefined();
      expect(p.cabeceras['access-sign']).toBeDefined();
      expect(p.cabeceras['access-timestamp']).toBeDefined();
      expect(p.cabeceras['access-passphrase']).toBeDefined();
    }
  });
});

describe('la respuesta de V3 llega con la forma interna de siempre', () => {
  /*
   * ==========================================================================
   * Por que se normaliza a la forma de V2 y no directamente a la del dominio
   * ==========================================================================
   * `PosicionBitget` la consumen tres sitios, cada uno para lo suyo:
   * `buscarPosicion` para resolver un cierre indeterminado, `margenYaAplicado`
   * para no aplicar dos veces un aporte de margen, y `aPosicionDominio` para
   * pintar el monitor. Traduciendo a esa forma, los tres funcionan sobre cuentas
   * UTA sin tocar una linea del motor de lotes.
   */
  it('renombra los campos de V3 a los nombres que ya consume el motor', () => {
    const enFormatoV2 = posicionV3AFormatoV2({
      symbol: 'BTCUSDT',
      posSide: 'short',
      total: '0.5',
      avgPrice: '62000',
      liquidationPrice: '71000',
      marginMode: 'isolated',
      leverage: '20',
      marginSize: '1550',
      unrealizedPL: '-120'
    });

    expect(enFormatoV2.holdSide).toBe('short');
    expect(enFormatoV2.openPriceAvg).toBe('62000');
    expect(enFormatoV2.liquidationPrice).toBe('71000');
    expect(enFormatoV2.marginSize).toBe('1550');
    /* UTA resuelve la moneda de margen sola: no viaja en la respuesta. */
    expect(enFormatoV2.marginCoin).toBeNull();
  });

  it('acepta el nombre alternativo de los dos campos sin confirmar', () => {
    const enFormatoV2 = posicionV3AFormatoV2({
      symbol: 'BTCUSDT',
      posSide: 'long',
      total: '1',
      margin: '900',
      unrealizedPnl: '15'
    });

    expect(enFormatoV2.marginSize).toBe('900');
    expect(enFormatoV2.unrealizedPL).toBe('15');
  });

  it('un campo que V3 no traiga queda ausente, nunca en cero', () => {
    /*
     * `margenYaAplicado` compara el margen leido contra el esperado para decidir
     * si reenviar un aporte. Un cero inventado ahi le haria creer que el margen
     * no se aplico y reenviaria, moviendo el doble del dinero aprobado.
     */
    const enFormatoV2 = posicionV3AFormatoV2({
      symbol: 'BTCUSDT',
      posSide: 'long',
      total: '1'
    });

    expect(enFormatoV2.marginSize).toBeUndefined();
    expect(enFormatoV2.unrealizedPL).toBeUndefined();
    expect(enFormatoV2.openPriceAvg).toBeUndefined();
  });
});

describe('la verificacion enruta sola', () => {
  it('una cuenta UTA se valida por V3, sin tocar ningun endpoint de V2', async () => {
    exchange.simularUta(AJUSTES_UTA);
    exchange.responderSiempre({ cuerpo: sobreOk([{ coin: 'USDT', available: '500' }]) });

    const r = await verificarCredencial(cliente, CLASICA, { mercado: MERCADO_REAL });

    expect(r.veredicto).toBe('valida');
    expect(r.accountMode).toBe('uta');
    expect(r.holdMode).toBe('hedge_mode');
    expect(r.modoPosicion).toBe('cobertura');
    expect(r.modoMargen).toBe('aislado');
    expect(r.saldoDisponible).toBe('500');

    /* Ni una peticion a V2: sus endpoints rechazarian esta key. */
    expect(rutas().every((r) => r.startsWith('/api/v3/'))).toBe(true);
  });

  it('avisa de lo que V3 no deja comprobar, en vez de callarlo', async () => {
    exchange.simularUta(AJUSTES_UTA);
    exchange.responderSiempre({ cuerpo: sobreOk([{ coin: 'USDT', available: '500' }]) });

    const r = await verificarCredencial(cliente, CLASICA, { mercado: MERCADO_REAL });

    /*
     * Los permisos y la IP ligada salen hoy de `/api/v2/spot/account/info`, que
     * una key UTA no puede consultar. Dar la cuenta por buena sin decirlo seria
     * dar por auditada una clave cuyos permisos nadie ha visto.
     */
    expect(r.advertencias.map((a) => a.codigo)).toContain('cuenta-uta');
    expect(r.permisos).toEqual([]);
  });

  it('una cuenta en transicion se rechaza sin pedirle nada al operador', async () => {
    exchange.simularUta({ ...AJUSTES_UTA, accountMode: 'upgrading' });

    const r = await verificarCredencial(cliente, CLASICA, { mercado: MERCADO_REAL });

    expect(r.veredicto).toBe('rechazada');
    expect(r.enTransicion).toBe(true);
    /* No se degrada el modo de una cuenta que esta cambiando. */
    expect(r.accountMode).toBeNull();
    expect(r.motivo).toContain('cambiando de modelo');
  });

  it('la deteccion no consume las respuestas encoladas de la prueba', async () => {
    /*
     * Fija la regla del exchange simulado: la sonda a `/api/v3/account/settings`
     * que abre toda verificacion se responde por su propio carril. Si gastara
     * cola, desplazaria todas las respuestas de cualquier prueba que use
     * `responder()` y la haria fallar por un motivo que no tiene que ver con lo
     * que prueba.
     */
    const antes = await detectarModo(cliente, CLASICA);
    expect(antes.modo).toBe('classic');

    exchange.responder({ cuerpo: sobreOk([{ symbol: 'BTCUSDT', holdSide: 'long', total: '1' }]) });
    const r = await obtenerPosiciones(cliente, CLASICA, MERCADO_REAL);

    /* La primera de la cola le tocaba a la peticion de V2, no a la sonda. */
    expect(r.datos).toHaveLength(1);
    expect(r.datos[0]?.symbol).toBe('BTCUSDT');
  });
});
