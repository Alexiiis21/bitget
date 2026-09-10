/**
 * Validación de una subcuenta **UTA real**: todo lo que se puede comprobar sin
 * mover dinero.
 *
 * ==========================================================================
 * Por qué esta prueba es la entrega, y no la sonda
 * ==========================================================================
 * La Fase A dejó `scripts/sondear-v3.mjs`, que manda peticiones firmadas a mano
 * y enseña lo que contesta Bitget. Sirve para descubrir. Esto es otra cosa:
 * recorre **el código del panel** —el mismo `ClienteBitget`, los mismos esquemas
 * Zod, la misma detección de modo, el mismo normalizador— contra una cuenta UTA
 * de verdad. Es la diferencia entre «Bitget responde algo» y «el panel entiende
 * lo que Bitget responde», que es lo único que demuestra que las Fases B, C y D
 * están bien.
 *
 * Todo lo escrito en esas tres fases salió de la documentación, no de respuestas
 * capturadas. Esta prueba es donde eso deja de ser cierto.
 *
 * ==========================================================================
 * No mueve dinero. Ninguna de estas peticiones escribe
 * ==========================================================================
 * Son seis lecturas. Se puede ejecutar contra la subcuenta UTA de producción sin
 * consecuencia: lo peor que puede pasar es que falle y diga qué campo no encaja.
 * Las escrituras están en `uta-escrituras.test.ts`, aparte y con su propio
 * cerrojo, porque ahí sí hay consecuencia.
 *
 * ==========================================================================
 * Qué preguntas cierra
 * ==========================================================================
 * Cada bloque corresponde a un hueco declarado en
 * `docs/00-uta-fase-1-equivalencias.md`:
 *
 *   §10    los nombres de campo reales de `account/settings` y `account/assets`
 *   §5.2   si las listas de V3 vienen peladas o dentro de `{list, cursor}`
 *   §9.1   si UTA admite el mercado de práctica (`SUSDT-FUTURES`)
 *   §4.1   el código exacto con que V3 rechaza una key Classic
 *   §5     `marginSize` y `unrealizedPL`, de los que dependen la columna de
 *          margen y el ROE del monitor
 *
 * Se ejecuta nombrándola:
 *
 *   npx vitest run --config vitest.fisica.config.ts test/fisica/uta-lecturas.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectarModo } from '@main/bitget/deteccion-modo';
import { MERCADO_REAL, MERCADO_SIMULADO } from '@main/bitget/mercado';
import { ClienteBitget } from '@main/bitget/rest/client';
import { obtenerActivosCuenta, obtenerAjustesCuenta } from '@main/bitget/rest/endpoints/ajustes-v3';
import { obtenerCuentasFuturos } from '@main/bitget/rest/endpoints/cuenta';
import { obtenerPosiciones } from '@main/bitget/rest/endpoints/posiciones';
import type { Credencial } from '@main/bitget/rest/signer';
import { verificarCredencial } from '@main/bitget/verificacion';
import { credencialUta, exigirUta } from './credenciales-uta';

let cliente: ClienteBitget;

/**
 * Lo aprendido durante la prueba, para volcarlo al final.
 *
 * La salida importa tanto como los `expect`: estas seis lecturas son la fuente
 * de la sección 10 del documento de equivalencias, que hoy está en blanco. Un
 * verde sin volcado obligaría a repetir la ejecución para leer los nombres.
 */
const hallazgos: string[] = [];
const anotar = (linea: string): void => {
  hallazgos.push(linea);
};

beforeAll(() => {
  exigirUta();
  cliente = new ClienteBitget();
});

afterAll(async () => {
  await cliente?.cerrar();

  console.log('\n─── Hallazgos contra la subcuenta UTA real ───');
  for (const linea of hallazgos) console.log(linea);
  console.log('─── Pegue esto en la §10 de docs/00-uta-fase-1-equivalencias.md ───\n');
});

