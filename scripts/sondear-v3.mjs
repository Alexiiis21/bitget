/**
 * Sonda de superficie: que responde la API V3 (UTA) y que responde la V2.
 *
 * ==========================================================================
 * Para que existe
 * ==========================================================================
 * El Paquete A de la migracion a UTA depende de dos datos que **no se pueden
 * deducir de la documentacion** y que INTEGRACION_V3_UTA.md deja marcados como
 * pendientes:
 *
 *   1. Que devuelve `/api/v3/account/settings` a una key de cuenta **Classic**.
 *      De ahi sale el codigo de error que significa «superficie equivocada», que
 *      es el unico que autoriza el fallback cruzado del Paquete E. Inventarlo
 *      seria construir la deteccion de modo sobre una suposicion.
 *   2. Los nombres reales de los campos que devuelve V3 en una cuenta UTA. El
 *      Centro de Monitoreo lee `openPriceAvg` y `liquidationPrice` de V2; V3
 *      renombra el primero a `avgPrice` segun la documentacion, y el resto del
 *      mapeo hay que capturarlo, no suponerlo.
 *
 * Este script pregunta y enseña la respuesta cruda. Es el equivalente de
 * `ver-permisos.mjs` para la migracion: misma forma, mismo criterio.
 *
 * ==========================================================================
 * Solo lee. No escribe nada, en ninguna superficie
 * ==========================================================================
 * Todas las peticiones son GET firmados. No hay ordenes, ni traspasos, ni
 * cambios de configuracion, ni acceso al vault. Correrlo contra una cuenta con
 * dinero real es inocuo: lo peor que puede pasar es gastar unas peticiones del
 * cupo por UID.
 *
 * Uso:
 *   node scripts/sondear-v3.mjs                 (BITGET_DEMO_*, superficie V3)
 *   node scripts/sondear-v3.mjs --env UTA       (BITGET_UTA_*,  superficie V3)
 *   node scripts/sondear-v3.mjs --env UTA --v2  (BITGET_UTA_*,  superficie V2)
 *   node scripts/sondear-v3.mjs --env DEMO --v2 (control: V2 con una key V2)
 *
 * Las cuatro combinaciones importan. Las dos cruzadas -key Classic contra V3 y
 * key UTA contra V2- son las que dan los codigos de desajuste; las dos rectas
 * son el control que demuestra que la credencial funciona y que un fallo de la
 * cruzada es del desajuste y no de la clave.
 *
 * La salida esta pensada para pegarse tal cual en
 * `docs/00-uta-fase-1-equivalencias.md`.
 */
import { createHmac } from 'node:crypto';

const HOST = 'https://api.bitget.com';

const args = process.argv.slice(2);
const opcion = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 || i + 1 >= args.length ? d : args[i + 1];
};

try {
  process.loadEnvFile('.env');
} catch {
  /* Sin .env se usan las variables del entorno, si las hay. */
}

const enmascarar = (c) =>
  typeof c === 'string' && c.length > 6 ? `${c.slice(0, 2)}****${c.slice(-4)}` : '****';

/**
 * Cadena de consulta canonica, ordenada por clave.
 *
 * Identica a `cadenaConsulta` de `src/main/bitget/rest/signer.ts`: lo que se
 * firma tienen que ser **exactamente los mismos bytes** que viajan en la
 * peticion. Se reproduce aqui en lugar de importarla porque el script no
 * depende del `src/` -corre con `node` a secas, sin compilar-.
 */
function cadenaConsulta(consulta) {
  const pares = Object.entries(consulta ?? {})
    .filter(([, v]) => v !== undefined && v !== null)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);

  return pares.length === 0 ? '' : `?${pares.join('&')}`;
}

/**
 * GET firmado. El firmado es identico en V2 y V3 -esa es una de las cosas que
 * esta sonda comprueba de paso-: mismas cuatro cabeceras, misma prefirma
 * `timestamp + METODO + rutaCompleta + cuerpo`, con el cuerpo vacio en un GET.
 */
