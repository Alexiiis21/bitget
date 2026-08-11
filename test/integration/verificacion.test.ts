/**
 * Verificacion de credenciales, contra el exchange simulado.
 *
 * Aqui se prueban los casos que la cuenta demo no sabe producir a peticion: una
 * key con permiso de retiro, una passphrase equivocada, una cuenta en modo
 * unilateral. La prueba contra Bitget real vive en test/red/credenciales.test.ts
 * y confirma que la forma de las respuestas sigue siendo esta.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClienteBitget } from '@main/bitget/rest/client';
import { verificarCredencial } from '@main/bitget/verificacion';
import {
  iniciarExchangeSimulado,
  sobreError,
  sobreOk,
  type ExchangeSimulado
} from '../mock-exchange/servidor';

const CREDENCIAL = { apiKey: 'bg_prueba', secretKey: 'secreto', passphrase: 'frase' };

/** Respuesta de /api/v2/spot/account/info con los permisos indicados. */
const infoCuenta = (authorities: string[], extra: Record<string, unknown> = {}): unknown =>
  sobreOk({ userId: '9274202242', authorities, ips: '', parentId: 1513226215, ...extra });

/** Respuesta de /api/v2/mix/account/account. */
const cuentaSimbolo = (extra: Record<string, unknown> = {}): unknown =>
  sobreOk({
    marginCoin: 'USDT',
    available: '500',
    accountEquity: '500',
    marginMode: 'isolated',
    posMode: 'hedge_mode',
    isolatedLongLever: 150,
    isolatedShortLever: 150,
    crossedMarginLeverage: 10,
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

describe('credencial correcta', () => {
  it('la acepta y devuelve el estado operativo de la cuenta', async () => {
    exchange.responder({ cuerpo: infoCuenta(['coow', 'cpow']) });
    exchange.responder({ cuerpo: cuentaSimbolo() });

    const r = await verificarCredencial(cliente, CREDENCIAL);

    expect(r.veredicto).toBe('valida');
    expect(r.uid).toBe('9274202242');
    expect(r.esSubcuenta).toBe(true);
    expect(r.modoPosicion).toBe('cobertura');
    expect(r.modoMargen).toBe('aislado');
    expect(r.apalancamientoLong).toBe(150);
    expect(r.motivo).toBeNull();
  });
});

describe('permisos', () => {
  /*
   * El caso que protege el dinero del cliente. Un codigo de permiso que no
   * esta en el catalogo no se deja pasar, aunque no sepamos que significa:
   * podria ser retiro. Ver la cabecera de verificacion.ts.
   */
  it('rechaza una key con un permiso que no reconoce', async () => {
    exchange.responder({ cuerpo: infoCuenta(['coow', 'cpow', 'wdow']) });

    const r = await verificarCredencial(cliente, CREDENCIAL);

    expect(r.veredicto).toBe('rechazada');
    expect(r.permisosDesconocidos).toEqual(['wdow']);
    expect(r.motivo).toContain('wdow');
  });

  it('no llega a consultar la cuenta si ya rechazo los permisos', async () => {
    exchange.responder({ cuerpo: infoCuenta(['permiso-raro']) });

    await verificarCredencial(cliente, CREDENCIAL);

    /* Una sola peticion: se corta en el paso 2, no gasta cuota en el 3. */
    expect(exchange.peticiones).toHaveLength(1);
  });

  it('rechaza una key sin ningun permiso', async () => {
    exchange.responder({ cuerpo: infoCuenta([]) });

    const r = await verificarCredencial(cliente, CREDENCIAL);

    expect(r.veredicto).toBe('rechazada');
    expect(r.motivo).toContain('ningun permiso');
  });
});

describe('credencial que Bitget no acepta', () => {
  it('devuelve un veredicto, no una excepcion, para que el alta masiva continue', async () => {
    exchange.responder({ cuerpo: sobreError('40005', 'passphrase does not match') });

    const r = await verificarCredencial(cliente, CREDENCIAL);

    expect(r.veredicto).toBe('invalida');
    expect(r.codigoBitget).toBe('40005');
    expect(r.motivo).toContain('passphrase');
  });

  it('propaga un fallo de red en lugar de culpar a la credencial', async () => {
    /* 429 es transitorio: la credencial puede ser perfecta. */
    exchange.responder({ estado: 429, cuerpo: 'rate limited' });

    await expect(verificarCredencial(cliente, CREDENCIAL)).rejects.toThrow();
  });
});

describe('advertencias que no invalidan', () => {
  it('avisa del modo unilateral sin rechazar la credencial', async () => {
    exchange.responder({ cuerpo: infoCuenta(['coow', 'cpow']) });
    exchange.responder({ cuerpo: cuentaSimbolo({ posMode: 'one_way_mode' }) });

    const r = await verificarCredencial(cliente, CREDENCIAL);

    expect(r.veredicto).toBe('valida');
    expect(r.modoPosicion).toBe('unilateral');
    expect(r.advertencias.map((a) => a.codigo)).toContain('modo-unilateral');
  });

  it('avisa del margen cruzado, que deja sin agregar margen', async () => {
    exchange.responder({ cuerpo: infoCuenta(['coow', 'cpow']) });
    exchange.responder({ cuerpo: cuentaSimbolo({ marginMode: 'crossed' }) });

    const r = await verificarCredencial(cliente, CREDENCIAL);

    expect(r.modoMargen).toBe('cruzado');
    expect(r.advertencias.map((a) => a.codigo)).toContain('margen-cruzado');
  });

  it('avisa de la falta de IP ligada y de saldo', async () => {
    exchange.responder({ cuerpo: infoCuenta(['coow', 'cpow']) });
    exchange.responder({ cuerpo: cuentaSimbolo({ available: '0' }) });

    const r = await verificarCredencial(cliente, CREDENCIAL);

    const codigos = r.advertencias.map((a) => a.codigo);
    expect(codigos).toContain('sin-ip-ligada');
    expect(codigos).toContain('sin-saldo');
  });

  it('no avisa de IP cuando la key tiene una ligada', async () => {
    exchange.responder({ cuerpo: infoCuenta(['coow', 'cpow'], { ips: '189.1.2.3, 200.4.5.6' }) });
    exchange.responder({ cuerpo: cuentaSimbolo() });

    const r = await verificarCredencial(cliente, CREDENCIAL);

    expect(r.ipsLigadas).toEqual(['189.1.2.3', '200.4.5.6']);
    expect(r.advertencias.map((a) => a.codigo)).not.toContain('sin-ip-ligada');
  });
});

describe('secretos', () => {
  it('no incluye la secretKey ni la passphrase en el resultado', async () => {
    exchange.responder({ cuerpo: infoCuenta(['coow', 'cpow']) });
    exchange.responder({ cuerpo: cuentaSimbolo() });

    const r = await verificarCredencial(cliente, CREDENCIAL);
    const serializado = JSON.stringify(r);

    expect(serializado).not.toContain(CREDENCIAL.secretKey);
    expect(serializado).not.toContain(CREDENCIAL.passphrase);
  });
});
