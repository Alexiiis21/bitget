/**
 * Sesion del panel, extremo a extremo dentro del proceso principal.
 *
 * Cubre el recorrido completo del alta de una subcuenta: verificar contra el
 * exchange, cifrar la credencial, anotar la cuenta y dejar su estado de
 * conexion listo para pintarse. Es la prueba que impide el fallo mas caro de
 * esta fase -guardar una credencial que Bitget no acepta- y la que garantiza
 * que ningun secreto sale por el IPC.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClienteBitget } from '@main/bitget/rest/client';
import { Sesion } from '@main/ipc/sesion';
import {
  iniciarExchangeSimulado,
  sobreError,
  sobreOk,
  type ExchangeSimulado
} from '../mock-exchange/servidor';

const MAESTRA = 'contrasena-de-prueba';

const ALTA = {
  etiqueta: 'Sub-01',
  grupoNombre: 'A',
  apiKey: 'bg_7Kq82ab3cd4ef19c',
  secretKey: 'secreto-que-no-debe-salir',
  passphrase: 'frase-que-no-debe-salir'
};

/** Respuesta de /api/v2/spot/account/info. */
const infoCuenta = (authorities: string[] = ['coow', 'cpow']): unknown =>
  sobreOk({ userId: '9274202242', authorities, ips: '1.2.3.4', parentId: 1513226215 });

/** Respuesta de /api/v2/mix/account/account. */
const cuentaSimbolo = (extra: Record<string, unknown> = {}): unknown =>
  sobreOk({
    marginCoin: 'USDT',
    available: '500',
    accountEquity: '500',
    marginMode: 'isolated',
    posMode: 'hedge_mode',
    isolatedLongLever: 10,
    isolatedShortLever: 10,
    crossedMarginLeverage: 10,
    ...extra
  });

/** Encola las dos respuestas de una verificacion que sale bien. */
const verificacionCorrecta = (exchange: ExchangeSimulado): void => {
  exchange.responder({ cuerpo: infoCuenta() });
  exchange.responder({ cuerpo: cuentaSimbolo() });
};

let carpeta: string;
let exchange: ExchangeSimulado;
let cliente: ClienteBitget;
let sesion: Sesion;
let rutaVault: string;
let rutaCuentas: string;

beforeEach(async () => {
  carpeta = await mkdtemp(join(tmpdir(), 'pcb-sesion-'));
  rutaVault = join(carpeta, 'vault.enc');
  rutaCuentas = join(carpeta, 'cuentas.json');

  exchange = await iniciarExchangeSimulado();
  cliente = new ClienteBitget({ host: exchange.url });
  sesion = new Sesion({ vault: rutaVault, cuentas: rutaCuentas }, cliente);
});

afterEach(async () => {
  sesion.cerrar();
  await cliente.cerrar();
  await exchange.cerrar();
  await rm(carpeta, { recursive: true, force: true });
});

describe('almacen', () => {
  it('empieza sin inicializar y queda desbloqueado tras crearlo', async () => {
    expect(await sesion.estadoVault()).toBe('sin-inicializar');

    const r = await sesion.crear(MAESTRA);

    expect(r.ok).toBe(true);
    expect(await sesion.estadoVault()).toBe('desbloqueado');
  });

  it('distingue la contrasena equivocada de cualquier otro fallo', async () => {
    await sesion.crear(MAESTRA);
    sesion.cerrar();

    const r = await sesion.abrir('otra-cosa');

    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('contrasena-incorrecta');
  });

  /*
   * La puerta que impide que un canal de IPC toque credenciales con el panel
   * bloqueado. Sin ella, cualquier fallo de la pantalla de desbloqueo dejaria
   * las claves accesibles.
   */
  it('no deja operar con el panel bloqueado', async () => {
    await expect(sesion.agregar(ALTA)).rejects.toThrow('bloqueado');
    expect(sesion.listar()).toEqual([]);
  });
});

