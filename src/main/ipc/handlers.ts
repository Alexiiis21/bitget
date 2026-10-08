/**
 * Registro de los canales de IPC.
 *
 * Cada canal declarado en el contrato se ata aqui a una operacion de `Sesion`,
 * y nada mas. Este archivo no tiene logica: si empieza a tenerla, es que se
 * esta filtrando dominio a la capa de transporte.
 *
 * Los argumentos que llegan del renderer se validan antes de usarse. El
 * renderer es nuestro, pero es tambien la unica superficie que un fallo de la
 * pagina podria manipular, y una cadena donde se espera un objeto no debe
 * llegar viva hasta el vault. docs/02-arquitectura.html.
 */
import { app, ipcMain } from 'electron';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { PLAN_VIGENCIA_MS } from '@shared/constants';
import type {
  EstadoApp,
  InfoSistema,
  PlanAperturaIpc,
  PlanApalancamientoIpc,
  PlanCierreIpc,
  PlanMargenIpc,
  PlanQuitarTpIpc,
  PlanTakeProfitIpc
} from '@shared/ipc-contract';
import type { FilaMonitor } from '@shared/types';
import { UNIDAD_OPERACION } from '../domain/dimension-orden';
import type {
  PlanApalancamiento,
  PlanApertura,
  PlanCierre,
  PlanMargen,
  PlanQuitarTakeProfit,
  PlanTakeProfit
} from '../execution/motor-lotes';
import { carpetaDatos, esPortable } from '../storage/paths';
import type { Instancia } from '../storage/instancia';
import type { Sesion } from './sesion';

/**
 * Un importe de dinero, listo para ensenarse.
 *
 * Dos decimales y **truncado**, nunca redondeado: es la misma regla que sigue
 * `dimensionarApertura` al calcular la cantidad. Un importe redondeado hacia
 * arriba le diria al operador que compromete 10,00 donde compromete 9,99, y de
 * los dos errores posibles ese es el que le hace aprobar algo que no es.
 *
 * Solo afecta a lo que se mira. La cantidad que viaja en la orden es `size`, que
 * sale intacto, y el plan de verdad -con sus decimales completos- se queda en el
 * proceso principal.
 */
const importe = (v: string | null): string =>
  v === null ? '0.00' : new Decimal(v || '0').toDecimalPlaces(2, Decimal.ROUND_DOWN).toFixed(2);

/**
 * El plan, recortado a lo que la pantalla necesita ver.
 *
 * Se deja fuera el `clientOid` de cada entrada: no aporta nada a quien mira la
 * confirmacion y es un identificador de orden real. Para reintentar basta con
 * la cuenta y el lado; la traduccion a identificadores la hace la sesion.
 *
 * `monedaMargen` viaja con el plan porque cada cifra de dinero de la
 * confirmacion se ensena con su moneda al lado, y esa moneda la decide el
 * mercado -USDT o SUSDT-, no la pantalla.
 */
const aVista = (plan: PlanApertura): PlanAperturaIpc => ({
  id: plan.id,
  mercado: plan.mercado.clave,
  monedaMargen: plan.mercado.marginCoin,
  simbolo: plan.simbolo,
  apalancamiento: plan.apalancamiento,
  precioLimite: plan.precioLimite,
  precioReferencia: plan.precioReferencia,
  margenInicial: plan.margenInicial,
  unidad: UNIDAD_OPERACION,
  entradas: plan.entradas.map((e) => ({
    cuentaId: e.cuentaId,
    etiqueta: e.etiqueta,
    lado: e.lado,
    size: e.size,
    nocional: importe(e.nocional),
    margenReal: importe(e.margenReal)
  })),
  descartes: plan.descartes.map((d) => ({
    cuentaId: d.cuentaId,
    etiqueta: d.etiqueta,
    lado: d.lado,
    motivo: d.motivo,
    mensaje: d.mensaje
  })),
  avisos: plan.avisos.map((a) => ({
    cuentaId: a.cuentaId,
    etiqueta: a.etiqueta,
    lado: a.lado,
    codigo: a.codigo,
    mensaje: a.mensaje
  })),
  margenTotal: importe(
    plan.entradas.reduce((total, e) => total.plus(e.margenReal), new Decimal(0)).toFixed()
  ),
  creadoEn: plan.creadoEn,
  expiraEn: new Date(Date.parse(plan.creadoEn) + PLAN_VIGENCIA_MS).toISOString()
});

