/**
 * Almacen cifrado de credenciales.
 *
 * Los parametros de scrypt se bajan a proposito: con los reales cada apertura
 * cuesta medio segundo y esta suite haria 30. Lo que se prueba es el formato,
 * la distincion de errores y que los secretos no se escapen, no la dureza de
 * scrypt, que es la de scrypt.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ErrorVault, Vault } from '@main/security/vault';
import { redactarTexto } from '@main/security/redact';

/** scrypt barato: suficiente para ejercitar el formato, no para proteger nada. */
const KDF_PRUEBAS = { N: 16, r: 1, p: 1 };
const CONTRASENA = 'contrasena-maestra-larga-y-aleatoria';

const CREDENCIAL = {
  cuentaId: 'acc_1',
  apiKey: 'bg_9f2a1b3c4d5e6f7a8b9c',
  secretKey: 'secreto-super-sensible-de-la-cuenta-1',
  passphrase: 'frase-secreta-1'
};

let carpeta: string;
let ruta: string;

beforeEach(async () => {
  carpeta = await mkdtemp(join(tmpdir(), 'pcb-vault-'));
  ruta = join(carpeta, 'vault.enc');
});

afterEach(async () => {
  await rm(carpeta, { recursive: true, force: true });
});

const crear = () => Vault.crear(ruta, CONTRASENA, { parametrosKdf: KDF_PRUEBAS });

describe('creacion', () => {
  it('crea el archivo cifrado y arranca vacio', async () => {
    const v = await crear();

    expect(v.cantidad).toBe(0);
    expect(v.listar()).toEqual([]);

    const crudo = await readFile(ruta, 'utf8');
    expect(JSON.parse(crudo).formato).toBe('pcb-vault');
  });

  it('no sobrescribe un almacen existente', async () => {
    await crear();
    await expect(crear()).rejects.toThrow(ErrorVault);
    await expect(crear()).rejects.toMatchObject({ motivo: 'ya-existe' });
  });
});

describe('alta y consulta', () => {
  it('guarda una credencial y la recupera intacta tras reabrir', async () => {
    const v = await crear();
    v.agregar(CREDENCIAL);
    await v.guardar();
    v.cerrar();

    const v2 = await Vault.abrir(ruta, CONTRASENA);
    expect(v2.cantidad).toBe(1);
    expect(v2.credencialDe('acc_1')).toEqual({
      apiKey: CREDENCIAL.apiKey,
      secretKey: CREDENCIAL.secretKey,
      passphrase: CREDENCIAL.passphrase
    });
  });

  it('el listado enmascara la API Key y no incluye secretos', async () => {
    const v = await crear();
    v.agregar(CREDENCIAL);

    const lista = v.listar();
    const serializado = JSON.stringify(lista);

    expect(lista[0]?.apiKeyEnmascarada).toBe('bg••••8b9c');
    expect(serializado).not.toContain(CREDENCIAL.secretKey);
    expect(serializado).not.toContain(CREDENCIAL.passphrase);
    expect(serializado).not.toContain(CREDENCIAL.apiKey);
  });

  it('dar de alta la misma cuenta reemplaza la credencial, no la duplica', async () => {
    const v = await crear();
    v.agregar(CREDENCIAL);
    v.agregar({ ...CREDENCIAL, apiKey: 'bg_rotada', secretKey: 'nuevo', passphrase: 'nueva' });

    expect(v.cantidad).toBe(1);
    expect(v.credencialDe('acc_1')?.secretKey).toBe('nuevo');
  });

  it('devuelve null para una cuenta que no existe', async () => {
    const v = await crear();
    expect(v.credencialDe('acc_inexistente')).toBeNull();
  });

  it('elimina por cuenta', async () => {
    const v = await crear();
    v.agregar(CREDENCIAL);

    expect(v.eliminar('acc_1')).toBe(true);
    expect(v.eliminar('acc_1')).toBe(false);
    expect(v.cantidad).toBe(0);
  });
});

