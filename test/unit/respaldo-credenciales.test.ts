/**
 * Respaldo y restauración de las credenciales en un solo archivo.
 *
 * Lo que se prueba aquí no es la comodidad de respaldar: es que **no se pierda
 * nada**, en los dos sentidos. Un respaldo que sale a medias no sirve el día
 * que hace falta, y una restauración mal hecha escribe encima del único archivo
 * que guarda las API keys. Por eso las pruebas de restaurar empiezan por las
 * negativas, igual que en `importar-credenciales.test.ts`.
 */
import { mkdtemp, mkdir, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DestinoImportacion } from '@main/storage/importar-credenciales';
import {
  buscarRespaldo,
  crearRespaldo,
  leerCabecera,
  restaurarRespaldo,
  NOMBRE_ALIAS,
  type OrigenRespaldo
} from '@main/storage/respaldo-credenciales';

/** Un sobre con la forma que comprueba el respaldo, sin descifrar nada. */
const VAULT = JSON.stringify({
  formato: 'pcb-vault',
  version: 2,
  kdf: { algoritmo: 'scrypt', N: 16, r: 1, p: 1, longitudClave: 32, salt: 'x' },
  cifrado: { algoritmo: 'aes-256-gcm', iv: 'x', tag: 'x' },
  verificador: { iv: 'x', tag: 'x', dato: 'x' },
  payload: 'x',
  actualizadoEn: '2026-09-13T00:00:00.000Z'
});

const CUENTAS = JSON.stringify({
  version: 4,
  grupos: [{ id: 'g1', nombre: 'A', orden: 0, colapsado: false }],
  cuentas: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }]
});

const ACTIVOS = '{"real":["BTCUSDT",null]}';

const OPCIONES = {
  appVersion: '0.9.0',
  entorno: 'staging',
  mercado: 'real' as const,
  panelOrigen: 3
};

let raiz = '';
let datos = '';
let respaldos = '';
let origen: OrigenRespaldo;

const rutasDe = (base: string): DestinoImportacion => ({
  base,
  vault: join(base, 'vault.enc'),
  vaultBak: join(base, 'vault.enc.bak'),
  cuentas: join(base, 'cuentas.json'),
  activos: join(base, 'activos.json')
});

/** Un instante fijo, para que los nombres de archivo sean predecibles. */
const enPunto =
  (h: number, m = 0, s = 0) =>
  (): Date =>
    new Date(2026, 8, 13, h, m, s);

beforeEach(async () => {
  raiz = await mkdtemp(join(tmpdir(), 'pcb-respaldo-'));
  datos = join(raiz, 'datos-staging');
  respaldos = join(raiz, 'Documentos', 'respaldos');
  await mkdir(datos);
  origen = {
    vault: join(datos, 'vault.enc'),
    cuentas: join(datos, 'cuentas.json'),
    activos: join(datos, 'activos.json')
  };
  await writeFile(origen.vault, VAULT, 'utf8');
  await writeFile(origen.cuentas, CUENTAS, 'utf8');
  await writeFile(origen.activos, ACTIVOS, 'utf8');
});