describe('la cuenta es UTA y el panel lo detecta', () => {
  it('`detectarModo` la reconoce como UTA y lee su `holdMode`', async () => {
    const modo = await detectarModo(cliente, credencialUta);

    /*
     * `transicion` no es un fallo de la prueba: significa que la cuenta está
     * migrando y Bitget dice que no se opere. Se distingue del fallo para que el
     * mensaje no mande a buscar un error que no existe.
     */
    if (modo.modo === 'transicion') {
      anotar('⚠ La cuenta está en transición (upgrading/switching). Repetir al terminar.');
    }

    expect(modo.modo).toBe('uta');
    anotar(`accountMode detectado · holdMode = ${String(modo.holdMode)}`);
  });

  it('`account/settings` encaja con el esquema de la Fase B', async () => {
    const r = await obtenerAjustesCuenta(cliente, credencialUta);
    const d = r.datos;

    /* Lo único que el esquema declara obligatorio, y sin ello no hay detección. */
    expect(d.accountMode).toBeTruthy();

    anotar(`settings.accountMode  = ${d.accountMode}`);
    anotar(`settings.holdMode     = ${String(d.holdMode)}`);
    anotar(`settings.assetMode    = ${String(d.assetMode)}`);
    anotar(`settings.accountLevel = ${String(d.accountLevel)}`);
    anotar(`settings.symbolConfigList: ${d.symbolConfigList?.length ?? 0} entradas`);

    const primera = d.symbolConfigList?.[0];
    if (primera !== undefined) {
      anotar(`  ejemplo: ${JSON.stringify(primera)}`);
    } else {
      /*
       * Sin esta lista, `obtenerCuentaSimbolo` no puede decir el apalancamiento
       * de un símbolo en UTA, y el motor comprueba con él que un cambio se
       * aplicó de verdad —la lección del 05/09/2026—.
       */
      anotar('  ⚠ symbolConfigList vacía: obtenerCuentaSimbolo devolverá «no se sabe».');
    }
  });

  it('`account/assets` da un saldo legible en la moneda del mercado', async () => {
    const r = await obtenerActivosCuenta(cliente, credencialUta);

    anotar(`assets: ${r.datos.length} monedas`);
    if (r.datos[0] !== undefined) anotar(`  ejemplo: ${JSON.stringify(r.datos[0])}`);

    /*
     * El saldo es lo que la Fase D arregló: hasta entonces `leerSaldo` iba a V2
     * en cuentas UTA, Bitget lo rechazaba y la columna se congelaba sin aviso.
     * Se comprueba por el camino real —`obtenerCuentasFuturos`, que despacha— y
     * no por el endpoint pelado.
     */
    const futuros = await obtenerCuentasFuturos(
      cliente,
      credencialUta,
      MERCADO_REAL.productType,
      MERCADO_REAL.marginCoin
    );
    const propia = futuros.datos.find((c) => c.marginCoin === MERCADO_REAL.marginCoin);

    anotar(`saldo ${MERCADO_REAL.marginCoin} = ${propia?.available ?? '(no aparece)'}`);
    expect(propia?.available ?? '').not.toBe('');
  });
});

describe('las posiciones se leen y se normalizan', () => {
  it('`current-position` se lee por el camino del panel y da la forma de V2', async () => {
    /*
     * Se llama a `obtenerPosiciones` —la función de V2— a propósito: con la
     * credencial sellada como `v3` tiene que despachar sola. Llamar directamente
     * a `obtenerPosicionesV3` probaría el endpoint y no el enrutamiento, que es
     * la mitad del trabajo de la Fase B.
     */
    const r = await obtenerPosiciones(cliente, credencialUta, MERCADO_REAL);

    anotar(`current-position: ${r.datos.length} posiciones abiertas`);

    const p = r.datos[0];
    if (p === undefined) {
      anotar('  (sin posiciones abiertas: los campos del monitor quedan sin confirmar)');
      return;
    }

    anotar(`  normalizada: ${JSON.stringify(p)}`);

    /* Los tres que el monitor no puede dibujar sin ellos. */
    expect(p.symbol).toBeTruthy();
    expect(p.holdSide).toBeTruthy();
    expect(p.total).toBeTruthy();

    /*
     * Los dos huecos declarados de la Fase B. No se exigen —el panel enseña un
     * guion si faltan, que es la lectura correcta— pero sí se anotan: de ellos
     * dependen la columna de margen y el ROE.
     */
    anotar(`  marginSize   = ${p.marginSize ?? '(ausente)'}`);
    anotar(`  unrealizedPL = ${p.unrealizedPL ?? '(ausente)'}`);
  });
});

