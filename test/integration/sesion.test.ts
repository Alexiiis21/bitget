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

/** UID de la cuenta principal, como lo devuelve Bitget: numero, no cadena. */
const UID_PADRE = 1513226215;

/**
 * Un UID distinto por credencial.
 *
 * Una API Key pertenece a una sola subcuenta, asi que dos altas distintas
 * traen UIDs distintos. Darles el mismo a todas haria pasar por buenas pruebas
 * en las que el registro esta confundiendo dos subcuentas en una.
 */
let siguienteUid = 5476143700;
const otroUid = (): string => String((siguienteUid += 1));

/** Respuesta de /api/v2/spot/account/info. */
const infoCuenta = (userId: string, authorities: string[] = ['coow', 'cpow']): unknown =>
  sobreOk({ userId, authorities, ips: '1.2.3.4', parentId: UID_PADRE });

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

/**
 * Encola las dos respuestas de una verificacion que sale bien.
 *
 * Devuelve el UID que dira Bitget, para las pruebas que necesitan repetirlo
 * -rotar una clave es la misma subcuenta otra vez-.
 */
const verificacionCorrecta = (exchange: ExchangeSimulado, userId = otroUid()): string => {
  exchange.responder({ cuerpo: infoCuenta(userId) });
  exchange.responder({ cuerpo: cuentaSimbolo() });
  return userId;
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
    exchange.responder({ cuerpo: infoCuenta(otroUid(), ['coow', 'cpow', 'wdow']) });

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

  /*
   * El tope se comprueba antes de salir a la red: rechazar despues costaria dos
   * peticiones del cupo para acabar diciendo que no, y dejaria la credencial ya
   * cifrada en memoria sin cuenta a la que pertenecer.
   */
  it('rechaza la sexta cuenta principal sin preguntar a Bitget', async () => {
    await sesion.crear(MAESTRA);
    for (const nombre of ['A', 'B', 'C', 'D', 'E']) {
      verificacionCorrecta(exchange);
      await sesion.agregar({ ...ALTA, grupoNombre: nombre });
    }
    const peticionesAntes = exchange.peticiones.length;

    const r = await sesion.agregar({ ...ALTA, grupoNombre: 'F' });

    expect(r.ok).toBe(false);
    expect(r.motivo).toContain('5 cuentas principales');
    expect(exchange.peticiones).toHaveLength(peticionesAntes);
    expect(sesion.cuentasPanel()).toHaveLength(5);
  });

  it('traslada las advertencias sin bloquear el alta', async () => {
    await sesion.crear(MAESTRA);
    exchange.responder({ cuerpo: infoCuenta(otroUid()) });
    exchange.responder({ cuerpo: cuentaSimbolo({ marginMode: 'crossed' }) });

    const r = await sesion.agregar(ALTA);

    expect(r.ok).toBe(true);
    expect(r.advertencias.map((a) => a.codigo)).toContain('margen-cruzado');
  });

  it('registrar dos veces la misma subcuenta rota su clave, no la duplica', async () => {
    await sesion.crear(MAESTRA);
    const uid = verificacionCorrecta(exchange);
    await sesion.agregar(ALTA);

    /* La clave nueva es otra, pero Bitget devuelve el mismo UID: es la misma. */
    verificacionCorrecta(exchange, uid);
    await sesion.agregar({ ...ALTA, apiKey: 'bg_nuevaclave0000abcd' });

    const filas = sesion.listar();
    expect(filas).toHaveLength(1);
    expect(filas[0]?.apiKeyEnmascarada).toBe('bg••••abcd');
    expect(filas[0]?.uid).toBe(uid);
  });

  /*
   * El caso que motivo guardar el UID: el operador rota la clave y de paso
   * renombra la subcuenta. Por nombre serian dos; por UID es una.
   */
  it('reconoce la subcuenta renombrada por su UID, sin duplicarla', async () => {
    await sesion.crear(MAESTRA);
    const uid = verificacionCorrecta(exchange);
    await sesion.agregar(ALTA);

    verificacionCorrecta(exchange, uid);
    const r = await sesion.agregar({ ...ALTA, etiqueta: 'Renombrada' });

    expect(r.ok).toBe(true);
    expect(sesion.listar()).toHaveLength(1);
    expect(sesion.listar()[0]?.etiqueta).toBe('Renombrada');
  });

  /* El UID lo pone Bitget y viaja hasta la pantalla; el operador no lo escribe. */
  it('detecta y guarda el UID y el de la cuenta principal', async () => {
    await sesion.crear(MAESTRA);
    const uid = verificacionCorrecta(exchange);

    const r = await sesion.agregar(ALTA);

    expect(r.cuenta?.uid).toBe(uid);
    expect(r.cuenta?.uidPadre).toBe(String(UID_PADRE));
    expect(sesion.listar()[0]?.uidPadre).toBe(String(UID_PADRE));
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

describe('proyeccion de la matriz', () => {
  it('agrupa por cuenta principal y ordena por casilla', async () => {
    await sesion.crear(MAESTRA);
    verificacionCorrecta(exchange);
    await sesion.agregar(ALTA);
    verificacionCorrecta(exchange);
    await sesion.agregar({ ...ALTA, etiqueta: 'Sub-02' });
    verificacionCorrecta(exchange);
    await sesion.agregar({ ...ALTA, etiqueta: 'Sub-03', grupoNombre: 'B' });

    const cuentas = sesion.cuentasPanel();

    expect(cuentas.map((c) => c.nombre)).toEqual(['A', 'B']);
    expect(cuentas[0]?.subcuentas.map((s) => [s.etiqueta, s.slot])).toEqual([
      ['Sub-01', 1],
      ['Sub-02', 2]
    ]);
    expect(cuentas[1]?.subcuentas[0]?.slot).toBe(1);
  });

  /*
   * El saldo llega dentro de la respuesta que confirma la credencial. Que
   * aparezca aqui sin una peticion mas es justo lo que hace que la matriz pueda
   * mostrarlo sin gastar cupo.
   */
  it('trae el saldo que vino con la verificacion', async () => {
    await sesion.crear(MAESTRA);
    verificacionCorrecta(exchange);
    await sesion.agregar(ALTA);

    expect(sesion.cuentasPanel()[0]?.subcuentas[0]?.saldo).toBe('500');
  });

  it('con el panel bloqueado devuelve una lista vacia, no un error', async () => {
    expect(sesion.cuentasPanel()).toEqual([]);
  });

  it('el estado de conexion de cada subcuenta viaja con la proyeccion', async () => {
    await sesion.crear(MAESTRA);
    verificacionCorrecta(exchange);
    const alta = await sesion.agregar(ALTA);
    expect(sesion.cuentasPanel()[0]?.subcuentas[0]?.estado).toBe('conectada');

    exchange.responder({ cuerpo: sobreError('40012', 'apikey/password is incorrect') });
    await sesion.verificar(alta.cuenta?.id ?? '');

    expect(sesion.cuentasPanel()[0]?.subcuentas[0]?.estado).toBe('desconectada');
  });
});

describe('aviso de cambios', () => {
  /*
   * Sin este aviso la pantalla solo se enteraria cuando el operador hiciera
   * algo, y el supervisor de reconexion trabaja por su cuenta: una cuenta que
   * vuelve seguiria pintada en rojo. RF-002.
   */
  it('avisa al dar de alta, al verificar y al dar de baja', async () => {
    await sesion.crear(MAESTRA);
    let avisos = 0;
    const dejar = sesion.alCambiar(() => {
      avisos += 1;
    });

    verificacionCorrecta(exchange);
    const alta = await sesion.agregar(ALTA);
    expect(avisos).toBeGreaterThan(0);

    const trasAlta = avisos;
    verificacionCorrecta(exchange);
    await sesion.verificar(alta.cuenta?.id ?? '');
    expect(avisos).toBeGreaterThan(trasAlta);

    const trasVerificar = avisos;
    await sesion.eliminar(alta.cuenta?.id ?? '');
    expect(avisos).toBeGreaterThan(trasVerificar);

    dejar();
  });

  it('deja de avisar a quien se da de baja', async () => {
    await sesion.crear(MAESTRA);
    let avisos = 0;
    const dejar = sesion.alCambiar(() => {
      avisos += 1;
    });
    dejar();

    verificacionCorrecta(exchange);
    await sesion.agregar(ALTA);

    expect(avisos).toBe(0);
  });

  it('avisa al bloquear el panel: la matriz tiene que vaciarse', async () => {
    await sesion.crear(MAESTRA);
    verificacionCorrecta(exchange);
    await sesion.agregar(ALTA);

    let avisos = 0;
    sesion.alCambiar(() => {
      avisos += 1;
    });
    sesion.cerrar();

    expect(avisos).toBe(1);
    expect(sesion.cuentasPanel()).toEqual([]);
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

/* ---------------- apertura de operaciones (Fase 4) ---------------- */

const SIMBOLO = 'SBTCSUSDT';

/** Contrato real de SBTCSUSDT, capturado de api.bitget.com el 12/08/2026. */
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

/** Deja el exchange respondiendo catalogo, precio y ordenes. */
function enrutarMercado(alOrdenar?: (cuerpo: Record<string, unknown>) => unknown): void {
  exchange.responderCon((p) => {
    if (p.url.startsWith('/api/v2/mix/market/contracts')) return { cuerpo: sobreOk([CONTRATO]) };
    if (p.url.startsWith('/api/v2/mix/market/ticker')) {
      return { cuerpo: sobreOk([{ symbol: SIMBOLO, lastPr: '63378', markPrice: '63381.3' }]) };
    }
    if (p.url.startsWith('/api/v2/mix/order/place-order')) {
      const cuerpo = JSON.parse(p.cuerpo) as Record<string, unknown>;
      return {
        cuerpo:
          alOrdenar?.(cuerpo) ??
          sobreOk({ orderId: `ord_${String(cuerpo['clientOid'])}`, clientOid: cuerpo['clientOid'] })
      };
    }
    return null;
  });
}

/** Sesion abierta con una subcuenta dada de alta y su saldo ya conocido. */
async function conUnaCuenta(): Promise<string> {
  await sesion.crear(MAESTRA);
  verificacionCorrecta(exchange);
  const alta = await sesion.agregar(ALTA);
  enrutarMercado();
  return alta.cuenta?.id ?? '';
}

describe('la sesion alimenta al motor de lotes', () => {
  it('entrega credencial y saldo de una cuenta registrada', async () => {
    const cuentaId = await conUnaCuenta();

    const ejecutable = sesion.cuentaEjecutable(cuentaId);

    expect(ejecutable?.etiqueta).toBe('Sub-01');
    /* El saldo es el que trajo la verificacion, sin una peticion mas. */
    expect(ejecutable?.saldoDisponible).toBe('500');
    expect(ejecutable?.credencial.secretKey).toBe(ALTA.secretKey);
    expect(ejecutable?.modoMargen).toBe('isolated');
  });

  /*
   * La credencial solo sale del vault con el panel abierto. Es la misma puerta
   * que protege el resto de la sesion, aplicada al camino de la ejecucion.
   */
  it('con el panel bloqueado no entrega ninguna credencial', async () => {
    const cuentaId = await conUnaCuenta();
    sesion.cerrar();

    expect(sesion.cuentaEjecutable(cuentaId)).toBeNull();
  });

  it('una cuenta que no existe no rompe nada: devuelve null', async () => {
    await conUnaCuenta();
    expect(sesion.cuentaEjecutable('cta_inventada')).toBeNull();
  });
});

describe('planificar y ejecutar una apertura', () => {
  it('planifica sin enviar ninguna orden', async () => {
    const cuentaId = await conUnaCuenta();

    const plan = await sesion.planificarApertura({
      simbolo: SIMBOLO,
      objetivos: [{ cuentaId, lado: 'long' }],
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null
    });

    expect(plan.entradas).toHaveLength(1);
    expect(plan.entradas[0]?.size).toBe('0.0157');
    /* El mercado lo pone la configuracion, no la peticion. Por defecto, simulado. */
    expect(plan.mercado.clave).toBe('simulado');
    expect(exchange.peticiones.filter((p) => p.url.includes('place-order'))).toHaveLength(0);
  });

  it('ejecuta el plan por su identificador y devuelve el informe', async () => {
    const cuentaId = await conUnaCuenta();

    const plan = await sesion.planificarApertura({
      simbolo: SIMBOLO,
      objetivos: [{ cuentaId, lado: 'long' }],
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null
    });
    const lote = await sesion.ejecutarApertura(plan.id);

    expect(lote.jobs).toHaveLength(1);
    expect(lote.jobs[0]?.estado).toBe('exito');
    expect(lote.jobs[0]?.etiqueta).toBe('Sub-01');
  });

  /*
   * El renderer manda el `id`, nunca el contenido. Si pudiera mandar el plan
   * entero, una pantalla comprometida podria cambiar la cantidad entre lo que
   * el operador aprueba y lo que sale hacia Bitget.
   */
  it('un plan que no existe no se ejecuta', async () => {
    await conUnaCuenta();
    await expect(sesion.ejecutarApertura('plan-inventado')).rejects.toThrow(/ya no existe/);
  });

  it('un plan caducado no se ejecuta: el precio ya no es el de ahora', async () => {
    const cuentaId = await conUnaCuenta();
    let reloj = Date.now();
    const otra = new Sesion({ vault: rutaVault, cuentas: rutaCuentas }, cliente, {
      ahora: () => reloj
    });
    await otra.abrir(MAESTRA);

    const plan = await otra.planificarApertura({
      simbolo: SIMBOLO,
      objetivos: [{ cuentaId, lado: 'long' }],
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null
    });

    reloj += 10 * 60 * 1000;

    await expect(otra.ejecutarApertura(plan.id)).rejects.toThrow(/caducó/);
    otra.cerrar();
  });

  it('bloquear el panel tira los planes pendientes', async () => {
    const cuentaId = await conUnaCuenta();
    const plan = await sesion.planificarApertura({
      simbolo: SIMBOLO,
      objetivos: [{ cuentaId, lado: 'long' }],
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null
    });

    sesion.cerrar();
    await sesion.abrir(MAESTRA);

    expect(sesion.plan(plan.id)).toBeUndefined();
  });

  /*
   * El reintento llega por cuenta y lado; la sesion lo traduce a los mismos
   * identificadores de orden del primer envio. Es lo que impide que reintentar
   * abra una segunda posicion.
   */
  it('reintentar una cuenta reutiliza su identificador de orden', async () => {
    const cuentaId = await conUnaCuenta();
    let fallar = true;
    enrutarMercado(() =>
      fallar ? { code: '40018', msg: 'Invalid IP', requestTime: 1, data: null } : undefined
    );

    const plan = await sesion.planificarApertura({
      simbolo: SIMBOLO,
      objetivos: [{ cuentaId, lado: 'long' }],
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null
    });
    const primero = await sesion.ejecutarApertura(plan.id);
    expect(primero.jobs[0]?.estado).toBe('fallo');

    fallar = false;
    const reintento = await sesion.ejecutarApertura(plan.id, [{ cuentaId, lado: 'long' }]);

    expect(reintento.jobs[0]?.estado).toBe('exito');
    expect(reintento.jobs[0]?.clientOid).toBe(primero.jobs[0]?.clientOid);
  });

  it('con el panel bloqueado no se planifica ni se ejecuta', async () => {
    await expect(
      sesion.planificarApertura({
        simbolo: SIMBOLO,
        objetivos: [{ cuentaId: 'x', lado: 'long' }],
        margenInicial: '100',
        apalancamiento: 10,
        precioLimite: null
      })
    ).rejects.toThrow('bloqueado');
  });
});

describe('planificar y ejecutar un cierre', () => {
  /** Posicion abierta tal como la devuelve `all-position`. */
  const posicionAbierta = {
    symbol: SIMBOLO,
    holdSide: 'long',
    total: '0.0157',
    available: '0.0157',
    marginCoin: 'SUSDT',
    marginMode: 'crossed',
    openPriceAvg: '63200.5',
    liquidationPrice: '57000.1',
    leverage: '10',
    marginSize: '99.3'
  };

  /** Enruta las llamadas del cierre; `hay` decide si la cuenta tiene posicion. */
  function enrutarCierre(hay = true): void {
    exchange.responderCon((p) => {
      if (p.url.startsWith('/api/v2/mix/position/all-position')) {
        return { cuerpo: sobreOk(hay ? [posicionAbierta] : []) };
      }
      if (p.url.startsWith('/api/v2/mix/order/close-positions')) {
        const cuerpo = JSON.parse(p.cuerpo) as Record<string, unknown>;
        return {
          cuerpo: sobreOk({
            successList: [{ orderId: `ord_${String(cuerpo['clientOid'])}` }],
            failureList: []
          })
        };
      }
      return null;
    });
  }

  it('consulta lo abierto y no cierra nada al planificar', async () => {
    await sesion.crear(MAESTRA);
    verificacionCorrecta(exchange);
    const alta = await sesion.agregar(ALTA);
    enrutarCierre();

    const plan = await sesion.planificarCierre({
      simbolo: SIMBOLO,
      objetivos: [{ cuentaId: alta.cuenta?.id ?? '', lado: 'long' }]
    });

    expect(plan.entradas).toHaveLength(1);
    expect(plan.entradas[0]?.size).toBe('0.0157');
    expect(plan.entradas[0]?.margenLiberado).toBe('99.3');
    expect(exchange.peticiones.filter((p) => p.url.includes('close-positions'))).toHaveLength(0);
  });

  it('ejecuta el cierre por su identificador', async () => {
    await sesion.crear(MAESTRA);
    verificacionCorrecta(exchange);
    const alta = await sesion.agregar(ALTA);
    enrutarCierre();

    const plan = await sesion.planificarCierre({
      simbolo: SIMBOLO,
      objetivos: [{ cuentaId: alta.cuenta?.id ?? '', lado: 'long' }]
    });
    const lote = await sesion.ejecutarCierre(plan.id);

    expect(lote.accion).toBe('cerrar');
    expect(lote.jobs[0]?.estado).toBe('exito');
    expect(lote.jobs[0]?.etiqueta).toBe('Sub-01');
  });

  it('una casilla sin posicion se descarta y aparece en el informe', async () => {
    await sesion.crear(MAESTRA);
    verificacionCorrecta(exchange);
    const alta = await sesion.agregar(ALTA);
    enrutarCierre(false);

    const plan = await sesion.planificarCierre({
      simbolo: SIMBOLO,
      objetivos: [{ cuentaId: alta.cuenta?.id ?? '', lado: 'long' }]
    });
    const lote = await sesion.ejecutarCierre(plan.id);

    expect(plan.entradas).toHaveLength(0);
    expect(lote.jobs[0]?.estado).toBe('omitida');
  });

  it('un plan de cierre que no existe no se ejecuta', async () => {
    await sesion.crear(MAESTRA);
    await expect(sesion.ejecutarCierre('plan-inventado')).rejects.toThrow(/ya no existe/);
  });

  it('bloquear el panel tira los planes de cierre', async () => {
    await sesion.crear(MAESTRA);
    verificacionCorrecta(exchange);
    const alta = await sesion.agregar(ALTA);
    enrutarCierre();

    const plan = await sesion.planificarCierre({
      simbolo: SIMBOLO,
      objetivos: [{ cuentaId: alta.cuenta?.id ?? '', lado: 'long' }]
    });

    sesion.cerrar();
    await sesion.abrir(MAESTRA);

    expect(sesion.planCierre(plan.id)).toBeUndefined();
  });

  it('con el panel bloqueado no se planifica un cierre', async () => {
    await expect(
      sesion.planificarCierre({ simbolo: SIMBOLO, objetivos: [{ cuentaId: 'x', lado: 'long' }] })
    ).rejects.toThrow('bloqueado');
  });
});
