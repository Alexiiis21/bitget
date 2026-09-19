/**
 * Registro de cuentas.
 *
 * Lo que se prueba aqui es lo que decide si el panel muestra la verdad: que dar
 * de alta dos veces la misma subcuenta la actualiza en vez de duplicarla, y que
 * una cuenta sin credencial en el vault no sobrevive a un reinicio.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CUENTAS_MADRE_MAX, NOMBRES_CUENTA_MADRE, SUBCUENTAS_POR_GRUPO } from '@shared/constants';
import { ErrorRegistro, RegistroCuentas } from '@main/domain/registro-cuentas';

let carpeta: string;
let ruta: string;

/** UID de la cuenta principal de las pruebas, como lo devuelve Bitget. */
const UID_PADRE = '1513226215';

/**
 * Un UID por subcuenta, distinto para cada una.
 *
 * Que la fabrica los reparta distintos no es cosmetico: el registro empareja
 * por UID, y una fabrica que diera el mismo a todas haria pasar por buenas
 * pruebas que en realidad estarian confundiendo dos subcuentas.
 */
const uidDe = (etiqueta: string): string => `5476143${etiqueta.replace(/\D/g, '').padStart(3, '0')}`;

/** Una cuenta tal como la escribia el formato de version 1: con `orden`, sin `slot`. */
const cuentaV1 = (id: string, etiqueta: string, orden: number) => ({
  id,
  grupoId: 'g1',
  etiqueta,
  uid: uidDe(etiqueta),
  credencialId: `cred_${id}`,
  apiKeyEnmascarada: 'bg••••4f2a',
  orden,
  activa: true,
  modoPosicion: 'cobertura',
  modoMargen: 'aislado',
  altaEn: '2026-08-01T00:00:00.000Z'
});

const alta = (id: string, etiqueta: string, grupoNombre = 'A', credencialId = 'cred_1') => ({
  id,
  grupoNombre,
  etiqueta,
  uid: uidDe(etiqueta),
  uidPadre: UID_PADRE,
  credencialId,
  apiKeyEnmascarada: 'bg••••4f2a',
  modoPosicion: 'cobertura' as const,
  modoMargen: 'aislado' as const
});

beforeEach(async () => {
  carpeta = await mkdtemp(join(tmpdir(), 'pcb-registro-'));
  ruta = join(carpeta, 'cuentas.json');
});

afterEach(async () => {
  await rm(carpeta, { recursive: true, force: true });
});

describe('alta', () => {
  it('crea la cuenta principal la primera vez y la reutiliza despues', async () => {
    const registro = await RegistroCuentas.cargar(ruta);

    registro.agregar(alta(registro.reservarId('A', 'Sub-01'), 'Sub-01'));
    registro.agregar(alta(registro.reservarId('A', 'Sub-02'), 'Sub-02'));

    expect(registro.listarGrupos()).toHaveLength(1);
    expect(registro.listarCuentas()).toHaveLength(2);
  });

  /*
   * Rotar una API Key es dar de alta la misma subcuenta otra vez. Si eso
   * duplicara la fila, el operador tendria dos cuentas con el mismo nombre y
   * una de ellas con credenciales muertas.
   */
  it('actualiza la subcuenta que ya existe en lugar de duplicarla', async () => {
    const registro = await RegistroCuentas.cargar(ruta);

    const primera = registro.agregar(alta(registro.reservarId('A', 'Sub-01'), 'Sub-01'));
    const segunda = registro.agregar({
      /* Con el UID, que es como lo llama la sesion: quien reconoce la ficha es Bitget. */
      ...alta(registro.reservarId('A', 'Sub-01', uidDe('Sub-01')), 'Sub-01'),
      credencialId: 'cred_2',
      apiKeyEnmascarada: 'bg••••9999'
    });

    expect(segunda.id).toBe(primera.id);
    expect(segunda.altaEn).toBe(primera.altaEn);
    expect(registro.listarCuentas()).toHaveLength(1);
    expect(registro.listarCuentas()[0]?.apiKeyEnmascarada).toBe('bg••••9999');
  });

  it('reconoce la cuenta principal sin distinguir mayusculas ni espacios', async () => {
    const registro = await RegistroCuentas.cargar(ruta);

    registro.agregar(alta(registro.reservarId('A', 'Sub-01'), 'Sub-01', 'A'));
    registro.agregar(alta(registro.reservarId(' a ', 'Sub-02'), 'Sub-02', ' a '));

    expect(registro.listarGrupos()).toHaveLength(1);
  });
});

