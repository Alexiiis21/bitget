/**
 * Un panel entero, respaldado y recuperado en otra carpeta.
 *
 * Las pruebas unitarias del respaldo mueven bytes y comprueban que llegan. Esto
 * comprueba lo otro, que es lo que de verdad se prometió al operador: que tras
 * cambiar de versión **sus API keys siguen ahí y se abren con su contraseña de
 * siempre**. Con un `Vault` de verdad, cifrado de verdad, en dos carpetas
 * distintas.
 *
 * El KDF va con parámetros baratos a propósito: los de producción tardan medio
 * segundo por apertura y aquí se abre varias veces.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RegistroCuentas } from '@main/domain/registro-cuentas';
import { Vault } from '@main/security/vault';
import type { DestinoImportacion } from '@main/storage/importar-credenciales';
import { crearRespaldo, restaurarRespaldo } from '@main/storage/respaldo-credenciales';

const KDF_PRUEBAS = { N: 16, r: 1, p: 1 };
const MAESTRA = 'la-de-siempre-2026';

const CREDENCIAL = {
  cuentaId: 'c1',
  apiKey: 'bg_1111111111111111',
  secretKey: 'secreto-de-la-primera',
  passphrase: 'frase-de-la-primera'
};

const OPCIONES = {
  appVersion: '0.9.0',
  entorno: 'staging',
  mercado: 'real' as const,
  panelOrigen: 3
};

let raiz = '';
let viejo = '';
let nuevo = '';
let respaldos = '';

const rutasDe = (base: string): DestinoImportacion => ({
  base,
  vault: join(base, 'vault.enc'),
  vaultBak: join(base, 'vault.enc.bak'),
  cuentas: join(base, 'cuentas.json'),
  activos: join(base, 'activos.json')
});

const origenDe = (base: string) => ({
  vault: join(base, 'vault.enc'),
  cuentas: join(base, 'cuentas.json'),
  activos: join(base, 'activos.json')
});

beforeEach(async () => {
  raiz = await mkdtemp(join(tmpdir(), 'pcb-respaldo-int-'));
  viejo = join(raiz, 'datos-staging');
  nuevo = join(raiz, 'Descargas', 'datos-staging');
  respaldos = join(raiz, 'Documentos', 'respaldos');
  await mkdir(viejo, { recursive: true });
  await mkdir(nuevo, { recursive: true });
});

afterEach(async () => {
  await rm(raiz, { recursive: true, force: true });
});

/** Un panel en uso: dos subcuentas con credencial y su registro en disco. */
async function panelConDosCuentas(base: string, maestra = MAESTRA): Promise<void> {
  const vault = await Vault.crear(join(base, 'vault.enc'), maestra, {
    parametrosKdf: KDF_PRUEBAS
  });
  vault.agregar(CREDENCIAL);
  vault.agregar({
    cuentaId: 'c2',
    apiKey: 'bg_2222222222222222',
    secretKey: 'secreto-de-la-segunda',
    passphrase: 'frase-de-la-segunda'
  });
  await vault.fijarPaso('paso-1234');
  await vault.guardar();

  const registro = await RegistroCuentas.cargar(join(base, 'cuentas.json'));
  registro.agregar({
    id: 'c1',
    grupoNombre: 'A',
    etiqueta: 'Sub-01',
    uid: '9001',
    uidPadre: '8000',
    credencialId: 'cred_1',
    apiKeyEnmascarada: 'bg••••1111',
    modoPosicion: 'cobertura',
    modoMargen: 'aislado'
  });
  registro.agregar({
    id: 'c2',
    grupoNombre: 'A',
    etiqueta: 'Sub-02',
    uid: '9002',
    uidPadre: '8000',
    credencialId: 'cred_2',
    apiKeyEnmascarada: 'bg••••2222',
    modoPosicion: 'cobertura',
    modoMargen: 'cruzado'
  });
  await registro.guardar();

  await writeFile(join(base, 'activos.json'), '{"real":["BTCUSDT",null]}', 'utf8');
}

