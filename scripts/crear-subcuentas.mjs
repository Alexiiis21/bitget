/**
 * Alta masiva de subcuentas virtuales de Bitget, con su API Key.
 *
 * --------------------------------------------------------------------------
 * Para que sirve
 * --------------------------------------------------------------------------
 * Crear a mano 20 subcuentas y sus 20 API Keys son 20 formularios. Este script
 * lo hace en cuatro peticiones. Las subcuentas **virtuales** no necesitan
 * correo ni KYC propio: heredan la verificacion de la cuenta madre.
 *
 * --------------------------------------------------------------------------
 * Lo que hay que saber antes de ejecutarlo
 * --------------------------------------------------------------------------
 *  1. Necesita la API Key de la **cuenta madre**, no la de una subcuenta. Una
 *     subcuenta no puede crear subcuentas.
 *  2. Crea las keys con permiso `contract_trade` **y nada mas**. No es un
 *     capricho: el panel rechaza toda credencial con un permiso que no
 *     reconozca -politica de fallar cerrado, ver src/main/bitget/verificacion.ts-
 *     asi que una key con permiso de spot no pasaria la verificacion.
 *  3. El archivo de salida contiene **secretos en claro**. Es la unica copia:
 *     Bitget no vuelve a mostrar una secretKey. Guardalo, importalo al panel y
 *     borralo.
 *  4. Por defecto NO crea nada. Enseña lo que haria. Hay que pasar `--crear`.
 *
 * --------------------------------------------------------------------------
 * Uso
 * --------------------------------------------------------------------------
 *   node scripts/crear-subcuentas.mjs --listar
 *   node scripts/crear-subcuentas.mjs --hasta 20                 (simulacion)
 *   node scripts/crear-subcuentas.mjs --hasta 20 --crear         (de verdad)
 *
 * `--hasta N` crea las que falten para llegar a N en total; `--cantidad N`
 * crea N mas. Si lo pedido no cabe en el tope de Bitget, se recorta.
 *
 * Variables en .env (la cuenta MADRE):
 *   BITGET_MADRE_API_KEY, BITGET_MADRE_SECRET_KEY, BITGET_MADRE_PASSPHRASE
 */
import { createHmac, randomInt } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const HOST = 'https://api.bitget.com';
/* Bitget acepta como maximo 5 elementos por peticion en el alta en lote. */
const LOTE_MAXIMO = 5;
/* Tope de subcuentas de una cuenta estandar. Ver docs de Bitget. */
const TOPE_BITGET = 20;

/* ---------------- argumentos ---------------- */

const args = process.argv.slice(2);
const opcion = (nombre, porDefecto = null) => {
  const i = args.indexOf(`--${nombre}`);
  return i === -1 || i + 1 >= args.length ? porDefecto : args[i + 1];
};
const bandera = (nombre) => args.includes(`--${nombre}`);

const cantidad = Number.parseInt(opcion('cantidad', '5'), 10);
const prefijo = opcion('prefijo', 'pcb');
const salida = opcion('salida', 'subcuentas-generadas.json');
const crearDeVerdad = bandera('crear');
const soloListar = bandera('listar');

/* ---------------- credenciales ---------------- */

try {
  process.loadEnvFile('.env');
} catch {
  /* Sin .env se usan las variables del entorno, si las hay. */
}

const madre = {
  apiKey: process.env['BITGET_MADRE_API_KEY'] ?? '',
  secretKey: process.env['BITGET_MADRE_SECRET_KEY'] ?? '',
  passphrase: process.env['BITGET_MADRE_PASSPHRASE'] ?? ''
};

if (madre.apiKey === '' || madre.secretKey === '' || madre.passphrase === '') {
  console.error(
    'Faltan las credenciales de la cuenta madre en .env:\n' +
      '  BITGET_MADRE_API_KEY, BITGET_MADRE_SECRET_KEY, BITGET_MADRE_PASSPHRASE\n\n' +
      'Ojo: tiene que ser la API Key de la cuenta PRINCIPAL. Una subcuenta no\n' +
      'puede crear subcuentas, y BITGET_DEMO_* es una subcuenta.'
  );
  process.exit(1);
}

/* ---------------- firma ---------------- */

/** timestamp + METODO + ruta + cuerpo, HMAC-SHA256 en base64. */
function firmar(secretKey, prefirma) {
  return createHmac('sha256', secretKey).update(prefirma, 'utf8').digest('base64');
}