describe('el UID de Bitget como identidad', () => {
  /*
   * El caso que motivo todo esto. El operador vuelve a registrar una subcuenta
   * -porque roto la clave- y de paso le cambia el nombre. Emparejando por
   * nombre aparecerian dos casillas para una sola subcuenta real, cada una con
   * una credencial, y una de las dos muerta.
   */
  it('reconoce la misma subcuenta aunque llegue con otro nombre', async () => {
    const registro = await RegistroCuentas.cargar(ruta);
    const uid = uidDe('Sub-01');

    const primera = registro.agregar(alta(registro.reservarId('A', 'Sub-01', uid), 'Sub-01'));
    const segunda = registro.agregar({
      ...alta(registro.reservarId('A', 'Renombrada', uid), 'Renombrada'),
      uid,
      credencialId: 'cred_2',
      apiKeyEnmascarada: 'bg••••9999'
    });

    expect(registro.listarCuentas()).toHaveLength(1);
    expect(segunda.id).toBe(primera.id);
    expect(segunda.etiqueta).toBe('Renombrada');
    /* La casilla es lo que el operador tiene memorizado: no se mueve. */
    expect(segunda.slot).toBe(primera.slot);
    expect(segunda.altaEn).toBe(primera.altaEn);
  });

  it('guarda el UID y el de la cuenta principal', async () => {
    const registro = await RegistroCuentas.cargar(ruta);

    const cuenta = registro.agregar(alta(registro.reservarId('A', 'Sub-01'), 'Sub-01'));

    expect(cuenta.uid).toBe(uidDe('Sub-01'));
    expect(cuenta.uidPadre).toBe(UID_PADRE);
  });

  /* Dos subcuentas distintas siguen siendo dos, aunque compartan cuenta madre. */
  it('no confunde dos subcuentas con el mismo padre', async () => {
    const registro = await RegistroCuentas.cargar(ruta);

    registro.agregar(alta(registro.reservarId('A', 'Sub-01', uidDe('Sub-01')), 'Sub-01'));
    registro.agregar(alta(registro.reservarId('A', 'Sub-02', uidDe('Sub-02')), 'Sub-02'));

    expect(registro.listarCuentas()).toHaveLength(2);
  });

  /*
   * Si ademas se equivoco de cuenta principal, sigue siendo la misma subcuenta.
   * Se mueve de grupo, toma casilla en el nuevo -la suya de antes pertenece a
   * otra rejilla- y el grupo que se queda vacio desaparece.
   */
  it('la mueve de cuenta principal sin duplicarla', async () => {
    const registro = await RegistroCuentas.cargar(ruta);
    const uid = uidDe('Sub-01');

    const primera = registro.agregar(alta(registro.reservarId('A', 'Sub-01', uid), 'Sub-01', 'A'));
    const segunda = registro.agregar(alta(registro.reservarId('B', 'Sub-01', uid), 'Sub-01', 'B'));

    expect(registro.listarCuentas()).toHaveLength(1);
    expect(segunda.id).toBe(primera.id);
    expect(registro.nombreDeGrupo(segunda.grupoId)).toBe('B');
    expect(registro.listarGrupos().map((g) => g.nombre)).toEqual(['B']);
  });

  /*
   * Una ficha de un archivo viejo puede no tener UID todavia. Mientras no lo
   * tenga, el emparejamiento por nombre tiene que seguir funcionando o rotar
   * una clave duplicaria la cuenta.
   */
  it('sin UID conocido se sigue emparejando por nombre', async () => {
    const registro = await RegistroCuentas.cargar(ruta);

    const primera = registro.agregar({
      ...alta(registro.reservarId('A', 'Sub-01'), 'Sub-01'),
      uid: '',
      uidPadre: ''
    });
    const segunda = registro.agregar({
      ...alta(registro.reservarId('A', 'Sub-01'), 'Sub-01'),
      credencialId: 'cred_2'
    });

    expect(registro.listarCuentas()).toHaveLength(1);
    expect(segunda.id).toBe(primera.id);
  });

  /*
   * ==========================================================================
   * Etiqueta repetida con otro UID: son dos subcuentas, no una
   * ==========================================================================
   * Lo reporto el cliente el 18/09/2026. Al dar de alta la vigesima subcuenta
   * de una cuenta principal repitio sin querer la etiqueta de la septima, y el
   * respaldo por nombre -que esta para las fichas viejas todavia sin UID- la
   * reconocio como esa misma ficha: la septima perdio su casilla y su
   * credencial del vault, y el registro se quedo en diecinueve. El panel dijo
   * «API key guardada».
   */
  it('una etiqueta repetida con otro UID no pisa la ficha anterior', async () => {
    const registro = await RegistroCuentas.cargar(ruta);
    for (let n = 1; n < SUBCUENTAS_POR_GRUPO; n += 1) {
      const etiqueta = `Sub-${String(n).padStart(2, '0')}`;
      registro.agregar({
        ...alta(registro.reservarId('A', etiqueta, uidDe(etiqueta)), etiqueta),
        slot: n
      });
    }

    /* La vigesima es otra subcuenta de Bitget, con la etiqueta de la septima. */
    const otroUid = '5476143999';
    registro.agregar({
      ...alta(registro.reservarId('A', 'Sub-07', otroUid), 'Sub-07', 'A', 'cred_20'),
      uid: otroUid,
      slot: SUBCUENTAS_POR_GRUPO
    });

    const cuentas = registro.listarCuentas();
    expect(cuentas).toHaveLength(SUBCUENTAS_POR_GRUPO);
    /* La septima sigue en su casilla, con su UID y su credencial. */
    expect(cuentas.find((c) => c.slot === 7)?.uid).toBe(uidDe('Sub-07'));
    expect(cuentas.find((c) => c.slot === 7)?.credencialId).toBe('cred_1');
    expect(cuentas.find((c) => c.slot === SUBCUENTAS_POR_GRUPO)?.uid).toBe(otroUid);
  });

  /* La comparacion ignora mayusculas y espacios, que es por donde se colaba. */
  it('« sub-07 » tampoco pisa a «Sub-07»', async () => {
    const registro = await RegistroCuentas.cargar(ruta);
    registro.agregar({
      ...alta(registro.reservarId('A', 'Sub-07', uidDe('Sub-07')), 'Sub-07'),
      slot: 7
    });

    const otroUid = '5476143999';
    registro.agregar({
      ...alta(registro.reservarId('A', ' sub-07 ', otroUid), ' sub-07 '),
      uid: otroUid,
      slot: 8
    });

    expect(registro.listarCuentas()).toHaveLength(2);
  });

  /*
   * `comprobarCabida` corre antes de verificar, o sea sin UID, y por eso sigue
   * mirando solo la etiqueta. Si dejara de reconocer la ficha, rotar una clave
   * se rechazaria como «casilla ocupada» sin llegar a salir a la red.
   */
  it('el chequeo previo deja rotar la clave sobre la misma casilla', async () => {
    const registro = await RegistroCuentas.cargar(ruta);
    registro.agregar({
      ...alta(registro.reservarId('A', 'Sub-07', uidDe('Sub-07')), 'Sub-07'),
      slot: 7
    });

    expect(registro.comprobarCabida('A', 'Sub-07', 7)).toBeNull();
    /* Y para cualquier otra subcuenta esa casilla sigue ocupada. */
    expect(registro.comprobarCabida('A', 'Sub-08', 7)?.motivo).toBe('casilla-ocupada');
  });
});