/**
 * El plan de cierre, recortado igual que el de apertura.
 *
 * `margenLiberadoTotal` se suma aqui y no en la pantalla porque es dinero: la
 * aritmetica de cantidades monetarias pasa por decimal.js en el proceso
 * principal, nunca por la coma flotante del renderer. docs/03 seccion 14.
 */
const aVistaCierre = (plan: PlanCierre): PlanCierreIpc => ({
  id: plan.id,
  mercado: plan.mercado.clave,
  monedaMargen: plan.mercado.marginCoin,
  simbolo: plan.simbolo,
  entradas: plan.entradas.map((e) => ({
    cuentaId: e.cuentaId,
    etiqueta: e.etiqueta,
    lado: e.lado,
    size: e.size,
    precioEntrada: e.precioEntrada,
    margenLiberado: e.margenLiberado === null ? null : importe(e.margenLiberado)
  })),
  descartes: plan.descartes.map((d) => ({
    cuentaId: d.cuentaId,
    etiqueta: d.etiqueta,
    lado: d.lado,
    motivo: d.motivo,
    mensaje: d.mensaje
  })),
  margenLiberadoTotal: importe(
    plan.entradas.reduce((total, e) => total.plus(e.margenLiberado ?? '0'), new Decimal(0)).toFixed()
  ),
  creadoEn: plan.creadoEn
});

/** El plan de Take Profit, con los precios concretos que el operador aprueba. */
const aVistaTp = (plan: PlanTakeProfit): PlanTakeProfitIpc => ({
  id: plan.id,
  mercado: plan.mercado.clave,
  simbolo: plan.simbolo,
  porcentaje: plan.porcentaje,
  entradas: plan.entradas.map((e) => ({
    cuentaId: e.cuentaId,
    etiqueta: e.etiqueta,
    lado: e.lado,
    precioDisparo: e.precioDisparo,
    precioEntrada: e.precioEntrada,
    apalancamiento: e.apalancamiento,
    movimientoPorcentaje: e.movimientoPorcentaje
  })),
  descartes: plan.descartes.map((d) => ({
    cuentaId: d.cuentaId,
    etiqueta: d.etiqueta,
    lado: d.lado,
    motivo: d.motivo,
    mensaje: d.mensaje
  })),
  creadoEn: plan.creadoEn
});

/** Lo que hay puesto ahora, para que el operador apruebe quitar algo concreto. */
const aVistaQuitarTp = (plan: PlanQuitarTakeProfit): PlanQuitarTpIpc => ({
  id: plan.id,
  mercado: plan.mercado.clave,
  simbolo: plan.simbolo,
  entradas: plan.entradas.map((e) => ({
    cuentaId: e.cuentaId,
    etiqueta: e.etiqueta,
    lado: e.lado,
    precioDisparo: e.precioDisparo
  })),
  descartes: plan.descartes.map((d) => ({
    cuentaId: d.cuentaId,
    etiqueta: d.etiqueta,
    lado: d.lado,
    motivo: d.motivo,
    mensaje: d.mensaje
  })),
  creadoEn: plan.creadoEn
});

const descartesDe = (plan: { descartes: PlanApertura['descartes'] }) =>
  plan.descartes.map((d) => ({
    cuentaId: d.cuentaId,
    etiqueta: d.etiqueta,
    lado: d.lado,
    motivo: d.motivo,
    mensaje: d.mensaje
  }));

const aVistaMargen = (plan: PlanMargen): PlanMargenIpc => ({
  id: plan.id,
  mercado: plan.mercado.clave,
  monedaMargen: plan.mercado.marginCoin,
  simbolo: plan.simbolo,
  cantidad: plan.cantidad,
  totalComprometido: importe(plan.totalComprometido),
  entradas: plan.entradas.map((e) => ({
    cuentaId: e.cuentaId,
    etiqueta: e.etiqueta,
    lado: e.lado,
    cantidad: e.cantidad,
    margenActual: importe(e.margenActual),
    margenResultante: importe(e.margenResultante)
  })),
  descartes: descartesDe(plan),
  creadoEn: plan.creadoEn
});