async function sondear(credencial, ruta, consulta = {}) {
  const rutaCompleta = `${ruta}${cadenaConsulta(consulta)}`;
  const timestamp = String(Date.now());
  const firma = createHmac('sha256', credencial.secretKey)
    .update(`${timestamp}GET${rutaCompleta}`, 'utf8')
    .digest('base64');

  const inicio = Date.now();
  let respuesta;
  let texto;

  try {
    respuesta = await fetch(`${HOST}${rutaCompleta}`, {
      headers: {
        'ACCESS-KEY': credencial.apiKey,
        'ACCESS-SIGN': firma,
        'ACCESS-TIMESTAMP': timestamp,
        'ACCESS-PASSPHRASE': credencial.passphrase,
        'Content-Type': 'application/json',
        locale: 'en-US'
      }
    });
    texto = await respuesta.text();
  } catch (e) {
    return { rutaCompleta, transporte: e.message, ms: Date.now() - inicio };
  }

  const ms = Date.now() - inicio;

  let json;
  try {
    json = JSON.parse(texto);
  } catch {
    return { rutaCompleta, http: respuesta.status, crudo: texto.slice(0, 800), ms };
  }

  return { rutaCompleta, http: respuesta.status, json, ms };
}

function imprimir(titulo, r) {
  console.log(`\n${'-'.repeat(78)}`);
  console.log(`  ${titulo}`);
  console.log(`  GET ${r.rutaCompleta}`);
  console.log(`${'-'.repeat(78)}`);

  if (r.transporte !== undefined) {
    console.log(`  SIN RESPUESTA (${r.ms} ms) — ${r.transporte}`);
    return;
  }

  if (r.crudo !== undefined) {
    console.log(`  HTTP ${r.http} (${r.ms} ms) — la respuesta no es JSON:`);
    console.log(r.crudo);
    return;
  }

  /*
   * `code` y `msg` van aparte del volcado aunque se repitan dentro: son el
   * veredicto, y en Bitget un HTTP 200 con `code` distinto de 00000 es un
   * rechazo. Verlos en una linea evita leerlo mal de un JSON largo.
   */
  console.log(`  HTTP ${r.http} (${r.ms} ms)  code ${r.json.code}  msg ${r.json.msg}`);
  console.log(JSON.stringify(resumir(r.json), null, 2));
}

/**
 * Recorta las listas largas antes de volcarlas.
 *
 * El catalogo del mercado real devuelve varios cientos de instrumentos, y en el
 * sondeo del 09/09/2026 esa pared de JSON enterro lo unico que se estaba
 * buscando: el codigo de rechazo de `account/settings`. Lo que hace falta de una
 * lista es **la forma de sus elementos**, no todos: con dos basta para leer los
 * nombres de campo, que es a lo que se viene.
 *
 * Se anota cuantos se omitieron para que nadie confunda el recorte con una
 * respuesta corta.
 */
function resumir(json, maximo = 2) {
  const data = json?.data;

  const recortar = (lista) =>
    lista.length <= maximo
      ? lista
      : [...lista.slice(0, maximo), `… y ${lista.length - maximo} mas (recortado por la sonda)`];

  if (Array.isArray(data)) return { ...json, data: recortar(data) };

  if (data !== null && typeof data === 'object' && Array.isArray(data.list)) {
    return { ...json, data: { ...data, list: recortar(data.list) } };
  }

  return json;
}

/* ---------- las dos baterias ---------- */

const SONDEOS_V3 = [
  {
    titulo: 'Modo de cuenta — el endpoint de verdad de la deteccion',
    ruta: '/api/v3/account/settings'
  },
  {
    titulo: 'Balances — equivalente de /api/v2/mix/account/accounts',
    ruta: '/api/v3/account/assets'
  },
  {
    titulo: 'Posiciones — equivalente de /api/v2/mix/position/all-position',
    ruta: '/api/v3/position/current-position',
    consulta: { category: 'USDT-FUTURES' }
  },
  {
    titulo: 'Catalogo del mercado real — que simbolos y limites publica V3',
    ruta: '/api/v3/market/instruments',
    consulta: { category: 'USDT-FUTURES' }
  }
];