/*
 * El modo de margen viaja en la orden como `marginMode` y Bitget lo obedece:
 * con la ficha desactualizada el panel abria en cruzado una cuenta que el
 * operador tenia en aislado. Se capturaba solo en el alta, y el operador puede
 * cambiarlo desde la web del exchange cuando quiera.
 */
describe('refresco de modos desde Bitget', () => {
  it('adopta el modo que Bitget declara ahora', async () => {
    const registro = await RegistroCuentas.cargar(ruta);
    const cuenta = registro.agregar(alta(registro.reservarId('A', 'Sub-01'), 'Sub-01'));
    expect(cuenta.modoMargen).toBe('aislado');

    expect(registro.actualizarModos(cuenta.id, { modoMargen: 'cruzado' })).toBe(true);
    expect(registro.cuenta(cuenta.id)?.modoMargen).toBe('cruzado');
  });

  it('no declara cambio cuando el modo es el que ya estaba', async () => {
    const registro = await RegistroCuentas.cargar(ruta);
    const cuenta = registro.agregar(alta(registro.reservarId('A', 'Sub-01'), 'Sub-01'));

    /* El `false` es lo que evita reescribir cuentas.json en cada verificacion. */
    expect(
      registro.actualizarModos(cuenta.id, { modoPosicion: 'cobertura', modoMargen: 'aislado' })
    ).toBe(false);
  });

  /*
   * Un `null` es «la verificacion no llego a leerlo» -IP sin autorizar, red
   * caida-, no «la cuenta ya no tiene modo». Pisar el ultimo valor bueno con un
   * desconocido dejaria al motor sin dato justo cuando menos puede comprobarlo.
   */
  it('ignora un modo desconocido en vez de pisar el ultimo bueno', async () => {
    const registro = await RegistroCuentas.cargar(ruta);
    const cuenta = registro.agregar(alta(registro.reservarId('A', 'Sub-01'), 'Sub-01'));

    expect(registro.actualizarModos(cuenta.id, { modoMargen: null, modoPosicion: null })).toBe(false);
    expect(registro.cuenta(cuenta.id)?.modoMargen).toBe('aislado');
    expect(registro.cuenta(cuenta.id)?.modoPosicion).toBe('cobertura');
  });

  it('el modo refrescado sobrevive al guardado', async () => {
    const registro = await RegistroCuentas.cargar(ruta);
    const cuenta = registro.agregar(alta(registro.reservarId('A', 'Sub-01'), 'Sub-01'));

    registro.actualizarModos(cuenta.id, { modoMargen: 'cruzado', modoPosicion: 'unilateral' });
    await registro.guardar();

    const releido = await RegistroCuentas.cargar(ruta);
    expect(releido.cuenta(cuenta.id)?.modoMargen).toBe('cruzado');
    expect(releido.cuenta(cuenta.id)?.modoPosicion).toBe('unilateral');
  });

  it('una cuenta que no existe no se inventa', async () => {
    const registro = await RegistroCuentas.cargar(ruta);
    expect(registro.actualizarModos('cta_inexistente', { modoMargen: 'cruzado' })).toBe(false);
  });
});

