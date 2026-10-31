import { join } from 'node:path';
import { app, BrowserWindow, shell } from 'electron';
import {
  MOSAICO_ALTO_MIN,
  MOSAICO_ANCHO_MIN,
  PUBLICACION_COALESCIDA_MS,
  WS_TICK_MS
} from '@shared/constants';
import { entorno, esStaging, mercadoCompilado } from '@shared/entorno';
import { MERCADOS } from './bitget/mercado';
import { ClienteBitget } from './bitget/rest/client';
import { PoolSockets } from './bitget/ws/pool';
import { BarridoPosiciones } from './execution/barrido-posiciones';
import { SupervisorReconexion } from './execution/supervisor-reconexion';
import { registrarIpc } from './ipc/handlers';
import { habilitarMenuContextual } from './menu-contextual';
import { Sesion } from './ipc/sesion';
import { cargarInstancia } from './storage/instancia';
import { iniciarBitacora } from './diagnostico/bitacora';
import { carpetaRespaldos, fijarCarpetaDeEntorno, rutas } from './storage/paths';
import { programarRespaldo, type RespaldoProgramado } from './storage/respaldo-automatico';

/*
 * Lo primero de todo, antes del cerrojo de instancia unica y antes de que
 * Electron escriba nada: cada entorno tiene su propia carpeta de datos, y por
 * tanto su propio vault y su propia contraseña maestra. docs/03 seccion 3.
 */
fijarCarpetaDeEntorno();

let ventana: BrowserWindow | null = null;
let sesion: Sesion | null = null;
let cliente: ClienteBitget | null = null;
let supervisor: SupervisorReconexion | null = null;
let barrido: BarridoPosiciones | null = null;
let pool: PoolSockets | null = null;
/** El respaldo automatico. Se vacia al cerrar; ver `window-all-closed`. */
let respaldoAuto: RespaldoProgramado | null = null;

function crearVentana(): void {
  ventana = new BrowserWindow({
    width: MOSAICO_ANCHO_MIN,
    height: MOSAICO_ALTO_MIN,
    minWidth: 1280,
    minHeight: 720,
    show: false,
    backgroundColor: '#ECEEF2',
    title: 'Panel de Control Bitget',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),

      /*
       * Configuracion de seguridad no negociable. docs/01 seccion 2.
       * El renderer no puede tocar Node ni el sistema de archivos: todo pasa
       * por el contrato de IPC.
       */
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false
    }
  });

  ventana.on('ready-to-show', () => ventana?.show());

  /*
   * Cortar, copiar y pegar con el boton derecho. Una ventana de Electron no
   * trae ese menu de serie, y sin el la unica forma de pegar una API Key de 64
   * caracteres es Ctrl+V. Ver `menu-contextual.ts`.
   */
  habilitarMenuContextual(ventana);

  /* Ningun enlace abre una ventana de Electron: siempre el navegador del sistema. */
  ventana.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  /* Bloquea cualquier navegacion fuera de la propia aplicacion. */
  ventana.webContents.on('will-navigate', (evento, url) => {
    const permitida = process.env['ELECTRON_RENDERER_URL'];
    if (!permitida || !url.startsWith(permitida)) evento.preventDefault();
  });

  const urlDev = process.env['ELECTRON_RENDERER_URL'];
  if (urlDev) void ventana.loadURL(urlDev);
  else void ventana.loadFile(join(__dirname, '../renderer/index.html'));
}

/* ---------------- empuje hacia la ventana ---------------- */

/**
 * Publica la matriz cada vez que cambia algo suyo.
 *
 * El supervisor de reconexion trabaja en segundo plano y por su cuenta: sin
 * este puente, la pantalla solo se enteraria de que una cuenta volvio cuando el
 * operador hiciera algo, y hasta entonces la seguiria pintando caida -o al
 * reves, lo que es peor-. RF-002.
 *
 * Los avisos se agrupan en una ventana corta antes de enviarse. Al desbloquear,
 * cien cuentas cambian de estado en pocos segundos; sin agrupar serian cien
 * mensajes y cien redibujados para una pantalla que solo necesita el ultimo.
 */