const aVistaApalancamiento = (plan: PlanApalancamiento): PlanApalancamientoIpc => ({
  id: plan.id,
  mercado: plan.mercado.clave,
  simbolo: plan.simbolo,
  apalancamiento: plan.apalancamiento,
  entradas: plan.entradas.map((e) => ({
    cuentaId: e.cuentaId,
    etiqueta: e.etiqueta,
    lado: e.lado,
    apalancamiento: e.apalancamiento,
    apalancamientoActual: e.apalancamientoActual
  })),
  descartes: descartesDe(plan),
  creadoEn: plan.creadoEn
});

const esquemaContrasena = z.string().min(1).max(1024);

const esquemaAlta = z.object({
  etiqueta: z.string().min(1).max(64),
  grupoNombre: z.string().min(1).max(64),
  apiKey: z.string().min(1).max(256),
  secretKey: z.string().min(1).max(256),
  passphrase: z.string().min(1).max(256)
});

const esquemaId = z.string().min(1).max(128);

/* El valor se valida de verdad en `domain/tope-margen.ts`; aqui solo la forma. */
const esquemaTope = z.string().min(1).max(32);

const esquemaObjetivo = z.object({
  cuentaId: z.string().min(1).max(128),
  lado: z.enum(['long', 'short'])
});

/**
 * Lo que la pantalla puede pedir de una apertura.
 *
 * Repare en lo que **no** esta: ni el mercado, ni el precio, ni la cantidad.
 * Esos tres los pone el proceso principal. Aceptarlos del renderer permitiria
 * que un fallo de la pagina mandara al mercado real una cantidad que nadie
 * calculo.
 */
const esquemaApertura = z.object({
  simbolo: z.string().min(1).max(32),
  objetivos: z.array(esquemaObjetivo).min(1).max(500),
  margenInicial: z.string().min(1).max(32),
  apalancamiento: z.number().positive().max(200),
  precioLimite: z.string().max(32).nullable()
});

/* Cerrar no lleva cantidad ni precio: se cierra lo que haya. */
const esquemaCierre = z.object({
  simbolo: z.string().min(1).max(32),
  objetivos: z.array(esquemaObjetivo).min(1).max(500)
});

/* El Take Profit lleva porcentaje; el precio lo calcula el proceso principal. */
const esquemaTp = z.object({
  simbolo: z.string().min(1).max(32),
  objetivos: z.array(esquemaObjetivo).min(1).max(500),
  porcentaje: z.string().min(1).max(16)
});

const esquemaMargen = z.object({
  simbolo: z.string().min(1).max(32),
  objetivos: z.array(esquemaObjetivo).min(1).max(500),
  cantidad: z.string().min(1).max(32)
});

const esquemaApalancamiento = z.object({
  simbolo: z.string().min(1).max(32),
  objetivos: z.array(esquemaObjetivo).min(1).max(500),
  apalancamiento: z.number().positive().max(200)
});