describe('baja', () => {
  it('retira la cuenta principal cuando se queda sin subcuentas', async () => {
    const registro = await RegistroCuentas.cargar(ruta);
    const cuenta = registro.agregar(alta(registro.reservarId('A', 'Sub-01'), 'Sub-01'));

    expect(registro.eliminar(cuenta.id)).toBe(true);
    expect(registro.listarGrupos()).toEqual([]);
  });

  it('conserva la cuenta principal mientras le quede alguna subcuenta', async () => {
    const registro = await RegistroCuentas.cargar(ruta);
    const primera = registro.agregar(alta(registro.reservarId('A', 'Sub-01'), 'Sub-01'));
    registro.agregar(alta(registro.reservarId('A', 'Sub-02'), 'Sub-02'));

    registro.eliminar(primera.id);

    expect(registro.listarGrupos()).toHaveLength(1);
  });
});

describe('sincronizacion con el vault', () => {
  /*
   * Pasa al copiar `cuentas.json` de otra maquina o al restaurar un `vault.enc`
   * viejo. Una cuenta sin credencial no puede firmar nada: mostrarla la haria
   * contar como operativa.
   */
  it('descarta las cuentas cuya credencial ya no esta', async () => {
    const registro = await RegistroCuentas.cargar(ruta);
    const viva = registro.agregar(alta(registro.reservarId('A', 'Sub-01'), 'Sub-01'));
    registro.agregar(alta(registro.reservarId('B', 'Sub-02'), 'Sub-02', 'B'));

    expect(registro.sincronizar([viva.id])).toBe(true);
    expect(registro.listarCuentas().map((c) => c.id)).toEqual([viva.id]);
    expect(registro.listarGrupos()).toHaveLength(1);
  });

  it('no toca nada cuando todas las cuentas tienen credencial', async () => {
    const registro = await RegistroCuentas.cargar(ruta);
    const cuenta = registro.agregar(alta(registro.reservarId('A', 'Sub-01'), 'Sub-01'));

    expect(registro.sincronizar([cuenta.id])).toBe(false);
  });
});

