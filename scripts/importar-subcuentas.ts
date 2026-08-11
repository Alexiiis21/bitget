/**
 * Importa al panel las subcuentas creadas por `scripts/crear-subcuentas.mjs`.
 *
 * --------------------------------------------------------------------------
 * Por que reutiliza `Sesion` y no escribe el vault por su cuenta
 * --------------------------------------------------------------------------
 * Seria mas corto abrir `vault.enc` aqui y anadir entradas. Tambien seria la
 * forma de que el formato del vault acabe teniendo dos implementaciones que se
 * separan sin que nadie se entere. Al pasar por `Sesion.agregar` se obtiene
 * exactamente el mismo camino que sigue el panel cuando el operador da de alta
 * una cuenta a mano: **verifica contra Bitget primero**, cifra despues, y no
 * guarda nada si la credencial no sirve.
 *
 * El efecto util es que este importador tambien **valida** el lote: si una de
 * las diez API Keys salio mal de Bitget, se entera aqui y no en la reunion.
 *
 * --------------------------------------------------------------------------
 * Antes de ejecutarlo
 * --------------------------------------------------------------------------
 *  1. **Cierra el panel.** Dos procesos escribiendo el mismo vault.enc es la
 *     unica forma realista de corromperlo.
 *  2. La contrasena maestra va en `PCB_MAESTRA`. Si el vault no existe, se crea
 *     con esa contrasena.
 *  3. Cada alta consulta a Bitget dos veces. Diez cuentas son veinte peticiones.
 *
 * --------------------------------------------------------------------------
 * Uso
 * --------------------------------------------------------------------------
 *   $env:PCB_MAESTRA = "tu-contrasena"
 *   npm run importar:subcuentas
 *
 * Variables opcionales:
 *   PCB_ARCHIVO   origen (por defecto subcuentas-generadas.json)
 *   PCB_CARPETA   carpeta de datos (por defecto la de staging en APPDATA)
 *   PCB_GRUPO     nombre de la cuenta principal (por defecto "Cuenta principal")
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { ClienteBitget } from '@main/bitget/rest/client';
import { Sesion } from '@main/ipc/sesion';

interface SubcuentaGenerada {
  subAccountUid: string;
  subAccountName: string;
  /** Nombre tal como se pidio al crearla. Ver `etiquetasDe`. */
  nombreSolicitado?: string;
  apiKey: string;
  secretKey: string;
  passphrase: string;
}

const maestra = process.env['PCB_MAESTRA'] ?? '';
const archivo = process.env['PCB_ARCHIVO'] ?? 'subcuentas-generadas.json';
const grupo = process.env['PCB_GRUPO'] ?? 'Cuenta principal';
const carpeta =
  process.env['PCB_CARPETA'] ??
  join(process.env['APPDATA'] ?? '', 'Panel de Control Bitget-staging');

if (maestra === '') {
  throw new Error(
    'Falta la contrasena maestra del vault.\n\n' +
      '  $env:PCB_MAESTRA = "tu-contrasena"\n' +
      '  npm run importar:subcuentas\n'
  );
}

let cliente: ClienteBitget;
let sesion: Sesion;

const existe = (ruta: string): Promise<boolean> => stat(ruta).then(() => true, () => false);

/**
 * Etiqueta unica para cada subcuenta.
 *
 * Parece que bastaria con el nombre que devuelve Bitget, pero **Bitget lo
 * enmascara**: las diez subcuentas vuelven como `pcb****@virtual-bitget.com`.
 * Usarlo daba la misma etiqueta a las diez, y como dar de alta la misma
 * etiqueta en el mismo grupo *actualiza en vez de duplicar*, cada alta
 * sobrescribia a la anterior y en el panel quedaba una sola cuenta.
 *
 * Orden de preferencia:
 *   1. `nombreSolicitado`, si el archivo lo trae -lo escriben las versiones
 *      nuevas de crear-subcuentas.mjs-, porque es el nombre real y legible.
 *   2. El nombre de Bitget, si no viene enmascarado.
 *   3. `Sub-01`, `Sub-02`... por posicion.
 *
 * El UID real queda igualmente guardado en cuentas.json, que es lo que se
 * coteja contra Bitget; la etiqueta solo tiene que ser legible y distinta.
 */