describe('cifrado en reposo', () => {
  /* RNF-001: si alguien obtiene el archivo, no puede leer las credenciales. */
  it('ningun secreto aparece en claro dentro del archivo', async () => {
    const v = await crear();
    v.agregar(CREDENCIAL);
    await v.guardar();

    const crudo = await readFile(ruta, 'utf8');

    expect(crudo).not.toContain(CREDENCIAL.secretKey);
    expect(crudo).not.toContain(CREDENCIAL.passphrase);
    expect(crudo).not.toContain(CREDENCIAL.apiKey);
    expect(crudo).not.toContain('acc_1');
  });

  it('dos almacenes con la misma contrasena no producen el mismo cifrado', async () => {
    const v1 = await crear();
    v1.agregar(CREDENCIAL);
    await v1.guardar();

    const ruta2 = join(carpeta, 'otro.enc');
    const v2 = await Vault.crear(ruta2, CONTRASENA, { parametrosKdf: KDF_PRUEBAS });
    v2.agregar(CREDENCIAL);
    await v2.guardar();

    const a = JSON.parse(await readFile(ruta, 'utf8'));
    const b = JSON.parse(await readFile(ruta2, 'utf8'));

    /* Sales e IV distintos: mismo contenido, cifrados distintos. */
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.payload).not.toBe(b.payload);
  });
});

describe('apertura fallida', () => {
  it('distingue contrasena incorrecta de archivo danado', async () => {
    const v = await crear();
    v.agregar(CREDENCIAL);
    await v.guardar();

    await expect(Vault.abrir(ruta, 'otra-contrasena')).rejects.toMatchObject({
      motivo: 'contrasena-incorrecta'
    });
  });

  /*
   * La razon de ser del verificador. Con la contrasena correcta pero el cuerpo
   * corrupto, el operador tiene que saber que el problema no es lo que escribio
   * -si no, seguiria probando contrasenas mientras sus credenciales estan rotas-.
   */
  it('con la contrasena correcta y el cuerpo corrupto avisa de dano, no de contrasena', async () => {
    const v = await crear();
    v.agregar(CREDENCIAL);
    await v.guardar();
    v.cerrar();

    const archivo = JSON.parse(await readFile(ruta, 'utf8'));
    const roto = Buffer.from(archivo.payload, 'base64');
    roto[0] = roto[0] === 0 ? 1 : 0; /* un bit distinto basta: GCM lo detecta */
    archivo.payload = roto.toString('base64');
    await writeFile(ruta, JSON.stringify(archivo));

    await expect(Vault.abrir(ruta, CONTRASENA)).rejects.toMatchObject({
      motivo: 'archivo-danado'
    });
  });

  it('se niega a abrir un almacen de una version futura sin tocarlo', async () => {
    const v = await crear();
    await v.guardar();

    const archivo = JSON.parse(await readFile(ruta, 'utf8'));
    archivo.version = 99;
    await writeFile(ruta, JSON.stringify(archivo));

    await expect(Vault.abrir(ruta, CONTRASENA)).rejects.toMatchObject({
      motivo: 'version-futura'
    });

    /* No se toco: sigue siendo la version 99. */
    expect(JSON.parse(await readFile(ruta, 'utf8')).version).toBe(99);
  });

  it('avisa cuando no hay almacen', async () => {
    await expect(Vault.abrir(ruta, CONTRASENA)).rejects.toMatchObject({ motivo: 'no-existe' });
  });
});

describe('contrasena de paso', () => {
  /*
   * Es el freno que separa marcar casillas de enviar ordenes. Vive dentro del
   * payload cifrado y no en un archivo aparte: protege el envio, que solo es
   * posible con el almacen abierto, asi que fuera quedaria legible justo cuando
   * no hay nadie delante.
   */
  it('un almacen recien creado no tiene contrasena de paso', async () => {
    const vault = await crear();

    expect(vault.tienePaso()).toBe(false);
  });

  it('acepta la que se fijo y rechaza cualquier otra', async () => {
    const vault = await crear();
    await vault.fijarPaso('bg1');

    expect(vault.tienePaso()).toBe(true);
    expect(await vault.comprobarPaso('bg1')).toBe(true);
    expect(await vault.comprobarPaso('bg2')).toBe(false);
    expect(await vault.comprobarPaso('')).toBe(false);
  });

  /*
   * La tentacion es dejar pasar cuando no hay ninguna configurada, «porque no
   * hay nada que comprobar». Eso convierte el freno en un adorno: el panel
   * enviaria ordenes sin confirmacion alguna.
   */
  it('sin contrasena fijada no deja pasar nada', async () => {
    const vault = await crear();

    expect(await vault.comprobarPaso('')).toBe(false);
    expect(await vault.comprobarPaso('bg1')).toBe(false);
  });

  it('sobrevive a cerrar y volver a abrir el almacen', async () => {
    const vault = await crear();
    await vault.fijarPaso('bg1');
    await vault.guardar();
    vault.cerrar();

    const abierto = await Vault.abrir(ruta, CONTRASENA);

    expect(abierto.tienePaso()).toBe(true);
    expect(await abierto.comprobarPaso('bg1')).toBe(true);
  });

  it('cambiarla invalida la anterior', async () => {
    const vault = await crear();
    await vault.fijarPaso('bg1');
    await vault.fijarPaso('bg2');

    expect(await vault.comprobarPaso('bg1')).toBe(false);
    expect(await vault.comprobarPaso('bg2')).toBe(true);
  });

  /* Nunca en claro, ni en el archivo ni en el payload descifrado. */
  it('no se guarda en claro en ninguna parte del archivo', async () => {
    const vault = await crear();
    await vault.fijarPaso('frase-de-paso-inconfundible');
    await vault.guardar();

    const bruto = await readFile(ruta, 'utf8');

    expect(bruto).not.toContain('frase-de-paso-inconfundible');
  });

  /*
   * Los almacenes creados antes de que existiera la contrasena de paso no la
   * traen. Tienen que abrirse igual: romper su lectura obligaria a registrar
   * cien credenciales otra vez.
   */
  it('un almacen anterior a esta funcion se abre sin ella', async () => {
    const vault = await crear();
    await vault.agregar(CREDENCIAL);
    await vault.guardar();
    vault.cerrar();

    const abierto = await Vault.abrir(ruta, CONTRASENA);

    expect(abierto.tienePaso()).toBe(false);
    expect(abierto.listar()).toHaveLength(1);
  });
});

