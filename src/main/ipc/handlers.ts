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
import { app, dialog, ipcMain } from 'electron';
import Decimal from 'decimal.js';
import { z } from 'zod';
import {
  CUENTAS_MADRE_MAX,
  NOMBRES_CUENTA_MADRE,
  PLAN_VIGENCIA_MS,
  RANURAS_ACTIVO,
  SUBCUENTAS_POR_GRUPO
} from '@shared/constants';
import type {
  EstadoApp,
  InfoSistema,
  PlanAperturaIpc,
  PlanApalancamientoIpc,
  PlanCierreIpc,
  PlanMargenIpc,
  PlanQuitarTpIpc,
  PlanTakeProfitIpc,
  ResultadoImportacionIpc
} from '@shared/ipc-contract';
import type { PosicionMonitor } from '@shared/types';
import { UNIDAD_OPERACION } from '../domain/dimension-orden';
import type {
  PlanApalancamiento,
  PlanApertura,
  PlanCierre,
  PlanMargen,
  PlanQuitarTakeProfit,
  PlanTakeProfit
} from '../execution/motor-lotes';
import { carpetaDatos, esPortable, rutas } from '../storage/paths';
import { importarCredenciales } from '../storage/importar-credenciales';
import { fijarNumeroPanel, type Instancia } from '../storage/instancia';
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
  modoMargen: plan.modoMargen,
  margenAdicional: plan.margenAdicional,
  margenAdicionalTotal: importe(
    plan.margenAdicional === null
      ? '0'
      : new Decimal(plan.margenAdicional).times(plan.entradas.length).toFixed()
  ),
  takeProfitPorcentaje: plan.takeProfitPorcentaje,
  entradas: plan.entradas.map((e) => ({
    cuentaId: e.cuentaId,
    etiqueta: e.etiqueta,
    lado: e.lado,
    size: e.size,
    nocional: importe(e.nocional),
    margenReal: importe(e.margenReal),
    /*
     * El precio de disparo NO pasa por `importe`: es un precio, no una cifra de
     * dinero de la cuenta, y truncarlo a dos decimales lo destruiria en los
     * activos de precio pequeño -PEPE cotiza en 0,0000026-.
     */
    precioDisparoTp: e.precioDisparoTp,
    modoMargenActual: e.modoMargenActual
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
  impedimento:
    plan.impedimento === null
      ? null
      : {
          codigo: plan.impedimento.codigo,
          mensaje: plan.impedimento.mensaje,
          casillas: plan.impedimento.casillas
        },
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
    plan.entradas
      .reduce((total, e) => total.plus(e.margenLiberado ?? '0'), new Decimal(0))
      .toFixed()
  ),
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

/**
 * El plan de Take Profit, con los precios concretos que el operador aprueba.
 *
 * `precioDisparoAnterior` viaja porque este plan **sustituye** lo que hubiera
 * puesto: sin el, la confirmacion diria «TP a 0,00271» sin decir que con eso se
 * quita el de 0,00263 que la posicion ya tenia.
 */
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
    movimientoPorcentaje: e.movimientoPorcentaje,
    precioDisparoAnterior: e.precioDisparoAnterior
  })),
  descartes: descartesDe(plan),
  creadoEn: plan.creadoEn
});

/**
 * El plan de margen, con lo que tiene cada posicion y lo que tendra.
 *
 * `cantidad` sale sin signo y `direccion` dice hacia donde va: la pantalla pone
 * el verbo -«agrega» o «retira»-, no interpreta un menos. Ver `PlanMargen`.
 */
