/**
 * Diagnostico de una carpeta de datos del panel. **Solo lee: no escribe nada.**
 *
 * --------------------------------------------------------------------------
 * Para que sirve
 * --------------------------------------------------------------------------
 * El panel guarda dos archivos que tienen que cuadrar:
 *
 *   vault.enc     las credenciales, cifradas con la contrasena maestra
 *   cuentas.json  las fichas: nombre de la subcuenta, cuenta principal, casilla
 *
 * La pantalla dibuja `cuentas.json`; el vault solo aporta la credencial. Si el
 * panel abre «sin cuentas», hay tres explicaciones posibles y piden arreglos
 * distintos:
 *
 *   1. El vault es otro (nuevo, vacio): el .exe se ejecuto desde otra carpeta y
 *      el panel creo un almacen nuevo con la contrasena que se escribio.
 *   2. El vault tiene las credenciales pero `cuentas.json` falta, no se puede
 *      leer o esta vacio: las credenciales siguen ahi, huerfanas.
 *   3. Las fichas se descartaron al abrir porque el vault no traia su
 *      credencial: quedan en `cuentas.json.bak`.
 *
 * Este script dice cual de las tres es, sin tocar ningun archivo.
 *
 * --------------------------------------------------------------------------
 * Uso
 * --------------------------------------------------------------------------
 * Con el panel **cerrado**, sobre una copia de la carpeta de datos del cliente
 * (`datos-staging\` junto al .exe portable):
 *
 *   $env:PCB_CARPETA = "C:\ruta\a\datos-staging"
 *   $env:PCB_MAESTRA = "contrasena-maestra"      # opcional
 *   npm run diagnosticar:datos
 *
 * Sin `PCB_MAESTRA` se informa de todo lo que esta en claro -archivos, fechas,
 * fichas de `cuentas.json`- pero no de que credenciales guarda el vault. Ningun
 * secreto sale por pantalla: las API Keys van enmascaradas.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { RegistroCuentas } from '@main/domain/registro-cuentas';
import { ErrorVault, Vault, type CredencialPublica } from '@main/security/vault';

const carpeta = process.env['PCB_CARPETA'] ?? '';
const maestra = process.env['PCB_MAESTRA'] ?? '';

const linea = (texto = ''): void => {
  process.stdout.write(`${texto}\n`);
};

async function describirArchivo(nombre: string): Promise<void> {
  try {
    const s = await stat(join(carpeta, nombre));
    linea(
      `  ${nombre.padEnd(20)} ${String(s.size).padStart(8)} bytes · modificado ${s.mtime.toISOString()}`
    );
  } catch {
    linea(`  ${nombre.padEnd(20)} (no existe)`);
  }
}

/** Lo que esta en claro en un vault: cuando se escribio por ultima vez. */
async function cabeceraVault(nombre: string): Promise<string> {
  try {
    const crudo = JSON.parse(await readFile(join(carpeta, nombre), 'utf8')) as Record<
      string,
      unknown
    >;
    return `formato ${String(crudo['formato'])} v${String(crudo['version'])} · guardado ${String(crudo['actualizadoEn'])}`;
  } catch {
    return 'no existe o no se puede leer';
  }
}

/**
 * Lee un `cuentas.json` sin pasar por el silencio de `RegistroCuentas.cargar`,
 * que ante un archivo ilegible devuelve un registro vacio. Aqui se distingue.
 */
async function fichas(
  nombre: string
): Promise<{ estado: string; registro: RegistroCuentas | null }> {
  const ruta = join(carpeta, nombre);
  let texto: string;
  try {
    texto = await readFile(ruta, 'utf8');
  } catch {
    return { estado: 'no existe', registro: null };
  }
  try {
    JSON.parse(texto);
  } catch {
    return { estado: 'NO ES JSON VALIDO (archivo danado o cortado)', registro: null };
  }
  const registro = await RegistroCuentas.cargar(ruta);
  const n = registro.listarCuentas().length;
  if (n === 0 && texto.includes('"cuentas"') && /"etiqueta"/.test(texto)) {
    return {
      estado:
        'TIENE FICHAS PERO EL PANEL NO LAS ENTIENDE (formato inesperado: el panel lo leeria vacio)',
      registro
    };
  }
  return { estado: `${n} fichas`, registro };
}

function listarFichas(registro: RegistroCuentas): void {
  for (const c of registro.listarCuentas().sort((a, b) => a.slot - b.slot)) {
    linea(
      `    ${c.id}  ${registro.nombreDeGrupo(c.grupoId)} · casilla ${c.slot} · ${c.etiqueta} · UID ${c.uid || '—'}`
    );
  }
}

async function credenciales(nombre: string): Promise<CredencialPublica[] | string> {
  try {
    const v = await Vault.abrir(join(carpeta, nombre), maestra);
    const lista = v.listar();
    v.cerrar();
    return lista;
  } catch (e) {
    if (e instanceof ErrorVault) return `${e.motivo}: ${e.message}`;
    throw e;
  }
}

