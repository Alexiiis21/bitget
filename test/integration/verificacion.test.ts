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
import { nivelDePermiso, verificarCredencial } from '@main/bitget/verificacion';
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
    expect(r.uidPadre).toBe('1513226215');
    expect(r.esSubcuenta).toBe(true);
    expect(r.modoPosicion).toBe('cobertura');
    expect(r.modoMargen).toBe('aislado');
    expect(r.apalancamientoLong).toBe(150);
    expect(r.motivo).toBeNull();
  });
});

describe('los UID que detecta el panel', () => {
  /*
   * El operador nunca escribe el UID: sale de aqui. Y sale con dos tipos
   * distintos -`userId` cadena, `parentId` numero-, verificado contra la API
   * real el 19/08/2026. Guardarlos tal cual haria que comparar uno con otro
   * fallara en silencio, asi que los dos salen como cadena.
   */
  it('normaliza el `parentId` numerico de Bitget a cadena', async () => {
    exchange.responder({ cuerpo: infoCuenta(['coow', 'cpow'], { parentId: 1513226215 }) });
    exchange.responder({ cuerpo: cuentaSimbolo() });

    const r = await verificarCredencial(cliente, CREDENCIAL);

    expect(r.uidPadre).toBe('1513226215');
    expect(typeof r.uidPadre).toBe('string');
  });

  /* Una cuenta que no es subcuenta de nadie: no hay padre que guardar. */
  it('sin `parentId` no inventa una cuenta principal', async () => {
    exchange.responder({ cuerpo: infoCuenta(['coow', 'cpow'], { parentId: null }) });
    exchange.responder({ cuerpo: cuentaSimbolo() });

    const r = await verificarCredencial(cliente, CREDENCIAL);

    expect(r.uidPadre).toBeNull();
    expect(r.esSubcuenta).toBe(false);
  });

  /* Un cero no es un UID: es la forma que tiene Bitget de decir «ninguno». */
  it('trata el `parentId` en cero como ausencia de cuenta principal', async () => {
    exchange.responder({ cuerpo: infoCuenta(['coow', 'cpow'], { parentId: 0 }) });
    exchange.responder({ cuerpo: cuentaSimbolo() });

    const r = await verificarCredencial(cliente, CREDENCIAL);

    expect(r.uidPadre).toBeNull();
    expect(r.esSubcuenta).toBe(false);
  });

  /* Si la credencial no autentica no hay UID que detectar, ni que inventar. */
  it('una credencial que Bitget no acepta no trae ningun UID', async () => {
    exchange.responder({ estado: 400, cuerpo: { code: '40006', msg: 'Invalid ACCESS_KEY' } });

    const r = await verificarCredencial(cliente, CREDENCIAL);

    expect(r.uid).toBeNull();
    expect(r.uidPadre).toBeNull();
  });
});