describe('casillas', () => {
  it('reparte las casillas en orden dentro de cada cuenta principal', async () => {
    const registro = await RegistroCuentas.cargar(ruta);

    const a = registro.agregar(alta(registro.reservarId('A', 'Sub-01'), 'Sub-01'));
    const b = registro.agregar(alta(registro.reservarId('A', 'Sub-02'), 'Sub-02'));
    /* Cada cuenta principal tiene su propia numeración: la B vuelve a empezar en 1. */
    const c = registro.agregar(alta(registro.reservarId('B', 'Sub-03'), 'Sub-03', 'B'));

    expect([a.slot, b.slot, c.slot]).toEqual([1, 2, 1]);
  });

  /*
   * Con 20 casillas por cuenta, no reutilizar el hueco de una baja dejaria la
   * rejilla sin sitio tras 20 altas y bajas aunque estuviera medio vacia.
   */
  it('reutiliza el hueco que deja una baja', async () => {
    const registro = await RegistroCuentas.cargar(ruta);
    registro.agregar(alta(registro.reservarId('A', 'Sub-01'), 'Sub-01'));
    const segunda = registro.agregar(alta(registro.reservarId('A', 'Sub-02'), 'Sub-02'));
    registro.agregar(alta(registro.reservarId('A', 'Sub-03'), 'Sub-03'));

    registro.eliminar(segunda.id);
    const nueva = registro.agregar(alta(registro.reservarId('A', 'Sub-09'), 'Sub-09'));

    expect(nueva.slot).toBe(2);
  });

  /*
   * La casilla es lo que el operador tiene memorizado. Que las demas se corran
   * al borrar una seria hacerle perder la referencia justo cuando mas rapido
   * necesita actuar. docs/04 pregunta P-6.
   */
  it('una baja no mueve de casilla a las demas', async () => {
    const registro = await RegistroCuentas.cargar(ruta);
    const primera = registro.agregar(alta(registro.reservarId('A', 'Sub-01'), 'Sub-01'));
    registro.agregar(alta(registro.reservarId('A', 'Sub-02'), 'Sub-02'));
    const tercera = registro.agregar(alta(registro.reservarId('A', 'Sub-03'), 'Sub-03'));

    registro.eliminar(primera.id);

    expect(registro.cuenta(tercera.id)?.slot).toBe(3);
  });

  /*
   * La casilla la elige el operador desde el 28/08/2026: «esta subcuenta va en
   * la 7». Antes la repartia el registro -la primera libre- y no habia forma de
   * decirlo, asi que organizar la rejilla obligaba a dar de alta en el orden
   * exacto en que se querian ver.
   */
  it('respeta la casilla que pide el alta, aunque haya huecos antes', async () => {
    const registro = await RegistroCuentas.cargar(ruta);

    const cuenta = registro.agregar({
      ...alta(registro.reservarId('A', 'Sub-07'), 'Sub-07'),
      slot: 7
    });

    expect(cuenta.slot).toBe(7);
    /* Y la siguiente sin casilla pedida sigue tomando la primera libre. */
    expect(registro.agregar(alta(registro.reservarId('A', 'Sub-01'), 'Sub-01')).slot).toBe(1);
  });

  /* Un choque rechaza el alta en vez de desalojar a quien estuviera. */
  it('no deja poner dos subcuentas en la misma casilla', async () => {
    const registro = await RegistroCuentas.cargar(ruta);
    registro.agregar({ ...alta(registro.reservarId('A', 'Sub-07'), 'Sub-07'), slot: 7 });

    expect(() =>
      registro.agregar({ ...alta(registro.reservarId('A', 'Sub-08'), 'Sub-08'), slot: 7 })
    ).toThrow(/ya la ocupa «Sub-07»/);
    /* Y el estorbo se dice antes de salir a la red, con el mismo mensaje. */
    expect(registro.comprobarCabida('A', 'Sub-08', 7)?.motivo).toBe('casilla-ocupada');
  });

  /* La misma casilla de otra cuenta principal no es la misma casilla. */
  it('la casilla 7 de la A y la 7 de la B conviven', async () => {
    const registro = await RegistroCuentas.cargar(ruta);
    registro.agregar({ ...alta(registro.reservarId('A', 'Sub-07'), 'Sub-07'), slot: 7 });

    const b = registro.agregar({
      ...alta(registro.reservarId('B', 'Sub-27'), 'Sub-27', 'B'),
      slot: 7
    });

    expect(b.slot).toBe(7);
  });

  /* Rotar la clave y dejarla donde estaba no es chocar consigo misma. */
  it('pedir la casilla que uno ya ocupa no molesta', async () => {
    const registro = await RegistroCuentas.cargar(ruta);
    const antes = registro.agregar({
      ...alta(registro.reservarId('A', 'Sub-07'), 'Sub-07'),
      slot: 7
    });

    const despues = registro.agregar({
      ...alta(registro.reservarId('A', 'Sub-07', uidDe('Sub-07')), 'Sub-07'),
      slot: 7,
      credencialId: 'cred_2'
    });

    expect(despues.id).toBe(antes.id);
    expect(despues.slot).toBe(7);
  });

  /* Y mover una subcuenta de casilla es volver a darla de alta en otra. */
  it('la misma subcuenta se puede mover a otra casilla libre', async () => {
    const registro = await RegistroCuentas.cargar(ruta);
    registro.agregar({ ...alta(registro.reservarId('A', 'Sub-07'), 'Sub-07'), slot: 7 });

    const movida = registro.agregar({
      ...alta(registro.reservarId('A', 'Sub-07', uidDe('Sub-07')), 'Sub-07'),
      slot: 12
    });

    expect(movida.slot).toBe(12);
    expect(registro.listarCuentas()).toHaveLength(1);
  });

  it('una casilla fuera del 1 al 20 se rechaza', async () => {
    const registro = await RegistroCuentas.cargar(ruta);

    expect(() =>
      registro.agregar({
        ...alta(registro.reservarId('A', 'Sub-01'), 'Sub-01'),
        slot: SUBCUENTAS_POR_GRUPO + 1
      })
    ).toThrow(ErrorRegistro);
  });

  it('rotar la clave de una subcuenta no la cambia de casilla', async () => {
    const registro = await RegistroCuentas.cargar(ruta);
    registro.agregar(alta(registro.reservarId('A', 'Sub-01'), 'Sub-01'));
    const antes = registro.agregar(alta(registro.reservarId('A', 'Sub-02'), 'Sub-02'));

    const despues = registro.agregar({
      ...alta(registro.reservarId('A', 'Sub-02', uidDe('Sub-02')), 'Sub-02'),
      credencialId: 'cred_2'
    });

    expect(despues.slot).toBe(antes.slot);
  });
});