function publicarCambios(sesion: Sesion): void {
  let pendiente: ReturnType<typeof setTimeout> | null = null;

  const enviar = (): void => {
    pendiente = null;
    if (ventana === null || ventana.isDestroyed()) return;
    ventana.webContents.send('panel:cuentas', sesion.cuentasPanel());
    void sesion.estadoApp().then(
      (estado) => {
        if (ventana !== null && !ventana.isDestroyed()) ventana.webContents.send('sistema:estado', estado);
      },
      () => undefined
    );
  };

  sesion.alCambiar(() => {
    if (pendiente !== null) return;
    pendiente = setTimeout(enviar, PUBLICACION_COALESCIDA_MS);
  });

  /*
   * El avance de un lote va sin agrupar y por su propio canal. Aqui no vale
   * esperar 250 ms: mientras cien ordenes salen, lo unico que el operador tiene
   * delante es esta barra, y es la que le dice que el panel no se ha colgado.
   */
  sesion.alProgresarLote((lote) => {
    if (ventana === null || ventana.isDestroyed()) return;
    ventana.webContents.send('lote:progreso', lote);
  });

  /* Cada revisión de alertas, para el aviso en pantalla. */
  sesion.alRevisarAlertas((revision) => {
    if (ventana === null || ventana.isDestroyed()) return;
    ventana.webContents.send('alertas:revision', revision);
  });

  /* El avance del historial, igual que el de un lote: sin agrupar. */
  sesion.alProgresarHistorial((progreso) => {
    if (ventana === null || ventana.isDestroyed()) return;
    ventana.webContents.send('historial:progreso', progreso);
  });

  /*
   * Las posiciones van por su propio canal y con su propia agrupacion, no
   * dentro de la de la matriz.
   *
   * Comparten el ritmo -250 ms- y no el temporizador a proposito: son dos
   * fuentes que cambian a ritmos muy distintos. Un socket de posiciones puede
   * empujar decenas de eventos por segundo mientras la matriz lleva minutos
   * quieta, y con un temporizador comun cada uno de esos empujones obligaria a
   * recalcular y reenviar tambien las cien filas de la matriz, que no han
   * cambiado. Separados, cada canal solo despierta por lo suyo.
   */
  let pendientePosiciones: ReturnType<typeof setTimeout> | null = null;

  sesion.alCambiarPosiciones(() => {
    if (pendientePosiciones !== null) return;
    pendientePosiciones = setTimeout(() => {
      pendientePosiciones = null;
      if (ventana === null || ventana.isDestroyed()) return;
      ventana.webContents.send('monitor:posiciones', sesion.posicionesMonitor());
    }, PUBLICACION_COALESCIDA_MS);
  });
}

/* ---------------- ciclo de vida ---------------- */