export function registrarIpc(sesion: Sesion, instancia: Instancia, mercado: 'real' | 'simulado'): void {
  ipcMain.handle(
    'sistema:info',
    (): InfoSistema => ({
      appVersion: app.getVersion(),
      instanciaId: instancia.id,
      instanciaNombre: instancia.nombre,
      numeroPanel: instancia.numero,
      mercado,
      portable: esPortable(),
      carpetaDatos: carpetaDatos(),
      electron: process.versions.electron,
      node: process.versions.node
    })
  );

  ipcMain.handle('sistema:estado', (): Promise<EstadoApp> => sesion.estadoApp());

  ipcMain.handle('vault:estado', () => sesion.estadoVault());
  ipcMain.handle('vault:crear', (_e, contrasena: unknown) =>
    sesion.crear(esquemaContrasena.parse(contrasena))
  );
  ipcMain.handle('vault:abrir', (_e, contrasena: unknown) =>
    sesion.abrir(esquemaContrasena.parse(contrasena))
  );
  ipcMain.handle('vault:cerrar', () => {
    sesion.cerrar();
  });
  ipcMain.handle('vault:comprobar', (_e, contrasena: unknown) =>
    sesion.comprobarMaestra(esquemaContrasena.parse(contrasena))
  );

  ipcMain.handle('cuentas:listar', () => sesion.listar());
  ipcMain.handle('cuentas:agregar', (_e, alta: unknown) => sesion.agregar(esquemaAlta.parse(alta)));
  ipcMain.handle('cuentas:eliminar', (_e, cuentaId: unknown) =>
    sesion.eliminar(esquemaId.parse(cuentaId))
  );
  ipcMain.handle('cuentas:verificar', (_e, cuentaId: unknown) =>
    sesion.verificar(esquemaId.parse(cuentaId))
  );

  ipcMain.handle('panel:cuentas', () => sesion.cuentasPanel());

  ipcMain.handle('mercado:activos', () => sesion.activos());
  ipcMain.handle('mercado:precios', () => sesion.precios());

  ipcMain.handle('paso:hay', () => sesion.hayPaso());
  ipcMain.handle('paso:comprobar', (_e, contrasena: unknown) =>
    sesion.comprobarPaso(esquemaContrasena.parse(contrasena))
  );
  ipcMain.handle('paso:fijar', (_e, contrasena: unknown) =>
    sesion.fijarPaso(esquemaContrasena.parse(contrasena))
  );

  ipcMain.handle('tope:estado', () => sesion.estadoTopeMargen());
  ipcMain.handle('tope:fijar', (_e, valor: unknown) => sesion.fijarTopeMargen(esquemaTope.parse(valor)));

  ipcMain.handle('apertura:planificar', async (_e, peticion: unknown) => {
    const plan = await sesion.planificarApertura(esquemaApertura.parse(peticion));
    return aVista(plan);
  });

  ipcMain.handle('apertura:ejecutar', (_e, planId: unknown, soloEstos: unknown) =>
    sesion.ejecutarApertura(
      esquemaId.parse(planId),
      soloEstos === undefined || soloEstos === null
        ? undefined
        : z.array(esquemaObjetivo).parse(soloEstos)
    )
  );

  ipcMain.handle('cierre:planificar', async (_e, peticion: unknown) => {
    const plan = await sesion.planificarCierre(esquemaCierre.parse(peticion));
    return aVistaCierre(plan);
  });

  ipcMain.handle('cierre:ejecutar', (_e, planId: unknown, soloEstos: unknown) =>
    sesion.ejecutarCierre(
      esquemaId.parse(planId),
      soloEstos === undefined || soloEstos === null
        ? undefined
        : z.array(esquemaObjetivo).parse(soloEstos)
    )
  );

  ipcMain.handle('tp:planificar', async (_e, peticion: unknown) => {
    const plan = await sesion.planificarTakeProfit(esquemaTp.parse(peticion));
    return aVistaTp(plan);
  });

  ipcMain.handle('tp:ejecutar', (_e, planId: unknown, soloEstos: unknown) =>
    sesion.ejecutarTakeProfit(
      esquemaId.parse(planId),
      soloEstos === undefined || soloEstos === null
        ? undefined
        : z.array(esquemaObjetivo).parse(soloEstos)
    )
  );

  ipcMain.handle('tp:planificar-quitar', async (_e, peticion: unknown) => {
    const plan = await sesion.planificarQuitarTakeProfit(esquemaCierre.parse(peticion));
    return aVistaQuitarTp(plan);
  });

  ipcMain.handle('tp:ejecutar-quitar', (_e, planId: unknown, soloEstos: unknown) =>
    sesion.ejecutarQuitarTakeProfit(
      esquemaId.parse(planId),
      soloEstos === undefined || soloEstos === null
        ? undefined
        : z.array(esquemaObjetivo).parse(soloEstos)
    )
  );

  ipcMain.handle('margen:planificar', async (_e, peticion: unknown) => {
    const plan = await sesion.planificarMargen(esquemaMargen.parse(peticion));
    return aVistaMargen(plan);
  });

  ipcMain.handle('margen:ejecutar', (_e, planId: unknown, soloEstos: unknown) =>
    sesion.ejecutarMargen(
      esquemaId.parse(planId),
      soloEstos === undefined || soloEstos === null
        ? undefined
        : z.array(esquemaObjetivo).parse(soloEstos)
    )
  );

  ipcMain.handle('apalancamiento:planificar', async (_e, peticion: unknown) => {
    const plan = await sesion.planificarApalancamiento(esquemaApalancamiento.parse(peticion));
    return aVistaApalancamiento(plan);
  });

  ipcMain.handle('apalancamiento:ejecutar', (_e, planId: unknown, soloEstos: unknown) =>
    sesion.ejecutarApalancamiento(
      esquemaId.parse(planId),
      soloEstos === undefined || soloEstos === null
        ? undefined
        : z.array(esquemaObjetivo).parse(soloEstos)
    )
  );

  /* Las posiciones llegan por WebSocket en la Fase 6. docs/00-entrega-fase-1. */
  ipcMain.handle('monitor:instantanea', (): FilaMonitor[] => []);
}
