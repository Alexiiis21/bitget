import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

/**
 * Humo de arranque: la unica prueba que ejerce los tres procesos a la vez.
 *
 * Verifica lo que ningun typecheck puede verificar: que la ventana abre, que el
 * preload expone la API y que el renderer recibe datos reales del proceso
 * principal por el contrato de IPC. Requiere `npm run build` previo.
 */
let app: ElectronApplication;
let ventana: Page;

test.beforeAll(async () => {
  app = await electron.launch({ args: ['./out/main/index.js'] });
  ventana = await app.firstWindow();
  await ventana.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
});

test('la ventana abre con el titulo del producto', async () => {
  await expect(ventana).toHaveTitle(/Panel de Control Bitget/);
});

test('el preload expone la API y no filtra Node al renderer', async () => {
  const superficie = await ventana.evaluate(() => ({
    tienePcb: typeof (window as unknown as { pcb?: unknown }).pcb === 'object',
    tieneRequire: typeof (window as unknown as { require?: unknown }).require,
    tieneProcess: typeof (window as unknown as { process?: unknown }).process
  }));

  expect(superficie.tienePcb).toBe(true);
  /* Aislamiento de contexto: el renderer no puede alcanzar Node. docs/01 seccion 2. */
  expect(superficie.tieneRequire).toBe('undefined');
  expect(superficie.tieneProcess).toBe('undefined');
});

test('el IPC responde con la informacion del sistema', async () => {
  const info = await ventana.evaluate(() => window.pcb.sistemaInfo());

  expect(info.appVersion).toBeTruthy();
  expect(info.electron).toBeTruthy();
  expect(info.carpetaDatos.length).toBeGreaterThan(0);
  expect(typeof info.portable).toBe('boolean');
});

/*
 * La comprobacion mas importante de la Fase 4: un panel recien instalado opera
 * contra el mercado simulado. Pasar a dinero real exige editar `config.json` a
 * proposito; nunca puede ser el estado por defecto ni un descuido.
 */
test('un panel nuevo arranca contra el mercado simulado, no contra dinero real', async () => {
  const info = await ventana.evaluate(() => window.pcb.sistemaInfo());
  expect(info.mercado).toBe('simulado');
});

