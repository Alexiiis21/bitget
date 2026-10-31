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
import { CUENTAS_MADRE_MAX, NOMBRES_CUENTA_MADRE } from '@shared/constants';
import { Sesion } from '@main/ipc/sesion';
import { FrenoMaestra } from '@main/security/freno-maestra';
import {
  iniciarExchangeSimulado,
  sobreError,
  sobreOk,
  type ExchangeSimulado
} from '../mock-exchange/servidor';

/*
 * scrypt barato: estas pruebas crean un almacen por caso y lo que ejercitan es
 * la sesion, no la dureza del cifrado -que cubre test/unit/vault.test.ts-. Con
 * el coste real, varias suites en paralelo agotaban el limite de tiempo de
 * vitest de forma intermitente.
 */
const KDF_PRUEBAS = { N: 16, r: 1, p: 1 };

const MAESTRA = 'contrasena-de-prueba';
/** La contrasena de paso, la misma que exigen abrir, cerrar y dar de baja. */
const PASO = 'bg1';

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
let rutaActivos: string;

beforeEach(async () => {
  carpeta = await mkdtemp(join(tmpdir(), 'pcb-sesion-'));
  rutaVault = join(carpeta, 'vault.enc');
  rutaCuentas = join(carpeta, 'cuentas.json');
  rutaActivos = join(carpeta, 'activos.json');

  exchange = await iniciarExchangeSimulado();
  cliente = new ClienteBitget({ host: exchange.url });
  sesion = new Sesion({ vault: rutaVault, cuentas: rutaCuentas, activos: rutaActivos }, cliente, { parametrosKdf: KDF_PRUEBAS });
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

  /*
   * Hasta el 29/08/2026 esto no se guardaba: un codigo de permiso desconocido
   * podia ser el de retiro, asi que se rechazaba. El cliente pidio admitir el
   * retiro, y con el cae el rechazo de lo desconocido -su unica razon de ser-.
   * Ver la cabecera de src/main/bitget/verificacion.ts.
   *
   * Lo que la prueba defiende ahora es lo que queda en pie: la key entra, pero
   * el alta **devuelve el codigo nombrado** para que la pantalla lo cante.
   */
  it('guarda la key con un permiso que no reconocemos, avisando de cual es', async () => {
    await sesion.crear(MAESTRA);
    exchange.responder({ cuerpo: infoCuenta(otroUid(), ['coow', 'cpow', 'wdow']) });
    exchange.responder({ cuerpo: cuentaSimbolo() });

    const r = await sesion.agregar(ALTA);

    expect(r.ok).toBe(true);
    expect(r.veredicto).toBe('valida');
    expect(sesion.listar()).toHaveLength(1);

    const aviso = r.advertencias.find((a) => a.codigo === 'permiso-desconocido');
    expect(aviso?.mensaje).toContain('wdow');
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
   *
   * --------------------------------------------------------------------------
   * Plazo propio: es la prueba mas pesada de la suite
   * --------------------------------------------------------------------------
   * Da de alta quince cuentas madre, y cada alta deriva una clave -el KDF esta
   * calibrado para tardar- y verifica contra el exchange simulado. Sola tarda
   * ~4,7 s contra el plazo por defecto de 5 s, asi que en una ejecucion
   * completa -cincuenta y un archivos repartidos entre los nucleos- lo rebasaba
   * de forma intermitente.
   *
   * El plazo mide la velocidad de la maquina, no la regla de negocio que esta
   * prueba afirma. Se le da margen suficiente en vez de recortar el bucle:
   * quince altas **son** el caso que se quiere probar, porque el tope se alcanza
   * con quince.
   */
  it('rechaza una cuenta principal de mas sin preguntar a Bitget', async () => {
    await sesion.crear(MAESTRA);
    for (const nombre of NOMBRES_CUENTA_MADRE) {
      verificacionCorrecta(exchange);
      await sesion.agregar({ ...ALTA, grupoNombre: nombre });
    }
    const peticionesAntes = exchange.peticiones.length;

    /* La que vendria despues de la O. */
    const r = await sesion.agregar({ ...ALTA, grupoNombre: 'P' });

    expect(r.ok).toBe(false);
    expect(r.motivo).toContain(`${CUENTAS_MADRE_MAX} cuentas principales`);
    expect(exchange.peticiones).toHaveLength(peticionesAntes);
    expect(sesion.cuentasPanel()).toHaveLength(CUENTAS_MADRE_MAX);
  }, 30_000);

  /*
   * La casilla la elige el operador en el formulario -de 1 a 20- y la subcuenta
   * va exactamente ahi. Antes la repartia el panel, asi que organizar la rejilla
   * obligaba a dar de alta en el orden exacto en que se querian ver.
   */
  it('la subcuenta va a la casilla que pidio el operador', async () => {
    await sesion.crear(MAESTRA);
    verificacionCorrecta(exchange);

    await sesion.agregar({ ...ALTA, casilla: 7 });

    expect(sesion.cuentasPanel()[0]?.subcuentas[0]?.slot).toBe(7);
  });

  /*
   * Y una casilla ocupada se rechaza **antes** de salir a la red: gastar dos
   * peticiones del cupo para acabar diciendo que no es justo lo que
   * `comprobarCabida` existe para evitar.
   */
  it('una casilla ocupada se rechaza sin preguntar a Bitget', async () => {
    await sesion.crear(MAESTRA);
    verificacionCorrecta(exchange);
    await sesion.agregar({ ...ALTA, casilla: 7 });
    const peticionesAntes = exchange.peticiones.length;

    const r = await sesion.agregar({ ...ALTA, etiqueta: 'Sub-08', casilla: 7 });

    expect(r.ok).toBe(false);
    expect(r.motivo).toContain('ya la ocupa «Sub-01»');
    expect(exchange.peticiones).toHaveLength(peticionesAntes);
    expect(sesion.listar()).toHaveLength(1);
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

  /*
   * El caso del 26/09/2026: «di de alta la 19 y se borro la 18». La API Key de
   * la 19 era la de la 18, Bitget devolvio su UID y el panel mudo la 18 a la
   * casilla 19 sustituyendole la clave, diciendo «registrada».
   */
  it('la clave de otra subcuenta, con otro nombre y en otra casilla, se rechaza sin tocar nada', async () => {
    await sesion.crear(MAESTRA);
    const uid = verificacionCorrecta(exchange);
    await sesion.agregar({ ...ALTA, etiqueta: 'Sub-18', grupoNombre: 'B', casilla: 18 });

    verificacionCorrecta(exchange, uid);
    const r = await sesion.agregar({
      ...ALTA,
      etiqueta: 'Sub-19',
      grupoNombre: 'B',
      casilla: 19,
      apiKey: 'bg_nuevaclave0000abcd'
    });

    expect(r.ok).toBe(false);
    expect(r.motivo).toContain('«Sub-18»');
    const filas = sesion.listar();
    expect(filas).toHaveLength(1);
    expect(filas[0]?.etiqueta).toBe('Sub-18');
    expect(sesion.cuentasPanel()[0]?.subcuentas[0]?.slot).toBe(18);

    /*
     * Y la credencial de la 18 no se sustituyo en el vault, ni siquiera en
     * memoria: al probarla, la peticion sale firmada con su clave de siempre.
     */
    verificacionCorrecta(exchange, uid);
    const antes = exchange.peticiones.length;
    await sesion.verificar(filas[0]!.id);
    const firmadas = exchange.peticiones.slice(antes).map((p) => p.cabeceras['access-key']);
    expect(firmadas.length).toBeGreaterThan(0);
    expect(new Set(firmadas)).toEqual(new Set([ALTA.apiKey]));
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
    await sesion.fijarPaso(PASO);
    verificacionCorrecta(exchange);
    const alta = await sesion.agregar(ALTA);
    const id = alta.cuenta?.id ?? '';

    expect(await sesion.eliminar(id, PASO)).toBe('borrada');
    expect(sesion.listar()).toEqual([]);

    /* Y no reaparece al reabrir el almacen. */
    sesion.cerrar();
    await sesion.abrir(MAESTRA);
    expect(sesion.listar()).toEqual([]);
  });

  /*
   * ==========================================================================
   * La baja exige la contrasena de paso, la misma de abrir y cerrar
   * ==========================================================================
   * Lo pidio el cliente el 31/08/2026. Lo que se comprueba aqui no es el
   * diálogo -eso es la pantalla- sino que el proceso principal **no borra nada**
   * sin la clave: es el unico freno que un fallo del renderer no se puede
   * saltar, y lo que la baja borra -la credencial cifrada- no se recupera desde
   * el panel.
   */
  it('sin la contrasena de paso correcta no se borra nada', async () => {
    await sesion.crear(MAESTRA);
    await sesion.fijarPaso(PASO);
    verificacionCorrecta(exchange);
    const alta = await sesion.agregar(ALTA);
    const id = alta.cuenta?.id ?? '';

    expect(await sesion.eliminar(id, 'otra-cosa')).toBe('paso-incorrecto');

    /* Sigue registrada, y sigue estandolo al reabrir el almacen. */
    expect(sesion.listar()).toHaveLength(1);
    sesion.cerrar();
    await sesion.abrir(MAESTRA);
    expect(sesion.listar()).toHaveLength(1);
  });

  /*
   * Sin contrasena de paso configurada la respuesta es «no», nunca «adelante».
   * Es la misma puerta que la de operar: un panel sin clave de paso no tiene
   * ningun freno que ofrecer, y dejar pasar «porque no hay nada que comprobar»
   * convertiria el freno en un adorno. Ver `Vault.comprobarPaso`.
   */
  it('sin contrasena de paso configurada, la baja no pasa', async () => {
    await sesion.crear(MAESTRA);
    verificacionCorrecta(exchange);
    const alta = await sesion.agregar(ALTA);

    expect(await sesion.eliminar(alta.cuenta?.id ?? '', PASO)).toBe('paso-incorrecto');
    expect(sesion.listar()).toHaveLength(1);
  });

  /* Una ficha que ya no esta se distingue de una clave equivocada: no hay nada que reintentar. */
  it('la baja de una cuenta que ya no esta lo dice, y no como clave incorrecta', async () => {
    await sesion.crear(MAESTRA);
    await sesion.fijarPaso(PASO);

    expect(await sesion.eliminar('cta_que_no_existe', PASO)).toBe('no-estaba');
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
   * ==========================================================================
   * Las cuentas principales van por el abecedario, no por antiguedad
   * ==========================================================================
   * Lo reporto el cliente: dio de alta el grupo B antes que el A y el panel le
   * pinto la B arriba. La de arriba crea A y luego B, asi que el orden de alta
   * y el alfabetico coinciden y no distingue un criterio del otro; esta invierte
   * el alta a proposito, que es lo unico que reproduce el fallo.
   *
   * No es la primera vez que aparece: el mismo problema se arreglo el
   * 05/09/2026 en la pantalla de API Keys, y quedo sin arreglar en la matriz.
   */
  it('ordena las cuentas principales alfabeticamente, no por orden de alta', async () => {
    await sesion.crear(MAESTRA);
    verificacionCorrecta(exchange);
    await sesion.agregar({ ...ALTA, grupoNombre: 'B', etiqueta: 'Sub-01' });
    verificacionCorrecta(exchange);
    await sesion.agregar({ ...ALTA, grupoNombre: 'A', etiqueta: 'Sub-02' });

    expect(sesion.cuentasPanel().map((c) => c.nombre)).toEqual(['A', 'B']);

    /*
     * Y sigue igual tras reabrir el almacen: el orden sale del camino de
     * lectura y no de un efecto colateral de la insercion en memoria. Es lo
     * que separa «arregla las instalaciones que ya existen» de «arregla solo
     * las altas nuevas».
     */
    sesion.cerrar();
    await sesion.abrir(MAESTRA);
    expect(sesion.cuentasPanel().map((c) => c.nombre)).toEqual(['A', 'B']);
  });

  /* Con tres se descarta un arreglo que solo intercambie el primer par. */
  it('con tres cuentas principales en desorden salen A, B y C', async () => {
    await sesion.crear(MAESTRA);
    for (const grupoNombre of ['C', 'A', 'B']) {
      verificacionCorrecta(exchange);
      await sesion.agregar({ ...ALTA, grupoNombre, etiqueta: `Sub-${grupoNombre}` });
    }

    expect(sesion.cuentasPanel().map((c) => c.nombre)).toEqual(['A', 'B', 'C']);
  });

  /*
   * La segunda via al mismo sintoma, y la que demuestra que el orden de alta
   * no era ni siquiera un orden de alta.
   *
   * `Grupo.orden` se asignaba con `this.grupos.length`, y los grupos se retiran
   * del array sin renumerar: vaciar la A y volver a crearla la dejaba con el
   * mismo numero que la B. A partir de ahi el orden lo decidia la estabilidad
   * del `sort`, que no es una respuesta.
   */
  it('una cuenta principal dada de baja y vuelta a crear no se va al final', async () => {
    await sesion.crear(MAESTRA);
    await sesion.fijarPaso(PASO);

    verificacionCorrecta(exchange);
    const primera = await sesion.agregar({ ...ALTA, grupoNombre: 'A', etiqueta: 'Sub-01' });
    verificacionCorrecta(exchange);
    await sesion.agregar({ ...ALTA, grupoNombre: 'B', etiqueta: 'Sub-02' });

    /* Al irse su ultima subcuenta, el grupo A desaparece del registro. */
    expect(await sesion.eliminar(primera.cuenta?.id ?? '', PASO)).toBe('borrada');
    expect(sesion.cuentasPanel().map((c) => c.nombre)).toEqual(['B']);

    verificacionCorrecta(exchange);
    await sesion.agregar({ ...ALTA, grupoNombre: 'A', etiqueta: 'Sub-03' });

    expect(sesion.cuentasPanel().map((c) => c.nombre)).toEqual(['A', 'B']);
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

  /*
   * El punto 10 del cliente, en una prueba.
   *
   * Hasta el 29/08/2026 el saldo de la matriz solo cambiaba al verificar la
   * credencial: el operador movia dinero entre cuentas desde la web de Bitget y
   * el panel seguia enseñando el de antes hasta que pulsaba «Probar» en esa
   * fila. Ahora el barrido lo trae solo, y `registrarSaldo` es la puerta por la
   * que entra. Lo que se fija es que esa puerta llega hasta la pantalla **sin
   * pasar por `verificar`**, que es lo unico que el cliente pidio.
   */
  it('un saldo del barrido cambia la matriz sin pasar por Probar', async () => {
    await sesion.crear(MAESTRA);
    verificacionCorrecta(exchange);
    const alta = await sesion.agregar(ALTA);
    expect(sesion.cuentasPanel()[0]?.subcuentas[0]?.saldo).toBe('500');

    const peticionesAntes = exchange.peticiones.length;
    sesion.registrarSaldo(alta.cuenta?.id ?? '', '1250.75');

    expect(sesion.cuentasPanel()[0]?.subcuentas[0]?.saldo).toBe('1250.75');
    /* No sale ninguna peticion: el barrido ya la hizo, esto solo la anota. */
    expect(exchange.peticiones).toHaveLength(peticionesAntes);
  });

  it('un saldo del barrido avisa a la pantalla, y solo cuando cambia', async () => {
    await sesion.crear(MAESTRA);
    verificacionCorrecta(exchange);
    const alta = await sesion.agregar(ALTA);
    const id = alta.cuenta?.id ?? '';

    let avisos = 0;
    sesion.alCambiar(() => {
      avisos += 1;
    });

    sesion.registrarSaldo(id, '1250.75');
    expect(avisos).toBe(1);

    /*
     * El mismo saldo dos veces no es una novedad. Sin este corte, trescientas
     * cuentas con el saldo quieto despertarian la publicacion a cada vuelta del
     * barrido para reenviar una matriz identica.
     */
    sesion.registrarSaldo(id, '1250.75');
    expect(avisos).toBe(1);

    sesion.registrarSaldo(id, '1300');
    expect(avisos).toBe(2);
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

/**
 * El aviso que dispara el respaldo automatico.
 *
 * La sesion no respalda nada: solo dice que sus credenciales cambiaron en
 * disco. Lo que se prueba aqui es cuando lo dice —y, sobre todo, que decirlo
 * no puede romper la operacion que lo provoco—.
 */
describe('aviso de que las credenciales cambiaron', () => {
  it('lo dispara un alta', async () => {
    await sesion.crear(MAESTRA);
    let veces = 0;
    sesion.alCambiarCredenciales(() => {
      veces += 1;
    });
    verificacionCorrecta(exchange);

    await sesion.agregar(ALTA);

    expect(veces).toBe(1);
  });

  it('lo dispara una baja', async () => {
    await sesion.crear(MAESTRA);
    await sesion.fijarPaso(PASO);
    verificacionCorrecta(exchange);
    const alta = await sesion.agregar(ALTA);
    let veces = 0;
    sesion.alCambiarCredenciales(() => {
      veces += 1;
    });

    await sesion.eliminar(alta.cuenta?.id ?? '', PASO);

    expect(veces).toBe(1);
  });

  /* No se escribio nada, asi que no hay nada que respaldar. */
  it('un alta rechazada no lo dispara', async () => {
    await sesion.crear(MAESTRA);
    let veces = 0;
    sesion.alCambiarCredenciales(() => {
      veces += 1;
    });
    exchange.responder({ cuerpo: sobreError('40012', 'apikey/password is incorrect') });

    const r = await sesion.agregar(ALTA);

    expect(r.ok).toBe(false);
    expect(veces).toBe(0);
  });

  /*
   * La garantia que sostiene todo el enganche: el respaldo es un añadido, el
   * alta es el trabajo. Si respaldar revienta, el alta sigue siendo un alta
   * correcta —ya esta escrita en disco cuando esto se avisa—.
   */
  it('un oyente que revienta no rompe el alta', async () => {
    await sesion.crear(MAESTRA);
    sesion.alCambiarCredenciales(() => {
      throw new Error('el disco de Documentos no responde');
    });
    verificacionCorrecta(exchange);

    const r = await sesion.agregar(ALTA);

    expect(r.ok).toBe(true);
    expect(sesion.listar()).toHaveLength(1);
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
    await sesion.fijarPaso(PASO);
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
    await sesion.eliminar(alta.cuenta?.id ?? '', PASO);
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

/**
 * Como esta el simbolo en Bitget, para la apertura.
 *
 * La planificacion lo lee para saber si tiene que cambiar el modo de margen
 * antes de abrir. Aislado, que es el modo con el que abren estas pruebas: asi
 * no hay nada que cambiar y lo que se mide es la sesion, no esa maniobra.
 */
const CUENTA_SIMBOLO = {
  marginCoin: 'SUSDT',
  available: '500',
  accountEquity: '500',
  marginMode: 'isolated',
  posMode: 'hedge_mode',
  isolatedLongLever: 10,
  isolatedShortLever: 10,
  crossedMarginLeverage: 10
};

/**
 * La hora que da Bitget en `/api/v2/public/time`. `null` es «el reloj de
 * verdad»; las pruebas del tope la mueven para simular que pasa el tiempo sin
 * tocar el reloj del equipo, o al reves.
 */
let horaBitget: number | null = null;

/** Deja el exchange respondiendo catalogo, precio, hora, configuracion y ordenes. */
function enrutarMercado(alOrdenar?: (cuerpo: Record<string, unknown>) => unknown): void {
  exchange.responderCon((p) => {
    if (p.url.startsWith('/api/v2/public/time')) {
      return { cuerpo: sobreOk({ serverTime: String(horaBitget ?? Date.now()) }) };
    }
    if (p.url.startsWith('/api/v2/mix/market/contracts')) return { cuerpo: sobreOk([CONTRATO]) };
    if (p.url.startsWith('/api/v2/mix/market/ticker')) {
      return { cuerpo: sobreOk([{ symbol: SIMBOLO, lastPr: '63378', markPrice: '63381.3' }]) };
    }
    if (p.url.startsWith('/api/v2/mix/account/account')) {
      return { cuerpo: sobreOk(CUENTA_SIMBOLO) };
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

/**
 * Sesion abierta con una subcuenta dada de alta, su saldo ya conocido y un tope
 * de margen holgado: sin tope no se abre nada, y las pruebas que no son del
 * tope no deben depender de el.
 */
async function conUnaCuenta(tope: string | null = '1000'): Promise<string> {
  await sesion.crear(MAESTRA);
  verificacionCorrecta(exchange);
  const alta = await sesion.agregar(ALTA);
  enrutarMercado();
  if (tope !== null) await sesion.fijarTopeMargen(tope);
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
      precioLimite: null,
      modoMargen: 'isolated'
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
      precioLimite: null,
      modoMargen: 'isolated'
    });
    const lote = await sesion.ejecutarApertura(plan.id);

    expect(lote.jobs).toHaveLength(1);
    expect(lote.jobs[0]?.estado).toBe('exito');
    expect(lote.jobs[0]?.etiqueta).toBe('Sub-01');
  });

  /*
   * El aviso que hace que el informe enseñe el saldo de **despues** de abrir.
   *
   * La sesion no releee nada por su cuenta: dice que cuentas acaba de tocar, y
   * el barrido -cableado en index.ts- les adelanta la lectura. Sin esto, la
   * matriz seguiria con el saldo de antes de la apertura hasta 45 segundos,
   * justo mientras el operador comprueba en el informe que salio bien.
   */
  it('avisa de las cuentas que toco, una sola vez y al terminar', async () => {
    const cuentaId = await conUnaCuenta();

    const avisos: readonly string[][] = [];
    sesion.alTocarCuentas((ids) => {
      (avisos as string[][]).push([...ids]);
    });

    const plan = await sesion.planificarApertura({
      simbolo: SIMBOLO,
      objetivos: [{ cuentaId, lado: 'long' }],
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null,
      modoMargen: 'isolated'
    });
    await sesion.ejecutarApertura(plan.id);

    /* Un aviso por lote, no uno por cada paso del progreso. */
    expect(avisos).toEqual([[cuentaId]]);
  });

  it('deja de avisar cuando el oyente se da de baja', async () => {
    const cuentaId = await conUnaCuenta();

    let avisos = 0;
    const baja = sesion.alTocarCuentas(() => {
      avisos += 1;
    });
    baja();

    const plan = await sesion.planificarApertura({
      simbolo: SIMBOLO,
      objetivos: [{ cuentaId, lado: 'long' }],
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null,
      modoMargen: 'isolated'
    });
    await sesion.ejecutarApertura(plan.id);

    expect(avisos).toBe(0);
  });

  /*
   * ========================================================================
   * Un plan impedido no sale, y esta es la comprobacion que lo garantiza.
   * ========================================================================
   * La pantalla ya lo enseña bloqueado y no deja llegar a la contraseña, pero
   * el renderer no puede ser el unico freno de nada que mueva dinero: si esta
   * puerta no existiera, bastaria un fallo de la pagina -o un `id` reenviado a
   * mano- para abrir un lote que el operador nunca pudo confirmar.
   *
   * La cuenta de las pruebas tiene 500 de disponible: 400 de margen inicial
   * caben, 400 mas 200 de adicional no.
   */
  it('un plan impedido por saldo no se ejecuta, y no sale ninguna orden', async () => {
    const cuentaId = await conUnaCuenta();

    const plan = await sesion.planificarApertura({
      simbolo: SIMBOLO,
      objetivos: [{ cuentaId, lado: 'long' }],
      margenInicial: '400',
      apalancamiento: 10,
      precioLimite: null,
      modoMargen: 'isolated',
      margenAdicional: '200'
    });

    expect(plan.impedimento?.codigo).toBe('saldo-margen-adicional');

    const enviadasAntes = exchange.peticiones.filter((p) => p.url.includes('place-order')).length;
    await expect(sesion.ejecutarApertura(plan.id)).rejects.toThrow(/No se abre ninguna posición/);

    expect(exchange.peticiones.filter((p) => p.url.includes('place-order'))).toHaveLength(
      enviadasAntes
    );
  });

  /* Ni por la puerta de atras: el impedimento es del lote, no de las casillas. */
  it('tampoco se ejecuta reintentando solo unas casillas', async () => {
    const cuentaId = await conUnaCuenta();

    const plan = await sesion.planificarApertura({
      simbolo: SIMBOLO,
      objetivos: [{ cuentaId, lado: 'long' }],
      margenInicial: '400',
      apalancamiento: 10,
      precioLimite: null,
      modoMargen: 'isolated',
      margenAdicional: '200'
    });

    await expect(
      sesion.ejecutarApertura(plan.id, [{ cuentaId, lado: 'long' }])
    ).rejects.toThrow(/No se abre ninguna posición/);
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
    const otra = new Sesion({ vault: rutaVault, cuentas: rutaCuentas, activos: rutaActivos }, cliente, {
      parametrosKdf: KDF_PRUEBAS,
      ahora: () => reloj
    });
    await otra.abrir(MAESTRA);

    const plan = await otra.planificarApertura({
      simbolo: SIMBOLO,
      objetivos: [{ cuentaId, lado: 'long' }],
      margenInicial: '100',
      apalancamiento: 10,
      precioLimite: null,
      modoMargen: 'isolated'
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
      precioLimite: null,
      modoMargen: 'isolated'
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
      precioLimite: null,
      modoMargen: 'isolated'
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
        precioLimite: null,
        modoMargen: 'isolated'
      })
    ).rejects.toThrow('bloqueado');
  });
});

/* ---------------- tope de margen inicial ---------------- */

describe('tope de margen inicial', () => {
  const DIA = 24 * 60 * 60 * 1000;
  const peticion = (cuentaId: string, margenInicial: string) => ({
    simbolo: SIMBOLO,
    objetivos: [{ cuentaId, lado: 'long' as const }],
    margenInicial,
    apalancamiento: 10,
    precioLimite: null,
    modoMargen: 'isolated' as const
  });
  const pidioPrecio = (): boolean =>
    exchange.peticiones.some((p) => p.url.includes('/market/ticker'));

  beforeEach(() => {
    horaBitget = null;
  });

  /**
   * Una sesion cuyo cliente de Bitget lee un reloj de equipo que la prueba
   * controla. La hora de Bitget se mueve aparte, con `horaBitget`.
   */
  async function conReloj(inicio: number) {
    let equipo = inicio;
    horaBitget = inicio;
    const cli = new ClienteBitget({ host: exchange.url, ahora: () => equipo });
    const s = new Sesion({ vault: rutaVault, cuentas: rutaCuentas, activos: rutaActivos }, cli);
    await s.crear(MAESTRA);
    verificacionCorrecta(exchange);
    const alta = await s.agregar(ALTA);
    enrutarMercado();
    return {
      s,
      cuentaId: alta.cuenta?.id ?? '',
      /** Pasa el tiempo de verdad: para el equipo y para Bitget. */
      pasar: (ms: number) => {
        equipo += ms;
        horaBitget = (horaBitget ?? 0) + ms;
      },
      /** Alguien toca el reloj de Windows. Bitget no se entera. */
      tocarEquipo: (ms: number) => {
        equipo += ms;
      },
      cerrar: async () => {
        s.cerrar();
        await cli.cerrar();
      }
    };
  }

  it('un panel recien instalado no tiene tope y no abre nada', async () => {
    const cuentaId = await conUnaCuenta(null);

    expect(sesion.estadoTopeMargen().estado).toBe('sin-tope');
    await expect(sesion.planificarApertura(peticion(cuentaId, '1'))).rejects.toThrow(
      /fijar el margen inicial máximo/
    );
    /* Se rechaza antes de gastar una sola peticion en precios. */
    expect(pidioPrecio()).toBe(false);
  });

  /*
   * El caso que motivo todo: el tope es 1 y el operador escribe 5 queriendo
   * escribir 0,5. No sale nada, para ninguna casilla.
   */
  it('un margen por encima del tope aborta el lote entero', async () => {
    const cuentaId = await conUnaCuenta('1');

    await expect(sesion.planificarApertura(peticion(cuentaId, '5'))).rejects.toThrow(
      /el tope de este panel es 1/
    );
    expect(pidioPrecio()).toBe(false);
    expect(exchange.peticiones.some((p) => p.url.includes('place-order'))).toBe(false);
  });

  it('un margen igual o menor que el tope si se planifica', async () => {
    const cuentaId = await conUnaCuenta('1');

    const plan = await sesion.planificarApertura(peticion(cuentaId, '1'));

    expect(plan.entradas).toHaveLength(1);
  });

  it('mientras esta vigente no se puede cambiar, ni para subirlo ni para bajarlo', async () => {
    await conUnaCuenta('1');

    await expect(sesion.fijarTopeMargen('5')).rejects.toThrow(/sigue vigente/);
    await expect(sesion.fijarTopeMargen('0.5')).rejects.toThrow(/sigue vigente/);
    expect(sesion.estadoTopeMargen()).toMatchObject({ estado: 'vigente', valor: '1' });
  });

  it('sobrevive a bloquear y desbloquear: vive dentro del almacen cifrado', async () => {
    await conUnaCuenta('0.5');
    sesion.cerrar();
    await sesion.abrir(MAESTRA);

    expect(sesion.estadoTopeMargen()).toMatchObject({ estado: 'vigente', valor: '0.5' });
    await expect(sesion.fijarTopeMargen('5')).rejects.toThrow(/sigue vigente/);
  });

  it('rechaza un tope que no es un numero positivo', async () => {
    await conUnaCuenta(null);

    for (const malo of ['0', '-1', 'abc', '1e3', '0,5']) {
      await expect(sesion.fijarTopeMargen(malo)).rejects.toThrow();
    }
    expect(sesion.estadoTopeMargen().estado).toBe('sin-tope');
  });

  it('a las 24 horas vence, bloquea la apertura y deja fijar uno nuevo', async () => {
    const r = await conReloj(Date.parse('2026-10-06T09:00:00Z'));
    await r.s.fijarTopeMargen('1');

    r.pasar(DIA - 60_000);
    expect(r.s.estadoTopeMargen().estado).toBe('vigente');
    await expect(r.s.fijarTopeMargen('2')).rejects.toThrow(/sigue vigente/);

    r.pasar(60_000);
    expect(r.s.estadoTopeMargen().estado).toBe('vencido');
    await expect(r.s.planificarApertura(peticion(r.cuentaId, '1'))).rejects.toThrow(/venció/);

    const nuevo = await r.s.fijarTopeMargen('2');
    expect(nuevo).toMatchObject({ estado: 'vigente', valor: '2' });
    await r.cerrar();
  });

  /*
   * Adelantar el reloj de Windows un dia hace que el tope *parezca* vencido, y
   * eso solo bloquea las aperturas. Para fijar otro se pregunta la hora a
   * Bitget, que sigue diciendo que el tope tiene un minuto.
   */
  it('adelantar el reloj del equipo no libera el tope', async () => {
    const r = await conReloj(Date.parse('2026-10-06T09:00:00Z'));
    await r.s.fijarTopeMargen('1');

    r.pasar(60_000);
    r.tocarEquipo(2 * DIA);

    await expect(r.s.fijarTopeMargen('50')).rejects.toThrow(/sigue vigente/);
    /* Tras preguntar a Bitget, el panel vuelve a saber la hora buena. */
    expect(r.s.estadoTopeMargen()).toMatchObject({ estado: 'vigente', valor: '1' });
    await r.cerrar();
  });

  /*
   * El truco inverso: atrasar el reloj antes de fijar para que el tope nazca
   * ya viejo y venza enseguida. `fijadoEn` es la hora de Bitget, no la del equipo.
   */
  it('atrasar el reloj del equipo antes de fijar no acorta el plazo', async () => {
    const bitget = Date.parse('2026-10-06T09:00:00Z');
    const r = await conReloj(bitget);
    r.tocarEquipo(-23 * 60 * 60 * 1000);

    const fijado = await r.s.fijarTopeMargen('1');

    expect(fijado.fijadoEn).toBe(new Date(bitget).toISOString());
    expect(fijado.venceEn).toBe(new Date(bitget + DIA).toISOString());
    await r.cerrar();
  });

  it('sin la hora de Bitget no se fija nada', async () => {
    await conUnaCuenta(null);
    exchange.responderCon((p) =>
      p.url.startsWith('/api/v2/public/time')
        ? { cuerpo: sobreOk({ serverTime: 'no-es-hora' }) }
        : null
    );

    await expect(sesion.fijarTopeMargen('1')).rejects.toThrow(/hora con Bitget/);
    expect(sesion.estadoTopeMargen().estado).toBe('sin-tope');
  });

  /*
   * Un plan dura dos minutos y un reintento puede llegar mas tarde. Si el tope
   * vence entre medias, lo aprobado ya no esta cubierto y no sale.
   */
  it('si vence entre planificar y enviar, no sale ninguna orden', async () => {
    const r = await conReloj(Date.parse('2026-10-06T09:00:00Z'));
    await r.s.fijarTopeMargen('1');
    r.pasar(DIA - 30_000);
    const plan = await r.s.planificarApertura(peticion(r.cuentaId, '1'));

    r.pasar(60_000);

    await expect(r.s.ejecutarApertura(plan.id)).rejects.toThrow(/venció/);
    expect(exchange.peticiones.some((p) => p.url.includes('place-order'))).toBe(false);
    await r.cerrar();
  });

  it('con el panel bloqueado no se consulta ni se fija', async () => {
    expect(() => sesion.estadoTopeMargen()).toThrow('bloqueado');
    await expect(sesion.fijarTopeMargen('1')).rejects.toThrow('bloqueado');
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
    /* En ganancia: cerrar no pide la contraseña de paso. */
    markPrice: '64000',
    liquidationPrice: '57000.1',
    leverage: '10',
    marginSize: '99.3'
  };

  /** Enruta las llamadas del cierre; `hay` decide si la cuenta tiene posicion. */
  function enrutarCierre(hay = true, marca = '64000'): void {
    exchange.responderCon((p) => {
      if (p.url.startsWith('/api/v2/mix/position/all-position')) {
        return { cuerpo: sobreOk(hay ? [{ ...posicionAbierta, markPrice: marca }] : []) };
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

  /*
   * El cliente, 29/10/2026: el cierre rapido sigue sin contraseña, salvo que
   * cierre en negativo. La sesion lo exige aunque la pantalla se lo salte.
   */
  describe('en negativo pide la contraseña de paso', () => {
    const PASO = 'paso-1234';

    async function planEnPerdida(): Promise<{ planId: string; cuentaId: string }> {
      await sesion.crear(MAESTRA);
      await sesion.fijarPaso(PASO);
      verificacionCorrecta(exchange);
      const alta = await sesion.agregar(ALTA);
      /* Long a 63200,5 con la marca en 63000: pierde. */
      enrutarCierre(true, '63000');
      const cuentaId = alta.cuenta?.id ?? '';
      const plan = await sesion.planificarCierre({
        simbolo: SIMBOLO,
        objetivos: [{ cuentaId, lado: 'long' }]
      });
      expect(Number(plan.entradas[0]?.resultadoEstimado)).toBeLessThan(0);
      return { planId: plan.id, cuentaId };
    }

    const cierres = () => exchange.peticiones.filter((p) => p.url.includes('close-positions'));

    it('sin contraseña no cierra nada', async () => {
      const { planId } = await planEnPerdida();
      await expect(sesion.ejecutarCierre(planId)).rejects.toThrow('contraseña de paso');
      expect(cierres()).toHaveLength(0);
    });

    it('con la contraseña equivocada no cierra nada', async () => {
      const { planId } = await planEnPerdida();
      await expect(sesion.ejecutarCierre(planId, undefined, 'otra')).rejects.toThrow('incorrecta');
      expect(cierres()).toHaveLength(0);
    });

    it('con la buena cierra, y el reintento del mismo plan no la vuelve a pedir', async () => {
      const { planId, cuentaId } = await planEnPerdida();
      const lote = await sesion.ejecutarCierre(planId, [{ cuentaId, lado: 'long' }], PASO);
      expect(lote.jobs[0]?.estado).toBe('exito');

      const otra = await sesion.ejecutarCierre(planId, [{ cuentaId, lado: 'long' }]);
      expect(otra.jobs[0]?.estado).toBe('exito');
    });

    it('sin precio con que calcular el resultado, la pide igual', async () => {
      await sesion.crear(MAESTRA);
      await sesion.fijarPaso(PASO);
      verificacionCorrecta(exchange);
      const alta = await sesion.agregar(ALTA);
      enrutarCierre(true, '');
      const plan = await sesion.planificarCierre({
        simbolo: SIMBOLO,
        objetivos: [{ cuentaId: alta.cuenta?.id ?? '', lado: 'long' }]
      });
      expect(plan.entradas[0]?.resultadoEstimado).toBeNull();
      await expect(sesion.ejecutarCierre(plan.id)).rejects.toThrow('contraseña de paso');
    });
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

/*
 * ---------------------------------------------------------------------------
 * Ajustar una posicion ya abierta
 * ---------------------------------------------------------------------------
 * Los cuatro canales -poner y quitar Take Profit, agregar y quitar margen-
 * estuvieron retirados entre el 26/08/2026 y el 01/09/2026. Se quitaron porque
 * el Take Profit y el margen adicional viajan **tambien** dentro de la apertura,
 * y con las dos vias abiertas el mismo importe se podia enviar dos veces sobre
 * la misma posicion.
 *
 * Lo que se prueba aqui es la `Sesion`, que es el objeto detras de cada canal:
 * el recorrido entero de las dos fases, con vault y credenciales de verdad. Lo
 * que impide la repeticion -que el Take Profit sustituya el anterior, que el
 * margen se planifique contra lo que Bitget dice que hay- se prueba en el motor.
 */
describe('ajustar una posicion ya abierta', () => {
  /** Posicion aislada: es el unico modo en el que Bitget mueve margen por posicion. */
  const posicionAislada = {
    symbol: SIMBOLO,
    holdSide: 'long',
    total: '0.0157',
    available: '0.0157',
    marginCoin: 'SUSDT',
    marginMode: 'isolated',
    openPriceAvg: '63000',
    liquidationPrice: '57000.1',
    leverage: '10',
    marginSize: '100'
  };

  /** Enruta lo que necesitan los dos ajustes; `planes` es lo que ya hay puesto. */
  function enrutarAjuste(planes: unknown[] = []): void {
    exchange.responderCon((p) => {
      if (p.url.startsWith('/api/v2/mix/market/contracts')) return { cuerpo: sobreOk([CONTRATO]) };
      if (p.url.startsWith('/api/v2/mix/position/all-position')) {
        return { cuerpo: sobreOk([posicionAislada]) };
      }
      if (p.url.startsWith('/api/v2/mix/order/orders-plan-pending')) {
        return { cuerpo: sobreOk({ entrustedList: planes }) };
      }
      if (p.url.startsWith('/api/v2/mix/order/place-tpsl-order')) {
        const cuerpo = JSON.parse(p.cuerpo) as Record<string, unknown>;
        return { cuerpo: sobreOk({ orderId: 'plan_nuevo', clientOid: cuerpo['clientOid'] }) };
      }
      if (p.url.startsWith('/api/v2/mix/order/cancel-plan-order')) {
        return { cuerpo: sobreOk({ successList: [{ orderId: 'plan_viejo' }], failureList: [] }) };
      }
      if (p.url.startsWith('/api/v2/mix/account/set-margin')) return { cuerpo: sobreOk({}) };
      return null;
    });
  }

  /** Sesion abierta, una subcuenta de alta y el exchange listo para el ajuste. */
  async function conPosicionAbierta(planes: unknown[] = []): Promise<string> {
    await sesion.crear(MAESTRA);
    verificacionCorrecta(exchange);
    const alta = await sesion.agregar(ALTA);
    enrutarAjuste(planes);
    return alta.cuenta?.id ?? '';
  }

  it('poner Take Profit calcula el precio y no coloca nada al planificar', async () => {
    const cuentaId = await conPosicionAbierta();

    const plan = await sesion.planificarTakeProfit({
      simbolo: SIMBOLO,
      objetivos: [{ cuentaId, lado: 'long' }],
      porcentaje: '35'
    });

    /* 63.000 x (1 + 0,35/10) = 65.205 */
    expect(plan.entradas[0]?.precioDisparo).toBe('65205');
    expect(exchange.peticiones.filter((p) => p.url.includes('place-tpsl'))).toHaveLength(0);
  });

  it('ejecuta el Take Profit por su identificador y quita el anterior', async () => {
    const cuentaId = await conPosicionAbierta([
      {
        orderId: 'plan_viejo',
        clientOid: 'oid_viejo',
        symbol: SIMBOLO,
        planType: 'pos_profit',
        triggerPrice: '64000',
        posSide: 'long'
      }
    ]);

    const plan = await sesion.planificarTakeProfit({
      simbolo: SIMBOLO,
      objetivos: [{ cuentaId, lado: 'long' }],
      porcentaje: '35'
    });
    const lote = await sesion.ejecutarTakeProfit(plan.id);

    expect(lote.accion).toBe('take-profit');
    expect(lote.jobs[0]?.estado).toBe('exito');
    expect(exchange.peticiones.filter((p) => p.url.includes('cancel-plan-order'))).toHaveLength(1);
  });

  it('agregar margen enseña el resultante y no envia nada al planificar', async () => {
    const cuentaId = await conPosicionAbierta();

    const plan = await sesion.planificarMargen({
      simbolo: SIMBOLO,
      objetivos: [{ cuentaId, lado: 'long' }],
      cantidad: '25',
      direccion: 'agregar'
    });

    expect(plan.entradas[0]?.margenActual).toBe('100');
    expect(plan.entradas[0]?.margenResultante).toBe('125');
    expect(exchange.peticiones.filter((p) => p.url.includes('set-margin'))).toHaveLength(0);
  });

  it('quitar margen envia el importe en negativo', async () => {
    const cuentaId = await conPosicionAbierta();

    const plan = await sesion.planificarMargen({
      simbolo: SIMBOLO,
      objetivos: [{ cuentaId, lado: 'long' }],
      cantidad: '25',
      direccion: 'quitar'
    });
    const lote = await sesion.ejecutarMargen(plan.id);

    expect(lote.accion).toBe('quitar-margen');
    expect(lote.jobs[0]?.estado).toBe('exito');
    const envio = exchange.peticiones.find((p) => p.url.includes('set-margin'));
    expect(JSON.parse(envio?.cuerpo ?? '{}')).toMatchObject({ amount: '-25', holdSide: 'long' });
  });

  it('un plan de ajuste que no existe no se ejecuta', async () => {
    await sesion.crear(MAESTRA);

    await expect(sesion.ejecutarTakeProfit('plan-inventado')).rejects.toThrow(/ya no existe/);
    await expect(sesion.ejecutarMargen('plan-inventado')).rejects.toThrow(/ya no existe/);
  });

  /* Un plan sin sesion no se puede ejecutar: se tira con las credenciales. */
  it('bloquear el panel tira los planes de ajuste', async () => {
    const cuentaId = await conPosicionAbierta();

    const tp = await sesion.planificarTakeProfit({
      simbolo: SIMBOLO,
      objetivos: [{ cuentaId, lado: 'long' }],
      porcentaje: '35'
    });
    const mg = await sesion.planificarMargen({
      simbolo: SIMBOLO,
      objetivos: [{ cuentaId, lado: 'long' }],
      cantidad: '25',
      direccion: 'agregar'
    });

    sesion.cerrar();
    await sesion.abrir(MAESTRA);

    expect(sesion.planTakeProfit(tp.id)).toBeUndefined();
    expect(sesion.planMargen(mg.id)).toBeUndefined();
  });

  it('con el panel bloqueado no se planifica ningun ajuste', async () => {
    await expect(
      sesion.planificarTakeProfit({
        simbolo: SIMBOLO,
        objetivos: [{ cuentaId: 'x', lado: 'long' }],
        porcentaje: '35'
      })
    ).rejects.toThrow('bloqueado');

    await expect(
      sesion.planificarMargen({
        simbolo: SIMBOLO,
        objetivos: [{ cuentaId: 'x', lado: 'long' }],
        cantidad: '25',
        direccion: 'quitar'
      })
    ).rejects.toThrow('bloqueado');
  });
});

/**
 * ==========================================================================
 * El freno de la contrasena maestra
 * ==========================================================================
 * Lo pidio el cliente el 17/09/2026: en vez de bloquear el panel tras varios
 * fallos -que deja al operador sin saber que hacer-, una espera que crece y se
 * cumple sola. Aqui se comprueba que el freno esta **en la sesion** y no en la
 * pantalla: quien llame a `abrir` por el IPC se lo encuentra igual.
 */
describe('la espera tras fallar la maestra', () => {
  /** Un reloj que se puede mover: las esperas son de minutos. */
  let reloj: number;

  /** Una sesion con su propio freno sobre el reloj de mentira. */
  async function sesionConFreno(): Promise<Sesion> {
    const freno = await FrenoMaestra.cargar(join(carpeta, 'intentos.json'), {
      ahora: () => reloj
    });
    return new Sesion(
      { vault: rutaVault, cuentas: rutaCuentas, activos: rutaActivos },
      cliente,
      { parametrosKdf: KDF_PRUEBAS, freno }
    );
  }

  beforeEach(async () => {
    reloj = 1_700_000_000_000;
    await sesion.crear(MAESTRA);
    sesion.cerrar();
  });

  it('los dos primeros fallos no frenan nada', async () => {
    const s = await sesionConFreno();

    expect((await s.abrir('mal-1')).motivo).toBe('contrasena-incorrecta');
    expect((await s.abrir('mal-2')).motivo).toBe('contrasena-incorrecta');
    expect(await s.esperaMaestraMs()).toBe(0);

    /* Y la buena sigue entrando: dos fallos no cierran la puerta. */
    expect((await s.abrir(MAESTRA)).ok).toBe(true);
    s.cerrar();
  });

  it('al tercer fallo impone tres minutos, y lo dice sin acusar a la clave', async () => {
    const s = await sesionConFreno();
    for (let i = 0; i < 3; i += 1) await s.abrir(`mal-${i}`);

    expect(await s.esperaMaestraMs()).toBe(3 * 60_000);

    const resultado = await s.abrir(MAESTRA);
    expect(resultado.ok).toBe(false);
    expect(resultado.motivo).toBe('espera-activa');
    expect(resultado.mensaje).toContain('3 minutos');
  });

  it('cumplida la espera, la contrasena buena entra', async () => {
    const s = await sesionConFreno();
    for (let i = 0; i < 3; i += 1) await s.abrir(`mal-${i}`);

    reloj += 3 * 60_000;

    const resultado = await s.abrir(MAESTRA);
    expect(resultado.ok).toBe(true);
    /* Y acertar borra el castigo: el siguiente fallo vuelve a ser el primero. */
    expect(await s.esperaMaestraMs()).toBe(0);
    s.cerrar();
  });

  it('la espera dobla con cada fallo posterior', async () => {
    const s = await sesionConFreno();
    for (let i = 0; i < 3; i += 1) await s.abrir(`mal-${i}`);

    reloj += 3 * 60_000;
    await s.abrir('otra-mala');

    expect(await s.esperaMaestraMs()).toBe(6 * 60_000);
  });

  /*
   * Las tres puertas que piden la maestra comparten contador. Sin esto, gastar
   * los tres intentos del desbloqueo y seguir probando en la pantalla de
   * seguridad daria tres intentos mas por cada sitio donde se pregunta.
   */
  it('el contador es el mismo para el desbloqueo y para la pantalla de seguridad', async () => {
    const s = await sesionConFreno();
    await s.abrir('mal-1');
    await s.abrir('mal-2');
    expect((await s.abrir(MAESTRA)).ok).toBe(true);

    /* Con la sesion ya abierta, dos fallos mas en la pantalla de seguridad. */
    await s.comprobarMaestra('mal-3');
    await s.comprobarMaestra('mal-4');
    expect(await s.esperaMaestraMs()).toBe(0);

    /* El tercero cae en la espera, aunque el primero fuera en otra pantalla. */
    expect(await s.comprobarMaestra('mal-5')).toBe(false);
    expect(await s.esperaMaestraMs()).toBe(3 * 60_000);

    /* Y con el freno echado, tampoco vale la buena. */
    expect(await s.comprobarMaestra(MAESTRA)).toBe(false);
    s.cerrar();
  });

  /*
   * Un vault que no existe no dice nada sobre la clave que se tecleo. Contarlo
   * castigaria con una hora de espera a quien tiene el almacen roto, que es
   * justo cuando mas falta hace poder intentarlo.
   */
  it('un fallo que no es de contrasena no gasta intentos', async () => {
    const otraCarpeta = join(carpeta, 'sin-vault');
    const s = new Sesion(
      {
        vault: join(otraCarpeta, 'vault.enc'),
        cuentas: join(otraCarpeta, 'cuentas.json'),
        activos: join(otraCarpeta, 'activos.json'),
        intentos: join(otraCarpeta, 'intentos.json')
      },
      cliente,
      { parametrosKdf: KDF_PRUEBAS }
    );

    for (let i = 0; i < 4; i += 1) {
      expect((await s.abrir('lo-que-sea')).motivo).toBe('no-existe');
    }

    expect(await s.esperaMaestraMs()).toBe(0);
  });
});