describe('cambiar de versión sin perder el panel', () => {
  /*
   * El caso del 05/09/2026, contado entero: el operador respalda, abre el .exe
   * nuevo desde Descargas y recupera sus credenciales con la contraseña que ya
   * tenía. Si alguna vez hay que borrar una prueba de este archivo, no es esta.
   */
  it('las credenciales se abren en la carpeta nueva con la contraseña de siempre', async () => {
    await panelConDosCuentas(viejo);

    const respaldo = await crearRespaldo(origenDe(viejo), respaldos, OPCIONES);
    expect(respaldo.ok).toBe(true);

    const r = await restaurarRespaldo(join(respaldos, respaldo.meta!.nombre), rutasDe(nuevo));
    expect(r.ok).toBe(true);
    expect(r.cuentas).toBe(2);

    const vault = await Vault.abrir(join(nuevo, 'vault.enc'), MAESTRA);
    expect(vault.credencialDe('c1')).toEqual({
      apiKey: CREDENCIAL.apiKey,
      secretKey: CREDENCIAL.secretKey,
      passphrase: CREDENCIAL.passphrase
    });
    expect(vault.credencialDe('c2')?.secretKey).toBe('secreto-de-la-segunda');
  });

  /* «Con la misma config»: los grupos, las casillas y los modos, no solo las claves. */
  it('las subcuentas llegan con su configuración', async () => {
    await panelConDosCuentas(viejo);
    const respaldo = await crearRespaldo(origenDe(viejo), respaldos, OPCIONES);

    await restaurarRespaldo(join(respaldos, respaldo.meta!.nombre), rutasDe(nuevo));

    const registro = await RegistroCuentas.cargar(join(nuevo, 'cuentas.json'));
    const cuentas = registro.listarCuentas();
    expect(cuentas).toHaveLength(2);
    expect(cuentas.map((c) => c.etiqueta).sort()).toEqual(['Sub-01', 'Sub-02']);
    expect(cuentas.find((c) => c.id === 'c2')?.modoMargen).toBe('cruzado');
    expect(cuentas.find((c) => c.id === 'c1')?.uidPadre).toBe('8000');
  });

  /* La de paso viaja dentro del payload cifrado, no aparte y nunca en claro. */
  it('la contraseña de paso sigue siendo la misma tras restaurar', async () => {
    await panelConDosCuentas(viejo);
    const respaldo = await crearRespaldo(origenDe(viejo), respaldos, OPCIONES);
    await restaurarRespaldo(join(respaldos, respaldo.meta!.nombre), rutasDe(nuevo));

    const vault = await Vault.abrir(join(nuevo, 'vault.enc'), MAESTRA);

    expect(vault.tienePaso()).toBe(true);
    await expect(vault.comprobarPaso('paso-1234')).resolves.toBe(true);
    await expect(vault.comprobarPaso('otra')).resolves.toBe(false);
  });

  /*
   * El caso frecuente, no el raro: el operador abrió el .exe nuevo, se inventó
   * una contraseña y creó un almacén vacío antes de darse cuenta. Tras
   * reemplazarlo manda la contraseña del respaldo, no la que acaba de inventar.
   */
  it('tras reemplazar un almacén manda la contraseña del respaldo', async () => {
    await panelConDosCuentas(viejo);
    const respaldo = await crearRespaldo(origenDe(viejo), respaldos, OPCIONES);

    /* El almacén vacío que se creó por error, con otra contraseña. */
    const estorbo = await Vault.crear(join(nuevo, 'vault.enc'), 'la-que-me-invente', {
      parametrosKdf: KDF_PRUEBAS
    });
    await estorbo.guardar();

    const r = await restaurarRespaldo(join(respaldos, respaldo.meta!.nombre), rutasDe(nuevo), {
      sobrescribir: true
    });
    expect(r.ok).toBe(true);
    expect(r.vaultApartado).not.toBeNull();

    await expect(Vault.abrir(join(nuevo, 'vault.enc'), MAESTRA)).resolves.toBeDefined();
    await expect(Vault.abrir(join(nuevo, 'vault.enc'), 'la-que-me-invente')).rejects.toThrow();
  });

  /* Y el que se apartó sigue abriéndose: apartar no es borrar. */
  it('el almacén apartado sigue siendo un almacén válido', async () => {
    await panelConDosCuentas(viejo);
    const respaldo = await crearRespaldo(origenDe(viejo), respaldos, OPCIONES);
    await Vault.crear(join(nuevo, 'vault.enc'), 'la-que-me-invente', {
      parametrosKdf: KDF_PRUEBAS
    });

    const r = await restaurarRespaldo(join(respaldos, respaldo.meta!.nombre), rutasDe(nuevo), {
      sobrescribir: true
    });

    const apartado = join(nuevo, r.vaultApartado!);
    await expect(Vault.abrir(apartado, 'la-que-me-invente')).resolves.toBeDefined();
  });

  /* Respaldar no toca el panel de origen: sigue funcionando igual. */
  it('respaldar deja el panel de origen intacto', async () => {
    await panelConDosCuentas(viejo);

    await crearRespaldo(origenDe(viejo), respaldos, OPCIONES);

    const vault = await Vault.abrir(join(viejo, 'vault.enc'), MAESTRA);
    expect(vault.credencialDe('c1')?.secretKey).toBe(CREDENCIAL.secretKey);
  });

  /*
   * RNF-001 en el archivo que sale del equipo: es el vault cifrado tal cual.
   * Si esta prueba falla, el respaldo está filtrando claves a Documentos.
   */
  it('el archivo de respaldo no contiene ningún secreto en claro', async () => {
    await panelConDosCuentas(viejo);
    const respaldo = await crearRespaldo(origenDe(viejo), respaldos, OPCIONES);

    const crudo = await import('node:fs/promises').then((fs) =>
      fs.readFile(join(respaldos, respaldo.meta!.nombre), 'utf8')
    );

    expect(crudo).not.toContain(CREDENCIAL.secretKey);
    expect(crudo).not.toContain(CREDENCIAL.passphrase);
    expect(crudo).not.toContain(CREDENCIAL.apiKey);
    expect(crudo).not.toContain(MAESTRA);
    expect(crudo).not.toContain('paso-1234');
  });
});