/*
 * Una sola instancia por carpeta de datos: dos procesos escribiendo el mismo
 * vault.enc es la unica forma realista de corromperlo. docs/03 seccion 3.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!ventana) return;
    if (ventana.isMinimized()) ventana.restore();
    ventana.focus();
  });

  void app.whenReady().then(async () => {
    const r = rutas();

    /*
     * Antes que nada: sin bitacora, un rechazo de Bitget es un numero sin
     * contexto. Se enciende aqui para que el arranque y la primera verificacion
     * ya queden anotados. Ver `diagnostico/bitacora.ts`.
     */
    await iniciarBitacora(undefined, app.getVersion());
    if (esStaging()) {
      console.warn(`[PCB] bitacora en: ${r.logs}`);
    }

    const instancia = await cargarInstancia(r.instancia);

    /*
     * Staging se anuncia al arrancar. Dev no: es el caso por defecto y un aviso
     * que sale siempre deja de leerse. Cuando alguien pregunte «¿esto son datos
     * reales?», la respuesta tiene que estar en el log y no en la memoria de
     * nadie.
     */
    if (esStaging()) {
      console.warn(`[PCB] entorno=${entorno()} — API real de Bitget. Datos en: ${r.base}`);
    }

    /*
     * Un solo cliente para todo el proceso: el limite de peticiones de Bitget
     * es por IP, y dos clientes con dos limitadores se pisarian el cupo.
     * docs/01 seccion 8.
     */
    /*
     * Contra que mercado opera este panel: un literal compilado, no un archivo
     * que alguien tenga que colocar. Este binario *es* de este mercado y no hay
     * nada en la carpeta de datos que pueda cambiarlo. Ver shared/entorno.ts.
     */
    const mercado = mercadoCompilado();
    if (mercado === 'real') {
      console.warn('[PCB] mercado=real — las ordenes de este panel mueven dinero de verdad.');
    }

    cliente = new ClienteBitget();
    const clienteVivo = cliente;

    /*
     * El reloj, antes de la primera firma.
     *
     * ======================================================================
     * Por que se mide al arrancar y no cuando falla algo
     * ======================================================================
     * Bitget rechaza la firma cuya marca de tiempo se aleje de la suya, y el
     * caso que lo produce en un panel de escritorio es de manual: el equipo
     * lleva dias apagado o suspendido, Windows todavia no ha resincronizado su
     * hora y el operador abre el panel. Sin esta medida, el primer sintoma son
     * **todas** las cuentas rechazadas con una credencial que esta perfecta, y
     * `Probar` devolviendo el mismo rechazo las veces que se pulse.
     *
     * No se espera a que termine: el endpoint es publico, no hay peticiones
     * firmadas hasta que alguien desbloquea el vault, y bloquear el arranque de
     * la ventana por una sonda de red seria pagar el peor caso -sin internet-
     * en todos los arranques. Si llegara tarde, `corregirReloj` la repite ante
     * el primer `40008`.
     */
    void clienteVivo.sincronizarReloj().then(
      () => {
        if (clienteVivo.relojDesviado) {
          console.warn(
            `[PCB] el reloj del equipo se desvia ${clienteVivo.desfaseActualMs} ms del de ` +
              'Bitget. Se corrige al firmar, pero conviene sincronizar la hora de Windows.'
          );
        }
      },
      (e: unknown) => {
        const detalle = e instanceof Error ? e.message : String(e);
        console.warn(`[PCB] no se pudo medir el desfase de reloj con Bitget: ${detalle}`);
      }
    );

    sesion = new Sesion(
      {
        vault: r.vault,
        cuentas: r.cuentas,
        activos: r.activos,
        intentos: r.intentos,
        historial: r.historial,
        acciones: r.acciones,
        alertas: r.alertas
      },
      cliente,
      /* El número se lee en cada aviso: si el operador lo cambia, los siguientes lo llevan. */
      { mercado, numeroPanel: () => instancia.numero }
    );

    /*
     * El reintento automatico de las cuentas caidas. Late desde el arranque y
     * no se para al bloquear el panel: mientras no haya vault abierto, cada
     * ciclo comprueba `operativa()` y no hace nada. Sin esto, `proximoIntento`
     * seria un calculo que nadie lee y una cuenta caida solo volveria si el
     * operador pulsa el boton. RNF-004.
     */
    supervisor = new SupervisorReconexion(sesion, {
      alFallar: (cuentaId, error) => {
        const detalle = error instanceof Error ? error.message : String(error);
        console.warn(`[PCB] reintento fallido en ${cuentaId}: ${detalle}`);
      }
    });
    supervisor.iniciar();

    /*
     * El barrido de posiciones, que es lo que llena el Centro de Monitoreo.
     *
     * Late desde el arranque igual que el supervisor y por el mismo motivo: con
     * el panel bloqueado cada ciclo comprueba `operativa()` y no hace nada, y en
     * cuanto se abre el vault empieza a leer sin que nadie tenga que arrancarlo.
     */
    barrido = new BarridoPosiciones(cliente, MERCADOS[mercado], sesion.almacenPosiciones, sesion);
    barrido.iniciar();

    /*
     * Un lote que termina adelanta la relectura de las cuentas que tocó.
     *
     * Es lo que hace que el saldo y las posiciones del informe sean los de
     * después de abrir y no los de antes. Sin esto habría que esperar el turno
     * normal de cada cuenta -hasta 45 segundos- con el operador delante del
     * informe comprobando que salió bien.
     *
     * Se cablea aquí, como el resto de los avisos de la sesión: ella dice qué
     * cuentas tocó y el barrido decide cuándo leerlas.
     */
    const barridoVivo = barrido;
    sesion.alTocarCuentas((cuentaIds) => barridoVivo.adelantar(cuentaIds));

    /*
     * Y el pool de sockets, que es lo que convierte «cada 45 segundos» en «al
     * instante» para las cuentas que tienen algo abierto. Las que no caben en
     * el presupuesto de 80 se quedan con el barrido y el panel lo dice: pierden
     * inmediatez, no informacion.
     */
    /*
     * Firma su login con el mismo reloj corregido que el REST. El socket manda
     * su propio `timestamp` -en segundos, ver `ws/conexion.ts`- y un equipo con
     * la hora desviada perderia tambien los sockets, con el agravante de que
     * ahi el sintoma es mudo: la cuenta cae a modo REST y sigue funcionando mas
     * lenta, sin que nada diga por que.
     */
    pool = new PoolSockets(MERCADOS[mercado], sesion.almacenPosiciones, sesion, {
      conexion: { ahora: () => clienteVivo.ahora() }
    });
    pool.iniciar();

    /*
     * El recuento de sockets vivos para la barra superior. Va por sondeo y no
     * por aviso porque no hay ningun instante concreto que publicar: lo que
     * interesa es cuanto queda del presupuesto, y eso cambia solo cuando el
     * pool revisa. `informarSockets` no anuncia nada si el numero no cambio.
     */
    const pulso = setInterval(() => sesion?.informarSockets(pool?.vivos.length ?? 0), WS_TICK_MS);
    pulso.unref();

    /*
     * El respaldo que se hace solo, cableado aqui como el resto de lo
     * transversal: la sesion avisa de que sus credenciales cambiaron y esto
     * decide que hacer con ello. Ella no sabe donde estan los Documentos del
     * operador, y no tiene por que.
     *
     * Copia bytes ya cifrados: no necesita la contrasena maestra y no puede
     * filtrar nada. Ver `respaldo-credenciales.ts`.
     */
    respaldoAuto = programarRespaldo({
      origen: { vault: r.vault, cuentas: r.cuentas, activos: r.activos },
      carpeta: carpetaRespaldos(),
      respaldo: { appVersion: app.getVersion(), entorno: entorno(), mercado, panelOrigen: instancia.numero },
      alFallar: (e) => console.warn(`[PCB] respaldo automatico fallido: ${e instanceof Error ? e.message : String(e)}`)
    });
    const auto = respaldoAuto;
    sesion.alCambiarCredenciales(() => auto.pedir());

    registrarIpc(sesion, instancia, mercado, r.instancia);
    publicarCambios(sesion);
    crearVentana();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) crearVentana();
    });
  });

  /*
   * Al cerrar se borra de memoria la clave derivada y las credenciales en
   * claro. No es cosmetico: un volcado del proceso tras el cierre no debe
   * contener las claves de cien cuentas.
   */
  app.on('window-all-closed', () => {
    /* Primero los latidos: que no arranque una lectura sobre un vault que se esta cerrando. */
    supervisor?.detener();
    barrido?.detener();
    pool?.detener();
    sesion?.cerrar();
    void cliente?.cerrar();

    /*
     * Se vacia lo que el respaldo automatico tuviera pendiente antes de salir:
     * el ultimo alta es justo la que no puede quedarse sin respaldar, porque es
     * la que el operador acaba de hacer.
     *
     * Con tope de dos segundos. Un disco atascado -o OneDrive sincronizando-
     * no puede impedir que el panel se cierre.
     */
    const pendiente = respaldoAuto?.parar() ?? Promise.resolve();
    void Promise.race([pendiente, new Promise((listo) => setTimeout(listo, 2_000))]).finally(() => app.quit());
  });
}

/*
 * Sin telemetria, sin llamadas de red fuera de Bitget, salvo los avisos a
 * api.telegram.org cuando el operador configura un bot. docs/01 seccion 7.
 */
app.commandLine.appendSwitch('disable-features', 'MediaRouter');
