/**
 * Alta, baja y nueva alta de una subcuenta UTA real.
 *
 * Reportado el 27/10/2026: la ELITE UTA del cliente dejo de conectarse con
 * «Credenciales invalidas · 40731». Esta prueba recorre el camino del boton
 * del panel -agregar, desconectar, volver a agregar- contra api.bitget.com con
 * la subcuenta UTA de `.env` y deja en la consola lo que contesto cada
 * superficie, para que un rechazo diga de donde viene.
 *
 * Solo lecturas: `account/settings`, `account/assets` y, si V3 dice
 * `classic`, `spot/account/info`. Escribe en una carpeta temporal.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectarModo } from '@main/bitget/deteccion-modo';
import { ClienteBitget, ErrorBitget } from '@main/bitget/rest/client';
import { obtenerInfoCuenta } from '@main/bitget/rest/endpoints/cuenta';
import { detenerBitacora, iniciarBitacora } from '@main/diagnostico/bitacora';
import { Sesion } from '@main/ipc/sesion';
import { archivoLogDeHoy } from '@main/storage/paths';
import './credenciales-reales';

const CREDENCIAL = {
  apiKey: process.env['BITGET_UTA_API_KEY'] ?? '',
  secretKey: process.env['BITGET_UTA_SECRET_KEY'] ?? '',
  passphrase: process.env['BITGET_UTA_PASSPHRASE'] ?? ''
};
const hayUta = CREDENCIAL.apiKey !== '' && CREDENCIAL.secretKey !== '';

const MAESTRA = 'contrasena-de-prueba-uta';
const PASO = 'bg1';

let carpeta: string;
let cliente: ClienteBitget;
let sesion: Sesion;

beforeAll(async () => {
  if (!hayUta) return;
  carpeta = await mkdtemp(join(tmpdir(), 'pcb-alta-uta-'));
  await iniciarBitacora(join(carpeta, 'logs'));
  cliente = new ClienteBitget();
  await cliente.sincronizarReloj();
  sesion = new Sesion(
    {
      vault: join(carpeta, 'vault.enc'),
      cuentas: join(carpeta, 'cuentas.json'),
      activos: join(carpeta, 'activos.json')
    },
    cliente
  );
  await sesion.crear(MAESTRA);
  await sesion.fijarPaso(PASO);
});

afterAll(async () => {
  if (!hayUta) return;
  sesion?.cerrar();
  await cliente?.cerrar();
  /* La bitacora va en cola: se le da un respiro antes de leerla y borrarla. */
  await new Promise((r) => setTimeout(r, 200));
  try {
    const texto = await readFile(join(carpeta, 'logs', archivoLogDeHoy()), 'utf8');
    const relevantes = texto
      .split('\n')
      .filter((l) => /deteccion-modo|verificacion-credencial|"tipo":"peticion"/.test(l));
    console.log(`--- bitacora (${relevantes.length} lineas) ---\n${relevantes.join('\n')}`);
  } catch {
    /* Sin bitacora no hay nada que ensenar. */
  }
  detenerBitacora();
  await rm(carpeta, { recursive: true, force: true });
});

describe.skipIf(!hayUta)('subcuenta UTA real', () => {
  it('la deteccion la manda a V3', async () => {
    const r = await detectarModo(cliente, CREDENCIAL);
    let v2: string;
    try {
      await obtenerInfoCuenta(cliente, { ...CREDENCIAL, superficie: 'v2' });
      v2 = 'acepta';
    } catch (e) {
      v2 = e instanceof ErrorBitget ? `${e.codigo} · ${e.mensajeOriginal ?? e.message}` : String(e);
    }
    console.log(
      `deteccion: modo=${r.modo} accountMode=${r.accountModeCrudo} holdMode=${r.holdMode} ` +
        `simbolos=${r.configSimbolos.length} · V2 spot/account/info: ${v2}`
    );
    expect(r.modo).toBe('uta');
  });

  it('agregar, desconectar y volver a agregar', async () => {
    const alta = {
      etiqueta: 'UTA prueba',
      grupoNombre: 'A',
      ...CREDENCIAL
    };

    const primera = await sesion.agregar(alta);
    console.log(`alta 1: ok=${primera.ok} motivo=${'motivo' in primera ? primera.motivo : '-'}`);
    expect(primera.ok).toBe(true);
    const id = sesion.listar()[0]?.id ?? '';
    expect(sesion.cuentaEjecutable(id)?.credencial.superficie).toBe('v3');

    expect(await sesion.eliminar(id, PASO)).toBe('borrada');
    expect(sesion.listar()).toHaveLength(0);

    const segunda = await sesion.agregar(alta);
    console.log(`alta 2: ok=${segunda.ok} motivo=${'motivo' in segunda ? segunda.motivo : '-'}`);
    expect(segunda.ok).toBe(true);
    const id2 = sesion.listar()[0]?.id ?? '';
    expect(sesion.cuentaEjecutable(id2)?.credencial.superficie).toBe('v3');

    const prueba = await sesion.verificar(id2);
    console.log(`revalidar: ${JSON.stringify(prueba).slice(0, 300)}`);
  });
});
