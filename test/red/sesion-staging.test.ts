/**
 * El recorrido completo del panel, con una credencial real y Bitget de verdad.
 *
 * --------------------------------------------------------------------------
 * Que demuestra que no demuestre ninguna otra prueba
 * --------------------------------------------------------------------------
 * `test/integration/sesion.test.ts` recorre este mismo camino contra el
 * exchange simulado: prueba que la **logica** es correcta suponiendo que Bitget
 * responde como creemos. Esta prueba quita esa suposicion. Aqui se da de alta
 * una subcuenta contra api.bitget.com, se cifra la credencial que Bitget acaba
 * de aceptar, se cierra el panel, se vuelve a abrir y se comprueba que sigue
 * ahi y que reconecta sola.
 *
 * Es, punto por punto, lo que el checklist de auditoria pide ver en vivo -
 * secciones A (conexion real), B (seguridad), C (persistencia) y D (estado de
 * conexion)-, en forma de prueba repetible.
 *
 * Las afirmaciones sobre secretos se hacen **leyendo los archivos del disco**,
 * no consultando al objeto en memoria. Que el vault diga que cifro no prueba
 * nada; que el secreto no aparezca en los bytes de cuentas.json, si.
 *
 * Se ejecuta con `npm run test:staging`. Escribe en una carpeta temporal, nunca
 * en la carpeta de datos del operador.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClienteBitget } from '@main/bitget/rest/client';
import { SupervisorReconexion } from '@main/execution/supervisor-reconexion';
import { Sesion } from '@main/ipc/sesion';
import { credencialReal, hayCredenciales } from './credenciales-reales';

const MAESTRA = 'contrasena-de-auditoria-2026';
const ETIQUETA = 'Sub-Auditoria';
const GRUPO = 'Cuenta principal';

let carpeta: string;
let rutaVault: string;
let rutaCuentas: string;
let cliente: ClienteBitget;
let sesion: Sesion;

beforeAll(async () => {
  if (!hayCredenciales) return;
  carpeta = await mkdtemp(join(tmpdir(), 'pcb-staging-'));
  rutaVault = join(carpeta, 'vault.enc');
  rutaCuentas = join(carpeta, 'cuentas.json');

  /* Sin `host`: en staging el cliente solo acepta api.bitget.com. */
  cliente = new ClienteBitget();
  await cliente.sincronizarReloj();

  sesion = new Sesion({ vault: rutaVault, cuentas: rutaCuentas }, cliente);
});

afterAll(async () => {
  sesion?.cerrar();
  await cliente?.cerrar();
  if (carpeta !== undefined) await rm(carpeta, { recursive: true, force: true });
});

describe.skipIf(!hayCredenciales)('panel completo contra Bitget real', () => {
  it('da de alta una subcuenta verificando primero contra Bitget', async () => {
    const creado = await sesion.crear(MAESTRA);
    expect(creado.ok).toBe(true);

    const alta = await sesion.agregar({
      etiqueta: ETIQUETA,
      grupoNombre: GRUPO,
      apiKey: credencialReal.apiKey,
      secretKey: credencialReal.secretKey,
      passphrase: credencialReal.passphrase
    });

    if (!alta.ok) {
      throw new Error(`Bitget no acepto la credencial real: ${alta.motivo ?? 'sin motivo'}`);
    }

    expect(alta.veredicto).toBe('valida');
    expect(alta.cuenta?.estado).toBe('conectada');

    /* Lo que sale hacia el renderer va enmascarado, incluso en el camino feliz. */
    expect(alta.cuenta?.apiKeyEnmascarada).not.toContain(credencialReal.secretKey);
    expect(alta.cuenta?.apiKeyEnmascarada).toContain('•');

    console.log(`
  cuenta dada de alta .. ${alta.cuenta?.etiqueta} (${alta.cuenta?.apiKeyEnmascarada})
  estado ............... ${alta.cuenta?.estado}
  advertencias ......... ${alta.advertencias.length === 0 ? 'ninguna' : ''}${alta.advertencias
    .map((a) => `\n    - [${a.codigo}] ${a.mensaje}`)
    .join('')}`);
  });

  it('no deja ningun secreto en texto plano en el disco', async () => {
    const cuentas = await readFile(rutaCuentas, 'utf8');
    const vault = await readFile(rutaVault);

    /* La pregunta literal del auditor sobre cuentas.json. */
    expect(cuentas).not.toContain(credencialReal.secretKey);
    expect(cuentas).not.toContain(credencialReal.passphrase);
    expect(cuentas).not.toContain(credencialReal.apiKey);

    /* Y el vault esta cifrado de verdad: el secreto no aparece en sus bytes. */
    const bytes = vault.toString('binary');
    expect(bytes).not.toContain(credencialReal.secretKey);
    expect(bytes).not.toContain(credencialReal.passphrase);

    console.log(`
  cuentas.json ......... ${cuentas.length} bytes, sin secretos
  vault.enc ............ ${vault.length} bytes, cifrado`);
  });

  it('conserva la cuenta al cerrar y volver a abrir el panel', async () => {
    sesion.cerrar();
    expect(sesion.listar()).toEqual([]);

    /* Una sesion nueva sobre los mismos archivos: como reabrir el programa. */
    const otra = new Sesion({ vault: rutaVault, cuentas: rutaCuentas }, cliente);
    const abierto = await otra.abrir(MAESTRA);
    expect(abierto.ok).toBe(true);

    const filas = otra.listar();
    expect(filas).toHaveLength(1);
    expect(filas[0]?.etiqueta).toBe(ETIQUETA);

    /*
     * Y arranca sin estado de conexion heredado: el panel no pinta de verde una
     * cuenta que lleva horas sin comprobarse. RF-002.
     */
    expect(filas[0]?.estado).toBe('desconectada');

    sesion = otra;
  });

  it('el supervisor reconecta la cuenta sin que nadie pulse nada', async () => {
    /*
     * Esta es la prueba del disparador de reconexion contra la API real. Tras
     * abrir, la cuenta figura como pendiente de reintento; un ciclo del
     * supervisor la verifica contra Bitget y debe dejarla conectada, sin
     * intervencion del operador. RNF-004.
     */
    expect(sesion.pendientesDeReintento()).toHaveLength(1);

    const supervisor = new SupervisorReconexion(sesion);
    await supervisor.ciclo();

    expect(sesion.listar()[0]?.estado).toBe('conectada');
    /* Ya conectada, deja de figurar como pendiente: no hay bucle infinito. */
    expect(sesion.pendientesDeReintento()).toEqual([]);
  });

  it('con el panel bloqueado el supervisor no toca nada', async () => {
    sesion.cerrar();

    const supervisor = new SupervisorReconexion(sesion);
    await supervisor.ciclo();

    /* Sin vault abierto no hay credencial que probar, y no se inventa un fallo. */
    expect(sesion.pendientesDeReintento()).toEqual([]);
    expect(supervisor.enCurso).toEqual([]);
  });
});