describe('comprobacion de la maestra', () => {
  it('acepta la correcta y rechaza cualquier otra', async () => {
    await sesion.crear(MAESTRA);

    expect(await sesion.comprobarMaestra(MAESTRA)).toBe(true);
    expect(await sesion.comprobarMaestra('otra-cosa')).toBe(false);
  });

  /* Con el panel bloqueado no hay nada que confirmar: no es una via de acceso. */
  it('no comprueba nada con el panel bloqueado', async () => {
    await sesion.crear(MAESTRA);
    sesion.cerrar();

    expect(await sesion.comprobarMaestra(MAESTRA)).toBe(false);
  });

  it('comprobar no cierra ni altera la sesion abierta', async () => {
    await sesion.crear(MAESTRA);
    verificacionCorrecta(exchange);
    await sesion.agregar(ALTA);

    await sesion.comprobarMaestra(MAESTRA);

    expect(sesion.listar()).toHaveLength(1);
    expect(await sesion.estadoVault()).toBe('desbloqueado');
  });
});

describe('alta de una subcuenta', () => {
  it('verifica, cifra y registra en una sola operacion', async () => {
    await sesion.crear(MAESTRA);
    verificacionCorrecta(exchange);

    const r = await sesion.agregar(ALTA);

    expect(r.ok).toBe(true);
    expect(r.veredicto).toBe('valida');
    expect(r.cuenta?.etiqueta).toBe('Sub-01');
    expect(r.cuenta?.grupoNombre).toBe('A');
    expect(r.cuenta?.estado).toBe('conectada');

    const filas = sesion.listar();
    expect(filas).toHaveLength(1);
    expect(filas[0]?.apiKeyEnmascarada).toBe('bg••••f19c');
  });

  /*
   * El fallo mas caro de esta fase seria guardar una credencial que Bitget no
   * acepta: el panel la contaria como operativa y fallaria la primera vez que
   * se le mandara una orden, con dinero de por medio. RF-001.
   */
  it('no guarda nada si Bitget rechaza la credencial', async () => {
    await sesion.crear(MAESTRA);
    exchange.responder({ cuerpo: sobreError('40012', 'apikey/password is incorrect') });

    const r = await sesion.agregar(ALTA);

    expect(r.ok).toBe(false);
    expect(r.veredicto).toBe('invalida');
    expect(sesion.listar()).toEqual([]);
  });

  /* Lista blanca de permisos: un codigo desconocido podria ser retiro. */
  it('no guarda nada si la key trae un permiso que no reconocemos', async () => {
    await sesion.crear(MAESTRA);
    exchange.responder({ cuerpo: infoCuenta(['coow', 'cpow', 'wdow']) });

    const r = await sesion.agregar(ALTA);

    expect(r.ok).toBe(false);
    expect(r.veredicto).toBe('rechazada');
    expect(r.motivo).toContain('wdow');
    expect(sesion.listar()).toEqual([]);
  });

  /*
   * Un corte de red no es un veredicto sobre la credencial. Guardarla seria
   * aceptar lo que no se ha podido comprobar; descartarla en silencio, perder
   * el trabajo del operador. Se informa y no se guarda.
   */
  it('no guarda nada si no se pudo preguntar al exchange', async () => {
    await sesion.crear(MAESTRA);
    exchange.responder({ estado: 503, cuerpo: 'gateway' });

    const r = await sesion.agregar(ALTA);

    expect(r.ok).toBe(false);
    expect(r.veredicto).toBeNull();
    expect(r.motivo).toContain('No se pudo comprobar');
    expect(sesion.listar()).toEqual([]);
  });

  it('traslada las advertencias sin bloquear el alta', async () => {
    await sesion.crear(MAESTRA);
    exchange.responder({ cuerpo: infoCuenta() });
    exchange.responder({ cuerpo: cuentaSimbolo({ marginMode: 'crossed' }) });

    const r = await sesion.agregar(ALTA);

    expect(r.ok).toBe(true);
    expect(r.advertencias.map((a) => a.codigo)).toContain('margen-cruzado');
  });

  it('registrar dos veces la misma subcuenta rota su clave, no la duplica', async () => {
    await sesion.crear(MAESTRA);
    verificacionCorrecta(exchange);
    await sesion.agregar(ALTA);

    verificacionCorrecta(exchange);
    await sesion.agregar({ ...ALTA, apiKey: 'bg_nuevaclave0000abcd' });

    const filas = sesion.listar();
    expect(filas).toHaveLength(1);
    expect(filas[0]?.apiKeyEnmascarada).toBe('bg••••abcd');
  });
});