function etiquetasDe(subcuentas: SubcuentaGenerada[]): string[] {
  return subcuentas.map((s, i) => {
    const solicitado = (s.nombreSolicitado ?? '').trim();
    if (solicitado !== '') return solicitado;

    const local = (s.subAccountName?.split('@')[0] ?? '').trim();
    if (local !== '' && !local.includes('*')) return local;

    return `Sub-${String(i + 1).padStart(2, '0')}`;
  });
}

beforeAll(async () => {
  cliente = new ClienteBitget();
  await cliente.sincronizarReloj();

  const rutaVault = join(carpeta, 'vault.enc');
  sesion = new Sesion({ vault: rutaVault, cuentas: join(carpeta, 'cuentas.json') }, cliente);

  const hayVault = await existe(rutaVault);
  const r = hayVault ? await sesion.abrir(maestra) : await sesion.crear(maestra);

  if (!r.ok) {
    throw new Error(
      `No se pudo ${hayVault ? 'abrir' : 'crear'} el vault en ${carpeta}: ` +
        `${r.motivo ?? ''} ${r.mensaje ?? ''}`.trim()
    );
  }

  console.log(`\n  carpeta de datos ..... ${carpeta}`);
  console.log(`  vault ................ ${hayVault ? 'abierto' : 'creado'}`);
});

afterAll(async () => {
  sesion?.cerrar();
  await cliente?.cerrar();
});

it('importa las subcuentas verificando cada credencial contra Bitget', async () => {
  const crudo = await readFile(archivo, 'utf8');
  const subcuentas = JSON.parse(crudo) as SubcuentaGenerada[];

  expect(subcuentas.length, `${archivo} no contiene subcuentas`).toBeGreaterThan(0);
  console.log(`  a importar ........... ${subcuentas.length} desde ${archivo}`);

  const etiquetas = etiquetasDe(subcuentas);

  /*
   * Etiquetas repetidas se sobrescriben entre si en silencio. Cortar aqui es
   * preferible a descubrir en la reunion que hay tres cuentas donde deberia
   * haber diez.
   */
  const repetidas = etiquetas.filter((e, i) => etiquetas.indexOf(e) !== i);
  expect(
    [...new Set(repetidas)],
    'hay etiquetas repetidas: cada alta sobrescribiria a la anterior'
  ).toEqual([]);

  const antes = sesion.listar().length;
  console.log(`  ya en el panel ....... ${antes}\n`);

  const fallidas: string[] = [];
  let importadas = 0;

  for (const [i, s] of subcuentas.entries()) {
    const etiqueta = etiquetas[i] ?? `Sub-${i + 1}`;

    const alta = await sesion.agregar({
      etiqueta,
      grupoNombre: grupo,
      apiKey: s.apiKey,
      secretKey: s.secretKey,
      passphrase: s.passphrase
    });

    if (alta.ok) {
      importadas += 1;
      const avisos = alta.advertencias.length > 0 ? ` (${alta.advertencias.length} advertencias)` : '';
      console.log(`  ok    ${etiqueta}  UID ${s.subAccountUid}${avisos}`);
    } else {
      fallidas.push(`${etiqueta}: ${alta.motivo ?? 'sin motivo'}`);
      console.log(`  FALLO ${etiqueta}  ${alta.motivo ?? ''}`);
    }
  }

  const despues = sesion.listar().length;

  console.log(`\n  importadas ........... ${importadas} de ${subcuentas.length}`);
  console.log(`  cuentas en el panel .. ${despues} (antes habia ${antes})\n`);

  if (fallidas.length > 0) {
    console.log('  Fallidas:');
    for (const f of fallidas) console.log(`    - ${f}`);
    console.log('');
  }

  /*
   * Se exige que entren todas. Un lote a medias es peor que ninguno: en la
   * reunion habria cuentas que el operador cree dadas de alta y no lo estan.
   */
  expect(fallidas, 'alguna credencial no fue aceptada por Bitget').toEqual([]);
  expect(importadas).toBe(subcuentas.length);

  /*
   * Y se comprueba el **estado final**, no solo lo que devolvio cada alta.
   *
   * No es redundante: la primera version de este script daba las diez por
   * importadas cuando en el panel solo habia entrado una, porque todas
   * compartian etiqueta y se sobrescribieron. Contar lo que hay al terminar es
   * lo unico que caza esa clase de fallo.
   */
  expect(
    despues - antes,
    'el panel no gano tantas cuentas como se importaron: alguna sobrescribio a otra'
  ).toBe(subcuentas.length);
});