describe('topes del contrato', () => {
  /*
   * Quince cuentas principales -de la A a la O- y veinte subcuentas cada una:
   * 300 en total. Eran cinco y 100 hasta el 28/08/2026. Ver `CUENTAS_MADRE_MAX`.
   */
  it('no admite una cuenta principal mas de las que caben', async () => {
    const registro = await RegistroCuentas.cargar(ruta);
    for (const nombre of NOMBRES_CUENTA_MADRE) {
      registro.agregar(alta(registro.reservarId(nombre, 'Sub-01'), 'Sub-01', nombre));
    }

    /* La que vendria despues de la O. */
    expect(() => registro.agregar(alta(registro.reservarId('P', 'Sub-01'), 'Sub-01', 'P'))).toThrow(
      ErrorRegistro
    );
    expect(registro.listarGrupos()).toHaveLength(CUENTAS_MADRE_MAX);
  });

  it('no admite la subcuenta 21 en la misma cuenta principal', async () => {
    const registro = await RegistroCuentas.cargar(ruta);
    for (let n = 1; n <= SUBCUENTAS_POR_GRUPO; n += 1) {
      const etiqueta = `Sub-${String(n).padStart(2, '0')}`;
      registro.agregar(alta(registro.reservarId('A', etiqueta), etiqueta));
    }

    expect(() => registro.agregar(alta(registro.reservarId('A', 'Sub-99'), 'Sub-99'))).toThrow(
      /20 subcuentas/
    );
  });
});

describe('formato anterior', () => {
  /*
   * Los archivos de version 1 solo traen `orden`, un indice desde cero. Romper
   * su lectura obligaria a volver a registrar cien credenciales a mano.
   */
  it('traduce el `orden` de la version 1 a la casilla equivalente', async () => {
    await writeFile(
      ruta,
      JSON.stringify({
        version: 1,
        grupos: [{ id: 'g1', nombre: 'A', orden: 0, colapsado: false }],
        cuentas: [
          { ...cuentaV1('c1', 'Sub-01', 0) },
          { ...cuentaV1('c2', 'Sub-02', 1) },
          { ...cuentaV1('c3', 'Sub-03', 2) }
        ]
      }),
      'utf8'
    );

    const registro = await RegistroCuentas.cargar(ruta);

    expect(registro.listarCuentas().map((c) => c.slot)).toEqual([1, 2, 3]);
  });

  /* Un archivo editado a mano puede traer casillas repetidas; no se pierde ninguna cuenta. */
  it('deshace las casillas repetidas sin descartar cuentas', async () => {
    await writeFile(
      ruta,
      JSON.stringify({
        version: 2,
        grupos: [{ id: 'g1', nombre: 'A', orden: 0, colapsado: false }],
        cuentas: [
          { ...cuentaV1('c1', 'Sub-01', 0), slot: 4 },
          { ...cuentaV1('c2', 'Sub-02', 1), slot: 4 }
        ]
      }),
      'utf8'
    );

    const registro = await RegistroCuentas.cargar(ruta);
    const casillas = registro.listarCuentas().map((c) => c.slot);

    expect(registro.listarCuentas()).toHaveLength(2);
    expect(new Set(casillas).size).toBe(2);
    expect(casillas).toContain(4);
  });
});

/*
 * ==========================================================================
 * El orden de las cuentas principales es el contrato de `listarGrupos()`
 * ==========================================================================
 * Antes lo ponia quien llamaba -`cuentasPanel()` ordenaba por `Grupo.orden`- y
 * por eso salia distinto en la matriz y en la pantalla de API Keys. Ahora lo
 * garantiza el registro, y estas pruebas son las que lo fijan: las de
 * integracion comprueban que la matriz lo respeta, pero el contrato vive aqui,
 * que es a donde tiene que mirar quien anada otro consumidor.
 */