const SONDEOS_V2 = [
  {
    titulo: 'Permisos y UID — lo que usa hoy verificarCredencial()',
    ruta: '/api/v2/spot/account/info'
  },
  {
    titulo: 'Posiciones — lo que alimenta el Centro de Monitoreo',
    ruta: '/api/v2/mix/position/all-position',
    consulta: { productType: 'USDT-FUTURES', marginCoin: 'USDT' }
  },
  {
    titulo: 'Balances — lo que lee el barrido cada 45 s',
    ruta: '/api/v2/mix/account/accounts',
    consulta: { productType: 'USDT-FUTURES' }
  }
];

/* ---------- lectura del veredicto ---------- */

/**
 * Traduce el primer sondeo a la frase que hay que pegar en el documento.
 *
 * Es lo unico del script que interpreta en vez de volcar. Se limita a la
 * pregunta que el Paquete A tiene que responder y no adivina mas alla de ella:
 * un `code` desconocido se enseña tal cual, sin clasificarlo.
 */
/**
 * Codigos que se producen al validar el sobre de autenticacion.
 *
 * Identicos en V2 y V3 -misma firma, mismas cabeceras-, asi que no distinguen
 * superficies. Espejo de `SOBRE_DE_AUTENTICACION` en `src/main/bitget/errors.ts`;
 * si cambia uno, cambia el otro.
 */
const SOBRE_DE_AUTENTICACION = new Set([
  '40001',
  '40002',
  '40003',
  '40005',
  '40006',
  '40009',
  '40018'
]);

/**
 * `true` si el rechazo es «esta cuenta es UTA y a la clave le falta el permiso».
 *
 * Se mira el **mensaje** y no solo el codigo: `40014` significa tambien «sin
 * permiso de trading» en cuentas clasicas, y confundirlos daria por UTA a una
 * cuenta que no lo es. Espejo de `esPermisoUtaFaltante` en
 * `src/main/bitget/errors.ts`.
 */
const esPermisoUta = (code, msg) => code === '40014' && /\buta\b/i.test(msg ?? '');

