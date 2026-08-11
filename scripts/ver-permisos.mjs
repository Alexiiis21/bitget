/**
 * Que permisos declara Bitget para una credencial.
 *
 * Bitget devuelve los permisos como codigos opacos de cuatro letras y **no
 * publica su significado**. El panel usa lista blanca -solo acepta los codigos
 * confirmados como inocuos- asi que cada vez que aparece un codigo nuevo hay
 * que averiguar de donde sale antes de decidir si se cataloga.
 *
 * Este script es la herramienta para eso: pregunta a la API real y enseña, para
 * cada credencial, el UID, si es subcuenta y la lista cruda de `authorities`.
 * No escribe nada ni toca el vault.
 *
 * Uso:
 *   node scripts/ver-permisos.mjs                      (lee subcuentas-generadas.json)
 *   node scripts/ver-permisos.mjs --archivo otro.json
 *   node scripts/ver-permisos.mjs --env                (usa BITGET_DEMO_* de .env)
 */
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const HOST = 'https://api.bitget.com';
const RUTA = '/api/v2/spot/account/info';

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

async function infoCuenta({ apiKey, secretKey, passphrase }) {
  const timestamp = String(Date.now());
  const firma = createHmac('sha256', secretKey)
    .update(`${timestamp}GET${RUTA}`, 'utf8')
    .digest('base64');

  const respuesta = await fetch(`${HOST}${RUTA}`, {
    headers: {
      'ACCESS-KEY': apiKey,
      'ACCESS-SIGN': firma,
      'ACCESS-TIMESTAMP': timestamp,
      'ACCESS-PASSPHRASE': passphrase,
      'Content-Type': 'application/json',
      locale: 'en-US'
    }
  });

  const json = await respuesta.json();
  if (json.code !== '00000') throw new Error(`[${json.code}] ${json.msg}`);
  return json.data;
}

const enmascarar = (c) => (typeof c === 'string' && c.length > 6 ? `${c.slice(0, 2)}****${c.slice(-4)}` : '****');

async function principal() {
  const credenciales = [];

  if (args.includes('--env')) {
    credenciales.push({
      etiqueta: 'BITGET_DEMO (.env)',
      apiKey: process.env['BITGET_DEMO_API_KEY'] ?? '',
      secretKey: process.env['BITGET_DEMO_SECRET_KEY'] ?? '',
      passphrase: process.env['BITGET_DEMO_PASSPHRASE'] ?? ''
    });
  } else {
    const archivo = opcion('archivo', 'subcuentas-generadas.json');
    const lista = JSON.parse(await readFile(archivo, 'utf8'));
    for (const s of lista) {
      credenciales.push({
        etiqueta: (s.subAccountName ?? '').split('@')[0],
        apiKey: s.apiKey,
        secretKey: s.secretKey,
        passphrase: s.passphrase
      });
    }
  }

  console.log('');
  const vistos = new Map();

  for (const c of credenciales) {
    try {
      const d = await infoCuenta(c);
      const permisos = d.authorities ?? [];
      for (const p of permisos) vistos.set(p, (vistos.get(p) ?? 0) + 1);

      console.log(
        `  ${c.etiqueta.padEnd(12)} key ${enmascarar(c.apiKey)}  UID ${d.userId}  ` +
          `parentId ${d.parentId ?? '-'}  authorities [${permisos.join(', ')}]`
      );
    } catch (e) {
      console.log(`  ${c.etiqueta.padEnd(12)} key ${enmascarar(c.apiKey)}  ERROR ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log('\n  Codigos observados:');
  for (const [codigo, veces] of [...vistos.entries()].sort()) {
    console.log(`    ${codigo}  en ${veces} credencial(es)`);
  }
  console.log('');
}

principal().catch((e) => {
  console.error(`\nError: ${e.message}\n`);
  process.exit(1);
});