describe('orden de las cuentas principales', () => {
  it('las devuelve por el abecedario aunque se dieran de alta al reves', async () => {
    const registro = await RegistroCuentas.cargar(ruta);

    registro.agregar(alta(registro.reservarId('B', 'Sub-01'), 'Sub-01', 'B'));
    registro.agregar(alta(registro.reservarId('A', 'Sub-02'), 'Sub-02', 'A'));

    expect(registro.listarGrupos().map((g) => g.nombre)).toEqual(['A', 'B']);
  });

  /*
   * El archivo que ya tiene instalado quien reporto el fallo, y el caso que el
   * arreglo tiene que curar **sin migrar nada**.
   *
   * Los dos grupos empatan a `orden: 1`, que es lo que producia vaciar la A y
   * volver a crearla: `orden` se asignaba con `this.grupos.length` y los grupos
   * se retiran del array sin renumerar. Con el empate, el orden lo decidia la
   * estabilidad del `sort`.
   */
  it('un archivo con el `orden` empatado se sigue leyendo alfabetico', async () => {
    await writeFile(
      ruta,
      JSON.stringify({
        version: 4,
        grupos: [
          { id: 'g1', nombre: 'B', orden: 1, colapsado: false },
          { id: 'g2', nombre: 'A', orden: 1, colapsado: false }
        ],
        cuentas: []
      }),
      'utf8'
    );

    const registro = await RegistroCuentas.cargar(ruta);

    expect(registro.listarGrupos().map((g) => g.nombre)).toEqual(['A', 'B']);
  });

  /* Un nombre tecleado a mano, de antes de que fueran una lista cerrada. */
  it('una cuenta principal de fuera de A-O va al final', async () => {
    await writeFile(
      ruta,
      JSON.stringify({
        version: 4,
        grupos: [
          { id: 'g1', nombre: 'Cuenta Madre 1', orden: 0, colapsado: false },
          { id: 'g2', nombre: 'B', orden: 1, colapsado: false },
          { id: 'g3', nombre: 'A', orden: 2, colapsado: false }
        ],
        cuentas: []
      }),
      'utf8'
    );

    const registro = await RegistroCuentas.cargar(ruta);

    expect(registro.listarGrupos().map((g) => g.nombre)).toEqual(['A', 'B', 'Cuenta Madre 1']);
  });

  /* Ordenar al leer no puede reordenar lo que se guarda. */
  it('no reescribe el archivo con el orden nuevo', async () => {
    const registro = await RegistroCuentas.cargar(ruta);
    registro.agregar(alta(registro.reservarId('B', 'Sub-01'), 'Sub-01', 'B'));
    registro.agregar(alta(registro.reservarId('A', 'Sub-02'), 'Sub-02', 'A'));

    expect(registro.listarGrupos().map((g) => g.nombre)).toEqual(['A', 'B']);
    await registro.guardar();

    const guardado = JSON.parse(await readFile(ruta, 'utf8')) as {
      grupos: { nombre: string }[];
    };
    expect(guardado.grupos.map((g) => g.nombre)).toEqual(['B', 'A']);
  });
});

describe('formato de version 2', () => {
  /*
   * Los archivos de version 2 no traen `uidPadre`. Tienen que cargarse igual y
   * quedarse con la cadena vacia: el dato lo da Bitget al validar y no se puede
   * inventar al migrar. Romper esta lectura obligaria a registrar cien
   * credenciales otra vez.
   */
  it('carga sin `uidPadre` y lo deja vacio hasta la proxima validacion', async () => {
    await writeFile(
      ruta,
      JSON.stringify({
        version: 2,
        grupos: [{ id: 'g1', nombre: 'A', orden: 0, colapsado: false }],
        cuentas: [
          {
            id: 'c1',
            grupoId: 'g1',
            etiqueta: 'Sub-01',
            uid: '5476143713',
            credencialId: 'cred_c1',
            apiKeyEnmascarada: 'bg••••4f2a',
            slot: 1,
            activa: true,
            modoPosicion: 'cobertura',
            modoMargen: 'aislado',
            altaEn: '2026-08-01T00:00:00.000Z'
          }
        ]
      }),
      'utf8'
    );

    const registro = await RegistroCuentas.cargar(ruta);
    const cuenta = registro.listarCuentas()[0];

    expect(cuenta?.uid).toBe('5476143713');
    expect(cuenta?.uidPadre).toBe('');
    expect(cuenta?.slot).toBe(1);
  });
});

