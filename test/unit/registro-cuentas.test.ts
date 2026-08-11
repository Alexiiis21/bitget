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
import { RegistroCuentas } from '@main/domain/registro-cuentas';

let carpeta: string;
let ruta: string;

const alta = (id: string, etiqueta: string, grupoNombre = 'A', credencialId = 'cred_1') => ({
  id,
  grupoNombre,
  etiqueta,
  uid: '9274202242',
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
      ...alta(registro.reservarId('A', 'Sub-01'), 'Sub-01'),
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