describe('crear un respaldo', () => {
  it('escribe el fechado y el alias, y son idénticos byte a byte', async () => {
    const r = await crearRespaldo(origen, respaldos, { ...OPCIONES, ahora: enPunto(14, 25, 7) });

    expect(r.ok).toBe(true);
    expect(r.meta?.nombre).toBe('respaldo-pcb-2026-09-13-142507.pcbak');

    const fechado = await readFile(join(respaldos, r.meta!.nombre));
    const alias = await readFile(join(respaldos, NOMBRE_ALIAS));
    expect(alias.equals(fechado)).toBe(true);
  });

  it('la cabecera lleva con qué se hizo y un sha256 por archivo', async () => {
    const r = await crearRespaldo(origen, respaldos, { ...OPCIONES, ahora: enPunto(9) });
    const archivo = JSON.parse(await readFile(join(respaldos, r.meta!.nombre), 'utf8'));

    expect(archivo.formato).toBe('pcb-respaldo');
    expect(archivo.version).toBe(1);
    expect(archivo.cuentas).toBe(3);
    expect(archivo.esquemas).toEqual({ vault: 2, cuentas: 4 });
    expect(archivo.panelOrigen).toBe(3);
    for (const nombre of ['vault.enc', 'cuentas.json', 'activos.json']) {
      expect(archivo.archivos[nombre].sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  /*
   * El operador va a abrir esto con el Bloc de notas para ver qué es. Ese es
   * el instante en el que la frase tiene que estar delante.
   */
  it('dice dentro del propio archivo que la contraseña no viaja', async () => {
    const r = await crearRespaldo(origen, respaldos, OPCIONES);
    const crudo = await readFile(join(respaldos, r.meta!.nombre), 'utf8');

    expect(crudo).toContain('NO contiene la contrasena maestra');
  });

  it('sin almacén no respalda, y no deja la carpeta con archivos a medias', async () => {
    const vacio = { ...origen, vault: join(datos, 'no-existe.enc') };

    const r = await crearRespaldo(vacio, respaldos, OPCIONES);

    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('sin-vault');
    await expect(readdir(respaldos)).rejects.toThrow();
  });

  it('rechaza un almacén que no tiene el formato del panel', async () => {
    await writeFile(origen.vault, '{"esto":"no es un vault"}', 'utf8');

    const r = await crearRespaldo(origen, respaldos, OPCIONES);

    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('vault-ilegible');
    await expect(readdir(respaldos)).rejects.toThrow();
  });

  /* El vault es lo irreemplazable; lo demás es accesorio y puede no estar. */
  it('omite los accesorios que no existen, en vez de fallar', async () => {
    const soloVault = { ...origen, activos: join(datos, 'no-hay.json') };

    const r = await crearRespaldo(soloVault, respaldos, OPCIONES);
    const archivo = JSON.parse(await readFile(join(respaldos, r.meta!.nombre), 'utf8'));

    expect(r.ok).toBe(true);
    expect(archivo.archivos['activos.json']).toBeUndefined();
    expect(archivo.archivos['vault.enc']).toBeDefined();
  });

  /* El segundo del nombre no es decorativo: dos altas caben en el mismo minuto. */
  it('dos respaldos en el mismo minuto son dos archivos distintos', async () => {
    await crearRespaldo(origen, respaldos, { ...OPCIONES, ahora: enPunto(10, 30, 1) });
    await crearRespaldo(origen, respaldos, { ...OPCIONES, ahora: enPunto(10, 30, 2) });

    const nombres = (await readdir(respaldos)).filter((n) => n !== NOMBRE_ALIAS);
    expect(nombres).toHaveLength(2);
  });
});

describe('la poda', () => {
  it('conserva los más recientes y el alias', async () => {
    for (let i = 1; i <= 12; i++) {
      await crearRespaldo(origen, respaldos, { ...OPCIONES, conservar: 10, ahora: enPunto(i) });
    }

    const nombres = (await readdir(respaldos)).sort();
    expect(nombres).toContain(NOMBRE_ALIAS);
    expect(nombres.filter((n) => n !== NOMBRE_ALIAS)).toHaveLength(10);
    /* Los que se fueron son los dos primeros, no unos cualesquiera. */
    expect(nombres).not.toContain('respaldo-pcb-2026-09-13-010000.pcbak');
    expect(nombres).toContain('respaldo-pcb-2026-09-13-120000.pcbak');
  });

  /*
   * La carpeta está en Documentos, o sea en territorio del operador: puede
   * tener ahí sus propias cosas y no es asunto del panel.
   */
  it('no toca lo que no es suyo', async () => {
    await mkdir(respaldos, { recursive: true });
    await writeFile(join(respaldos, 'notas.txt'), 'mis cosas', 'utf8');
    await writeFile(join(respaldos, 'respaldo-viejo.pcbak'), 'x', 'utf8');

    for (let i = 1; i <= 12; i++) {
      await crearRespaldo(origen, respaldos, { ...OPCIONES, conservar: 2, ahora: enPunto(i) });
    }

    const nombres = await readdir(respaldos);
    expect(nombres).toContain('notas.txt');
    expect(nombres).toContain('respaldo-viejo.pcbak');
    expect(await readFile(join(respaldos, 'notas.txt'), 'utf8')).toBe('mis cosas');
  });
});

describe('encontrar el respaldo', () => {
  it('una carpeta que no existe es «no hay», no un error', async () => {
    await expect(buscarRespaldo(join(raiz, 'nada'))).resolves.toBeNull();
  });

  it('elige el alias cuando es legible', async () => {
    await crearRespaldo(origen, respaldos, { ...OPCIONES, ahora: enPunto(8) });

    const hallado = await buscarRespaldo(respaldos);

    expect(hallado?.nombre).toBe(NOMBRE_ALIAS);
    expect(hallado?.cuentas).toBe(3);
    expect(hallado?.panelOrigen).toBe(3);
    expect(hallado?.demasiadoNuevo).toBe(false);
  });

  /* Una escritura interrumpida o una sincronización a medias no deja sin salida. */
  it('con el alias corrupto cae al fechado más reciente', async () => {
    await crearRespaldo(origen, respaldos, { ...OPCIONES, ahora: enPunto(8) });
    await crearRespaldo(origen, respaldos, { ...OPCIONES, ahora: enPunto(9) });
    await writeFile(join(respaldos, NOMBRE_ALIAS), 'basura', 'utf8');

    const hallado = await buscarRespaldo(respaldos);

    expect(hallado?.nombre).toBe('respaldo-pcb-2026-09-13-090000.pcbak');
  });

  /*
   * Copiar la carpeta a mano reescribe las fechas del sistema de archivos. Si
   * la pantalla las enseñara, mentiría.
   */
  it('la fecha sale de la cabecera, no del sistema de archivos', async () => {
    const r = await crearRespaldo(origen, respaldos, { ...OPCIONES, ahora: enPunto(14, 25, 7) });
    const ruta = join(respaldos, r.meta!.nombre);
    await utimes(ruta, new Date(2020, 0, 1), new Date(2020, 0, 1));

    const cabecera = await leerCabecera(ruta);

    expect(cabecera?.creadoEn).toBe(new Date(2026, 8, 13, 14, 25, 7).toISOString());
  });

  it('marca como demasiado nuevo un respaldo de una versión futura', async () => {
    await mkdir(respaldos, { recursive: true });
    const futuro = { formato: 'pcb-respaldo', version: 99, creadoEn: 'x', appVersion: '9.9.9' };
    await writeFile(join(respaldos, NOMBRE_ALIAS), JSON.stringify(futuro), 'utf8');

    const hallado = await buscarRespaldo(respaldos);

    expect(hallado?.demasiadoNuevo).toBe(true);
  });

  it('un archivo que no es un respaldo no se confunde con uno', async () => {
    await mkdir(respaldos, { recursive: true });
    await writeFile(join(respaldos, NOMBRE_ALIAS), '{"formato":"otra-cosa"}', 'utf8');

    await expect(buscarRespaldo(respaldos)).resolves.toBeNull();
  });
});

describe('restaurar: lo que no se puede hacer nunca', () => {
  let destinoDir = '';
  let destino: DestinoImportacion;
  let pcbak = '';

  beforeEach(async () => {
    destinoDir = join(raiz, 'nuevo');
    await mkdir(destinoDir);
    destino = rutasDe(destinoDir);
    const r = await crearRespaldo(origen, respaldos, { ...OPCIONES, ahora: enPunto(11) });
    pcbak = join(respaldos, r.meta!.nombre);
  });

  /*
   * La regla que sostiene todo lo demás, heredada de `importar-credenciales`:
   * sin una confirmación explícita no se pisa un almacén.
   */
  it('no sobrescribe un almacén existente sin permiso explícito', async () => {
    await writeFile(destino.vault, 'EL ALMACEN BUENO', 'utf8');

    const r = await restaurarRespaldo(pcbak, destino);

    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('ya-hay-vault');
    expect(await readFile(destino.vault, 'utf8')).toBe('EL ALMACEN BUENO');
  });

  it('un respaldo manipulado se rechaza sin escribir nada', async () => {
    const archivo = JSON.parse(await readFile(pcbak, 'utf8'));
    archivo.archivos['vault.enc'].sha256 = 'f'.repeat(64);
    await writeFile(pcbak, JSON.stringify(archivo), 'utf8');

    const r = await restaurarRespaldo(pcbak, destino);

    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('integridad');
    await expect(readFile(destino.vault, 'utf8')).rejects.toThrow();
    await expect(readFile(destino.cuentas, 'utf8')).rejects.toThrow();
  });

  /*
   * Es `vault.ts:323` un paso antes. Descubrir que el respaldo era de un panel
   * más nuevo *después* de haber reemplazado el vault propio sería el peor
   * desenlace posible.
   */
  it('un almacén de una versión futura se rechaza antes de escribir', async () => {
    const archivo = JSON.parse(await readFile(pcbak, 'utf8'));
    archivo.esquemas.vault = 99;
    await writeFile(pcbak, JSON.stringify(archivo), 'utf8');

    const r = await restaurarRespaldo(pcbak, destino);

    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('esquema-futuro');
    await expect(readFile(destino.vault, 'utf8')).rejects.toThrow();
  });

  it('un respaldo de un panel más nuevo se rechaza antes de escribir', async () => {
    const archivo = JSON.parse(await readFile(pcbak, 'utf8'));
    archivo.version = 99;
    await writeFile(pcbak, JSON.stringify(archivo), 'utf8');

    const r = await restaurarRespaldo(pcbak, destino);

    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('version-futura');
    expect(r.mensaje).toContain('Actualice el panel');
    await expect(readFile(destino.vault, 'utf8')).rejects.toThrow();
  });

  it('un archivo que no existe se dice, no se revienta', async () => {
    const r = await restaurarRespaldo(join(respaldos, 'fantasma.pcbak'), destino);

    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('no-existe');
  });
});

describe('restaurar', () => {
  let destinoDir = '';
  let destino: DestinoImportacion;
  let pcbak = '';

  beforeEach(async () => {
    destinoDir = join(raiz, 'nuevo');
    await mkdir(destinoDir);
    destino = rutasDe(destinoDir);
    const r = await crearRespaldo(origen, respaldos, { ...OPCIONES, ahora: enPunto(11) });
    pcbak = join(respaldos, r.meta!.nombre);
  });

  it('deja el almacén, el registro y las casillas de activo', async () => {
    const r = await restaurarRespaldo(pcbak, destino);

    expect(r.ok).toBe(true);
    expect(r.cuentas).toBe(3);
    expect(await readFile(destino.vault, 'utf8')).toBe(VAULT);
    expect(await readFile(destino.cuentas, 'utf8')).toBe(CUENTAS);
    expect(await readFile(destino.activos, 'utf8')).toBe(ACTIVOS);
  });

  it('avisa de que hace falta la contraseña de esa instalación', async () => {
    const r = await restaurarRespaldo(pcbak, destino);

    expect(r.mensaje).toContain('contraseña maestra');
  });

  /* Lo que compensa relajar la regla 1: apartar, no borrar. */
  it('con permiso, aparta el almacén anterior en vez de borrarlo', async () => {
    await writeFile(destino.vault, 'EL ALMACEN ANTERIOR', 'utf8');

    const r = await restaurarRespaldo(pcbak, destino, { sobrescribir: true, ahora: enPunto(16) });

    expect(r.ok).toBe(true);
    expect(r.vaultApartado).toBe('vault.enc.reemplazado-2026-09-13-160000');
    expect(await readFile(`${destino.vault}.reemplazado-2026-09-13-160000`, 'utf8')).toBe(
      'EL ALMACEN ANTERIOR'
    );
    expect(await readFile(destino.vault, 'utf8')).toBe(VAULT);
  });

  /*
   * Sin esto, el `.bak` del almacén viejo sobrevive junto al vault nuevo —otra
   * sal, otra contraseña— y el consejo «pruebe con el respaldo .bak» apuntaría
   * a un archivo de otro almacén. Trampa silenciosa.
   */
  it('el .bak del almacén viejo se va con el suyo', async () => {
    await writeFile(destino.vault, 'ANTERIOR', 'utf8');
    await writeFile(destino.vaultBak, 'ANTERIOR BAK', 'utf8');

    await restaurarRespaldo(pcbak, destino, { sobrescribir: true, ahora: enPunto(16) });

    await expect(readFile(destino.vaultBak, 'utf8')).rejects.toThrow();
    expect(await readFile(`${destino.vaultBak}.reemplazado-2026-09-13-160000`, 'utf8')).toBe(
      'ANTERIOR BAK'
    );
  });

  it('un respaldo sin casillas de activo no deja un archivo vacío en destino', async () => {
    const sinActivos = { ...origen, activos: join(datos, 'no-hay.json') };
    const r = await crearRespaldo(sinActivos, respaldos, { ...OPCIONES, ahora: enPunto(12) });

    await restaurarRespaldo(join(respaldos, r.meta!.nombre), destino);

    await expect(readFile(destino.activos, 'utf8')).rejects.toThrow();
    expect(await readFile(destino.vault, 'utf8')).toBe(VAULT);
  });

  /* La que dice que la función funciona: el operador recupera su panel. */
  it('ida y vuelta: lo que sale de una carpeta llega igual a otra', async () => {
    await restaurarRespaldo(pcbak, destino);

    expect(await readFile(destino.vault)).toEqual(await readFile(origen.vault));
    expect(await readFile(destino.cuentas)).toEqual(await readFile(origen.cuentas));
    expect(await readFile(destino.activos)).toEqual(await readFile(origen.activos));
  });
});