describe('las preguntas abiertas del documento', () => {
  it('§9.1 — dice si UTA admite el mercado de práctica', async () => {
    /*
     * ======================================================================
     * Es la pregunta más cara que queda abierta
     * ======================================================================
     * `SUSDT-FUTURES` no está en la lista de `category` de V3. Si de verdad no
     * lo admite, toda la suite `test/fisica/` —apertura, cierre, Take Profit—
     * no se puede repetir sobre UTA en dinero simulado, y validar las
     * escrituras exige una subcuenta UTA desechable con dinero real.
     *
     * No se afirma nada: se pregunta y se anota. Un `expect` aquí obligaría a
     * elegir de antemano cuál de las dos respuestas es «correcta», y las dos
     * son informativas.
     */
    const r = await obtenerPosiciones(cliente, credencialUta, MERCADO_SIMULADO).then(
      (ok) => ({ admitido: true, detalle: `${ok.datos.length} posiciones` }),
      (e: unknown) => ({
        admitido: false,
        detalle: e instanceof Error ? `${(e as { codigo?: string }).codigo ?? '?'} · ${e.message}` : String(e)
      })
    );

    anotar(
      r.admitido
        ? `§9.1 SUSDT-FUTURES ADMITIDO en UTA (${r.detalle}) → las pruebas físicas siguen en simulado`
        : `§9.1 SUSDT-FUTURES RECHAZADO en UTA → ${r.detalle}`
    );
    anotar('        (si está rechazado, las escrituras UTA van con dinero real)');
  });

  it('§4.1 — captura el código con que V3 rechaza una key Classic', async () => {
    /*
     * El código que la Fase B no pudo fijar. `detectarModo` no lo necesita
     * —trata cualquier fallo de negocio como Classic, y por eso es correcto sin
     * conocerlo— pero la Fase E sí: es la única señal inequívoca de «superficie
     * equivocada», la que autoriza el reintento cruzado.
     *
     * Se pregunta con la credencial demo, que es Classic, forzándola a hablar V3.
     */
    const clasicaForzada: Credencial = { ...credencialDemo(), superficie: 'v3' };
    if (clasicaForzada.apiKey === '') {
      anotar('§4.1 sin BITGET_DEMO_*: no se pudo capturar el código de superficie equivocada');
      return;
    }

    const detalle = await obtenerAjustesCuenta(cliente, clasicaForzada).then(
      () => 'la key Classic fue ACEPTADA por V3 (inesperado: revisar qué cuenta es)',
      (e: unknown) =>
        e instanceof Error
          ? `código ${(e as { codigo?: string }).codigo ?? '?'} · ${e.message}`
          : String(e)
    );

    anotar(`§4.1 key Classic contra /api/v3/account/settings → ${detalle}`);
  });
});

/** La credencial demo (Classic), o cadenas vacías si no está configurada. */
function credencialDemo(): Credencial {
  return {
    apiKey: process.env['BITGET_DEMO_API_KEY'] ?? '',
    secretKey: process.env['BITGET_DEMO_SECRET_KEY'] ?? '',
    passphrase: process.env['BITGET_DEMO_PASSPHRASE'] ?? ''
  };
}

describe('la verificación completa, tal como la hace el panel al dar de alta', () => {
  it('marca la cuenta como UTA y no la rechaza', async () => {
    const r = await verificarCredencial(cliente, credencialUta, { mercado: MERCADO_REAL });

    anotar(`verificación: veredicto=${r.veredicto} accountMode=${String(r.accountMode)}`);
    anotar(`  permisos: ${r.permisos.join(', ') || '(ninguno)'}`);
    if (r.permisosDesconocidos.length > 0) {
      anotar(`  ⚠ permisos fuera del catálogo: ${r.permisosDesconocidos.join(', ')}`);
    }

    expect(r.accountMode).toBe('uta');
    /*
     * `rechazada` significa que Bitget la acepta pero incumple una regla propia
     * —típicamente un permiso de retiro, que el contrato prohíbe—. Es un fallo
     * de la cuenta, no del panel, y tiene que verse.
     */
    expect(r.veredicto).toBe('valida');
  });
});