test('los canales de apertura existen y exigen el panel abierto', async () => {
  const resultado = await ventana.evaluate(async () => {
    try {
      await window.pcb.aperturaPlanificar({
        simbolo: 'SBTCSUSDT',
        objetivos: [{ cuentaId: 'x', lado: 'long' }],
        margenInicial: '100',
        apalancamiento: 10,
        precioLimite: null,
        /*
         * El modo de margen y el margen adicional son obligatorios en el canal
         * desde el 26/08/2026. Sin ellos la peticion no llega a la sesion: la
         * rechaza el esquema, y este caso comprobaria la validacion en vez del
         * cerrojo del panel bloqueado.
         */
        modoMargen: 'isolated',
        margenAdicional: null,
        takeProfitPorcentaje: null
      });
      return 'planifico';
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  });

  /* Con el vault cerrado no se planifica nada, y el canal responde en vez de no existir. */
  expect(resultado).toContain('bloqueado');
});

/*
 * Las operaciones de la Fase 4 tienen su canal, y todas se comportan igual con
 * el panel bloqueado: responden que no, en vez de no existir. Que respondan es
 * lo que se comprueba aqui; que hagan lo correcto, las pruebas de integracion y
 * las fisicas.
 */
test('los canales de operacion existen y ninguno opera con el panel bloqueado', async () => {
  const respuestas = await ventana.evaluate(async () => {
    const objetivos = [{ cuentaId: 'x', lado: 'long' as const }];
    const intentar = async (f: () => Promise<unknown>): Promise<string> => {
      try {
        await f();
        return 'PLANIFICO';
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    };

    return {
      cierre: await intentar(() => window.pcb.cierrePlanificar({ simbolo: 'SBTCSUSDT', objetivos })),
      tp: await intentar(() =>
        window.pcb.tpPlanificar({ simbolo: 'SBTCSUSDT', objetivos, porcentaje: '35' })
      ),
      quitarTp: await intentar(() =>
        window.pcb.tpPlanificarQuitar({ simbolo: 'SBTCSUSDT', objetivos })
      ),
      /*
       * `cantidad` sin signo y `direccion` aparte: es lo que exige el esquema
       * del canal. Un `-50` aqui lo rechazaria la validacion, y entonces este
       * caso comprobaria el esquema en vez del cerrojo del panel bloqueado.
       */
      margen: await intentar(() =>
        window.pcb.margenPlanificar({
          simbolo: 'SBTCSUSDT',
          objetivos,
          cantidad: '50',
          direccion: 'agregar'
        })
      ),
      apalancamiento: await intentar(() =>
        window.pcb.apalancamientoPlanificar({ simbolo: 'SBTCSUSDT', objetivos, apalancamiento: 20 })
      )
    };
  });

  for (const [canal, mensaje] of Object.entries(respuestas)) {
    expect(mensaje, canal).toContain('bloqueado');
  }
});

/*
 * La superficie de `window.pcb`, contra el binario ya compilado.
 *
 * --------------------------------------------------------------------------
 * Esta prueba comprobaba lo contrario
 * --------------------------------------------------------------------------
 * Entre el 26/08/2026 y el 01/09/2026 exigia que los cuatro canales de ajuste
 * **no** existieran: se habian retirado porque el Take Profit y el margen
 * adicional viajan tambien dentro de la apertura, y con las dos vias abiertas la
 * misma cantidad se podia enviar dos veces sobre la misma posicion.
 *
 * Volvieron porque el cliente necesita corregir lo que ya esta abierto, y lo que
 * impide la repeticion ya no es que el canal no exista: es que el Take Profit
 * sustituye el anterior en vez de anadirse, que el margen enseña `actual →
 * resultante` antes de confirmar, y que en la pantalla los importes de la
 * apertura y los del ajuste son campos distintos. Ver `PlanKind`.
 *
 * Lo que se comprueba aqui es que la superficie es **exactamente** la declarada,
 * ni un canal de mas: un metodo que sobra en el preload es un canal que la
 * pantalla puede llamar sin que ningun tipo lo impida.
 */
test('la superficie de window.pcb es la del contrato, sin canales de sobra', async () => {
  const superficie = await ventana.evaluate(() => Object.keys(window.pcb).sort());

  expect(superficie).toEqual(
    [
      'apalancamientoEjecutar',
      'apalancamientoPlanificar',
      'aperturaEjecutar',
      'aperturaPlanificar',
      'cierreEjecutar',
      'cierrePlanificar',
      'cuentasAgregar',
      'cuentasEliminar',
      'cuentasListar',
      'cuentasVerificar',
      'margenEjecutar',
      'margenPlanificar',
      'mercadoCatalogo',
      'mercadoFijarRanura',
      'mercadoPrecios',
      'mercadoRanuras',
      'monitorInstantanea',
      'panelCuentas',
      'pasoComprobar',
      'pasoFijar',
      'pasoHay',
      'sistemaEstado',
      'sistemaFijarNumeroPanel',
      'sistemaInfo',
      'suscribir',
      'tpEjecutar',
      'tpEjecutarQuitar',
      'tpPlanificar',
      'tpPlanificarQuitar',
      'vaultAbrir',
      'vaultCerrar',
      'vaultComprobar',
      'vaultCrear',
      'vaultEstado'
    ].sort()
  );
});

/*
 * El catalogo es publico: no necesita credenciales ni almacen abierto, y por eso
 * la pantalla puede dibujar el selector de activo antes de desbloquear. Trae los
 * simbolos del mercado simulado, que es donde arranca un panel nuevo.
 *
 * --------------------------------------------------------------------------
 * Esta prueba llamaba a un canal que ya no existe
 * --------------------------------------------------------------------------
 * Pedia `mercadoActivos`, la lista fija de ocho, retirada el 28/08/2026 cuando
 * las casillas del selector pasaron a ser configurables. La sustituyen dos:
 * `mercadoCatalogo` -el catalogo entero del mercado- y `mercadoRanuras` -las
 * ocho casillas, con sus huecos y en su orden-.
 *
 * Se comprueban las dos, y no solo la que hacia falta para arreglar el rojo: lo
 * que esta prueba defiende es que el selector se puede dibujar con el panel
 * bloqueado, y eso hoy necesita las dos respuestas.
 */
test('el catalogo de activos responde con el panel aun bloqueado', async () => {
  const catalogo = await ventana.evaluate(() => window.pcb.mercadoCatalogo());

  expect(catalogo.length).toBeGreaterThan(0);
  for (const activo of catalogo) {
    expect(activo.simbolo).toContain('SUSDT');
    expect(activo.apalancamientoMax).toBeGreaterThan(0);
  }
});

test('las casillas de activo responden con el panel aun bloqueado', async () => {
  const ranuras = await ventana.evaluate(() => window.pcb.mercadoRanuras());

  /* Ocho huecos siempre, ocupados o no: es lo que dibuja el selector. */
  expect(ranuras).toHaveLength(8);
  for (const ranura of ranuras) {
    if (ranura === null) continue;
    expect(ranura.simbolo).toContain('SUSDT');
  }
});

/*
 * La contrasena de paso vive dentro del almacen cifrado. Con el panel bloqueado
 * no hay ninguna que comprobar, y la respuesta segura es «no», nunca «si».
 */
test('la contrasena de paso no deja pasar con el panel bloqueado', async () => {
  const hay = await ventana.evaluate(() => window.pcb.pasoHay());
  const acepta = await ventana.evaluate(() => window.pcb.pasoComprobar('bg1'));

  expect(hay).toBe(false);
  expect(acepta).toBe(false);
});

test('el panel arranca bloqueado, con el numero que llega por IPC', async () => {
  const info = await ventana.evaluate(() => window.pcb.sistemaInfo());

  /* Lo primero que se ve es el desbloqueo: sin contrasena no hay credenciales. */
  await expect(ventana.getByText('Contraseña maestra')).toBeVisible();
  await expect(ventana.getByText(`PCB · PANEL #${info.numeroPanel}`)).toBeVisible();
});

test('detras del bloqueo esta el panel del diseno aprobado v2', async () => {
  /*
   * `cuentas` arranca vacío hasta que se desbloquea el almacén (a diferencia
   * del diseño anterior, que precargaba datos de muestra): lo que se puede
   * verificar sin desbloquear es el armazón -encabezado y barra lateral-, no
   * el contenido de las cuentas.
   */
  await expect(ventana.getByText('Panel de Control Bitget')).toBeVisible();
  await expect(ventana.getByText('EJECUCIÓN')).toBeVisible();
  await expect(ventana.getByText('PARÁMETROS')).toBeVisible();
});