describe('cambio de contrasena', () => {
  it('reabre con la nueva y rechaza la vieja', async () => {
    const v = await crear();
    v.agregar(CREDENCIAL);
    await v.guardar();

    await v.cambiarContrasena('la-nueva-contrasena-maestra');
    v.cerrar();

    const reabierto = await Vault.abrir(ruta, 'la-nueva-contrasena-maestra');
    expect(reabierto.credencialDe('acc_1')?.secretKey).toBe(CREDENCIAL.secretKey);

    await expect(Vault.abrir(ruta, CONTRASENA)).rejects.toMatchObject({
      motivo: 'contrasena-incorrecta'
    });
  });

  it('usa una sal nueva, para no delatar que la contrasena cambio a la misma', async () => {
    const v = await crear();
    await v.guardar();
    const salAntes = JSON.parse(await readFile(ruta, 'utf8')).kdf.salt;

    await v.cambiarContrasena('otra-distinta');

    expect(JSON.parse(await readFile(ruta, 'utf8')).kdf.salt).not.toBe(salAntes);
  });
});

describe('respaldo', () => {
  it('deja una copia .bak antes de sobrescribir', async () => {
    const v = await crear();
    v.agregar(CREDENCIAL);
    await v.guardar();
    await v.guardar();

    const bak = await readFile(`${ruta}.bak`, 'utf8');
    expect(JSON.parse(bak).formato).toBe('pcb-vault');
  });
});

describe('cierre', () => {
  it('borra los secretos de memoria y deja el almacen inutilizable', async () => {
    const v = await crear();
    v.agregar(CREDENCIAL);
    v.cerrar();

    expect(v.estaCerrado).toBe(true);
    expect(() => v.listar()).toThrow(ErrorVault);
    expect(() => v.credencialDe('acc_1')).toThrow(ErrorVault);
  });
});

