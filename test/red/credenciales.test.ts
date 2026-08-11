/**
 * Verificacion de credenciales contra api.bitget.com, con la cuenta demo.
 *
 * Cubre el capitulo 10.1 del pliego -«Pruebas de Conexion»- en la parte que
 * necesita una API Key real: conexion exitosa, deteccion de errores de
 * autenticacion y estado de la cuenta.
 *
 * Su papel frente a las pruebas del exchange simulado: alli se comprueba la
 * logica de decision; aqui se comprueba que **la realidad sigue teniendo la
 * forma que esa logica supone**. Si Bitget cambia un campo o un endpoint, esta
 * prueba es la que se cae.
 *
 * Se ejecuta con `npm run test:red`. Sin credenciales en .env se omite sola,
 * para no volverse un obstaculo en una maquina que no las tenga.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClienteBitget } from '@main/bitget/rest/client';
import { ErrorBitget } from '@main/bitget/errors';
import type { Credencial } from '@main/bitget/rest/signer';
import {
  describirPermiso,
  verificarCredencial,
  type ResultadoVerificacion
} from '@main/bitget/verificacion';
import { credencialReal, hayCredenciales, uidEsperado } from './credenciales-reales';

/**
 * Verifica tolerando que el exchange nos limite.
 *
 * Las pruebas de credencial equivocada generan fallos de autenticacion a
 * proposito, y Bitget responde 429 tras unos cuantos. Ese 429 no dice nada
 * sobre nuestro codigo -de hecho, que llegue aqui demuestra que el error
 * transitorio se propaga en lugar de culpar a la credencial-, asi que se
 * distingue de un fallo real en lugar de pintar la suite en rojo.
 */
async function verificarTolerandoLimite(
  cliente: ClienteBitget,
  credencial: Credencial
): Promise<ResultadoVerificacion | null> {
  try {
    return await verificarCredencial(cliente, credencial);
  } catch (e) {
    if (e instanceof ErrorBitget && e.reintentable) {
      console.log(`  omitida: el exchange esta limitando (${e.codigo}). No es un fallo del panel.`);
      return null;
    }
    throw e;
  }
}

/*
 * Con `npm run test:red` la suite se omite si no hay `.env`. Con
 * `npm run test:staging` no puede omitirse: falta de credenciales es un fallo.
 * Ver test/red/credenciales-reales.ts.
 */
const credencial = credencialReal;

let cliente: ClienteBitget;

beforeAll(async () => {
  cliente = new ClienteBitget();
  if (hayCredenciales) await cliente.sincronizarReloj();
});

afterAll(async () => {
  await cliente.cerrar();
});