it('diagnostico de la carpeta de datos', async () => {
  expect(carpeta, 'Falta PCB_CARPETA: la carpeta de datos a revisar').not.toBe('');

  linea();
  linea(`Carpeta: ${carpeta}`);
  linea();
  linea('Archivos');
  const presentes = await readdir(carpeta).catch(() => [] as string[]);
  for (const nombre of [
    'vault.enc',
    'vault.enc.bak',
    'cuentas.json',
    'cuentas.json.bak',
    'instancia.json'
  ]) {
    await describirArchivo(nombre);
  }
  const otros = presentes.filter(
    (n) =>
      ![
        'vault.enc',
        'vault.enc.bak',
        'cuentas.json',
        'cuentas.json.bak',
        'instancia.json'
      ].includes(n)
  );
  if (otros.length > 0) linea(`  otros: ${otros.join(', ')}`);

  linea();
  linea('Vault (lo que esta en claro)');
  linea(`  vault.enc ......... ${await cabeceraVault('vault.enc')}`);
  linea(`  vault.enc.bak ..... ${await cabeceraVault('vault.enc.bak')}`);

  linea();
  linea('Fichas de cuentas');
  const actual = await fichas('cuentas.json');
  const respaldo = await fichas('cuentas.json.bak');
  linea(`  cuentas.json ...... ${actual.estado}`);
  if (actual.registro !== null) listarFichas(actual.registro);
  linea(`  cuentas.json.bak .. ${respaldo.estado}`);
  if (respaldo.registro !== null) listarFichas(respaldo.registro);

  if (maestra === '') {
    linea();
    linea('Sin PCB_MAESTRA no se puede ver que credenciales guarda el vault.');
    return;
  }

  linea();
  linea('Credenciales dentro del vault (API Key enmascarada)');
  const creds = await credenciales('vault.enc');
  const credsBak = await credenciales('vault.enc.bak');
  for (const [nombre, r] of [
    ['vault.enc', creds],
    ['vault.enc.bak', credsBak]
  ] as const) {
    if (typeof r === 'string') {
      linea(`  ${nombre.padEnd(17)} ${r}`);
      continue;
    }
    linea(`  ${nombre.padEnd(17)} ${r.length} credenciales`);
    for (const c of r) linea(`    ${c.cuentaId}  ${c.apiKeyEnmascarada}  alta ${c.altaEn}`);
  }

  /* ---- cruce y veredicto ---- */

  if (typeof creds === 'string') {
    linea();
    linea(
      creds.startsWith('contrasena-incorrecta')
        ? 'VEREDICTO: esa contrasena no abre este vault. Si el cliente creo un panel nuevo, ' +
            'puede que este vault sea el viejo con su contrasena de antes, o al reves.'
        : 'VEREDICTO: el vault no se pudo abrir; ver el motivo arriba.'
    );
    return;
  }

  const idsVault = new Set(creds.map((c) => c.cuentaId));
  const fichasActuales = actual.registro?.listarCuentas() ?? [];
  const fichasRespaldo = respaldo.registro?.listarCuentas() ?? [];
  const idsFichas = new Set(fichasActuales.map((c) => c.id));
  const huerfanas = creds.filter((c) => !idsFichas.has(c.cuentaId));
  const recuperablesDelBak = fichasRespaldo.filter(
    (c) => idsVault.has(c.id) && !idsFichas.has(c.id)
  );

  linea();
  linea('Cruce');
  linea(`  credenciales sin ficha (huerfanas en el vault) ... ${huerfanas.length}`);
  linea(`  fichas del .bak que el vault si puede firmar ..... ${recuperablesDelBak.length}`);

  const ilegible =
    actual.estado.startsWith('TIENE FICHAS') || actual.estado.startsWith('NO ES JSON');

  linea();
  if (creds.length === 0) {
    linea(
      'VEREDICTO: el vault esta VACIO. Es un almacen nuevo: el panel se abrio desde otra carpeta ' +
        'y creo uno con la contrasena que se escribio. Las credenciales estan en la carpeta de datos ' +
        'de la version anterior, junto al .exe viejo.'
    );
  } else if (huerfanas.length > 0 && recuperablesDelBak.length > 0) {
    linea(
      'VEREDICTO: las credenciales SIGUEN en el vault y cuentas.json.bak tiene sus fichas. ' +
        'Con el panel cerrado, copiar cuentas.json.bak sobre cuentas.json las recupera.'
    );
  } else if (huerfanas.length > 0 && ilegible) {
    linea(
      'VEREDICTO: las credenciales SIGUEN en el vault y cuentas.json tiene fichas, pero el panel no ' +
        'puede leerlas y arranca como si estuviera vacio. Hay que corregir ese archivo, no volver a dar de alta.'
    );
  } else if (huerfanas.length > 0) {
    linea(
      'VEREDICTO: las credenciales SIGUEN en el vault pero no hay ficha que las nombre. ' +
        'Hay que reconstruir cuentas.json (nombre, cuenta principal y casilla de cada una).'
    );
  }
  if (huerfanas.length > 0) {
    linea(
      'MIENTRAS TANTO: no dar de alta cuentas en el panel. Cada alta reescribe cuentas.json y el .bak ' +
        'solo guarda la version anterior: dos altas y se pierden las fichas que se podian recuperar.'
    );
  }
  if (creds.length > 0 && huerfanas.length === 0) {
    linea(
      'VEREDICTO: vault y cuentas.json cuadran. Si el panel no las muestra, el problema no esta en estos archivos.'
    );
  }
});