function veredicto(superficie, primero) {
  if (primero.json === undefined) {
    return 'Sin respuesta legible. No concluir nada: repetir el sondeo.';
  }

  const { code, msg, data } = primero.json;

  if (superficie === 'V3') {
    if (code === '00000') {
      const d = data ?? {};
      return (
        `La credencial habla V3: es una cuenta UTA.\n` +
        `    accountMode  ${d.accountMode ?? '(ausente)'}\n` +
        `    holdMode     ${d.holdMode ?? '(ausente)'}  ` +
        `-> posSide ${d.holdMode === 'hedge_mode' ? 'ES OBLIGATORIO' : 'se omite'}\n` +
        `    accountLevel ${d.accountLevel ?? '(ausente)'}\n` +
        `    assetMode    ${d.assetMode ?? '(ausente)'}`
      );
    }
    /*
     * Un rechazo del sobre de autenticacion no dice NADA de la superficie.
     *
     * La firma y las cuatro cabeceras son identicas en V2 y V3, asi que estos
     * codigos se habrian producido igual en la otra API. Esta rama existe porque
     * el 09/09/2026 este mismo script concluyo que `40018 · Invalid IP` era «el
     * codigo de desajuste de superficie que buscaba la Fase A». No lo era, y esa
     * frase mando a buscar un problema de migracion donde habia uno de lista
     * blanca.
     */
    /*
     * `40014` nombrando permisos de UTA **prueba que la cuenta es unificada**.
     *
     * Capturado el 09/09/2026: «Incorrect permissions, need UTA manage read or
     * UTA manage write permissions». Bitget no le habla de permisos de UTA a una
     * clave de cuenta clasica: reconoce la cuenta y le falta un ambito a la
     * clave. Confirmado ademas por el titular, que sabe que esa subcuenta esta
     * migrada.
     *
     * Este script llego a llamar a esto «el codigo de desajuste de superficie».
     * Era falso y mandaba a la conclusion contraria a la verdadera.
     */
    if (esPermisoUta(code, msg)) {
      return (
        `La cuenta ES UTA, pero a la clave le falta un permiso.\n` +
        `    code ${code} · ${msg}\n` +
        `    V3 reconoce la cuenta: no le hablaria de permisos de UTA a una clave\n` +
        `    de cuenta clasica. Habilite «UTA manage read» en esa API Key desde\n` +
        `    Bitget y repita el sondeo para leer accountMode y holdMode.`
      );
    }

    if (SOBRE_DE_AUTENTICACION.has(code)) {
      return (
        `NO SE PUDO PREGUNTAR. Bitget rechazo la autenticacion:\n` +
        `    code ${code} · ${msg}\n` +
        `    Esto NO dice si la cuenta es UTA o Classic: la firma y las cabeceras\n` +
        `    son identicas en las dos APIs, asi que V2 habria fallado igual.\n` +
        `    Corrija la credencial -o la IP en la lista blanca de Bitget- y repita\n` +
        `    el sondeo. Hasta entonces el modo de esta cuenta sigue sin saberse.`
      );
    }

    return (
      `La credencial NO habla V3. Codigo de desajuste de superficie:\n` +
      `    code ${code} · ${msg}\n` +
      `    Este es el valor que buscaba el Paquete A: el que detectMode() debe\n` +
      `    tratar como 'classic', y el unico que autoriza el fallback cruzado.`
    );
  }

  if (code === '00000') return 'La credencial habla V2: es una cuenta Classic (o UTA con V2 vivo).';
  return `La credencial NO habla V2. Codigo de desajuste:\n    code ${code} · ${msg}`;
}

async function principal() {
  const prefijo = (opcion('env', 'DEMO') ?? 'DEMO').toUpperCase();
  const superficie = args.includes('--v2') ? 'V2' : 'V3';

  const credencial = {
    apiKey: process.env[`BITGET_${prefijo}_API_KEY`] ?? '',
    secretKey: process.env[`BITGET_${prefijo}_SECRET_KEY`] ?? '',
    passphrase: process.env[`BITGET_${prefijo}_PASSPHRASE`] ?? ''
  };

  if (credencial.apiKey === '') {
    throw new Error(
      `No hay BITGET_${prefijo}_API_KEY en el entorno ni en .env. ` +
        'Ver el bloque correspondiente de .env.example.'
    );
  }

  const sondeos = superficie === 'V3' ? SONDEOS_V3 : SONDEOS_V2;

  console.log('');
  console.log(`  Sonda de superficie ${superficie}`);
  console.log(`  Credencial  BITGET_${prefijo}  key ${enmascarar(credencial.apiKey)}`);
  console.log(`  Fecha       ${new Date().toISOString()}`);
  console.log(`  Peticiones  ${sondeos.length}, todas GET. No se escribe nada.`);

  const resultados = [];

  for (const s of sondeos) {
    const r = await sondear(credencial, s.ruta, s.consulta ?? {});
    imprimir(s.titulo, r);
    resultados.push(r);
    /* Mismo respiro que ver-permisos.mjs: el limite es por UID. */
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log('  VEREDICTO');
  console.log(`${'='.repeat(78)}`);
  console.log(`  ${veredicto(superficie, resultados[0])}`);

  console.log('');
  console.log('  Pegar la salida completa en docs/00-uta-fase-1-equivalencias.md');
  console.log('');
}

principal().catch((e) => {
  console.error(`\nError: ${e.message}\n`);
  process.exit(1);
});