describe('permisos', () => {
  /*
   * Este caso rechazaba hasta el 29/08/2026, cuando el cliente pidio admitir
   * las claves con permiso de retiro. Al caer el rechazo por retiro cae tambien
   * el de lo desconocido, que existia solo por si un codigo sin catalogar fuera
   * el de retiro. Ver la cabecera de verificacion.ts.
   *
   * La prueba se queda -invertida- porque el que importa no es el veredicto,
   * sino que el codigo salga **nombrado** en una advertencia. Aceptar en
   * silencio seria lo unico peor que rechazar.
   */
  it('acepta una key con un permiso que no reconoce, pero lo dice', async () => {
    exchange.responder({ cuerpo: infoCuenta(['coow', 'cpow', 'wdow']) });
    exchange.responder({ cuerpo: cuentaSimbolo() });

    const r = await verificarCredencial(cliente, CREDENCIAL);

    expect(r.veredicto).toBe('valida');
    expect(r.permisosDesconocidos).toEqual(['wdow']);

    const aviso = r.advertencias.find((a) => a.codigo === 'permiso-desconocido');
    expect(aviso?.mensaje).toContain('wdow');
  });

  it('rechaza una key sin ningun permiso', async () => {
    exchange.responder({ cuerpo: infoCuenta([]) });

    const r = await verificarCredencial(cliente, CREDENCIAL);

    expect(r.veredicto).toBe('rechazada');
    expect(r.motivo).toContain('ningun permiso');
  });

  /*
   * Los permisos reales de la clave de la cuenta madre, leidos el 29/08/2026
   * con `node scripts/ver-permisos.mjs --env MADRE`.
   *
   * Se fija aqui porque es la clave que usara la funcion de traspasos: si
   * manana deja de pasar la verificacion, esta prueba dice si fue porque le
   * anadieron un permiso -y hay que catalogarlo- o por otra cosa.
   */
  it('acepta la clave de la cuenta madre tal como esta hoy, sin advertir de permisos', async () => {
    exchange.responder({ cuerpo: infoCuenta(['coow', 'cpow', 'chow']) });
    exchange.responder({ cuerpo: cuentaSimbolo() });

    const r = await verificarCredencial(cliente, CREDENCIAL);

    expect(r.veredicto).toBe('valida');
    expect(r.permisosDesconocidos).toEqual([]);
    expect(r.advertencias.map((a) => a.codigo)).not.toContain('permiso-traspaso');
  });
});

describe('niveles de permiso', () => {
  /*
   * El catalogo dice de cada codigo que puede hacer con el dinero, y la
   * politica se decide sobre eso -ver la cabecera de verificacion.ts-. Todo lo
   * catalogado hoy es de operar: ninguna clave del panel mueve saldo todavia.
   */
  it('los cuatro codigos catalogados son de operacion, ninguno mueve dinero', () => {
    for (const codigo of ['coow', 'cpow', 'ttow', 'chow']) {
      expect(nivelDePermiso(codigo)).toBe('operacion');
    }
  });

  it('un codigo sin catalogar no tiene nivel', () => {
    expect(nivelDePermiso('wdow')).toBeNull();
  });
});

/*
 * ==========================================================================
 * El precio del cambio de politica, escrito como prueba.
 * ==========================================================================
 * Estas dos fijan que ya **no** hay rechazo por permisos. Si alguna se pusiera
 * en rojo sin que nadie lo hubiera pedido, es que se restauro el fallo cerrado
 * -`ACEPTAR_DESCONOCIDOS` o `NIVELES_ACEPTADOS` en verificacion.ts- y hay que
 * decidir a proposito cual de las dos cosas se quiere.
 */
describe('politica de permisos vigente', () => {
  it('un permiso desconocido ya no corta antes de consultar la cuenta', async () => {
    exchange.responder({ cuerpo: infoCuenta(['permiso-raro']) });
    exchange.responder({ cuerpo: cuentaSimbolo() });

    await verificarCredencial(cliente, CREDENCIAL);

    /*
     * Tres peticiones: la deteccion de modo, la info de cuenta y la del simbolo.
     *
     * Lo que fija esta prueba es que **se llega a la tercera**: el paso 2 ya no
     * corta ante un permiso sin catalogar. La primera es
     * `/api/v3/account/settings`, que desde el Paquete B abre toda verificacion
     * para saber si la cuenta habla V2 o V3; el exchange simulado la rechaza por
     * defecto -es una cuenta clasica- y no consume cola.
     */
    expect(exchange.peticiones).toHaveLength(3);
    expect(exchange.peticiones[0]?.url).toContain('/api/v3/account/settings');
    expect(exchange.peticiones[2]?.url).toContain('/api/v2/mix/account/account');
  });

  it('ningun codigo catalogado queda vetado por la politica de hoy', () => {
    for (const codigo of ['coow', 'cpow', 'ttow', 'chow']) {
      expect(nivelDePermiso(codigo)).not.toBeNull();
    }
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
