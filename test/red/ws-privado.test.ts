/**
 * El socket privado, contra ws.bitget.com de verdad.
 *
 * --------------------------------------------------------------------------
 * Para que existe esta prueba
 * --------------------------------------------------------------------------
 * `ConexionBitget` esta escrita desde la documentacion de Bitget, y hay dos
 * cosas que la documentacion no basta para dar por buenas:
 *
 *  1. **La firma del login.** Timestamp en segundos y cadena
 *     `timestamp + 'GET' + '/user/verify'`. Si estuviera mal, Bitget responde
 *     «firma invalida» sin decir cual de las dos cosas falla.
 *  2. **El argumento comodin de cada suscripcion.** `coin` en `positions` e
 *     `instId` en `orders-algo`, segun la documentacion. Es exactamente la
 *     clase de detalle que ya mordio una vez en este proyecto -`posSide` contra
 *     `holdSide` en `tpsl.ts`, que hizo que el panel dijera «sin Take Profit»
 *     sobre posiciones que lo tenian-.
 *
 * Las dos se resuelven aqui de una vez: si el socket queda vivo, el login esta
 * bien firmado **y** los dos canales existen con los argumentos que se mandan.
 * Si no, la prueba dice cual fallo y con que codigo.
 *
 * Se ejecuta con `npm run test:red`. Sin credenciales se omite, como el resto
 * de la carpeta; en staging falla en vez de omitirse.
 *
 * No abre ni cierra nada: solo escucha. Lo unico que gasta es una conexion del
 * presupuesto de la IP.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MERCADO_REAL, MERCADO_SIMULADO } from '@main/bitget/mercado';
import {
  ConexionBitget,
  URL_WS_PRIVADO,
  type MotivoCaida
} from '@main/bitget/ws/conexion';
import { credencialReal, hayCredenciales } from './credenciales-reales';

/**
 * El mercado con el que se prueba.
 *
 * Las credenciales de `.env` son de la cuenta demo, cuyo `productType` es
 * `SUSDT-FUTURES`. Si Bitget rechazara la suscripcion por el `instType`, es lo
 * primero que hay que mirar: el canal existe en los dos mercados, pero el
 * `instType` tiene que ser el de la cuenta que firma.
 */
const MERCADO = MERCADO_SIMULADO;

let conexion: ConexionBitget | null = null;

afterEach(() => {
  conexion?.cerrar();
  conexion = null;
});

interface Desenlace {
  viva: boolean;
  motivo: MotivoCaida | null;
  codigo: string | null;
  mensaje: string | null;
  empujones: string[];
}

/** Conecta y espera al primer desenlace: viva, o caida con su motivo. */
function conectar(mercado = MERCADO): Promise<Desenlace> {
  return new Promise<Desenlace>((listo) => {
    const empujones: string[] = [];

    conexion = new ConexionBitget('red', credencialReal, mercado, {
      alEmpujar: (canal) => empujones.push(canal),
      alQuedarViva: () => listo({ viva: true, motivo: null, codigo: null, mensaje: null, empujones }),
      alCaer: (motivo, detalle) =>
        listo({ viva: false, motivo, codigo: detalle.codigo, mensaje: detalle.mensaje, empujones })
    });

    conexion.conectar();
  });
}

describe.skipIf(!hayCredenciales)('socket privado de Bitget', () => {
  it('la URL es la del canal privado v2', () => {
    expect(URL_WS_PRIVADO).toBe('wss://ws.bitget.com/v2/ws/private');
  });

  it(
    'el login se acepta y los dos canales se suscriben',
    async () => {
      const desenlace = await conectar();

      /*
       * El mensaje del fallo importa mas que el propio expect: es lo que dice
       * si hay que corregir la firma o el nombre del argumento del canal.
       */
      expect(
        desenlace.viva,
        `El socket no quedo vivo. motivo=${desenlace.motivo} codigo=${desenlace.codigo} ` +
          `mensaje=${desenlace.mensaje}\n` +
          '  motivo=credencial  -> revise la firma del login en ws/conexion.ts ' +
          '(timestamp en SEGUNDOS, cadena `<ts>GET/user/verify`).\n' +
          '  motivo=suscripcion -> revise ARGUMENTOS_CANAL en ws/conexion.ts: ' +
          'Bitget no acepto `coin`/`instId` como comodin, o el instType no es el de la cuenta.'
      ).toBe(true);
    },
    20_000
  );

  it(
    'una firma mal construida se rechaza, y asi se sabe que la buena no pasa por casualidad',
    async () => {
      const rota = { ...credencialReal, secretKey: `${credencialReal.secretKey}x` };
      const desenlace = await new Promise<Desenlace>((listo) => {
        conexion = new ConexionBitget('red', rota, MERCADO, {
          alEmpujar: () => undefined,
          alQuedarViva: () =>
            listo({ viva: true, motivo: null, codigo: null, mensaje: null, empujones: [] }),
          alCaer: (motivo, detalle) =>
            listo({ viva: false, motivo, codigo: detalle.codigo, mensaje: detalle.mensaje, empujones: [] })
        });
        conexion.conectar();
      });

      expect(desenlace.viva).toBe(false);
      expect(desenlace.motivo).toBe('credencial');
    },
    20_000
  );

  it('el mercado real y el simulado no comparten instType', () => {
    /*
     * El `instType` de la suscripcion sale del mercado, no de una constante
     * suelta. Es la misma proteccion que en REST: un panel compilado para el
     * mercado simulado no puede suscribirse a las posiciones del real.
     */
    expect(MERCADO_SIMULADO.productType).toBe('SUSDT-FUTURES');
    expect(MERCADO_REAL.productType).toBe('USDT-FUTURES');
  });
});