const aVistaMargen = (plan: PlanMargen): PlanMargenIpc => ({
  id: plan.id,
  mercado: plan.mercado.clave,
  monedaMargen: plan.mercado.marginCoin,
  simbolo: plan.simbolo,
  cantidad: plan.cantidad,
  direccion: plan.direccion,
  totalComprometido: importe(plan.totalComprometido),
  entradas: plan.entradas.map((e) => ({
    cuentaId: e.cuentaId,
    etiqueta: e.etiqueta,
    lado: e.lado,
    /* Sin signo tambien por casilla: el sentido ya lo lleva el plan. */
    cantidad: plan.cantidad,
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

/**
 * El alta de una subcuenta, con la cuenta principal y la casilla acotadas.
 *
 * Las dos dejaron de ser texto libre el 28/08/2026. La cuenta principal es una
 * de las quince del panel -de la `A` a la `O`- y no un nombre que se teclea: con
 * el campo abierto, «A» y «a » creaban dos cuentas principales distintas y el
 * tope de quince se gastaba en duplicados. La casilla es un numero de 1 a 20 y
 * se comprueba aqui porque es un indice que llega de fuera.
 *
 * `RegistroCuentas` sigue aceptando cualquier nombre a proposito: los registros
 * de antes de esa fecha traen los que se escribieron entonces y tienen que
 * seguir cargando. Lo que se cierra es la puerta por la que entran los nuevos.
 */
const esquemaAlta = z.object({
  etiqueta: z.string().min(1).max(64),
  grupoNombre: z.string().refine((n) => NOMBRES_CUENTA_MADRE.includes(n), {
    message: `La cuenta principal debe ser una de las ${CUENTAS_MADRE_MAX}: de la A a la ${NOMBRES_CUENTA_MADRE.at(-1) ?? 'O'}.`
  }),
  casilla: z.number().int().min(1).max(SUBCUENTAS_POR_GRUPO),
  apiKey: z.string().min(1).max(256),
  secretKey: z.string().min(1).max(256),
  passphrase: z.string().min(1).max(256)
});

const esquemaId = z.string().min(1).max(128);

/**
 * Alta de una cuenta principal.
 *
 * Sin `grupoNombre` ni `casilla`: una cuenta madre no ocupa fila en el panel,
 * no se opera y no compite por las casillas de un grupo. Lo unico que se le
 * pide es un nombre para reconocerla y sus tres claves.
 */
/**
 * Peticion de traspaso.
 *
 * El importe entra como **cadena**, no como numero: un `number` en JavaScript
 * no puede representar exactamente 0.1, y aqui la cifra es dinero. Se valida su
 * forma -digitos y un punto- y el resto lo comprueba el planificador contra el
 * maximo transferible que reporta Bitget.
 */
const esquemaTraspaso = z.object({
  uidOrigen: z.string().min(1).max(64),
  uidDestino: z.string().min(1).max(64),
  importe: z
    .string()
    .min(1)
    .max(32)
    .regex(/^\d+(\.\d+)?$/, 'El importe debe ser un numero.'),
  uidMadre: z.string().min(1).max(64).optional()
});

/**
 * Peticion de reparto masivo.
 *
 * El tope de destinos es el de subcuentas que puede tener una cuenta principal
 * en el panel. No es una defensa contra el operador -no puede elegir mas de las
 * que ve- sino contra una lista manipulada que hiciera al panel enviar miles de
 * traspasos en serie.
 */
const esquemaReparto = z.object({
  destinos: z
    .array(z.string().min(1).max(64))
    .min(1)
    .max(CUENTAS_MADRE_MAX * SUBCUENTAS_POR_GRUPO),
  total: z
    .string()
    .min(1)
    .max(32)
    .regex(/^\d+(\.\d+)?$/, 'El importe debe ser un numero.'),
  modo: z.enum(['iguales', 'igualar']),
  uidMadre: z.string().min(1).max(64).optional()
});

const esquemaRecogida = z.object({
  origenes: z
    .array(z.string().min(1).max(64))
    .min(1)
    .max(CUENTAS_MADRE_MAX * SUBCUENTAS_POR_GRUPO),
  uidMadre: z.string().min(1).max(64).optional()
});

const esquemaAltaMadre = z.object({
  etiqueta: z.string().min(1).max(64),
  apiKey: z.string().min(1).max(256),
  secretKey: z.string().min(1).max(256),
  passphrase: z.string().min(1).max(256)
});

const esquemaObjetivo = z.object({
  cuentaId: z.string().min(1).max(128),
  lado: z.enum(['long', 'short'])
});

/**
 * Que casilla de activo se edita, y con que.
 *
 * El indice se acota aqui y no solo en la sesion porque es un indice de array
 * que llega de fuera. `null` es vaciar la casilla, que es una operacion legitima
 * y no un valor ausente; el simbolo se comprueba despues contra el catalogo del
 * exchange, que es lo unico que puede decir si existe.
 */
const esquemaRanura = z
  .number()
  .int()
  .min(0)
  .max(RANURAS_ACTIVO - 1);
const esquemaSimboloRanura = z.string().min(1).max(32).nullable();

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
  precioLimite: z.string().max(32).nullable(),
  /*
   * El modo de margen si viene del renderer, a diferencia del mercado.
   *
   * No es una contradiccion con lo anterior: el mercado decide si las ordenes
   * mueven dinero de verdad y por eso lo fija la maquina, mientras que aislado
   * o cruzado es una decision de trading que el operador toma en cada
   * operacion. El enum lo acota a los dos valores que Bitget acepta.
   */
  modoMargen: z.enum(['isolated', 'crossed']),
  /* El margen adicional de la misma confirmacion. */
  margenAdicional: z.string().max(32).nullable(),
  /* El Take Profit de la misma confirmacion. El precio lo calcula el proceso principal. */
  takeProfitPorcentaje: z.string().max(16).nullable()
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

/**
 * El ajuste de margen, con la direccion aparte de la cifra.
 *
 * `cantidad` no acepta el signo: el esquema exige un decimal positivo y quien
 * decide si suma o resta es `direccion`, que solo tiene dos valores. Asi un
 * payload mal formado no puede convertir en silencio un aporte en una retirada
 * -que es la que acerca la liquidacion-, ni siquiera si la pantalla falla.
 */
const esquemaMargen = z.object({
  simbolo: z.string().min(1).max(32),
  objetivos: z.array(esquemaObjetivo).min(1).max(500),
  cantidad: z
    .string()
    .min(1)
    .max(32)
    .regex(/^\d+(\.\d+)?$/, 'El margen debe ser un número positivo, sin signo.'),
  direccion: z.enum(['agregar', 'quitar'])
});

const esquemaApalancamiento = z.object({
  simbolo: z.string().min(1).max(32),
  objetivos: z.array(esquemaObjetivo).min(1).max(500),
  apalancamiento: z.number().positive().max(200)
});

/**
 * Cuanto puede valer el numero de panel.
 *
 * Es un rotulo, no un indice: no hay tabla que dimensione ni archivo que se
 * nombre con el. El tope de seis cifras es el del campo de la cabecera, y esta
 * aqui para que no entre por IPC algo que la pantalla no deja teclear.
 */
const esquemaNumeroPanel = z.number().int().min(1).max(999_999);

export function registrarIpc(
  sesion: Sesion,
  instancia: Instancia,
  mercado: 'real' | 'simulado',
  /** `instancia.json`: donde se guarda el numero cuando el operador lo cambia. */
  rutaInstancia: string
): void {
  ipcMain.handle('sistema:info', (): InfoSistema => ({
    appVersion: app.getVersion(),
    instanciaId: instancia.id,
    instanciaNombre: instancia.nombre,
    numeroPanel: instancia.numero,
    mercado,
    portable: esPortable(),
    carpetaDatos: carpetaDatos(),
    electron: process.versions.electron,
    node: process.versions.node
  }));

  ipcMain.handle('sistema:estado', (): Promise<EstadoApp> => sesion.estadoApp());

  ipcMain.handle('sistema:numero-panel', (_e, numero: unknown) =>
    fijarNumeroPanel(rutaInstancia, instancia, esquemaNumeroPanel.parse(numero))
  );

  /*
   * Traer las credenciales de una instalacion anterior.
   *
   * El dialogo de carpeta se abre **aqui**, en el proceso principal: el renderer
   * no puede elegir una ruta ni mandarla: solo puede pedir que se abra el
   * selector. Asi una pantalla comprometida no puede senalar una carpeta a su
   * antojo, que es la unica forma de que este canal tocara archivos que nadie
   * eligio.
   *
   * Y por eso tampoco recibe parametros. Ver `importar-credenciales.ts` para las
   * tres reglas, empezando por la que importa: no se pisa un almacen existente.
   */
  ipcMain.handle('credenciales:importar', async (): Promise<ResultadoImportacionIpc> => {
    const eleccion = await dialog.showOpenDialog({
      title: 'Elija la carpeta de datos del panel anterior',
      properties: ['openDirectory'],
      buttonLabel: 'Importar credenciales'
    });

    if (eleccion.canceled || eleccion.filePaths[0] === undefined) {
      return { cancelado: true, ok: false, motivo: null, mensaje: '', cuentas: null };
    }

    const r = rutas();
    return {
      cancelado: false,
      ...(await importarCredenciales(eleccion.filePaths[0], {
        base: r.base,
        vault: r.vault,
        vaultBak: r.vaultBak,
        cuentas: r.cuentas,
        activos: r.activos
      }))
    };
  });

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
  /*
   * La baja lleva la contrasena de paso, y no es opcional en el canal.
   *
   * `esquemaContrasena` exige al menos un caracter, asi que una llamada sin
   * clave -o con la cadena vacia- ni siquiera llega a `Sesion.eliminar`: revienta
   * aqui, que es donde se acota todo lo que entra de fuera. La comprobacion de si
   * **es** la correcta la hace la sesion, que es quien tiene el almacen abierto.
   */
  ipcMain.handle('cuentas:eliminar', (_e, cuentaId: unknown, contrasenaPaso: unknown) =>
    sesion.eliminar(esquemaId.parse(cuentaId), esquemaContrasena.parse(contrasenaPaso))
  );
  ipcMain.handle('cuentas:verificar', (_e, cuentaId: unknown) =>
    sesion.verificar(esquemaId.parse(cuentaId))
  );

  ipcMain.handle('panel:cuentas', () => sesion.cuentasPanel());

  /*
   * Cuentas madre y saldos de sus subcuentas. Fase 2 de los traspasos.
   *
   * La baja lleva contrasena de paso por el mismo motivo que la de una
   * subcuenta, y con mas razon: es la clave que puede mover saldo entre todas.
   * `saldos:leer` es la unica que sale a la red, y su cupo es de 1 peticion cada
   * 10 s por UID: se llama al abrir la pantalla y al refrescar, nunca en bucle.
   */
  ipcMain.handle('madres:listar', () => sesion.listarMadres());
  ipcMain.handle('madres:agregar', (_e, alta: unknown) =>
    sesion.agregarMadre(esquemaAltaMadre.parse(alta))
  );
  ipcMain.handle('madres:eliminar', (_e, uidMadre: unknown, contrasenaPaso: unknown) =>
    sesion.eliminarMadre(esquemaId.parse(uidMadre), esquemaContrasena.parse(contrasenaPaso))
  );
  ipcMain.handle('saldos:leer', (_e, uidMadre: unknown) =>
    sesion.saldosSubcuentas(uidMadre === undefined ? undefined : esquemaId.parse(uidMadre))
  );

  /*
   * Traspaso, en dos pasos. Planificar no envia nada; ejecutar si.
   *
   * `traspaso:ejecutar` recibe el id del plan y la contrasena de paso, nunca un
   * importe: los numeros ya viajaron en el plan que el operador aprobo, y
   * volver a aceptarlos aqui permitiria enviar algo distinto de lo aprobado.
   */
  ipcMain.handle('traspaso:planificar', (_e, peticion: unknown) =>
    sesion.planificarTraspaso(esquemaTraspaso.parse(peticion))
  );
  ipcMain.handle('traspaso:ejecutar', (_e, planId: unknown, contrasenaPaso: unknown) =>
    sesion.ejecutarTraspaso(esquemaId.parse(planId), esquemaContrasena.parse(contrasenaPaso))
  );
  ipcMain.handle('traspaso:historial', (_e, limite: unknown) =>
    sesion.historialTraspasos(typeof limite === 'number' ? limite : undefined)
  );

  ipcMain.handle('reparto:planificar', (_e, peticion: unknown) =>
    sesion.planificarReparto(esquemaReparto.parse(peticion))
  );
  ipcMain.handle('recogida:planificar', (_e, peticion: unknown) =>
    sesion.planificarRecogida(esquemaRecogida.parse(peticion))
  );
  ipcMain.handle('reparto:ejecutar', (_e, planId: unknown, contrasenaPaso: unknown) =>
    sesion.ejecutarReparto(esquemaId.parse(planId), esquemaContrasena.parse(contrasenaPaso))
  );

  /*
   * Las ocho casillas del selector, y el catalogo con el que se editan.
   *
   * `mercado:activos` -la lista fija de ocho- se retiro el 28/08/2026: ahora las
   * casillas se pueden cambiar, asi que lo que la pantalla necesita es la lista
   * **con sus huecos** y en su orden. Un canal que sigue existiendo se puede
   * seguir llamando, y este devolveria una foto sin las casillas vacias.
   */
  ipcMain.handle('mercado:ranuras', () => sesion.ranuras());
  ipcMain.handle('mercado:catalogo', () => sesion.catalogo());
  ipcMain.handle('mercado:fijar-ranura', (_e, indice: unknown, simbolo: unknown) =>
    sesion.fijarRanura(esquemaRanura.parse(indice), esquemaSimboloRanura.parse(simbolo))
  );
  ipcMain.handle('mercado:precios', () => sesion.precios());

  ipcMain.handle('paso:hay', () => sesion.hayPaso());
  ipcMain.handle('paso:comprobar', (_e, contrasena: unknown) =>
    sesion.comprobarPaso(esquemaContrasena.parse(contrasena))
  );
  ipcMain.handle('paso:fijar', (_e, contrasena: unknown) =>
    sesion.fijarPaso(esquemaContrasena.parse(contrasena))
  );

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

  /*
   * La foto inicial del monitor. Lo que la mantiene al dia despues es el evento
   * `monitor:posiciones`, que publica index.ts.
   */
  ipcMain.handle('monitor:instantanea', (): PosicionMonitor[] => sesion.posicionesMonitor());
}