describe('formato de version 3 — antes de la convivencia con UTA', () => {
  /*
   * ==========================================================================
   * Por que `classic` y no «desconocido»
   * ==========================================================================
   * Los archivos de version 3 no traen `accountMode`, porque se escribieron
   * cuando UTA no existia y **todas** las cuentas eran clasicas. Cargarlas como
   * clasicas no es una suposicion optimista: es un hecho sobre cuando se
   * escribio el archivo.
   *
   * Lo que si seria peligroso es lo contrario. Una cuenta cargada como `uta` por
   * defecto enrutaria sus peticiones a `/api/v3/*`, donde no la conocen, y el
   * operador veria cien cuentas caidas tras actualizar el panel.
   */
  const cuentaV3 = {
    id: 'c1',
    grupoId: 'g1',
    etiqueta: 'Sub-01',
    uid: '5476143713',
    uidPadre: '1513226215',
    credencialId: 'cred_c1',
    apiKeyEnmascarada: 'bg••••4f2a',
    slot: 1,
    activa: true,
    modoPosicion: 'cobertura',
    modoMargen: 'aislado',
    altaEn: '2026-08-01T00:00:00.000Z'
  };

  const escribirV3 = async (): Promise<void> => {
    await writeFile(
      ruta,
      JSON.stringify({
        version: 3,
        grupos: [{ id: 'g1', nombre: 'A', orden: 0, colapsado: false }],
        cuentas: [cuentaV3]
      }),
      'utf8'
    );
  };

  it('carga sin `accountMode` y la deja clasica, con holdMode sin saber', async () => {
    await escribirV3();

    const registro = await RegistroCuentas.cargar(ruta);
    const cuenta = registro.listarCuentas()[0];

    expect(cuenta?.accountMode).toBe('classic');
    /* `null` es «no se ha leido». Solo lo informa V3. */
    expect(cuenta?.holdMode).toBeNull();
    /* Y no se pierde nada de lo que ya traia. */
    expect(cuenta?.uidPadre).toBe('1513226215');
  });

  it('al guardar reescribe en version 4, sin conversion por las bravas', async () => {
    await escribirV3();

    const registro = await RegistroCuentas.cargar(ruta);
    await registro.guardar();

    const archivo = JSON.parse(await readFile(ruta, 'utf8')) as {
      version: number;
      cuentas: { accountMode: string; holdMode: string | null }[];
    };

    expect(archivo.version).toBe(4);
    expect(archivo.cuentas[0]?.accountMode).toBe('classic');
    expect(archivo.cuentas[0]?.holdMode).toBeNull();
  });

  it('la deteccion asciende la cuenta a UTA y eso si se persiste', async () => {
    await escribirV3();

    const registro = await RegistroCuentas.cargar(ruta);

    expect(registro.actualizarModos('c1', { accountMode: 'uta', holdMode: 'hedge_mode' })).toBe(
      true
    );
    expect(registro.cuenta('c1')?.accountMode).toBe('uta');
    expect(registro.cuenta('c1')?.holdMode).toBe('hedge_mode');
  });

  it('un `null` de la deteccion NO degrada una cuenta ya conocida como UTA', async () => {
    /*
     * `null` significa «la deteccion no concluyo» —un corte de red, un 429—, no
     * «ya no es UTA». Pisar `uta` con `classic` ahi dejaria a esa subcuenta
     * enrutando a una superficie que la rechaza hasta la siguiente verificacion
     * buena. El caso de vuelta ni siquiera existe: Bitget no permite regresar de
     * UTA a clasica.
     */
    await escribirV3();

    const registro = await RegistroCuentas.cargar(ruta);
    registro.actualizarModos('c1', { accountMode: 'uta', holdMode: 'hedge_mode' });

    expect(registro.actualizarModos('c1', { accountMode: null, holdMode: null })).toBe(false);
    expect(registro.cuenta('c1')?.accountMode).toBe('uta');
    expect(registro.cuenta('c1')?.holdMode).toBe('hedge_mode');
  });
});

describe('persistencia', () => {
  it('sobrevive a un reinicio', async () => {
    const registro = await RegistroCuentas.cargar(ruta);
    registro.agregar(alta(registro.reservarId('A', 'Sub-01'), 'Sub-01'));
    await registro.guardar();

    const recargado = await RegistroCuentas.cargar(ruta);

    expect(recargado.listarCuentas()).toHaveLength(1);
    expect(recargado.nombreDeGrupo(recargado.listarCuentas()[0]!.grupoId)).toBe('A');
  });

  /*
   * Un archivo ilegible no se sobrescribe: perder el listado es molesto,
   * machacarlo con uno vacio es irreversible.
   */
  it('arranca vacio ante un archivo danado, sin destruirlo', async () => {
    await writeFile(ruta, '{ esto no es json', 'utf8');

    const registro = await RegistroCuentas.cargar(ruta);

    expect(registro.listarCuentas()).toEqual([]);
    expect(await readFile(ruta, 'utf8')).toBe('{ esto no es json');
  });

  it('no guarda ningun secreto en claro', async () => {
    const registro = await RegistroCuentas.cargar(ruta);
    registro.agregar(alta(registro.reservarId('A', 'Sub-01'), 'Sub-01'));
    await registro.guardar();

    const texto = await readFile(ruta, 'utf8');

    expect(texto).not.toContain('secretKey');
    expect(texto).not.toContain('passphrase');
    expect(texto).toContain('bg••••4f2a');
  });
});