async function peticion(metodo, ruta, cuerpo = null) {
  const timestamp = String(Date.now());
  const texto = cuerpo === null ? '' : JSON.stringify(cuerpo);
  const firma = firmar(madre.secretKey, `${timestamp}${metodo}${ruta}${texto}`);

  const respuesta = await fetch(`${HOST}${ruta}`, {
    method: metodo,
    headers: {
      'ACCESS-KEY': madre.apiKey,
      'ACCESS-SIGN': firma,
      'ACCESS-TIMESTAMP': timestamp,
      'ACCESS-PASSPHRASE': madre.passphrase,
      'Content-Type': 'application/json',
      locale: 'en-US'
    },
    body: cuerpo === null ? undefined : texto
  });

  const json = await respuesta.json();

  /* Bitget responde HTTP 200 aunque la operacion haya sido rechazada. */
  if (json.code !== '00000') {
    throw new Error(`Bitget rechazo ${ruta}: [${json.code}] ${json.msg}`);
  }
  return json.data;
}

/* ---------------- operaciones ---------------- */

const enmascarar = (clave) =>
  typeof clave === 'string' && clave.length > 6
    ? `${clave.slice(0, 2)}${'*'.repeat(6)}${clave.slice(-4)}`
    : '******';

async function listar() {
  const datos = await peticion('GET', '/api/v2/user/virtual-subaccount-list');
  const lista = Array.isArray(datos) ? datos : (datos?.subAccountList ?? []);
  console.log(`\nSubcuentas virtuales existentes: ${lista.length} de ${TOPE_BITGET}\n`);
  for (const s of lista) {
    console.log(`  ${s.subAccountUid ?? '?'}  ${s.subAccountName ?? '?'}  ${s.status ?? ''}`);
  }
  return lista;
}

/**
 * Passphrase distinta por subcuenta.
 *
 * Bitget exige entre 8 y 32 caracteres **con letras y numeros** -codigo 40070-,
 * asi que no basta con volcar bytes al azar: hay que garantizar que aparezca al
 * menos un digito y al menos una letra. Se construye con uno obligatorio de
 * cada clase y se baraja, en lugar de generar y reintentar hasta que cumpla.
 *
 * Se excluyen los caracteres ambiguos -I, l, 1, O, 0- porque estas passphrases
 * acaban leyendose de un archivo y copiandose a mano mas veces de las previstas.
 *
 * Una passphrase compartida convertiria una fuga en la fuga de las veinte.
 */
const MAYUSCULAS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const MINUSCULAS = 'abcdefghijkmnpqrstuvwxyz';
const DIGITOS = '23456789';
const ALFABETO = MAYUSCULAS + MINUSCULAS + DIGITOS;

const alAzar = (conjunto) => conjunto[randomInt(conjunto.length)];

function generarPassphrase(longitud = 16) {
  const caracteres = [alAzar(MAYUSCULAS), alAzar(MINUSCULAS), alAzar(DIGITOS)];
  while (caracteres.length < longitud) caracteres.push(alAzar(ALFABETO));

  /* Fisher-Yates: sin barajar, las tres primeras posiciones serian predecibles. */
  for (let i = caracteres.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [caracteres[i], caracteres[j]] = [caracteres[j], caracteres[i]];
  }

  return caracteres.join('');
}

/**
 * Nombre de subcuenta: exactamente 8 letras, sin digitos.
 *
 * Lo exige Bitget -codigo 40055, «subName must be an English letter with a
 * length of 8»-, asi que no vale numerar `pcb01`. Se resuelve con una raiz de 6
 * letras y un sufijo de 2 que cuenta en base 26: aa, ab, ac... Sigue siendo
 * legible y ordenado, que es lo que hace falta para cotejar cada subcuenta con
 * su UID delante del cliente.
 */
const LONGITUD_NOMBRE = 8;
const LONGITUD_SUFIJO = 2;

const soloLetras = (texto) => texto.toLowerCase().replace(/[^a-z]/g, '');

/** 0 -> 'aa', 1 -> 'ab', ... 25 -> 'az', 26 -> 'ba'. */
function sufijo(indice) {
  let n = indice;
  let salida = '';
  for (let i = 0; i < LONGITUD_SUFIJO; i += 1) {
    salida = String.fromCharCode(97 + (n % 26)) + salida;
    n = Math.floor(n / 26);
  }
  return salida;
}

/**
 * Nombres correlativos, saltando los que ya existen.
 *
 * Bitget rechaza un nombre repetido, y devuelve los existentes en forma de
 * correo -`pcbsubaa@algo.com`-, asi que la colision se busca por como empieza
 * el nombre y no por igualdad exacta.
 */
function planear(cantidad, nombresOcupados) {
  const ocupados = nombresOcupados.map((n) => String(n ?? '').toLowerCase());
  const raiz = soloLetras(`${prefijo}sub`).slice(0, LONGITUD_NOMBRE - LONGITUD_SUFIJO)
    .padEnd(LONGITUD_NOMBRE - LONGITUD_SUFIJO, 'x');

  const marca = Date.now();
  const plan = [];
  let n = 0;

  while (plan.length < cantidad && n < 26 ** LONGITUD_SUFIJO) {
    const nombre = `${raiz}${sufijo(n)}`;
    n += 1;
    if (ocupados.some((o) => o.startsWith(nombre))) continue;

    plan.push({
      subAccountName: nombre,
      passphrase: generarPassphrase(),
      /* Solo futuros: el panel rechaza cualquier permiso que no reconozca. */
      permList: ['contract_trade'],
      label: `pcb-${marca}-${String(plan.length + 1).padStart(2, '0')}`
    });
  }

  return plan;
}