describe.skipIf(!hayCredenciales)('verificacion contra la cuenta demo', () => {
  it('acepta la credencial y describe el estado real de la cuenta', async () => {
    const r = await verificarTolerandoLimite(cliente, credencial);
    if (r === null) return;

    console.log(`
  veredicto ............ ${r.veredicto}
  UID .................. ${r.uid}
  es subcuenta ......... ${r.esSubcuenta ? 'si' : 'no'}
  permisos ............. ${r.permisos.map((p) => `${p} (${describirPermiso(p)})`).join(', ')}
  IPs ligadas .......... ${r.ipsLigadas.length > 0 ? r.ipsLigadas.join(', ') : 'ninguna'}
  modo de posicion ..... ${r.modoPosicion}
  modo de margen ....... ${r.modoMargen}
  apalancamiento ....... long ${r.apalancamientoLong}x / short ${r.apalancamientoShort}x
  saldo disponible ..... ${r.saldoDisponible} USDT
  latencia ............. ${r.latenciaMs} ms
  advertencias ......... ${r.advertencias.length === 0 ? 'ninguna' : ''}${r.advertencias
    .map((a) => `\n    - [${a.codigo}] ${a.mensaje}`)
    .join('')}`);

    expect(r.veredicto).toBe('valida');
    expect(r.uid).toMatch(/^\d+$/);
    expect(r.permisosDesconocidos).toEqual([]);
  }, 30_000);

  /*
   * La pregunta del auditor: «¿las peticiones de cada cuenta estan asociadas a
   * su API Key/UID?». Aqui se responde con la API real: la credencial del .env
   * tiene que devolver el UID que el .env declara. Si alguien deja media
   * credencial de otra cuenta en el entorno, esta prueba lo caza; sin ella, el
   * panel mostraria datos correctos de la cuenta equivocada.
   */
  it.skipIf(uidEsperado === '')('responde el UID de la cuenta que se esperaba', async () => {
    const r = await verificarTolerandoLimite(cliente, credencial);
    if (r === null) return;

    /*
     * El fallo tipico aqui no es una credencial cruzada, sino haber anotado en
     * .env el UID de la **cuenta madre** en lugar del de la subcuenta. Bitget
     * los muestra juntos en el perfil y solo se distinguen por el rotulo. El
     * mensaje lo nombra para no mandar a nadie a buscar un problema que no
     * existe.
     */
    expect(
      r.uid,
      `El UID que devuelve Bitget (${r.uid}) no es el declarado en BITGET_DEMO_UID ` +
        `(${uidEsperado}).\n` +
        `La credencial pertenece a ${r.esSubcuenta ? 'una subcuenta' : 'una cuenta principal'}. ` +
        'Si el valor de .env es el de la cuenta madre, corrijalo por el de la subcuenta: ' +
        'este comprueba la cuenta que firma, no la que la contiene.'
    ).toBe(uidEsperado);
  }, 30_000);

  /*
   * El modo de posicion decide si la estrategia del operador es ejecutable, y
   * no se puede cambiar con posiciones abiertas. Por eso se lee al dar de alta
   * y no cuando ya hay dinero dentro. docs/adr/0006-modo-cobertura.md.
   */
  it('lee el modo de posicion, que es lo que decide si la estrategia cabe', async () => {
    const r = await verificarTolerandoLimite(cliente, credencial);
    if (r === null) return;

    expect(r.modoPosicion === 'cobertura' || r.modoPosicion === 'unilateral').toBe(true);

    if (r.modoPosicion !== 'cobertura') {
      console.log(
        '\n  AVISO: la cuenta demo esta en modo unilateral. La estrategia de Daniel\n' +
          '  necesita cobertura (LONG y SHORT a la vez). Hay que cambiarlo en Bitget\n' +
          '  antes de abrir posiciones.'
      );
    }
  }, 30_000);

  it('detecta una passphrase equivocada y la clasifica como fallo de cuenta', async () => {
    const r = await verificarTolerandoLimite(cliente, {
      ...credencial,
      passphrase: 'passphrase-que-no-es'
    });
    if (r === null) return;

    console.log(`  Bitget rechazo con codigo ${r.codigoBitget}: "${r.motivo}"`);

    expect(r.veredicto).toBe('invalida');
    expect(r.codigoBitget).not.toBeNull();
    /* Un dato sensible jamas viaja en el resultado, ni siquiera al fallar. */
    expect(JSON.stringify(r)).not.toContain(credencial.secretKey);
  }, 30_000);

  it('detecta una secret key equivocada sin lanzar excepcion', async () => {
    const r = await verificarTolerandoLimite(cliente, {
      ...credencial,
      secretKey: 'c2VjcmV0by1xdWUtbm8tZXM='
    });
    if (r === null) return;

    console.log(`  Bitget rechazo con codigo ${r.codigoBitget}: "${r.motivo}"`);

    expect(r.veredicto).toBe('invalida');
  }, 30_000);

  it('una API Key inexistente falla la cuenta y nunca se reintenta', async () => {
    const fallo = await cliente
      .peticionFirmada(
        { apiKey: 'bg_inexistente', secretKey: 'x', passphrase: 'y' },
        { metodo: 'GET', ruta: '/api/v2/spot/account/info', idempotente: true },
        (await import('zod')).z.unknown()
      )
      .then(
        () => null,
        (e: unknown) => e as ErrorBitget
      );

    expect(fallo).toBeInstanceOf(ErrorBitget);
    expect(fallo?.reintentable).toBe(false);
  }, 30_000);
});