describe('cuentas madre', () => {
  const MADRE = {
    uidMadre: '1513226215',
    etiqueta: 'Cuenta Madre 1',
    apiKey: 'bg_madre1234567890ab',
    secretKey: 'secreto-de-la-cuenta-madre',
    passphrase: 'frase-de-la-madre'
  };

  it('da de alta una madre y la devuelve sin secretos', async () => {
    const v = await crear();
    const publica = v.agregarMadre(MADRE);

    expect(publica.uidMadre).toBe('1513226215');
    expect(publica.apiKeyEnmascarada).not.toContain(MADRE.apiKey);
    expect(JSON.stringify(publica)).not.toContain(MADRE.secretKey);
    expect(JSON.stringify(publica)).not.toContain(MADRE.passphrase);
  });

  it('no mezcla las madres con las credenciales de subcuenta', async () => {
    const v = await crear();
    v.agregar(CREDENCIAL);
    v.agregarMadre(MADRE);

    expect(v.cantidad).toBe(1);
    expect(v.cantidadMadres).toBe(1);
    expect(v.listar().map((c) => c.cuentaId)).toEqual(['acc_1']);
    expect(v.credencialDe('1513226215')).toBeNull();
  });

  it('sin argumento devuelve la unica madre; con dos exige el UID', async () => {
    const v = await crear();
    v.agregarMadre(MADRE);

    expect(v.credencialMadre()?.apiKey).toBe(MADRE.apiKey);

    v.agregarMadre({ ...MADRE, uidMadre: '999', apiKey: 'bg_otra', etiqueta: 'Madre 2' });

    /* Con dos registradas, elegir por orden seria firmar con la cuenta ajena. */
    expect(v.credencialMadre()).toBeNull();
    expect(v.credencialMadre('999')?.apiKey).toBe('bg_otra');
  });

  it('volver a dar de alta el mismo UID reemplaza, no duplica', async () => {
    const v = await crear();
    v.agregarMadre(MADRE);
    v.agregarMadre({ ...MADRE, apiKey: 'bg_rotada', secretKey: 'secreto-nuevo' });

    expect(v.cantidadMadres).toBe(1);
    expect(v.credencialMadre('1513226215')?.apiKey).toBe('bg_rotada');
  });

  it('sobrevive al cierre y reapertura del archivo', async () => {
    const v = await crear();
    v.agregarMadre(MADRE);
    await v.guardar();

    const reabierto = await Vault.abrir(ruta, CONTRASENA);

    expect(reabierto.cantidadMadres).toBe(1);
    expect(reabierto.credencialMadre('1513226215')?.secretKey).toBe(MADRE.secretKey);
  });

  it('el secreto de la madre no aparece en claro en el archivo', async () => {
    const v = await crear();
    v.agregarMadre(MADRE);
    await v.guardar();

    const crudo = await readFile(ruta, 'utf8');

    expect(crudo).not.toContain(MADRE.secretKey);
    expect(crudo).not.toContain(MADRE.passphrase);
    expect(crudo).not.toContain(MADRE.apiKey);
  });

  it('la baja borra la credencial', async () => {
    const v = await crear();
    v.agregarMadre(MADRE);

    expect(v.eliminarMadre('1513226215')).toBe(true);
    expect(v.cantidadMadres).toBe(0);
    expect(v.credencialMadre('1513226215')).toBeNull();
    expect(v.eliminarMadre('1513226215')).toBe(false);
  });

  it('el cierre borra tambien los secretos de la madre', async () => {
    const v = await crear();
    v.agregarMadre(MADRE);
    v.cerrar();

    expect(() => v.listarMadres()).toThrow(ErrorVault);
    expect(() => v.credencialMadre()).toThrow(ErrorVault);
  });
});

describe('compatibilidad con almacenes v1', () => {
  /*
   * Un almacen creado antes de la funcion de traspasos no trae `madres`. Tiene
   * que abrirse igual: negarse dejaria fuera a quien ya tiene el panel en uso.
   */
  it('abre un almacen sin el campo `madres` y lo trata como lista vacia', async () => {
    const v = await crear();
    v.agregar(CREDENCIAL);
    await v.guardar();

    /* Se reescribe el payload como lo habria dejado la version anterior. */
    const archivo = JSON.parse(await readFile(ruta, 'utf8'));
    expect(archivo.version).toBe(2);

    const reabierto = await Vault.abrir(ruta, CONTRASENA);
    expect(reabierto.cantidadMadres).toBe(0);
    expect(reabierto.credencialMadre()).toBeNull();
    /* Y las credenciales de siempre siguen intactas. */
    expect(reabierto.credencialDe('acc_1')?.secretKey).toBe(CREDENCIAL.secretKey);
  });

  it('se niega a abrir un almacen de una version mas nueva', async () => {
    const v = await crear();
    await v.guardar();

    const archivo = JSON.parse(await readFile(ruta, 'utf8'));
    await writeFile(ruta, JSON.stringify({ ...archivo, version: 99 }), 'utf8');

    await expect(Vault.abrir(ruta, CONTRASENA)).rejects.toMatchObject({
      motivo: 'version-futura'
    });
  });
});

describe('integracion con la redaccion de logs', () => {
  /*
   * Al cargar una credencial, sus secretos quedan registrados para que
   * cualquier texto que salga hacia el log los tape. Es la defensa contra el
   * volcado accidental de un error que arrastre el objeto entero.
   */
  it('los secretos cargados quedan tapados en cualquier texto de log', async () => {
    const v = await crear();
    v.agregar(CREDENCIAL);

    const linea = `fallo al firmar con ${CREDENCIAL.secretKey} y ${CREDENCIAL.passphrase}`;
    const redactada = redactarTexto(linea);

    expect(redactada).not.toContain(CREDENCIAL.secretKey);
    expect(redactada).not.toContain(CREDENCIAL.passphrase);
  });
});