async function crear(plan) {
  const creadas = [];

  for (let i = 0; i < plan.length; i += LOTE_MAXIMO) {
    const lote = plan.slice(i, i + LOTE_MAXIMO);
    const numero = Math.floor(i / LOTE_MAXIMO) + 1;
    process.stdout.write(`  lote ${numero} (${lote.length} subcuentas)... `);

    const datos = await peticion('POST', '/api/v2/user/batch-create-subaccount-and-apikey', lote);

    for (const r of datos ?? []) {
      const original = lote.find((p) => p.label === r.label);
      creadas.push({
        subAccountUid: r.subAccountUid,
        subAccountName: r.subAccountName,
        /*
         * Bitget devuelve el nombre enmascarado -`pcb****@virtual-bitget.com`-,
         * asi que se guarda tambien el que se pidio. Sin el, el importador no
         * puede distinguir una subcuenta de otra por el nombre.
         */
        nombreSolicitado: original?.subAccountName ?? null,
        label: r.label,
        apiKey: r.subAccountApiKey,
        secretKey: r.secretKey,
        passphrase: original?.passphrase ?? null,
        permList: r.permList
      });
    }
    console.log('ok');

    /* Un segundo entre lotes: el alta de subcuentas tiene su propio limite. */
    if (i + LOTE_MAXIMO < plan.length) await new Promise((r) => setTimeout(r, 1_100));
  }

  return creadas;
}

/* ---------------- principal ---------------- */

async function principal() {
  const existentes = await listar();
  const yaExisten = existentes.length;
  const capacidad = Math.max(0, TOPE_BITGET - yaExisten);

  if (soloListar) return;

  if (capacidad === 0) {
    console.error(
      `\nYa tienes las ${TOPE_BITGET} subcuentas que permite una cuenta estandar.\n` +
        'Por encima de ese tope hace falta el Programa Broker de Bitget.'
    );
    process.exit(1);
  }

  /*
   * `--hasta N` es el modo comodo: se pide un total, no un incremento. Evita
   * tener que restar a mano lo que ya existe cada vez que se retoma el alta.
   */
  const hasta = opcion('hasta', null);
  let aCrear = cantidad;

  if (hasta !== null) {
    const objetivo = Number.parseInt(hasta, 10);
    if (!Number.isInteger(objetivo) || objetivo < 1) {
      console.error('--hasta tiene que ser un entero positivo.');
      process.exit(1);
    }
    aCrear = objetivo - yaExisten;
    if (aCrear < 1) {
      console.log(`\nYa tienes ${yaExisten} subcuentas: no hay nada que crear para llegar a ${objetivo}.\n`);
      return;
    }
  } else if (!Number.isInteger(cantidad) || cantidad < 1) {
    console.error('--cantidad tiene que ser un entero positivo.');
    process.exit(1);
  }

  /* Recortar en vez de abortar: crear las que caben es lo que se queria. */
  if (aCrear > capacidad) {
    console.log(
      `\nPediste ${aCrear} pero solo caben ${capacidad} (ya hay ${yaExisten} de ${TOPE_BITGET}).\n` +
        `Se preparan ${capacidad}. Por encima del tope hace falta el Programa Broker.`
    );
    aCrear = capacidad;
  }

  const plan = planear(aCrear, existentes.map((s) => s.subAccountName));

  console.log(`\nSe crearian ${plan.length} subcuentas con permiso [contract_trade]:\n`);
  for (const p of plan) console.log(`  ${p.subAccountName}`);

  if (!crearDeVerdad) {
    console.log('\nSimulacion. No se ha creado nada.');
    console.log('Para hacerlo de verdad, repite el comando anadiendo --crear\n');
    return;
  }

  console.log('\nCreando...\n');
  const creadas = await crear(plan);

  await writeFile(salida, JSON.stringify(creadas, null, 2), 'utf8');

  console.log(`\nCreadas ${creadas.length} subcuentas:\n`);
  for (const c of creadas) {
    console.log(`  ${c.subAccountName}  UID ${c.subAccountUid}  key ${enmascarar(c.apiKey)}`);
  }

  console.log(
    `\nCredenciales completas en: ${salida}\n\n` +
      'AVISO: ese archivo tiene los secretos en claro y es la unica copia -Bitget\n' +
      'no vuelve a mostrar una secretKey-. Importalas al panel y borralo.\n'
  );
}

principal().catch((e) => {
  console.error(`\nError: ${e.message}\n`);
  process.exit(1);
});
