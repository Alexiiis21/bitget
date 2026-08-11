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