describe('secretos', () => {
  /* RNF-001: lo que cruza el IPC no puede contener la clave completa. */
  it('lo que sale hacia el renderer no contiene ningun secreto', async () => {
    await sesion.crear(MAESTRA);
    verificacionCorrecta(exchange);

    const alta = await sesion.agregar(ALTA);
    const serializado = JSON.stringify({ alta, filas: sesion.listar() });

    expect(serializado).not.toContain(ALTA.secretKey);
    expect(serializado).not.toContain(ALTA.passphrase);
    expect(serializado).not.toContain(ALTA.apiKey);
  });

  it('el registro en claro tampoco los contiene', async () => {
    await sesion.crear(MAESTRA);
    verificacionCorrecta(exchange);
    await sesion.agregar(ALTA);

    const cuentas = await readFile(rutaCuentas, 'utf8');
    const vault = await readFile(rutaVault, 'utf8');

    expect(cuentas).not.toContain(ALTA.secretKey);
    expect(cuentas).not.toContain(ALTA.apiKey);
    /* En el vault estan, pero cifrados: no aparecen como texto. */
    expect(vault).not.toContain(ALTA.secretKey);
    expect(vault).not.toContain(ALTA.passphrase);
  });
});

describe('baja y prueba', () => {
  it('la baja retira a la vez la cuenta y su credencial', async () => {
    await sesion.crear(MAESTRA);
    verificacionCorrecta(exchange);
    const alta = await sesion.agregar(ALTA);
    const id = alta.cuenta?.id ?? '';

    expect(await sesion.eliminar(id)).toBe(true);
    expect(sesion.listar()).toEqual([]);

    /* Y no reaparece al reabrir el almacen. */
    sesion.cerrar();
    await sesion.abrir(MAESTRA);
    expect(sesion.listar()).toEqual([]);
  });

  it('probar una credencial que sigue siendo valida la deja conectada', async () => {
    await sesion.crear(MAESTRA);
    verificacionCorrecta(exchange);
    const alta = await sesion.agregar(ALTA);

    verificacionCorrecta(exchange);
    const prueba = await sesion.verificar(alta.cuenta?.id ?? '');

    expect(prueba.ok).toBe(true);
    expect(prueba.estado).toBe('conectada');
  });

  /*
   * Una key revocada es un fallo definitivo: la cuenta queda desconectada y no
   * se programa reintento. Reintentar una credencial muerta gasta cupo de la IP
   * que necesitan las otras 99. Ver domain/estado-conexion.ts.
   */
  it('probar una credencial revocada la deja desconectada', async () => {
    await sesion.crear(MAESTRA);
    verificacionCorrecta(exchange);
    const alta = await sesion.agregar(ALTA);

    exchange.responder({ cuerpo: sobreError('40012', 'apikey/password is incorrect') });
    const prueba = await sesion.verificar(alta.cuenta?.id ?? '');

    expect(prueba.ok).toBe(false);
    expect(prueba.estado).toBe('desconectada');
    expect(sesion.listar()[0]?.estado).toBe('desconectada');
  });
});

describe('reapertura', () => {
  it('las cuentas siguen ahi tras cerrar y volver a abrir', async () => {
    await sesion.crear(MAESTRA);
    verificacionCorrecta(exchange);
    await sesion.agregar(ALTA);

    sesion.cerrar();
    const r = await sesion.abrir(MAESTRA);

    expect(r.ok).toBe(true);
    expect(sesion.listar()).toHaveLength(1);
    /* Aun no se ha vuelto a preguntar a Bitget: nadie esta conectado todavia. */
    expect(sesion.listar()[0]?.estado).toBe('desconectada');
  });

  it('el recuento del sistema refleja lo registrado', async () => {
    await sesion.crear(MAESTRA);
    verificacionCorrecta(exchange);
    await sesion.agregar(ALTA);

    const estado = await sesion.estadoApp();

    expect(estado.vault).toBe('desbloqueado');
    expect(estado.cuentasRegistradas).toBe(1);
    expect(estado.cuentasConectadas).toBe(1);
  });
});
