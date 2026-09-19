/**
 * Sesion del panel: lo unico que el renderer puede provocar.
 *
 * Reune las cuatro piezas de la Fase 2 -almacen cifrado, registro de cuentas,
 * verificacion contra Bitget y estado de conexion- y las expone como
 * operaciones completas. La pantalla pide «da de alta esta subcuenta» y aqui
 * dentro se verifica contra la API, se cifra la credencial, se anota la cuenta
 * y se registra su estado; si algo falla, no queda nada a medias.
 *
 * Ningun metodo devuelve un secreto. Lo que sale de aqui es exactamente lo que
 * el contrato de IPC declara, y la API Key va siempre enmascarada. RNF-001.
 */
import type {
  AltaCuenta,
  AltaMadre,
  CuentaPanel,
  EstadoApp,
  EstadoVault,
  FilaCuenta,
  MadreIpc,
  MovimientoTraspasoIpc,
  ResultadoMovimientoIpc,
  ResultadoReparto,
  ResultadoTraspaso,
  ResultadoAlta,
  ResultadoAltaMadre,
  ResultadoBaja,
  ResultadoPrueba,
  ResultadoVault,
  SaldosPantalla
} from '@shared/ipc-contract';
import { PLAN_VIGENCIA_MS } from '@shared/constants';
import type {
  AccountMode,
  Cuenta,
  Decimal as Cantidad,
  EstadoConexion,
  HoldMode,
  Job,
  Lado,
  Lote,
  PosicionMonitor
} from '@shared/types';
import { ErrorBitget } from '../bitget/errors';
import type { ModoMargenApi } from '../bitget/rest/endpoints/ordenes';
import { MERCADOS, type ClaveMercado } from '../bitget/mercado';
import type { ClienteBitget } from '../bitget/rest/client';
import type { Credencial } from '../bitget/rest/signer';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { verificarCredencial, type ResultadoVerificacion } from '../bitget/verificacion';
import { obtenerCuentasFuturos, obtenerInfoCuenta } from '../bitget/rest/endpoints/cuenta';
import {
  buscarTraspaso,
  obtenerSaldosSubcuentas,
  traspasarEntreSubcuentas
} from '../bitget/rest/endpoints/subcuentas';
import { MONEDA_TRASPASOS, resumirSaldos } from '../domain/saldos-subcuentas';
import { planificarTraspaso, type PlanTraspaso } from '../domain/plan-traspaso';
import { roeDe } from '../domain/roe';
import {
  planificarRecogida,
  planificarReparto,
  type ModoReparto,
  type PlanReparto
} from '../domain/plan-reparto';
import { RegistroTraspasos } from '../storage/registro-traspasos';
import {
  activosDeRanuras,
  catalogoCompleto,
  preciosDe,
  type ActivoOperable
} from '../bitget/catalogo-activos';
import {
  cargarRanuras,
  guardarRanuras,
  normalizarRanuras,
  type RanurasEnDisco,
  type RanurasMercado
} from '../storage/ranuras-activos';
import type { CuentaSocket, FuentePool } from '../bitget/ws/pool';
import { AlmacenPosiciones, type Deriva } from '../domain/almacen-posiciones';
import type {
  CuentaBarrible,
  FuenteBarrido,
  ResultadoLectura
} from '../execution/barrido-posiciones';
import { RegistroConexiones } from '../domain/estado-conexion';
import { ErrorRegistro, RegistroCuentas } from '../domain/registro-cuentas';
import type { ParametrosKdf } from '../security/kdf';
import {
  ErrorPlan,
  MotorLotes,
  type ApalancamientoCuenta,
  type CuentaEjecutable,
  type DireccionMargen,
  type FuenteCuentas,
  type PlanApalancamiento,
  type PlanApertura,
  type PlanCierre,
  type PlanMargen,
  type PlanQuitarTakeProfit,
  type PlanTakeProfit
} from '../execution/motor-lotes';
import { ErrorVault, Vault, estadoEnDisco } from '../security/vault';
import { FrenoMaestra } from '../security/freno-maestra';
import { textoEspera } from '@shared/espera-maestra';

export interface RutasSesion {
  vault: string;
  cuentas: string;
  /** `activos.json`: que activo tiene el operador en cada una de las ocho casillas. */
  activos: string;
  /**
   * `traspasos/movimientos.jsonl`: el registro de lo que se ha movido.
   *
   * Opcional para no obligar a cada prueba a declararlo; cuando falta se deriva
   * de la carpeta del vault, que es donde vive el resto del estado.
   */
  traspasos?: string;
  /**
   * `intentos.json`: los fallos contra la maestra y la espera en curso.
   *
   * Se deriva de la carpeta del vault cuando falta, igual que `traspasos`.
   */
  intentos?: string;
}

export interface OpcionesSesion {
  /** Mercado contra el que se opera. Lo fija `config.json`, nunca el renderer. */
  mercado?: ClaveMercado;
  /** Se inyecta en las pruebas; en produccion lo construye la propia sesion. */
  motor?: MotorLotes;
  /**
   * Coste de scrypt al **crear** el almacen. Solo para pruebas.
   *
   * En produccion no se pasa y manda el valor real -N = 2^17, medio segundo y
   * 128 MB por derivacion-, que es lo que hace inviable la fuerza bruta sobre un
   * `vault.enc` robado. Bajarlo aqui seria debilitar el almacen; el motivo de
   * que exista la puerta es otro: las pruebas de integracion crean un almacen
   * por caso, y con el coste real cada una gasta segundos en criptografia que ya
   * cubre `test/unit/vault.test.ts`. Con varias suites en paralelo eso no solo
   * era lento: agotaba el limite de tiempo de vitest de forma intermitente.
   *
   * Mismo patron que `OpcionesVault.parametrosKdf`, del que es la continuacion.
   */
  parametrosKdf?: Partial<Omit<ParametrosKdf, 'algoritmo'>>;
  /**
   * Freno de intentos contra la maestra. Se inyecta en las pruebas para poder
   * mover el reloj; en produccion lo carga la sesion de `rutas.intentos`.
   */
  freno?: FrenoMaestra;
  ahora?: () => number;
  /**
   * Espera entre lecturas de la posicion recien abierta. Se inyecta en las
   * pruebas para no depender de relojes reales. Ver `ponerTakeProfitTrasAbrir`.
   */
  dormir?: (ms: number) => Promise<void>;
}

/**
 * Cuantas veces se relee la posicion antes de darla por ausente, y cuanto se
 * espera entre lecturas.
 *
 * Una orden a mercado devuelve su `orderId` en cuanto entra, pero la posicion
 * puede tardar un instante en aparecer en `/position/all-position`. Sin esta
 * espera, el Take Profit de la misma confirmacion se descartaria por
 * «no hay posicion» **justo despues de haberla abierto**, que es el fallo que
 * este flujo existe para evitar.
 */
const INTENTOS_POSICION = 3;
const ESPERA_POSICION_MS = 700;

const textoError = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Lo que hay que hacer cuando una posicion se abrio y su Take Profit no entro.
 *
 * Se acompaña **siempre** al motivo tecnico, venga de un descarte o del propio
 * envio. El motivo a secas -«Solo se puede agregar margen en margen aislado»-
 * no le dice al operador lo unico que importa: que esa posicion esta abierta y
 * sin proteccion, y que la accion es ponersela a mano.
 */
const SIN_PROTECCION =
  'La posición quedó abierta SIN Take Profit: póngaselo con «Poner Take Profit», ' +
  'en la sección «Sobre posiciones abiertas».';

/**
 * Lo mismo para el margen adicional que se pidio con la apertura.
 *
 * El plan ya impide el caso previsible -pedirlo en margen cruzado aborta el
 * lote entero antes de abrir nada-, asi que llegar aqui significa que fallo el
 * envio con la posicion ya abierta. Tiene que verse: la posicion existe y tiene
 * menos colchon del que el operador aprobo.
 */
const SIN_MARGEN_EXTRA =
  'La posición quedó abierta SIN el margen adicional: agrégueselo con «Agregar margen», ' +
  'en la sección «Sobre posiciones abiertas».';

/** Texto por defecto de una fila de Take Profit que no trajo el suyo. */
const mensajeTp = (estado: Job['estado']): string =>
  estado === 'exito'
    ? 'Take Profit puesto'
    : estado === 'omitida'
      ? 'No hizo falta poner el Take Profit.'
      : SIN_PROTECCION;

/** Lo mismo para una fila de margen adicional. */
const mensajeMargen = (estado: Job['estado']): string =>
  estado === 'exito'
    ? 'Margen adicional agregado'
    : estado === 'omitida'
      ? 'No hizo falta agregar margen adicional.'
      : SIN_MARGEN_EXTRA;

/**
 * En que estado se ensena una punta, y por que.
 *
 * Son tres cosas distintas que la pantalla tiene que poder distinguir, porque
 * piden reacciones opuestas del operador:
 *
 *   `indeterminada`  la posicion existe pero su ultima lectura no se completo
 *   `sin-conexion`   la cuenta no responde: estos numeros son los ultimos que
 *                    se supieron, no los de ahora
 *   `modo-rest`      la cuenta esta viva pero sin socket, asi que el dato puede
 *                    llevar hasta 45 s de retraso
 *
 * El orden no es arbitrario: una posicion indeterminada lo es aunque la cuenta
 * haya vuelto, y una cuenta caida hace irrelevante que estuviera en modo REST.
 * Se resuelve de lo mas grave a lo menos.
 */
/* El ROE lo calcula `domain/roe.ts`: es aritmetica, y alli se prueba sin electron. */

function estadoDePunta(
  estadoPosicion: 'viva' | 'indeterminada',
  estadoConexion: EstadoConexion,
  motivoConexion: string | null
): { estado: PosicionMonitor['estado']; motivo: string | null } {
  if (estadoPosicion === 'indeterminada') {
    return {
      estado: 'indeterminada',
      motivo: 'La ultima lectura de esta posicion no se completo.'
    };
  }
  if (estadoConexion === 'desconectada') {
    return {
      estado: 'sin-conexion',
      motivo: motivoConexion ?? 'La subcuenta no responde: estos datos son los ultimos conocidos.'
    };
  }
  if (estadoConexion === 'modo-rest') {
    return {
      estado: 'modo-rest',
      motivo: 'Sin conexion en vivo: el dato puede llevar hasta 45 s de retraso.'
    };
  }
  return { estado: 'ok', motivo: null };
}

/**
 * La respuesta cuando el freno esta echado.
 *
 * El motivo es propio -`espera-activa`- y no `contrasena-incorrecta`: la clave
 * que se acaba de teclear puede ser la buena, y decirle a alguien que su
 * contrasena es incorrecta cuando lo que pasa es que hay que esperar es como se
 * empieza a dudar de una clave que estaba bien.
 */
function esperaActiva(restanteMs: number): ResultadoVault {
  return {
    ok: false,
    motivo: 'espera-activa',
    mensaje:
      `Demasiados intentos seguidos con la contraseña maestra. Vuelva a intentarlo dentro de ` +
      `${textoEspera(restanteMs)}. La espera crece con cada fallo y se borra en cuanto acierte.`
  };
}

export class Sesion implements FuenteCuentas, FuenteBarrido, FuentePool {
  private readonly rutas: RutasSesion;
  /**
   * Se carga la primera vez que alguien teclea la maestra y se conserva.
   *
   * Una promesa y no el objeto: dos pantallas que prueben la clave a la vez
   * -desbloqueo y restauracion- tienen que compartir **el mismo** freno, y
   * cargarlo dos veces daria dos contadores con la mitad del cupo cada uno.
   */
  private frenoCargando: Promise<FrenoMaestra> | null = null;
  private readonly cliente: ClienteBitget;
  private readonly mercado: ClaveMercado;
  private readonly motor: MotorLotes;
  private readonly ahoraMs: () => number;
  private readonly parametrosKdf: Partial<Omit<ParametrosKdf, 'algoritmo'>> | undefined;
  private readonly dormir: (ms: number) => Promise<void>;
  /**
   * Planes calculados y aun sin ejecutar.
   *
   * Viven aqui y no en el renderer a proposito: la pantalla recibe el plan para
   * ensenarlo y devuelve solo su `id`. Asi ninguna cantidad, ningun precio y
   * ninguna cuenta pueden alterarse entre lo que el operador aprueba y lo que
   * sale hacia Bitget.
   */
  /**
   * Las ocho casillas, en tres formas y con tres vidas distintas.
   *
   * `ranurasCache` son los simbolos que el operador tiene puestos -viene del
   * disco y solo cambia cuando el edita una casilla-; `ranurasActivosCache` es
   * esa misma lista ya resuelta contra el catalogo de Bitget, con sus huecos; y
   * `activosCache` es la version compacta, la que consume todo lo demas.
   *
   * Se leen una vez por sesion porque el catalogo del exchange no cambia
   * mientras el panel esta abierto. Editar una casilla las invalida.
   */
  private ranurasCache: RanurasMercado | null = null;
  private ranurasActivosCache: (ActivoOperable | null)[] | null = null;
  private activosCache: ActivoOperable[] | null = null;
  /** Los 754 contratos del mercado. Solo alimenta el buscador de activos. */
  private catalogoCache: ActivoOperable[] | null = null;
  private readonly planes = new Map<string, PlanApertura>();
  /** Lo mismo para los cierres. Se guardan aparte porque no caducan igual. */
  private readonly planesCierre = new Map<string, PlanCierre>();
  /*
   * Los ajustes sobre una posicion ya abierta guardan su plan como los demas.
   *
   * Los dos mapas se retiraron el 26/08/2026 con sus canales y vuelven con
   * ellos. Lo que sostiene la promesa es lo mismo que en la apertura: el plan
   * -con el margen actual leido de Bitget y el resultante- vive aqui, y de la
   * pantalla solo vuelve su `id`. Ver `planificarMargen`.
   */
  private readonly planesTp = new Map<string, PlanTakeProfit>();
  private readonly planesMargen = new Map<string, PlanMargen>();
  /**
   * Traspasos calculados y aun sin enviar, con el momento en que se calcularon.
   *
   * Caducan como los demas planes: un traspaso aprobado hace diez minutos se
   * calculo sobre saldos que ya no son los de ahora.
   */
  private readonly planesTraspaso = new Map<string, { plan: PlanTraspaso; creadoMs: number }>();
  /** Repartos y recogidas calculados y sin enviar. Caducan como los demás. */
  private readonly planesReparto = new Map<string, { plan: PlanReparto; creadoMs: number }>();
  private readonly traspasos: RegistroTraspasos;
  private readonly planesQuitarTp = new Map<string, PlanQuitarTakeProfit>();
  private readonly planesApalancamiento = new Map<string, PlanApalancamiento>();
  /**
   * Estado de conexion de la sesion en curso.
   *
   * Se tira al bloquear el panel, no se conserva. Con el panel bloqueado no se
   * consulta a Bitget, asi que el estado envejece; conservarlo pintaria de
   * verde al desbloquear cuentas que llevan horas sin comprobarse. RF-002.
   */
  private conexiones = new RegistroConexiones();
  /**
   * Las posiciones vivas que dibuja el Centro de Monitoreo.
   *
   * A diferencia de `conexiones`, la instancia **no se sustituye** al bloquear:
   * se vacia con `limpiar()`. La diferencia importa porque el puente hacia la
   * ventana se suscribe una sola vez al arrancar el proceso; cambiar el objeto
   * dejaria ese oyente atado a un almacen que ya no recibe nada, y el monitor se
   * quedaria congelado en la foto del bloqueo sin que nada lo delatara.
   */
  private readonly posiciones = new AlmacenPosiciones();
  /**
   * Casillas de la ultima apertura, para promoverlas a socket.
   *
   * Es lo que hace que una posicion recien abierta aparezca en el monitor al
   * instante y no cuando pase el barrido: en el momento de abrir, esas cuentas
   * todavia estan frias. Se sustituye entero en cada apertura -es «la ultima»,
   * no «todas las que hubo»- y por eso no crece.
   */
  private ultimosObjetivos = new Set<string>();
  /**
   * Subcuentas que Bitget declara **en mitad del cambio** a UTA.
   *
   * Vive en memoria y no en `cuentas.json` a proposito: es un estado transitorio
   * -`accountMode` en `upgrading` o `switching`- que termina solo. Persistirlo
   * dejaria una cuenta bloqueada para siempre si el panel se cierra mientras
   * dura el cambio, y para saber que ya termino hay que preguntar a Bitget de
   * todas formas.
   *
   * Mientras esta aqui, la subcuenta no se opera: la superficie que responde hoy
   * puede dejar de hacerlo a mitad de una orden.
   */
  private readonly enTransicion = new Set<string>();
  /** Sockets vivos, para la barra superior. Lo rellena el pool. */
  private sockets = 0;
  private vault: Vault | null = null;
  private registro: RegistroCuentas | null = null;
  /**
   * Saldo disponible por cuenta, tal como lo devolvio la ultima verificacion.
   *
   * No se persiste: un saldo guardado en disco es un saldo desactualizado la
   * proxima vez que se abre el panel, y mostrarlo como si fuera de ahora es
   * peor que no mostrarlo. Al desbloquear se vuelve a llenar conforme cada
   * cuenta se verifica.
   */
  private readonly saldos = new Map<string, string>();
  /**
   * Apalancamiento por cuenta, tambien de la ultima verificacion.
   *
   * El cliente confirmo que el apalancamiento se fija una vez y queda fijo, asi
   * que la apertura no lo cambia. Pero el margen comprometido depende de el, y
   * por eso hay que saberlo: llega gratis en la misma respuesta que confirma la
   * credencial.
   */
  private readonly apalancamientos = new Map<string, ApalancamientoCuenta>();
  private readonly oyentes = new Set<() => void>();
  private readonly oyentesLote = new Set<(lote: Lote) => void>();
  private readonly oyentesCuentasTocadas = new Set<(cuentaIds: readonly string[]) => void>();
  /** Quien quiere enterarse de que las credenciales cambiaron. Ver `alCambiarCredenciales`. */
  private readonly oyentesCredenciales = new Set<() => void>();
  private desuscribirConexiones: (() => void) | null = null;

  constructor(rutas: RutasSesion, cliente: ClienteBitget, opciones: OpcionesSesion = {}) {
    this.rutas = rutas;
    this.traspasos = new RegistroTraspasos(
      rutas.traspasos ?? join(dirname(rutas.vault), 'traspasos', 'movimientos.jsonl')
    );
    this.cliente = cliente;
    this.mercado = opciones.mercado ?? 'simulado';
    this.ahoraMs = opciones.ahora ?? Date.now;
    this.parametrosKdf = opciones.parametrosKdf;
    if (opciones.freno !== undefined) this.frenoCargando = Promise.resolve(opciones.freno);
    this.dormir =
      opciones.dormir ??
      ((ms) =>
        new Promise((r) => {
          setTimeout(r, ms);
        }));
    this.motor =
      opciones.motor ??
      new MotorLotes(cliente, this, {
        alProgresar: (lote) => {
          for (const oyente of this.oyentesLote) oyente(lote);
          /*
           * `terminadoEn` deja de ser nulo en el `finally` de `correrLote`, asi
           * que el ultimo aviso de cada lote -y solo ese- llega aqui con fecha.
           *
           * Es el unico punto por el que pasan las seis operaciones, de modo que
           * enganchar aqui evita tener que acordarse de hacerlo en cada
           * `ejecutar*`, que es exactamente la clase de sitio donde el sexto se
           * queda sin enganchar.
           */
          if (lote.terminadoEn !== null) this.avisarCuentasTocadas(lote);
        }
      });
    this.escucharConexiones();
  }

  /* ---------------- avisos de cambio ---------------- */

  /**
   * Avisa cuando cambia algo que la matriz dibuja.
   *
   * Existe porque el estado de conexion lo mueve el supervisor por su cuenta,
   * en segundo plano: sin este aviso la pantalla solo se enteraria cuando el
   * operador hiciera algo, y una cuenta caida seguiria en verde hasta entonces.
   * RF-002. El proceso principal lo traduce a un evento de IPC.
   */
  alCambiar(oyente: () => void): () => void {
    this.oyentes.add(oyente);
    return () => {
      this.oyentes.delete(oyente);
    };
  }

  private anunciar(): void {
    for (const oyente of this.oyentes) oyente();
  }

  /**
   * Avisa cuando el juego de credenciales de este panel ha cambiado en disco.
   *
   * Lo consume el respaldo automatico, que vive en `index.ts`: la sesion no sabe
   * donde estan los Documentos del operador ni que forma tiene un `.pcbak`, y no
   * tiene por que saberlo. Aqui solo se dice **que** algo cambio.
   */
  alCambiarCredenciales(oyente: () => void): () => void {
    this.oyentesCredenciales.add(oyente);
    return () => {
      this.oyentesCredenciales.delete(oyente);
    };
  }

  /**
   * Sincrono y a prueba de oyentes rotos.
   *
   * Un respaldo que falla **no puede** romper un alta: cuando esto se llama, el
   * alta ya escribio en disco y ya tiene su resultado. Por eso no se espera a
   * nadie y por eso cada oyente va en su propio `try`: lo unico que puede pasar
   * si el respaldo automatico revienta es que no haya respaldo, y de eso el
   * operador se entera al pulsar el boton manual, que es el momento honesto.
   */
  private avisarCredenciales(): void {
    for (const oyente of this.oyentesCredenciales) {
      try {
        oyente();
      } catch {
        /* El respaldo se apaña solo; la operacion que lo disparo no se entera. */
      }
    }
  }

  /** Reengancha el aviso al registro de conexiones vigente. */
  private escucharConexiones(): void {
    this.desuscribirConexiones?.();
    this.desuscribirConexiones = this.conexiones.alCambiar(() => this.anunciar());
  }

  /* ---------------- almacen ---------------- */

  async estadoVault(): Promise<EstadoVault> {
    if (this.vault !== null && !this.vault.estaCerrado) return 'desbloqueado';
    return estadoEnDisco(this.rutas.vault);
  }

  /** Crea el almacen la primera vez que se usa el panel. */
  async crear(contrasena: string): Promise<ResultadoVault> {
    return this.abrirCon(() =>
      Vault.crear(
        this.rutas.vault,
        contrasena,
        this.parametrosKdf === undefined ? {} : { parametrosKdf: this.parametrosKdf }
      )
    );
  }

  /**
   * El freno de la maestra, cargado una sola vez para todo el proceso.
   *
   * Las tres puertas que piden la clave -desbloqueo, pantalla de seguridad y
   * restauracion de respaldo- comparten este objeto a proposito: es la misma
   * contrasena, y un contador por puerta seria tres cupos de tres intentos que
   * se recorren cambiando de pantalla.
   */
  private frenoMaestra(): Promise<FrenoMaestra> {
    this.frenoCargando ??= FrenoMaestra.cargar(
      this.rutas.intentos ?? join(dirname(this.rutas.vault), 'intentos.json')
    );
    return this.frenoCargando;
  }

  /** Lo que falta de espera, para que la pantalla pueda contarlo. */
  async esperaMaestraMs(): Promise<number> {
    return (await this.frenoMaestra()).restanteMs();
  }

  /**
   * Abre el almacen, con el freno por delante.
   *
   * --------------------------------------------------------------------------
   * Que cuenta como fallo y que no
   * --------------------------------------------------------------------------
   * Solo `contrasena-incorrecta`. Un `archivo-danado` o un `no-existe` no dicen
   * nada sobre la clave que se tecleo, y contarlos acabaria castigando con una
   * hora de espera a quien tiene un vault roto -que es justo cuando mas falta
   * hace poder intentarlo-.
   */
  async abrir(contrasena: string): Promise<ResultadoVault> {
    const freno = await this.frenoMaestra();
    const restante = freno.restanteMs();
    if (restante > 0) return esperaActiva(restante);

    const resultado = await this.abrirCon(() => Vault.abrir(this.rutas.vault, contrasena));

    if (resultado.ok) {
      await freno.anotarAcierto();
    } else if (resultado.motivo === 'contrasena-incorrecta') {
      const espera = await freno.anotarFallo();
      if (espera > 0) return esperaActiva(espera);
    }

    return resultado;
  }

  /**
   * Tronco comun de crear y abrir.
   *
   * Al terminar carga el registro de cuentas y descarta las que se quedaron sin
   * credencial: un `cuentas.json` que no cuadra con el `vault.enc` es lo que
   * ocurre al copiar carpetas entre equipos, y mostrar una cuenta que no puede
   * firmar nada la haria contar como operativa.
   */
  private async abrirCon(abrir: () => Promise<Vault>): Promise<ResultadoVault> {
    try {
      const vault = await abrir();
      this.vault = vault;

      const registro = await RegistroCuentas.cargar(this.rutas.cuentas);
      const vivas = vault.listar().map((c) => c.cuentaId);
      if (registro.sincronizar(vivas)) await registro.guardar();
      this.registro = registro;

      for (const cuenta of registro.listarCuentas()) this.conexiones.registrar(cuenta.id);

      this.anunciar();
      return { ok: true, motivo: null, mensaje: null };
    } catch (e) {
      if (e instanceof ErrorVault) return { ok: false, motivo: e.motivo, mensaje: e.message };
      throw e;
    }
  }

  /**
   * Confirma la contrasena maestra sin dar acceso a nada.
   *
   * La pide la pantalla de seguridad antes de dejar cambiar la contrasena de
   * paso: quien se levanta de la silla deja el panel abierto, y sin esta
   * comprobacion cualquiera podria fijar una clave de dos digitos conocida.
   */
  async comprobarMaestra(contrasena: string): Promise<boolean> {
    if (this.vault === null || this.vault.estaCerrado) return false;
    return this.comprobarConFreno(contrasena);
  }

  /**
   * La misma comprobacion, pero **con el panel bloqueado**.
   *
   * La usa la restauracion de un respaldo, que ocurre antes de desbloquear
   * nada: pide la maestra de este panel para no dejar que cualquiera reemplace
   * el `vault.enc` con otro. Pasa por el mismo freno que las otras dos puertas.
   */
  async comprobarMaestraEnDisco(contrasena: string): Promise<boolean> {
    return this.comprobarConFreno(contrasena);
  }

  /**
   * Comprueba la clave contra el archivo y mueve el contador.
   *
   * Devuelve `false` tanto si la clave no era como si habia espera en curso: no
   * es un descuido, es que quien pregunta solo necesita saber si puede seguir.
   * El motivo -y cuanto falta- se consulta aparte con `esperaMaestraMs`, que es
   * lo que la pantalla usa para escribir la cuenta atras.
   */
  private async comprobarConFreno(contrasena: string): Promise<boolean> {
    const freno = await this.frenoMaestra();
    if (freno.restanteMs() > 0) return false;

    const ok = await Vault.comprobarContrasena(this.rutas.vault, contrasena);
    if (ok) await freno.anotarAcierto();
    else await freno.anotarFallo();
    return ok;
  }

  /** Cierra el almacen y borra de memoria lo que se pueda. */
  cerrar(): void {
    this.vault?.cerrar();
    this.vault = null;
    this.registro = null;
    this.saldos.clear();
    this.apalancamientos.clear();
    /* Un plan sin sesion no se puede ejecutar: se tira con las credenciales. */
    this.planes.clear();
    this.planesCierre.clear();
    this.planesTp.clear();
    this.planesMargen.clear();
    this.planesQuitarTp.clear();
    this.planesApalancamiento.clear();
    this.conexiones = new RegistroConexiones();
    /*
     * Las posiciones se tiran por lo mismo que el estado de conexion: con el
     * panel bloqueado no se consulta a Bitget, asi que envejecen. Volver a
     * ensenarlas al desbloquear seria dar por abierta una posicion que pudo
     * cerrarse hace horas, y con ella su liquidacion y su Take Profit.
     */
    this.posiciones.limpiar();
    this.ultimosObjetivos = new Set();
    this.sockets = 0;
    this.escucharConexiones();
    this.anunciar();
  }

  /* ---------------- cuentas ---------------- */

  /**
   * Exige la sesion abierta.
   *
   * Es la puerta que impide que un canal de IPC toque credenciales con el panel
   * bloqueado. No es un detalle defensivo: sin ella, cualquier fallo de la
   * pantalla de desbloqueo dejaria las claves accesibles.
   */
  private exigirAbierta(): { vault: Vault; registro: RegistroCuentas } {
    if (this.vault === null || this.registro === null || this.vault.estaCerrado) {
      throw new Error('El panel esta bloqueado.');
    }
    return { vault: this.vault, registro: this.registro };
  }

  listar(): FilaCuenta[] {
    if (this.vault === null || this.registro === null || this.vault.estaCerrado) return [];
    const registro = this.registro;

    return registro.listarCuentas().map((cuenta) => {
      const estado = this.conexiones.estado(cuenta.id);
      return {
        id: cuenta.id,
        etiqueta: cuenta.etiqueta,
        grupoNombre: registro.nombreDeGrupo(cuenta.grupoId),
        uid: cuenta.uid,
        uidPadre: cuenta.uidPadre,
        apiKeyEnmascarada: cuenta.apiKeyEnmascarada,
        estado: estado?.estado ?? 'desconectada',
        motivo: estado?.motivo ?? null,
        accountMode: cuenta.accountMode,
        enTransicion: this.enTransicion.has(cuenta.id),
        altaEn: cuenta.altaEn
      };
    });
  }

  /**
   * La matriz de seleccion: cuentas principales con sus subcuentas.
   *
   * Las cuentas principales salen por el abecedario -A, B, C...- y de eso se
   * encarga `listarGrupos()`. Aqui **no se reordenan**: un segundo criterio
   * encima del suyo seria el que mandaria, y tener el orden escrito en dos
   * sitios es como la matriz acabo enseñandolo distinto de la pantalla de API
   * Keys. Este JSDoc callaba el orden de los grupos, y ese silencio es por
   * donde se colo el fallo.
   *
   * Las subcuentas van ordenadas por casilla y no por antiguedad ni por nombre,
   * porque la casilla es lo que el operador tiene memorizado. Con el panel
   * bloqueado devuelve una lista vacia en lugar de fallar: es la respuesta
   * correcta, no un error.
   */
  cuentasPanel(): CuentaPanel[] {
    if (this.vault === null || this.registro === null || this.vault.estaCerrado) return [];
    const registro = this.registro;

    return registro.listarGrupos().map((grupo) => ({
      id: grupo.id,
      nombre: grupo.nombre,
      subcuentas: registro
        .listarCuentas()
        .filter((c) => c.grupoId === grupo.id)
        .sort((a, b) => a.slot - b.slot)
        .map((cuenta) => {
          const estado = this.conexiones.estado(cuenta.id);
          return {
            id: cuenta.id,
            etiqueta: cuenta.etiqueta,
            slot: cuenta.slot,
            saldo: this.saldos.get(cuenta.id) ?? '0',
            estado: estado?.estado ?? 'desconectada',
            motivo: estado?.motivo ?? null
          };
        })
    }));
  }

  /* ---------------- posiciones vivas ---------------- */

  /**
   * El almacen de posiciones, para quien las lee del exchange.
   *
   * Lo usan el barrido REST y el pool de sockets, que son los que meten datos
   * aqui; el resto del sistema solo consume `posicionesMonitor()`. No es un
   * escape de encapsulacion: la sesion no sabe leer posiciones, y ponerle un
   * metodo por cada forma de aplicarlas seria repetir el almacen entero.
   */
  get almacenPosiciones(): AlmacenPosiciones {
    return this.posiciones;
  }

  /** Avisa cuando cambia alguna posicion. Lo consume el evento `monitor:posiciones`. */
  alCambiarPosiciones(oyente: () => void): () => void {
    return this.posiciones.alCambiar(oyente);
  }

  /**
   * Cuantas cuentas tienen socket vivo. Lo publica la barra superior.
   *
   * Lo informa el pool en vez de calcularlo la sesion, porque el unico que sabe
   * cuantos sockets hay abiertos es quien los abre. Sirve para ver de un
   * vistazo cuanto queda del presupuesto de 80.
   */
  informarSockets(vivos: number): void {
    if (this.sockets === vivos) return;
    this.sockets = vivos;
    this.anunciar();
  }

  /**
   * Las cuentas que el barrido debe consultar, con su credencial.
   *
   * Quedan fuera dos clases de cuenta, por motivos distintos:
   *
   *  - Sin credencial guardada: no hay nada con lo que firmar.
   *  - Rechazada definitivamente por Bitget -`desconectada` y sin reintento
   *    programado-: releerla cada 45 segundos gastaria cupo para recibir el
   *    mismo rechazo hasta que alguien corrija la clave. Vuelve en cuanto la
   *    verificacion la reviva, que es lo unico que puede arreglarlo.
   */
  cuentasBarribles(): CuentaBarrible[] {
    if (this.vault === null || this.registro === null || this.vault.estaCerrado) return [];

    const salida: CuentaBarrible[] = [];
    for (const cuenta of this.registro.listarCuentas()) {
      const credencial = this.credencialSellada(cuenta.id);
      if (credencial === null) continue;

      const estado = this.conexiones.estado(cuenta.id);
      if (estado?.estado === 'desconectada' && estado.proximoIntento === null) continue;

      salida.push({ cuentaId: cuenta.id, credencial });
    }
    return salida;
  }

  /**
   * La credencial de una subcuenta, sellada con la superficie que le toca.
   *
   * ==========================================================================
   * El unico sitio por el que una credencial sale del vault
   * ==========================================================================
   * Es el punto donde se decide si esa subcuenta hablara V2 o V3, y por eso
   * todo lo que necesite credenciales pasa por aqui en vez de llamar a
   * `vault.credencialDe` directamente: una credencial sin sellar habla V2 por
   * defecto, de modo que un camino que se saltara este metodo mandaria una
   * cuenta UTA a la superficie clasica y la veria caerse sin explicacion.
   *
   * El sello sale del registro, que es donde lo dejo la ultima deteccion. No se
   * consulta a Bitget aqui: esto se llama en cada ciclo del barrido y de cada
   * lote, y una peticion por llamada seria una tormenta.
   */
  private credencialSellada(cuentaId: string): Credencial | null {
    if (this.vault === null || this.registro === null) return null;

    const credencial = this.vault.credencialDe(cuentaId);
    if (credencial === null) return null;

    const cuenta = this.registro.cuenta(cuentaId);
    return {
      ...credencial,
      superficie: cuenta?.accountMode === 'uta' ? 'v3' : 'v2',
      /*
       * Decide si `posSide` viaja en el cuerpo de las peticiones de V3.
       * `null` -no detectado- se resuelve enviandolo, que es el lado seguro:
       * omitirlo en una cuenta de cobertura deja que Bitget elija el lado.
       */
      holdMode: cuenta?.holdMode ?? null
    };
  }

  /**
   * Desenlace de una lectura del barrido.
   *
   * --------------------------------------------------------------------------
   * El exito NO se registra, y es deliberado
   * --------------------------------------------------------------------------
   * `registrarExito` pone `proximoIntento` en `null`, que es como se le dice al
   * supervisor «esta cuenta no necesita verificarse». Y el barrido no puede
   * afirmar eso: desde el 29/08/2026 si refresca el saldo -ver `registrarSaldo`-
   * pero **no el apalancamiento**, que sigue llegando solo con la verificacion
   * de la credencial y es lo que decide el margen de cada apertura.
   *
   * Al desbloquear, las cien cuentas vencen su verificacion a la vez y es asi
   * como se llenan los apalancamientos. Si el barrido -que arranca en el mismo
   * instante- las fuera marcando como exitosas, cancelaria esas verificaciones y
   * la matriz operaria con apalancamientos que nadie ha leido.
   *
   * El fallo si se registra: una cuenta cuyas posiciones no se pueden leer esta
   * en problemas, y anotarlo programa la verificacion que puede arreglarlo. Hace
   * falta que falle `FALLOS_PARA_DESCONECTAR` veces seguidas -mas de dos
   * minutos, al ritmo del barrido- antes de pintarla en rojo.
   */
  registrarLectura(cuentaId: string, resultado: ResultadoLectura): void {
    if (resultado.ok) return;
    this.conexiones.registrarFallo(cuentaId, resultado.error);
  }

  /**
   * El saldo que acaba de leer el barrido.
   *
   * --------------------------------------------------------------------------
   * Lo que arregla, y por que no lo arreglaba el socket
   * --------------------------------------------------------------------------
   * Hasta el 29/08/2026 el saldo solo se refrescaba al verificar la credencial,
   * es decir, al reconectar o al pulsar «Probar». Mover dinero entre cuentas
   * desde la web de Bitget no cambiaba nada en pantalla, y el operador tenia que
   * ir cuenta por cuenta pulsando un boton para enterarse de su propio saldo.
   *
   * No era trabajo del socket: el pool se suscribe a `positions` y `orders-algo`
   * y no al canal `account`, que es por donde Bitget empuja el saldo. Era
   * trabajo del barrido, que ya pasa por cada cuenta con su credencial.
   *
   * Se anuncia siempre. El aviso va coalescido a `PUBLICACION_COALESCIDA_MS` en
   * el proceso principal, asi que trescientas cuentas terminando su barrido no
   * son trescientos envios al renderer.
   */
  registrarSaldo(cuentaId: string, disponible: string): void {
    if (this.saldos.get(cuentaId) === disponible) return;
    this.escribirSaldo(cuentaId, disponible);
    this.anunciar();
  }

  /**
   * Las cuentas que merecen socket, en orden de prioridad.
   *
   * Primero las que tienen posiciones abiertas: son las unicas que aportan
   * filas al monitor y por tanto las unicas donde la inmediatez se nota.
   *
   * Despues, las casillas de la ultima apertura. Sin ellas, abrir 34 posiciones
   * y verlas aparecer hasta 45 segundos mas tarde -cuando pase el barrido- seria
   * la experiencia normal del panel, porque en el momento de abrir esas cuentas
   * todavia estan frias. Se promueven al ejecutar y se sueltan en la apertura
   * siguiente; si para entonces tienen posiciones, ya entran por la primera
   * lista.
   *
   * El orden es lo que decide quien se queda fuera cuando no caben las 100 en
   * los 80 huecos: quien todavia no tiene nada que enseñar.
   */
  cuentasCalientes(): CuentaSocket[] {
    if (this.vault === null || this.registro === null || this.vault.estaCerrado) return [];

    const salida: CuentaSocket[] = [];
    const puestas = new Set<string>();

    const anadir = (cuentaId: string): void => {
      if (puestas.has(cuentaId)) return;
      const credencial = this.credencialSellada(cuentaId);
      if (credencial === null) return;
      puestas.add(cuentaId);
      salida.push({ cuentaId, credencial });
    };

    for (const cuentaId of this.posiciones.cuentasConPosicion()) anadir(cuentaId);
    for (const cuentaId of this.ultimosObjetivos) anadir(cuentaId);

    return salida;
  }

  /**
   * La cuenta se queda sin conexion en vivo, o la recupera.
   *
   * `RegistroConexiones` solo lo aplica a cuentas que estan `conectada` o ya en
   * `modo-rest`, asi que esto no puede pintar de verde una cuenta caida.
   */
  marcarModoRest(cuentaId: string, enModoRest: boolean): void {
    this.conexiones.marcarModoRest(cuentaId, enModoRest);
    this.anunciar();
  }

  /**
   * Bitget rechazo la credencial al abrir el socket.
   *
   * Se registra y no se hace nada mas, a proposito. El rechazo llega del
   * `login` del socket, y esta capa no puede concluir de ahi que la credencial
   * no sirva para operar: puede ser un desajuste de reloj o un permiso que
   * afecta solo al canal privado, y marcar la cuenta como desconectada la
   * sacaria de un lote de apertura que habria funcionado. Quien decide si una
   * credencial vale sigue siendo la verificacion REST.
   */
  alRechazarCredencial(
    cuentaId: string,
    detalle: { codigo: string | null; mensaje: string | null }
  ): void {
    console.warn(
      `[PCB] socket rechazado en ${cuentaId}: ${detalle.codigo ?? 'sin codigo'} ` +
        `${detalle.mensaje ?? ''}`.trimEnd() +
        ' — la cuenta sigue en modo REST.'
    );
  }

  /**
   * Divergencias entre lo que habia en memoria y lo que dijo el exchange.
   *
   * Hoy el barrido es la unica fuente, asi que toda deriva es un alta o un
   * cierre normal y no se anota: seria una linea de log por cada posicion que se
   * abre. Lo que si se anota es el cambio de un campo sobre una posicion que ya
   * estaba, porque con una sola fuente eso no deberia pasar mas que cuando el
   * precio de liquidacion se mueve de verdad. Cuando exista el socket, esta es
   * la senal de que un push se esta aplicando mal.
   */
  registrarDeriva(derivas: readonly Deriva[]): void {
    for (const d of derivas) {
      if (d.campo === 'alta' || d.campo === 'cierre') continue;
      console.warn(
        `[PCB] deriva en ${d.cuentaId} ${d.simbolo} ${d.lado}: ` +
          `${d.campo} en memoria ${d.enMemoria}, en Bitget ${d.enLectura}`
      );
    }
  }

  /**
   * Las posiciones vivas, proyectadas a lo que la pantalla dibuja.
   *
   * Con el panel bloqueado devuelve la lista vacia, igual que `cuentasPanel`:
   * sin registro no se puede decir a que grupo pertenece una casilla ni como se
   * llama, y una posicion sin casilla no se puede pintar en ningun sitio.
   *
   * Una posicion de una cuenta que ya no esta registrada se omite en lugar de
   * salir con la etiqueta en blanco. Ocurre en la ventana entre dar de baja una
   * subcuenta y que el almacen la olvide.
   */
  posicionesMonitor(): PosicionMonitor[] {
    if (this.vault === null || this.registro === null || this.vault.estaCerrado) return [];
    const registro = this.registro;

    const salida: PosicionMonitor[] = [];
    for (const viva of this.posiciones.instantanea()) {
      const cuenta = registro.cuenta(viva.cuentaId);
      if (cuenta === undefined) continue;

      const conexion = this.conexiones.estado(viva.cuentaId);

      salida.push({
        cuentaId: viva.cuentaId,
        grupoId: cuenta.grupoId,
        etiqueta: cuenta.etiqueta,
        simbolo: viva.simbolo,
        activoId: this.activoDeSimbolo(viva.simbolo),
        lado: viva.lado,
        entrada: viva.precioEntrada,
        liquidacion: viva.precioLiquidacion,
        takeProfit: viva.takeProfit?.precio ?? null,
        takeProfitPorcentaje: viva.takeProfit?.porcentaje ?? null,
        margenInicial: viva.aporte?.margenInicial ?? null,
        margenAdicional: viva.aporte?.margenAdicional ?? null,
        margenActual: viva.margen,
        pnl: viva.pnl,
        roe: roeDe(viva.pnl, viva.tamano, viva.precioEntrada, viva.apalancamiento),
        apalancamiento: viva.apalancamiento,
        tamano: viva.tamano,
        origen: viva.origen,
        actualizadoEn: viva.actualizadoEn,
        abiertaEn: viva.aporte?.abiertaEn ?? null,
        ...estadoDePunta(viva.estado, conexion?.estado ?? 'desconectada', conexion?.motivo ?? null)
      });
    }
    return salida;
  }

  /**
   * Nombre corto del activo a partir del simbolo de la API.
   *
   * Sale del catalogo cuando ya se ha consultado, que es el caso normal: la
   * pantalla lo pide al desbloquear. El respaldo existe para el instante en que
   * llegan posiciones antes que el catalogo, y hace lo mismo que
   * `catalogo-activos.ts`: quitar el prefijo del mercado simulado y la moneda de
   * margen. Peor que enseñar `BTC` seria enseñar `SBTCSUSDT`, que el operador no
   * reconoce como lo que ve en Bitget.
   */
  private activoDeSimbolo(simbolo: string): string {
    const delCatalogo = this.activosCache?.find((a) => a.simbolo === simbolo);
    if (delCatalogo !== undefined) return delCatalogo.id;

    const mercado = MERCADOS[this.mercado];
    let corto = simbolo;
    if (mercado.prefijoSimbolo !== '' && corto.startsWith(mercado.prefijoSimbolo)) {
      corto = corto.slice(mercado.prefijoSimbolo.length);
    }
    return corto.endsWith(mercado.marginCoin) ? corto.slice(0, -mercado.marginCoin.length) : corto;
  }

  /* ---------------- catalogo de activos ---------------- */

  /**
   * Los simbolos que el operador tiene puestos en las ocho casillas.
   *
   * Se leen del disco una vez y se conservan en memoria: es configuracion del
   * panel, no un dato de mercado, y no cambia mas que cuando el propio operador
   * edita una casilla. El mercado que no tenga nada guardado arranca con la
   * lista de fabrica -`mercado.simbolos`-, que es lo que el panel enseñaba antes
   * de que las casillas fueran editables.
   */
  private async ranurasGuardadas(): Promise<RanurasMercado> {
    if (this.ranurasCache === null) {
      const enDisco = await cargarRanuras(this.rutas.activos);
      this.ranurasCache = normalizarRanuras(enDisco[this.mercado], MERCADOS[this.mercado].simbolos);
    }
    return this.ranurasCache;
  }

  /**
   * Las ocho casillas del selector, resueltas contra el catalogo de Bitget.
   *
   * Se cachea porque el catalogo no cambia en una sesion: los topes de
   * apalancamiento y los decimales de un contrato son estables, y volver a
   * pedirlos cada vez que la pantalla se dibuja gastaria cupo sin aportar nada.
   * Editar una casilla invalida la cache, que es la unica forma de que esto
   * cambie sin reiniciar.
   */
  async ranuras(): Promise<(ActivoOperable | null)[]> {
    if (this.ranurasActivosCache === null) {
      this.ranurasActivosCache = await activosDeRanuras(
        this.cliente,
        MERCADOS[this.mercado],
        await this.ranurasGuardadas()
      );
      this.activosCache = this.ranurasActivosCache.filter((a): a is ActivoOperable => a !== null);
    }
    return this.ranurasActivosCache;
  }

  /**
   * Los activos operables del mercado activo, sin los huecos.
   *
   * Es la misma lista que `ranuras()` compactada, y la que usa todo lo que no
   * dibuja el selector: los precios, la traduccion de simbolo a nombre corto y
   * la validacion de lo que se puede operar. Una casilla vacia no es un activo.
   */
  async activos(): Promise<ActivoOperable[]> {
    return (await this.ranuras()).filter((a): a is ActivoOperable => a !== null);
  }

  /**
   * Todo lo que el mercado ofrece. Solo para el buscador de activos.
   *
   * Se cachea aparte de las casillas y por el mismo motivo: son 754 contratos
   * que no cambian en una sesion. Nada de esta lista se puede operar mientras no
   * ocupe una de las ocho casillas -es `activos()` quien decide eso-, asi que
   * traerla entera no amplia lo que el panel puede enviar a Bitget.
   */
  async catalogo(): Promise<ActivoOperable[]> {
    if (this.catalogoCache === null) {
      this.catalogoCache = await catalogoCompleto(this.cliente, MERCADOS[this.mercado]);
    }
    return this.catalogoCache;
  }

  /**
   * Pone un activo en una casilla, o la vacia. Devuelve las ocho ya resueltas.
   *
   * Lo que llega del renderer es un simbolo, y aqui se comprueba **contra el
   * catalogo del exchange** antes de guardarlo: un simbolo que Bitget no ofrece
   * en este mercado se rechaza en el acto, en vez de guardarse y convertirse en
   * una casilla que falla al planificar. Es la misma regla que el resto del
   * proceso principal -el renderer propone, la maquina comprueba-.
   *
   * El mismo activo no puede ocupar dos casillas. No es una manida: la pantalla
   * identifica el activo por su nombre corto, asi que dos casillas con BTC serian
   * dos botones llamados igual y el precio de uno se pintaria en los dos. Se dice
   * en que casilla esta ya, que es lo unico que el operador necesita saber.
   */
  async fijarRanura(indice: number, simbolo: string | null): Promise<(ActivoOperable | null)[]> {
    const ranuras = [...(await this.ranurasGuardadas())];
    if (indice < 0 || indice >= ranuras.length) {
      throw new Error(`La casilla ${indice + 1} no existe: el panel tiene ${ranuras.length}.`);
    }

    if (simbolo !== null) {
      const contrato = (await this.catalogo()).find((a) => a.simbolo === simbolo);
      if (contrato === undefined) {
        throw new Error(
          `Bitget no ofrece ${simbolo} en el mercado ${this.mercado}. No se cambió ninguna casilla.`
        );
      }

      const ocupada = ranuras.findIndex((s, i) => s === simbolo && i !== indice);
      if (ocupada !== -1) {
        throw new Error(
          `${contrato.etiqueta} ya está en la casilla ${ocupada + 1}. ` +
            'Vacíe esa casilla primero si quiere moverlo.'
        );
      }
    }

    ranuras[indice] = simbolo;
    this.ranurasCache = normalizarRanuras(ranuras, MERCADOS[this.mercado].simbolos);

    const enDisco: RanurasEnDisco = await cargarRanuras(this.rutas.activos);
    enDisco[this.mercado] = this.ranurasCache;
    await guardarRanuras(this.rutas.activos, enDisco);

    /*
     * Las casillas cambiaron: la vista resuelta que habia en memoria ya no vale.
     *
     * No se anuncia nada. `anunciar()` es el aviso de que cambio **la matriz de
     * cuentas** y publica el canal `panel:cuentas`; usarlo aqui diria que
     * cambiaron las cuentas cuando lo que cambio es el selector. Quien pidio el
     * cambio recibe las ocho casillas nuevas como respuesta, que es el unico
     * sitio donde hacen falta.
     */
    this.ranurasActivosCache = null;
    return this.ranuras();
  }

  /**
   * Precio de marca de cada activo. **Sin cachear**: es justo lo que cambia.
   *
   * Es el mismo precio con el que se dimensiona una apertura. Si la pantalla
   * enseñara el ultimo negociado y el plan usara el de marca, el operador veria
   * dos cifras distintas para lo mismo y no sabria cual creer.
   */
  async precios(): Promise<Record<string, string>> {
    return preciosDe(this.cliente, MERCADOS[this.mercado], await this.activos());
  }

  /** El simbolo de la API que corresponde a un activo de la pantalla. */
  async simboloDe(activoId: string): Promise<string | null> {
    return (await this.activos()).find((a) => a.id === activoId)?.simbolo ?? null;
  }

  /* ---------------- contrasena de paso ---------------- */

  /** ¿Hay contrasena de paso configurada? */
  hayPaso(): boolean {
    return this.vault?.tienePaso() ?? false;
  }

  /**
   * Comprueba la contrasena de paso antes de una operacion.
   *
   * Con el panel bloqueado responde `false` y no lanza: quien pregunta es la
   * pantalla de confirmacion, y un error ahi se veria como un fallo del panel
   * en lugar de como lo que es, que no hay sesion.
   */
  async comprobarPaso(contrasena: string): Promise<boolean> {
    if (this.vault === null) return false;
    return this.vault.comprobarPaso(contrasena);
  }

  /** Fija o cambia la contrasena de paso. Exige la sesion abierta. */
  async fijarPaso(contrasena: string): Promise<void> {
    const { vault } = this.exigirAbierta();
    await vault.fijarPaso(contrasena);
    await vault.guardar();
  }

  /* ---------------- apertura de operaciones ---------------- */

  /**
   * Lo que el motor necesita de una cuenta para poder operarla.
   *
   * Es el unico sitio por el que una credencial completa sale del vault, y no
   * cruza el IPC: se la queda el motor para firmar. Devuelve `null` -en vez de
   * lanzar- si la cuenta no esta, no tiene credencial o el panel esta
   * bloqueado, porque para el motor eso es un objetivo que se descarta con su
   * motivo, no un fallo del lote.
   */
  /**
   * Por que `cuentaEjecutable` diria que no.
   *
   * Existe para que el descarte del motor no llame «ya no está registrada» a
   * una cuenta que esta perfectamente y solo esta migrando a UTA. Sigue el
   * mismo orden de comprobaciones que `cuentaEjecutable`, para que las dos
   * respuestas no puedan separarse.
   */
  motivoNoEjecutable(cuentaId: string): 'transicion' | 'bloqueada' | 'desconocida' {
    if (this.vault === null || this.registro === null || this.vault.estaCerrado) return 'bloqueada';
    if (this.registro.cuenta(cuentaId) === undefined) return 'desconocida';
    if (this.enTransicion.has(cuentaId)) return 'transicion';
    return 'desconocida';
  }

  cuentaEjecutable(cuentaId: string): CuentaEjecutable | null {
    if (this.vault === null || this.registro === null || this.vault.estaCerrado) return null;

    const cuenta = this.registro.cuenta(cuentaId);
    if (cuenta === undefined) return null;

    /*
     * En mitad del cambio a UTA no se opera. Sale como objetivo descartado -que
     * es lo que significa `null` aqui- y no como fallo del lote: la cuenta esta
     * bien, solo que Bitget la esta moviendo de modelo y la superficie que
     * responde ahora puede dejar de hacerlo a mitad de la orden.
     */
    if (this.enTransicion.has(cuentaId)) return null;

    const credencial = this.credencialSellada(cuentaId);
    if (credencial === null) return null;

    /*
     * El modo de la ficha, que es el del **primer simbolo del mercado**.
     *
     * Ya no alimenta la apertura: desde el 26/08/2026 el modo lo elige el
     * operador en el panel y el motor lo comprueba contra el simbolo que se va a
     * operar. Aqui se conserva como ultimo recurso para las funciones que actuan
     * sobre una posicion existente -agregar margen, Take Profit-, y solo cuando
     * Bitget no informa el modo de la propia posicion.
     *
     * No vale para decidir con que modo se abre. En Bitget el modo es por
     * simbolo, asi que el de BTC no dice nada de SOL; usarlo para abrir es lo
     * que reconfiguraba activos en silencio.
     */
    const modoMargenApi = cuenta.modoMargen === 'aislado' ? 'isolated' : 'crossed';

    return {
      cuentaId,
      etiqueta: cuenta.etiqueta,
      credencial,
      saldoDisponible: this.saldos.get(cuentaId) ?? '0',
      modoMargen: modoMargenApi,
      ...(this.apalancamientos.has(cuentaId)
        ? { apalancamiento: this.apalancamientos.get(cuentaId) as ApalancamientoCuenta }
        : {})
    };
  }

  /**
   * El motor descubrio que esta cuenta estaba en la superficie contraria.
   *
   * ==========================================================================
   * Se persiste, y por eso el lote no vuelve a tropezar
   * ==========================================================================
   * Ocurre cuando el titular migra su cuenta a UTA entre dos usos del panel: lo
   * guardado dice `classic`, Bitget ya solo habla V3, y la primera casilla
   * falla. El motor lo comprueba contra `account/settings`, corrige y reenvia
   * —ver `MotorLotes.corregirSuperficie`—.
   *
   * Guardarlo aqui es lo que hace que la correccion valga para algo mas que esa
   * casilla: sin esto, las otras 99 del mismo lote volverian a fallar una por
   * una, cada una gastando su propia deteccion, y el barrido y el socket
   * seguirian yendo a la API equivocada hasta que alguien revalidara la
   * credencial a mano.
   *
   * El aviso a la pantalla solo sale si algo cambio de verdad: `actualizarModos`
   * devuelve `false` cuando ya estaba asi, y reescribir el archivo de cuentas en
   * cada casilla de un lote de trescientas seria una tormenta de escrituras.
   */
  alCorregirModo(cuentaId: string, modo: AccountMode, holdMode: HoldMode | null): void {
    if (this.registro === null) return;
    if (!this.registro.actualizarModos(cuentaId, { accountMode: modo, holdMode })) return;
    this.anunciar();
  }

  /** Avisa del avance de un lote en curso. Lo consume el evento `lote:progreso`. */
  alProgresarLote(oyente: (lote: Lote) => void): () => void {
    this.oyentesLote.add(oyente);
    return () => {
      this.oyentesLote.delete(oyente);
    };
  }

  /**
   * Avisa de que un lote acaba de tocar estas cuentas en Bitget.
   *
   * --------------------------------------------------------------------------
   * Quien escucha, y por que no lo hace la sesion misma
   * --------------------------------------------------------------------------
   * Lo consume el barrido, para adelantarles la relectura: acaban de cambiar de
   * saldo y de posiciones, y esperar su turno normal dejaria la matriz
   * enseñando lo de antes de abrir durante casi un minuto, justo cuando el
   * operador mira el informe para comprobar que salio bien.
   *
   * La sesion no releee nada por su cuenta, igual que no programa sus propios
   * reintentos: dice que cuentas tocan y quien sepa leerlas lo hara. Es lo que
   * permite que las pruebas comprueben el aviso sin montar un barrido, y que el
   * barrido siga siendo el unico sitio con calendario.
   */
  alTocarCuentas(oyente: (cuentaIds: readonly string[]) => void): () => void {
    this.oyentesCuentasTocadas.add(oyente);
    return () => {
      this.oyentesCuentasTocadas.delete(oyente);
    };
  }

  /**
   * Las cuentas de un lote terminado, sin las que se quedaron fuera.
   *
   * Las `omitida` son descartes del planificador: nunca se les envio nada, asi
   * que su saldo es el mismo de hace un segundo y adelantarles la lectura seria
   * gastar una peticion en confirmar que no ha pasado nada.
   *
   * Las `fallo` si entran. Un fallo dice que Bitget rechazo **esa** orden, no
   * que la cuenta este igual: en una apertura con Take Profit y margen, la
   * orden puede haber entrado y haber fallado la maniobra siguiente.
   */
  private avisarCuentasTocadas(lote: Lote): void {
    const ids = [
      ...new Set(lote.jobs.filter((j) => j.estado !== 'omitida').map((j) => j.cuentaId))
    ];
    if (ids.length === 0) return;
    for (const oyente of this.oyentesCuentasTocadas) oyente(ids);
  }

  /**
   * Calcula el plan de una apertura. **No envia ninguna orden.**
   *
   * El mercado no viene en la peticion: lo pone la configuracion del equipo. Si
   * el renderer pudiera elegirlo, un fallo de la pantalla podria mandar al
   * mercado real algo que se creia una prueba.
   */
  async planificarApertura(peticion: {
    simbolo: string;
    objetivos: { cuentaId: string; lado: Lado }[];
    margenInicial: string;
    apalancamiento: number;
    precioLimite: string | null;
    modoMargen: ModoMargenApi;
    margenAdicional?: string | null;
    takeProfitPorcentaje?: string | null;
  }): Promise<PlanApertura> {
    this.exigirAbierta();

    const plan = await this.motor.planificar({
      mercado: MERCADOS[this.mercado],
      simbolo: peticion.simbolo,
      objetivos: peticion.objetivos,
      margenInicial: peticion.margenInicial,
      apalancamiento: peticion.apalancamiento,
      precioLimite: peticion.precioLimite,
      modoMargen: peticion.modoMargen,
      margenAdicional: peticion.margenAdicional ?? null,
      takeProfitPorcentaje: peticion.takeProfitPorcentaje ?? null
    });

    this.purgarPlanes();
    this.planes.set(plan.id, plan);
    return plan;
  }

  /**
   * Calcula el plan de un cierre. **No envia ninguna orden.**
   *
   * Consulta las posiciones abiertas de cada cuenta seleccionada, de modo que
   * la confirmacion diga cuantas hay de verdad y cuales ya estaban cerradas.
   */
  async planificarCierre(peticion: {
    simbolo: string;
    objetivos: { cuentaId: string; lado: Lado }[];
  }): Promise<PlanCierre> {
    this.exigirAbierta();

    const plan = await this.motor.planificarCierre({
      mercado: MERCADOS[this.mercado],
      simbolo: peticion.simbolo,
      objetivos: peticion.objetivos
    });

    this.purgarPlanes();
    this.planesCierre.set(plan.id, plan);
    return plan;
  }

  /**
   * Envia un plan de cierre ya aprobado.
   *
   * A diferencia de la apertura, el plan **no caduca**: un cierre sigue siendo
   * el mismo cierre pasen los minutos que pasen, porque no lleva dentro un
   * precio con el que se calculo nada. Lo que pudo cambiar es el tamano de la
   * posicion, y de eso se encarga Bitget al cerrar «lo que haya».
   */
  async ejecutarCierre(
    planId: string,
    soloEstos?: { cuentaId: string; lado: Lado }[]
  ): Promise<Lote> {
    this.exigirAbierta();

    const plan = this.planesCierre.get(planId);
    if (plan === undefined) {
      throw new ErrorPlan(
        'plan-desconocido',
        'Ese plan ya no existe. Vuelva a revisar la operación antes de enviarla.'
      );
    }

    const oids =
      soloEstos === undefined
        ? undefined
        : plan.entradas
            .filter((e) => soloEstos.some((s) => s.cuentaId === e.cuentaId && s.lado === e.lado))
            .map((e) => e.clientOid);

    const lote = await this.motor.ejecutarCierre(plan, oids);

    if (soloEstos === undefined && lote.jobs.every((j) => j.estado !== 'fallo')) {
      this.planesCierre.delete(planId);
    }

    return lote;
  }

  /**
   * Calcula donde queda el Take Profit de cada posicion abierta. **No coloca nada.**
   *
   * --------------------------------------------------------------------------
   * Existio, se retiro el 26/08/2026, y vuelve con dos cerrojos
   * --------------------------------------------------------------------------
   * Se quito porque el mismo valor podia salir dos veces sobre la misma
   * posicion: una con la apertura, que ya lo lleva dentro, y otra por este
   * camino. El cliente necesita poder ponerlo y quitarlo sobre lo que ya esta
   * abierto -una posicion que quedo sin el, o un objetivo que ha cambiado-, asi
   * que vuelve, pero no como estaba:
   *
   *  1. **Sustituye, no anade.** El plan lee lo que Bitget tiene puesto y lo
   *     cancela antes de colocar el nuevo, de modo que una casilla nunca acaba
   *     con dos ordenes de cierre. Ver `MotorLotes.ejecutarTakeProfit`.
   *  2. **Campo propio en la pantalla.** El porcentaje que sale con la apertura
   *     y el que se aplica despues son dos campos distintos, asi que el valor
   *     que quedo escrito para abrir no se puede reenviar por descuido.
   *
   * El porcentaje es ganancia sobre el margen inicial, no movimiento del precio:
   * el precio de cada posicion sale de su entrada y su apalancamiento reales.
   * Ver `domain/precio-take-profit.ts`.
   */
  async planificarTakeProfit(peticion: {
    simbolo: string;
    objetivos: { cuentaId: string; lado: Lado }[];
    porcentaje: string;
  }): Promise<PlanTakeProfit> {
    this.exigirAbierta();

    const plan = await this.motor.planificarTakeProfit({
      mercado: MERCADOS[this.mercado],
      simbolo: peticion.simbolo,
      objetivos: peticion.objetivos,
      porcentaje: peticion.porcentaje
    });

    this.purgarPlanes();
    this.planesTp.set(plan.id, plan);
    return plan;
  }

  /**
   * Coloca los Take Profit de un plan aprobado.
   *
   * No caduca por tiempo, pero **si por precio**: el objetivo se calculo con la
   * entrada de cada posicion, que no cambia. Lo que si cambiaria es que el
   * operador reposicione entre planificar y confirmar; en ese caso el precio de
   * entrada seria otro y conviene volver a planificar.
   */
  async ejecutarTakeProfit(
    planId: string,
    soloEstos?: { cuentaId: string; lado: Lado }[]
  ): Promise<Lote> {
    this.exigirAbierta();

    const plan = this.planesTp.get(planId);
    if (plan === undefined) {
      throw new ErrorPlan(
        'plan-desconocido',
        'Ese plan ya no existe. Vuelva a revisar la operación antes de enviarla.'
      );
    }

    const lote = await this.motor.ejecutarTakeProfit(plan, this.oidsDe(plan.entradas, soloEstos));

    /*
     * El Take Profit entra en el monitor ahora, no en el proximo barrido, y con
     * su porcentaje: Bitget solo devuelve el precio de disparo, asi que el «30 %»
     * del distintivo no se puede recuperar de una relectura. Es lo mismo que
     * hace la apertura al colocarlo. Ver `ponerTakeProfitTrasAbrir`.
     */
    for (const j of lote.jobs) {
      if (j.estado !== 'exito') continue;
      const entrada = plan.entradas.find((e) => e.cuentaId === j.cuentaId && e.lado === j.lado);
      if (entrada === undefined) continue;

      this.posiciones.fijarTakeProfit(j.cuentaId, plan.simbolo, j.lado, {
        precio: entrada.precioDisparo,
        porcentaje: Number(plan.porcentaje),
        planId: j.ordenId ?? ''
      });
    }

    if (soloEstos === undefined && lote.jobs.every((j) => j.estado !== 'fallo')) {
      this.planesTp.delete(planId);
    }

    return lote;
  }

  planTakeProfit(planId: string): PlanTakeProfit | undefined {
    return this.planesTp.get(planId);
  }

  /**
   * Calcula cuanto margen se mueve en cada posicion. **No envia nada.**
   *
   * --------------------------------------------------------------------------
   * Agregar y quitar, y por que se puede sostener esta vez
   * --------------------------------------------------------------------------
   * Este es el camino que causo la incidencia del 26/08/2026: una posicion
   * acabo con 2 USDT de margen donde el operador habia escrito 1, porque el
   * importe salio con la apertura **y** por este canal, y `set-margin` es la
   * unica peticion del panel sin identificador propio que rechace el repetido.
   *
   * Vuelve porque el cliente lo necesita -una posicion abierta a la que hay que
   * darle colchon, o quitarselo- y con lo que faltaba entonces:
   *
   *  - el importe de la apertura y el de este ajuste son **campos distintos**,
   *    asi que el que quedo escrito para abrir no se reenvia solo;
   *  - la confirmacion enseña `margen actual → resultante` leido de Bitget, de
   *    modo que aplicar dos veces se ve antes de enviar, no despues;
   *  - `direccion` decide el signo en el motor, no un `-` tecleado.
   *
   * Comprueba lo critico antes de salir a la red: que exista la posicion, que
   * este en margen aislado -Bitget no admite otra cosa-, que haya saldo si se
   * agrega y que quede margen si se retira.
   */
  async planificarMargen(peticion: {
    simbolo: string;
    objetivos: { cuentaId: string; lado: Lado }[];
    cantidad: string;
    direccion: DireccionMargen;
  }): Promise<PlanMargen> {
    this.exigirAbierta();

    const plan = await this.motor.planificarMargen({
      mercado: MERCADOS[this.mercado],
      simbolo: peticion.simbolo,
      objetivos: peticion.objetivos,
      cantidad: peticion.cantidad,
      direccion: peticion.direccion
    });

    this.purgarPlanes();
    this.planesMargen.set(plan.id, plan);
    return plan;
  }

  /** Mueve el margen de un plan aprobado: lo agrega o lo retira. */
  async ejecutarMargen(
    planId: string,
    soloEstos?: { cuentaId: string; lado: Lado }[]
  ): Promise<Lote> {
    this.exigirAbierta();

    const plan = this.planesMargen.get(planId);
    if (plan === undefined) {
      throw new ErrorPlan(
        'plan-desconocido',
        'Ese plan ya no existe. Vuelva a revisar la operación antes de enviarla.'
      );
    }

    const lote = await this.motor.ejecutarMargen(plan, this.oidsDe(plan.entradas, soloEstos));

    /*
     * Solo el que de verdad entro, y con el signo de la entrada.
     *
     * El distintivo MGA existe para saber si la posicion lleva margen adicional
     * y cuanto, asi que anotar uno que fallo lo encenderia sobre una posicion
     * que no lo lleva. Y una retirada anotada en positivo diria lo contrario de
     * lo que paso: `EntradaMargen.cantidad` ya viene negativa cuando se retira.
     */
    for (const j of lote.jobs) {
      if (j.estado !== 'exito') continue;
      const entrada = plan.entradas.find((e) => e.cuentaId === j.cuentaId && e.lado === j.lado);
      if (entrada === undefined) continue;

      this.posiciones.anotarAporte(j.cuentaId, plan.simbolo, j.lado, {
        margenAdicional: entrada.cantidad
      });
    }

    if (soloEstos === undefined && lote.jobs.every((j) => j.estado !== 'fallo')) {
      this.planesMargen.delete(planId);
    }

    return lote;
  }

  planMargen(planId: string): PlanMargen | undefined {
    return this.planesMargen.get(planId);
  }

  /** Un plan calculado, si sigue vigente. */
  plan(planId: string): PlanApertura | undefined {
    return this.planes.get(planId);
  }

  planCierre(planId: string): PlanCierre | undefined {
    return this.planesCierre.get(planId);
  }

  /**
   * Averigua que Take Profit hay puesto en cada casilla. **No quita nada.**
   *
   * Lee los planes que Bitget tiene puestos en vez de recordar los que coloco
   * el panel: el operador tambien los pone y los quita desde la app, y esos
   * tambien tiene que poder quitarlos desde aqui.
   */
  async planificarQuitarTakeProfit(peticion: {
    simbolo: string;
    objetivos: { cuentaId: string; lado: Lado }[];
  }): Promise<PlanQuitarTakeProfit> {
    this.exigirAbierta();

    const plan = await this.motor.planificarQuitarTakeProfit({
      mercado: MERCADOS[this.mercado],
      simbolo: peticion.simbolo,
      objetivos: peticion.objetivos
    });

    this.purgarPlanes();
    this.planesQuitarTp.set(plan.id, plan);
    return plan;
  }

  /** Quita los Take Profit de un plan aprobado. */
  async ejecutarQuitarTakeProfit(
    planId: string,
    soloEstos?: { cuentaId: string; lado: Lado }[]
  ): Promise<Lote> {
    this.exigirAbierta();

    const plan = this.planesQuitarTp.get(planId);
    if (plan === undefined) {
      throw new ErrorPlan(
        'plan-desconocido',
        'Ese plan ya no existe. Vuelva a revisar la operación antes de enviarla.'
      );
    }

    const oids =
      soloEstos === undefined
        ? undefined
        : plan.entradas
            .filter((e) => soloEstos.some((s) => s.cuentaId === e.cuentaId && s.lado === e.lado))
            .map((e) => e.clientOid);

    const lote = await this.motor.ejecutarQuitarTakeProfit(plan, oids);

    if (soloEstos === undefined && lote.jobs.every((j) => j.estado !== 'fallo')) {
      this.planesQuitarTp.delete(planId);
    }

    return lote;
  }

  planQuitarTakeProfit(planId: string): PlanQuitarTakeProfit | undefined {
    return this.planesQuitarTp.get(planId);
  }

  /**
   * Prepara el ajuste de apalancamiento. **No envia nada.**
   *
   * No necesita que haya posicion: es configuracion de la cuenta. Y fijar el
   * mismo valor dos veces no tiene consecuencia, asi que es la mas benigna de
   * las cinco funciones.
   */
  async planificarApalancamiento(peticion: {
    simbolo: string;
    objetivos: { cuentaId: string; lado: Lado }[];
    apalancamiento: number;
  }): Promise<PlanApalancamiento> {
    this.exigirAbierta();

    const plan = await this.motor.planificarApalancamiento({
      mercado: MERCADOS[this.mercado],
      simbolo: peticion.simbolo,
      objetivos: peticion.objetivos,
      apalancamiento: peticion.apalancamiento
    });

    this.purgarPlanes();
    this.planesApalancamiento.set(plan.id, plan);
    return plan;
  }

  async ejecutarApalancamiento(
    planId: string,
    soloEstos?: { cuentaId: string; lado: Lado }[]
  ): Promise<Lote> {
    this.exigirAbierta();

    const plan = this.planesApalancamiento.get(planId);
    if (plan === undefined) {
      throw new ErrorPlan(
        'plan-desconocido',
        'Ese plan ya no existe. Vuelva a revisar la operación antes de enviarla.'
      );
    }

    const oids = this.oidsDe(plan.entradas, soloEstos);
    const lote = await this.motor.ejecutarApalancamiento(plan, oids);

    if (soloEstos === undefined && lote.jobs.every((j) => j.estado !== 'fallo')) {
      this.planesApalancamiento.delete(planId);
    }
    return lote;
  }

  planApalancamiento(planId: string): PlanApalancamiento | undefined {
    return this.planesApalancamiento.get(planId);
  }

  /**
   * Traduce «cuenta y lado» a los identificadores del primer envio.
   *
   * La pantalla no conoce los `clientOid` ni tiene por que: hacer la traduccion
   * aqui es lo que garantiza que un reintento reutiliza los mismos y no unos
   * nuevos.
   */
  private oidsDe(
    entradas: readonly { cuentaId: string; lado: Lado; clientOid: string }[],
    soloEstos?: { cuentaId: string; lado: Lado }[]
  ): string[] | undefined {
    if (soloEstos === undefined) return undefined;
    return entradas
      .filter((e) => soloEstos.some((s) => s.cuentaId === e.cuentaId && s.lado === e.lado))
      .map((e) => e.clientOid);
  }

  /**
   * Envia un plan ya aprobado por el operador.
   *
   * El plan se identifica por su `id` y se lee de la memoria del proceso
   * principal, no del mensaje: lo que sale hacia Bitget es exactamente lo que
   * se calculo y se enseno.
   */
  async ejecutarApertura(
    planId: string,
    soloEstos?: { cuentaId: string; lado: Lado }[]
  ): Promise<Lote> {
    this.exigirAbierta();

    const plan = this.planes.get(planId);
    if (plan === undefined) {
      throw new ErrorPlan(
        'plan-desconocido',
        'Ese plan ya no existe. Vuelva a revisar la operación antes de enviarla.'
      );
    }

    if (this.vencido(plan)) {
      this.planes.delete(planId);
      throw new ErrorPlan(
        'plan-vencido',
        'El plan caducó: el precio con el que se calcularon las cantidades ya no es el de ahora. ' +
          'Vuelva a revisar la operación.'
      );
    }

    /*
     * Un plan impedido no se envia, ni entero ni a trozos.
     *
     * La pantalla ya lo bloquea y ademas enseña el motivo, pero esta es la
     * comprobacion que de verdad lo garantiza: el renderer no puede ser el
     * unico freno de nada que mueva dinero. Vale igual para el reintento -que
     * llega con `soloEstos` y podria colarse por la puerta de atras- porque el
     * impedimento es del lote, no de las casillas que se reintentan.
     *
     * El plan **no se borra**: el operador va a corregir los importes o a
     * desmarcar casillas y a planificar otra vez, y borrarlo aqui solo cambiaria
     * el mensaje que ve si vuelve a intentarlo.
     */
    if (plan.impedimento !== null) {
      throw new ErrorPlan('plan-impedido', plan.impedimento.mensaje);
    }

    /*
     * El reintento llega por cuenta y lado, no por `clientOid`: la pantalla no
     * tiene por que conocer los identificadores de orden, y traducirlos aqui
     * garantiza que se reutilizan los mismos y no unos nuevos.
     */
    const oids =
      soloEstos === undefined
        ? undefined
        : plan.entradas
            .filter((e) => soloEstos.some((s) => s.cuentaId === e.cuentaId && s.lado === e.lado))
            .map((e) => e.clientOid);

    /*
     * Las casillas de esta apertura pasan a merecer socket **antes** de enviar
     * nada. Si se promovieran despues, el primer empujon -el que trae la
     * posicion recien abierta- llegaria antes que la conexion y se perderia; la
     * posicion no apareceria hasta el barrido, hasta 45 segundos mas tarde.
     */
    this.ultimosObjetivos = new Set(plan.entradas.map((e) => e.cuentaId));
    this.anunciar();

    const lote = await this.motor.ejecutar(plan, oids);

    /*
     * Las posiciones que la apertura acaba de abrir, **antes** de añadir al
     * informe ninguna fila derivada.
     *
     * Se calcula una vez y se pasa a las dos maniobras siguientes a proposito:
     * cada una añade sus propias filas a `lote.jobs`, asi que releer la lista
     * despues haria que el margen adicional creyera que las filas de Take
     * Profit son posiciones abiertas y les intentara agregar margen.
     *
     * `indeterminada` entra junto a `exito`: si esa orden si entro, su posicion
     * necesita el Take Profit y el margen igual que las demas. Quien decide si
     * la posicion existe es la lectura que hace cada planificador, no lo que
     * respondiera el envio.
     */
    const abiertas = lote.jobs.filter((j) => j.estado === 'exito' || j.estado === 'indeterminada');

    /*
     * El Take Profit y el margen adicional de la **misma** confirmacion.
     *
     * Van aqui y no dentro del motor porque son maniobras distintas sobre
     * endpoints distintos, y el motor esta construido para una accion por lote.
     * Lo que las une es la aprobacion del operador, que es cosa de la sesion.
     *
     * El Take Profit primero: si algo se tuerce a mitad, la posicion queda al
     * menos protegida. El margen adicional aleja la liquidacion, pero no la
     * cierra en beneficio.
     */
    if (plan.takeProfitPorcentaje !== null) {
      await this.ponerTakeProfitTrasAbrir(plan, lote, abiertas);
    }
    if (plan.margenAdicional !== null) {
      await this.agregarMargenTrasAbrir(plan, lote, abiertas);
    }

    this.anotarMargenInicial(plan, abiertas);

    /*
     * Un plan solo se ejecuta entero una vez. Se conserva mientras queden
     * cuentas por reintentar, y se retira cuando ya no hay nada que reintentar.
     */
    if (soloEstos === undefined && lote.jobs.every((j) => j.estado !== 'fallo')) {
      this.planes.delete(planId);
    }

    return lote;
  }

  /**
   * Anota en el almacen el margen que el operador acaba de comprometer.
   *
   * Es lo unico que hace que la columna «M. inicial» del monitor tenga un
   * numero: Bitget no lo tiene. Se toma de `plan.entradas`, que es la cantidad
   * exacta que se aprobo en la confirmacion, y **no** del margen que devuelva
   * despues la posicion -ese incluye el adicional y se mueve solo-.
   *
   * Se llama al final, despues del Take Profit y del margen adicional, por una
   * razon de tiempos: esas dos maniobras releen la posicion hasta que aparece en
   * `/position/all-position`, asi que para cuando llega aqui, la posicion suele
   * existir ya en Bitget. Importa porque una foto del barrido que llegue antes
   * que la posicion se lleva el aporte por delante -ver la poda de huerfanos en
   * `AlmacenPosiciones`-, y este orden reduce esa ventana a casi nada.
   *
   * Entran las `indeterminada` junto a las `exito`, como en el resto de la
   * apertura: si esa orden si entro, su posicion comprometio ese margen. Si no
   * entro, la poda del almacen retira el aporte en la siguiente foto.
   */
  private anotarMargenInicial(plan: PlanApertura, abiertas: readonly Job[]): void {
    for (const job of abiertas) {
      const entrada = plan.entradas.find((e) => e.cuentaId === job.cuentaId && e.lado === job.lado);
      if (entrada === undefined) continue;

      this.posiciones.anotarAporte(job.cuentaId, plan.simbolo, job.lado, {
        margenInicial: entrada.margenReal
      });
    }
  }

  /**
   * Coloca el Take Profit de las posiciones que la apertura acaba de abrir.
   *
   * --------------------------------------------------------------------------
   * Por que el precio se calcula aqui y no en la confirmacion
   * --------------------------------------------------------------------------
   * El plan enseño un precio de disparo **estimado**, calculado con el precio
   * de referencia porque en ese momento la posicion no existia. El que se envia
   * se calcula ahora, desde el precio de entrada real que devuelve Bitget: es
   * el unico con el que «35%» significa el 35% que el operador espera. Con una
   * orden a mercado los dos se parecen; con el mercado moviendose, no tienen
   * por que.
   *
   * --------------------------------------------------------------------------
   * Los Take Profit entran en el informe como trabajos propios
   * --------------------------------------------------------------------------
   * No se doblan en el mensaje del trabajo de apertura, y la razon es concreta:
   * el informe **descarta los mensajes de los trabajos correctos** -solo lee
   * los de fallo e indeterminada, ver `aResultado` en el renderer-. Un Take
   * Profit fallido escrito en el mensaje de una apertura correcta seria
   * invisible, y una posicion abierta que el operador cree protegida y no lo
   * esta es exactamente el fallo que este cambio venia a quitar.
   *
   * Por eso cada Take Profit aparece como su propia fila -«Sub-01 · TP»- con su
   * propio desenlace. La apertura conserva el suyo: que el Take Profit falle no
   * convierte en fallida una posicion que si se abrio.
   */
  private async ponerTakeProfitTrasAbrir(
    plan: PlanApertura,
    lote: Lote,
    abiertas: readonly Job[]
  ): Promise<void> {
    const porcentaje = plan.takeProfitPorcentaje;
    if (porcentaje === null) return;
    if (abiertas.length === 0) return;

    const objetivos = abiertas.map((j) => ({ cuentaId: j.cuentaId, lado: j.lado }));
    const estadoApertura = new Map(abiertas.map((j) => [`${j.cuentaId}|${j.lado}`, j.estado]));

    let planTp: PlanTakeProfit;
    try {
      /*
       * La posicion puede tardar un instante en aparecer despues de que la
       * orden entre. Se relee antes de dar ninguna por ausente: descartar aqui
       * por «no hay posicion» dejaria sin Take Profit una posicion que acaba de
       * abrirse, que es justo lo que no puede pasar.
       */
      planTp = await this.motor.planificarTakeProfit({
        mercado: MERCADOS[this.mercado],
        simbolo: plan.simbolo,
        objetivos,
        porcentaje
      });

      for (
        let intento = 1;
        intento < INTENTOS_POSICION && planTp.descartes.some((d) => d.motivo === 'sin-posicion');
        intento += 1
      ) {
        await this.dormir(ESPERA_POSICION_MS);
        planTp = await this.motor.planificarTakeProfit({
          mercado: MERCADOS[this.mercado],
          simbolo: plan.simbolo,
          objetivos,
          porcentaje
        });
      }
    } catch (e) {
      /*
       * Ni siquiera se pudo calcular. Las posiciones estan abiertas y sin Take
       * Profit, y eso tiene que verse: una fila por casilla diciendolo.
       */
      for (const job of abiertas) {
        lote.jobs.push(
          this.trabajoDerivado(
            job,
            'TP',
            'fallo',
            null,
            `No se pudo calcular el Take Profit: ${textoError(e)}`
          )
        );
      }
      return;
    }

    if (planTp.entradas.length > 0) {
      const loteTp = await this.motor.ejecutarTakeProfit(planTp);
      for (const j of loteTp.jobs) {
        const original = abiertas.find((a) => a.cuentaId === j.cuentaId && a.lado === j.lado);
        if (original === undefined) continue;

        /*
         * Al motivo que da Bitget se le añade que hacer. «Parameter
         * verification exception» en una fila llamada «Sub-01 · TP» no le dice
         * al operador que tiene una posicion abierta y desprotegida.
         */
        const motivo = j.mensaje ?? mensajeTp(j.estado);
        lote.jobs.push(
          this.trabajoDerivado(
            original,
            'TP',
            j.estado,
            j.ordenId,
            j.estado === 'fallo' && !motivo.includes(SIN_PROTECCION)
              ? `${motivo} ${SIN_PROTECCION}`
              : motivo
          )
        );

        /*
         * El Take Profit entra en el monitor ahora, no dentro de 45 segundos.
         *
         * Y con su porcentaje, que es el dato que el barrido no puede recuperar:
         * Bitget solo devuelve el precio de disparo. Anotarlo aqui es lo que
         * hace que el distintivo diga «30 %» en vez de un guion, y el almacen lo
         * conserva mientras el precio no cambie.
         */
        if (j.estado !== 'exito') continue;
        const entrada = planTp.entradas.find((e) => e.cuentaId === j.cuentaId && e.lado === j.lado);
        if (entrada === undefined) continue;

        this.posiciones.fijarTakeProfit(j.cuentaId, plan.simbolo, j.lado, {
          precio: entrada.precioDisparo,
          porcentaje: Number(porcentaje),
          planId: j.ordenId ?? ''
        });
      }
    }

    /*
     * Un descarte del Take Profit sobre una posicion que **si** se abrio es un
     * fallo, no una omision: quedo abierta y desprotegida. Sobre una apertura
     * indeterminada es una omision, porque lo mas probable es que no llegara a
     * abrirse nada.
     */
    for (const d of planTp.descartes) {
      const original = abiertas.find((a) => a.cuentaId === d.cuentaId && a.lado === d.lado);
      if (original === undefined) continue;
      const abrio = estadoApertura.get(`${d.cuentaId}|${d.lado}`) === 'exito';
      lote.jobs.push(
        this.trabajoDerivado(
          original,
          'TP',
          abrio ? 'fallo' : 'omitida',
          null,
          abrio ? `${d.mensaje} ${SIN_PROTECCION}` : d.mensaje
        )
      );
    }
  }

  /**
   * Una fila derivada de la apertura en su informe: el Take Profit o el margen.
   *
   * Cada una va con su propio desenlace y su propio rotulo -«Sub-01 · TP»,
   * «Sub-01 · MGA»- en vez de doblarse en el mensaje de la apertura, porque el
   * informe **descarta los mensajes de los trabajos correctos**: un Take Profit
   * fallido escrito dentro de una apertura correcta seria invisible.
   */
  private trabajoDerivado(
    apertura: Job,
    sufijo: 'TP' | 'MGA',
    estado: Job['estado'],
    ordenId: string | null,
    mensaje: string
  ): Job {
    return {
      cuentaId: apertura.cuentaId,
      lado: apertura.lado,
      etiqueta: `${apertura.etiqueta} · ${sufijo}`,
      /*
       * Sin `clientOid`: el de estas maniobras pertenece a su propio plan, que
       * no es el que la pantalla reenviaria al reintentar. Dejarlo vacio es lo
       * mismo que ya se hace con los descartes.
       */
      clientOid: '',
      estado,
      codigoBitget: null,
      mensaje,
      ordenId
    };
  }

  /**
   * Agrega a las posiciones recien abiertas el margen adicional aprobado.
   *
   * --------------------------------------------------------------------------
   * Lo que puede fallar aqui ya no incluye el caso previsible
   * --------------------------------------------------------------------------
   * Pedir margen adicional en margen cruzado aborta el plan **antes de abrir
   * nada** -ver `MotorLotes.planificar`-, que es lo que pidio el cliente: en
   * cruzado no existe «agregar margen» porque el margen sale del saldo total de
   * la cuenta, y abrir igualmente dejaria la posicion con menos colchon del que
   * se aprobo. Asi que aqui solo quedan fallos del envio con la posicion ya
   * abierta, y esos se cuentan como fallo y se dicen.
   *
   * La espera antes de darse por vencido es la misma que la del Take Profit y
   * por la misma razon: la posicion tarda un instante en aparecer en
   * `/position/all-position` despues de que la orden entre.
   */
  private async agregarMargenTrasAbrir(
    plan: PlanApertura,
    lote: Lote,
    abiertas: readonly Job[]
  ): Promise<void> {
    const cantidad = plan.margenAdicional;
    if (cantidad === null) return;
    if (abiertas.length === 0) return;

    const objetivos = abiertas.map((j) => ({ cuentaId: j.cuentaId, lado: j.lado }));
    const estadoApertura = new Map(abiertas.map((j) => [`${j.cuentaId}|${j.lado}`, j.estado]));

    let planMargen: PlanMargen;
    try {
      planMargen = await this.motor.planificarMargen({
        mercado: MERCADOS[this.mercado],
        simbolo: plan.simbolo,
        objetivos,
        cantidad,
        /* La apertura solo aporta margen; retirarlo es una accion del operador. */
        direccion: 'agregar'
      });

      for (
        let intento = 1;
        intento < INTENTOS_POSICION &&
        planMargen.descartes.some((d) => d.motivo === 'sin-posicion');
        intento += 1
      ) {
        await this.dormir(ESPERA_POSICION_MS);
        planMargen = await this.motor.planificarMargen({
          mercado: MERCADOS[this.mercado],
          simbolo: plan.simbolo,
          objetivos,
          cantidad,
          direccion: 'agregar'
        });
      }
    } catch (e) {
      for (const job of abiertas) {
        lote.jobs.push(
          this.trabajoDerivado(
            job,
            'MGA',
            'fallo',
            null,
            `No se pudo calcular el margen adicional: ${textoError(e)} ${SIN_MARGEN_EXTRA}`
          )
        );
      }
      return;
    }

    if (planMargen.entradas.length > 0) {
      const loteMargen = await this.motor.ejecutarMargen(planMargen);
      for (const j of loteMargen.jobs) {
        const original = abiertas.find((a) => a.cuentaId === j.cuentaId && a.lado === j.lado);
        if (original === undefined) continue;

        const motivo = j.mensaje ?? mensajeMargen(j.estado);
        lote.jobs.push(
          this.trabajoDerivado(
            original,
            'MGA',
            j.estado,
            j.ordenId,
            j.estado === 'fallo' && !motivo.includes(SIN_MARGEN_EXTRA)
              ? `${motivo} ${SIN_MARGEN_EXTRA}`
              : motivo
          )
        );

        /*
         * Solo el que de verdad entro. El margen adicional es la unica peticion
         * del panel sin identificador propio -ver `PlanKind`-, asi que anotar
         * uno que fallo dejaria el distintivo MGA encendido sobre una posicion
         * que no lo lleva, y ese distintivo existe justamente para saber si lo
         * lleva.
         */
        if (j.estado === 'exito') {
          this.posiciones.anotarAporte(j.cuentaId, plan.simbolo, j.lado, {
            margenAdicional: cantidad
          });
        }
      }
    }

    for (const d of planMargen.descartes) {
      const original = abiertas.find((a) => a.cuentaId === d.cuentaId && a.lado === d.lado);
      if (original === undefined) continue;
      const abrio = estadoApertura.get(`${d.cuentaId}|${d.lado}`) === 'exito';
      lote.jobs.push(
        this.trabajoDerivado(
          original,
          'MGA',
          abrio ? 'fallo' : 'omitida',
          null,
          abrio ? `${d.mensaje} ${SIN_MARGEN_EXTRA}` : d.mensaje
        )
      );
    }
  }

  private vencido(plan: PlanApertura): boolean {
    return this.ahoraMs() - Date.parse(plan.creadoEn) > PLAN_VIGENCIA_MS;
  }

  /** Los planes caducados no se guardan: son cantidades calculadas con un precio viejo. */
  private purgarPlanes(): void {
    for (const [id, plan] of this.planes) {
      if (this.vencido(plan)) this.planes.delete(id);
    }
  }

  /**
   * El unico sitio que escribe `saldos`.
   *
   * Hay dos fuentes -la verificacion de la credencial y el barrido- y conviene
   * que sigan teniendo un solo escritor: es el mapa que pinta la matriz y del
   * que sale `saldoDisponible` para decidir si una apertura cabe, asi que dos
   * caminos hacia el serian dos sitios donde olvidarse de la traza o del aviso.
   */
  private escribirSaldo(cuentaId: string, disponible: string): void {
    this.saldos.set(cuentaId, disponible);
  }

  /**
   * Anota el saldo que vino con la verificacion.
   *
   * Bitget lo devuelve en la misma respuesta que confirma la credencial, asi
   * que llegar hasta aqui no ha costado ninguna peticion adicional.
   */
  private anotarSaldo(cuentaId: string, verificacion: ResultadoVerificacion): void {
    this.apalancamientos.set(cuentaId, {
      long: verificacion.apalancamientoLong,
      short: verificacion.apalancamientoShort,
      cruzado: verificacion.apalancamientoCruzado
    });
    if (verificacion.saldoDisponible === null) return;
    this.escribirSaldo(cuentaId, verificacion.saldoDisponible);
  }

  /**
   * Alta de una subcuenta: verificar primero, guardar despues.
   *
   * El orden importa. Guardar una credencial sin verificarla dejaria en el
   * panel una cuenta que parece operativa y que fallara la primera vez que se
   * le mande una orden -es decir, con dinero de por medio-. RF-001.
   */
  async agregar(alta: AltaCuenta): Promise<ResultadoAlta> {
    const { vault, registro } = this.exigirAbierta();

    const etiqueta = alta.etiqueta.trim();
    const grupoNombre = alta.grupoNombre.trim();
    if (etiqueta === '' || grupoNombre === '') {
      return {
        ok: false,
        veredicto: null,
        motivo: 'Falta el nombre de la subcuenta o el de la cuenta principal.',
        advertencias: [],
        cuenta: null
      };
    }

    /* Antes de gastar dos peticiones del cupo en una credencial que no cabría. */
    const estorbo = registro.comprobarCabida(grupoNombre, etiqueta, alta.casilla);
    if (estorbo !== null) {
      return {
        ok: false,
        veredicto: null,
        motivo: estorbo.message,
        advertencias: [],
        cuenta: null
      };
    }

    /*
     * Los tres campos se recortan, la passphrase incluida.
     *
     * Era el unico que entraba tal cual, y eso hacia que un espacio pegado al
     * copiar y pegar -o el espacio duro que arrastran las notas y los PDF-
     * llegara a Bitget dentro de la cabecera ACCESS-PASSPHRASE. La respuesta es
     * 40005 o 40012, que el panel traduce a «la passphrase no coincide»: el
     * operador ve la clave correcta en pantalla y un error que dice lo
     * contrario. La passphrase de Bitget es alfanumerica, asi que un espacio en
     * los extremos nunca forma parte de ella y recortarlo no puede quitar nada
     * legitimo.
     */
    const credencial: Credencial = {
      apiKey: alta.apiKey.trim(),
      secretKey: alta.secretKey.trim(),
      passphrase: alta.passphrase.trim()
    };

    let verificacion: ResultadoVerificacion;
    try {
      verificacion = await verificarCredencial(this.cliente, credencial, {
        mercado: MERCADOS[this.mercado]
      });
    } catch (e) {
      /*
       * Solo llega aqui un fallo de red o un limite de peticiones: la
       * verificacion devuelve veredicto en vez de lanzar cuando la credencial
       * es el problema. No se guarda nada, porque no se sabe si sirve.
       */
      return {
        ok: false,
        veredicto: null,
        motivo:
          e instanceof ErrorBitget
            ? `No se pudo comprobar la credencial: ${e.message}`
            : 'No se pudo comprobar la credencial: no hay conexion con Bitget.',
        advertencias: [],
        cuenta: null
      };
    }

    if (verificacion.veredicto !== 'valida') {
      return {
        ok: false,
        veredicto: verificacion.veredicto,
        motivo: verificacion.motivo,
        advertencias: verificacion.advertencias.map((a) => ({
          codigo: a.codigo,
          mensaje: a.mensaje
        })),
        cuenta: null
      };
    }

    /*
     * El UID va aqui y no antes por una razon de orden: es Bitget quien lo
     * dice, y hasta que la verificacion no responde no se sabe cual es. Es lo
     * que permite reconocer una subcuenta que se vuelve a registrar con otro
     * nombre en vez de duplicarla.
     */
    const cuentaId = registro.reservarId(grupoNombre, etiqueta, verificacion.uid ?? undefined);
    const publica = vault.agregar({
      cuentaId,
      apiKey: credencial.apiKey,
      secretKey: credencial.secretKey,
      passphrase: credencial.passphrase,
      permisos: {
        verificadoEn: new Date().toISOString(),
        authorities: verificacion.permisos,
        ipsPermitidas: verificacion.ipsLigadas
      }
    });

    /*
     * La casilla que eligió el operador se reserva aquí.
     *
     * `comprobarCabida` ya la miró antes de salir a la red, pero solo mirar no
     * reserva, y entre las dos comprobaciones ha pasado la verificación contra
     * Bitget —que es la que dice el UID, y con él, cuál es la ficha de esta
     * subcuenta—. Con ese dato el registro puede distinguir «la casilla 7 la
     * ocupa otra» de «la ocupo yo mismo, que estoy rotando mi clave».
     *
     * Un choque aquí rechaza el alta en vez de desalojar a nadie. No se escribe
     * nada en disco: ni el vault ni el registro se guardan hasta más abajo, así
     * que la credencial recién añadida se queda solo en memoria. Se deja estar a
     * propósito en lugar de retirarla: en un alta nueva es invisible y se
     * reaprovecha al repetir, y en una rotación de clave retirarla dejaría a esa
     * subcuenta sin credencial con la que firmar hasta el siguiente arranque.
     */
    let cuenta: Cuenta;
    try {
      cuenta = registro.agregar({
        id: cuentaId,
        grupoNombre,
        etiqueta,
        ...(alta.casilla === undefined ? {} : { slot: alta.casilla }),
        uid: verificacion.uid ?? '',
        uidPadre: verificacion.uidPadre ?? '',
        credencialId: publica.id,
        apiKeyEnmascarada: publica.apiKeyEnmascarada,
        modoPosicion: verificacion.modoPosicion ?? 'unilateral',
        modoMargen: verificacion.modoMargen ?? 'cruzado',
        /*
         * `undefined` -no `'classic'`- cuando la deteccion no concluyo, para que
         * `agregar` aplique su propio defecto en vez de escribir un modo que
         * nadie ha comprobado.
         */
        ...(verificacion.accountMode === null ? {} : { accountMode: verificacion.accountMode }),
        holdMode: verificacion.holdMode
      });
    } catch (e) {
      if (!(e instanceof ErrorRegistro)) throw e;
      return { ok: false, veredicto: null, motivo: e.message, advertencias: [], cuenta: null };
    }

    /*
     * El vault primero: si fallara la segunda escritura quedaria una credencial
     * sin cuenta, que es invisible y se reaprovecha al repetir el alta. Al
     * reves quedaria una cuenta sin credencial, y esa si se veria en pantalla.
     */
    await vault.guardar();
    await registro.guardar();
    this.avisarCredenciales();

    this.anotarSaldo(cuentaId, verificacion);
    this.conexiones.registrarVerificacion(cuentaId, verificacion);
    this.anunciar();

    return {
      ok: true,
      veredicto: 'valida',
      motivo: null,
      advertencias: verificacion.advertencias.map((a) => ({
        codigo: a.codigo,
        mensaje: a.mensaje
      })),
      cuenta: {
        id: cuenta.id,
        etiqueta: cuenta.etiqueta,
        grupoNombre,
        uid: cuenta.uid,
        uidPadre: cuenta.uidPadre,
        apiKeyEnmascarada: cuenta.apiKeyEnmascarada,
        estado: 'conectada',
        motivo: null,
        accountMode: cuenta.accountMode,
        /* Un alta en transicion no llega aqui: sale `rechazada` antes. */
        enTransicion: false,
        altaEn: cuenta.altaEn
      }
    };
  }

  /**
   * Baja de una subcuenta: se van a la vez la credencial y la cuenta.
   *
   * --------------------------------------------------------------------------
   * Pide la contrasena de paso, la misma de abrir y cerrar
   * --------------------------------------------------------------------------
   * Lo pidio el cliente el 31/08/2026, y por el mismo motivo por el que la piden
   * las dos operaciones: esto no se deshace pulsando otra vez. La credencial sale
   * cifrada del almacen y el panel no la guarda en ningun otro sitio, asi que
   * volver a tener esa subcuenta operativa es ir a Bitget, generar otra API Key y
   * teclear tres claves de 64 caracteres. Un clic de mas en «Eliminar» -o alguien
   * que se sienta ante un panel desbloqueado- costaba eso, y sin aviso ninguno.
   *
   * Se comprueba **aqui y antes de tocar nada**, no en la pantalla. Un freno que
   * solo vive en el renderer es un freno que un fallo de la pagina se salta; y
   * comprobarlo despues de `registro.eliminar` dejaria la baja hecha en memoria
   * aunque la clave fuera mala.
   *
   * Sin contrasena de paso configurada, `comprobarPaso` responde `false` -nunca
   * `true`-, de modo que la baja queda cerrada hasta que se fije una en Seguridad.
   * Es la misma puerta que la de operar, y por la misma razon: un panel sin clave
   * de paso no tiene ningun freno que ofrecer.
   */
  async eliminar(cuentaId: string, contrasenaPaso: string): Promise<ResultadoBaja> {
    const { vault, registro } = this.exigirAbierta();

    if (!(await vault.comprobarPaso(contrasenaPaso))) return 'paso-incorrecto';

    const habia = registro.eliminar(cuentaId);
    vault.eliminar(cuentaId);
    this.conexiones.olvidar(cuentaId);
    this.saldos.delete(cuentaId);
    /*
     * Sus posiciones se van con ella. Sin esto quedarian en el almacen sin
     * casilla a la que pertenecer: `posicionesMonitor` las omite, asi que no se
     * verian, pero seguirian contando en `cuentasConPosicion()` y esa cuenta
     * fantasma pediria un socket para siempre.
     */
    this.posiciones.olvidarCuenta(cuentaId);

    if (!habia) return 'no-estaba';

    await vault.guardar();
    await registro.guardar();
    this.avisarCredenciales();
    this.anunciar();
    return 'borrada';
  }

  /** Vuelve a preguntar a Bitget por una credencial ya guardada. */
  async verificar(cuentaId: string): Promise<ResultadoPrueba> {
    const { vault, registro } = this.exigirAbierta();

    if (registro.cuenta(cuentaId) === undefined) {
      return {
        ok: false,
        estado: 'desconectada',
        motivo: 'La subcuenta ya no esta registrada en este panel.',
        latenciaMs: 0,
        advertencias: []
      };
    }

    const credencial = vault.credencialDe(cuentaId);
    if (credencial === null) {
      return {
        ok: false,
        estado: 'desconectada',
        motivo: 'No hay credencial guardada para esta subcuenta.',
        latenciaMs: 0,
        advertencias: []
      };
    }

    this.conexiones.marcarConectando(cuentaId);

    let verificacion: ResultadoVerificacion;
    try {
      verificacion = await verificarCredencial(this.cliente, credencial, {
        mercado: MERCADOS[this.mercado]
      });
    } catch (e) {
      /* Fallo de transporte: es la red la que falla, no la credencial. */
      const estado = this.conexiones.registrarFallo(cuentaId, e);
      this.anunciar();
      return {
        ok: false,
        estado,
        motivo: e instanceof Error ? e.message : String(e),
        latenciaMs: 0,
        advertencias: []
      };
    }

    this.anotarSaldo(cuentaId, verificacion);

    /*
     * Se apunta o se levanta en cada verificacion, que es la unica lectura
     * fresca que hay: el cambio a UTA termina por su cuenta y nadie avisa.
     */
    if (verificacion.enTransicion) this.enTransicion.add(cuentaId);
    else this.enTransicion.delete(cuentaId);

    /*
     * Modo de posicion y de margen, tal como estan **ahora** en Bitget.
     *
     * Se capturaban solo en el alta, y el operador puede cambiarlos desde la web
     * del exchange cuando quiera. `cuentaEjecutable` alimenta con `modoMargen` el
     * `marginMode` de la orden, y Bitget obedece ese campo: con la ficha
     * desactualizada el panel abria en cruzado una cuenta puesta en aislado. Es
     * la unica lectura fresca que hay de estos dos campos, asi que aqui se
     * escribe o no se escribe en ningun sitio.
     */
    if (
      registro.actualizarModos(cuentaId, {
        modoPosicion: verificacion.modoPosicion,
        modoMargen: verificacion.modoMargen,
        /*
         * Con que API habla, segun la deteccion que acaba de hacer la
         * verificacion. Es la revalidacion periodica la que se entera de que una
         * subcuenta paso a UTA por su cuenta -el operador la actualiza en Bitget
         * y el panel no se entera de ninguna otra forma-, asi que este es el
         * camino por el que una cuenta migrada deja de estar muda.
         *
         * `null` -deteccion no concluida- lo ignora `actualizarModos`.
         */
        accountMode: verificacion.accountMode,
        holdMode: verificacion.holdMode
      })
    ) {
      /*
       * Fallar al guardar no invalida la verificacion: la ficha en memoria ya
       * quedo al dia y es la que consulta el motor. Se reintentara en el
       * siguiente ciclo, que llega solo.
       */
      await registro.guardar().catch(() => undefined);
    }

    const estado: EstadoConexion = this.conexiones.registrarVerificacion(cuentaId, verificacion);
    /*
     * Se anuncia siempre, no solo cuando cambia el estado: una cuenta que ya
     * estaba conectada puede traer un saldo nuevo, y el registro de conexiones
     * -que solo vigila el estado- no tendria por que enterarse de eso.
     */
    this.anunciar();

    return {
      ok: verificacion.veredicto === 'valida',
      estado,
      motivo: verificacion.motivo,
      latenciaMs: verificacion.latenciaMs,
      advertencias: verificacion.advertencias.map((a) => ({ codigo: a.codigo, mensaje: a.mensaje }))
    };
  }

  /* ---------------- reconexion automatica ---------------- */

  /**
   * Cuentas cuyo reintento ya vencio.
   *
   * Junto con `operativa` y `verificar`, forma el puerto `FuenteReintentos` que
   * consume `SupervisorReconexion`. La sesion no programa nada por su cuenta:
   * expone que cuentas tocan y quien quiera que las reintente lo hara.
   */
  pendientesDeReintento(): string[] {
    if (!this.operativa()) return [];
    return this.conexiones.pendientesDeReintento();
  }

  /**
   * Hay vault abierto y registro cargado.
   *
   * Con el panel bloqueado no hay credenciales que probar: el supervisor lo
   * consulta antes de cada ciclo para no llamar a `verificar` -que lanzaria- y
   * no pintar como caida una cuenta que solo espera el desbloqueo.
   */
  operativa(): boolean {
    return this.vault !== null && this.registro !== null && !this.vault.estaCerrado;
  }

  /* ---------------- cuentas madre y saldos ---------------- */

  /**
   * Da de alta la credencial de una cuenta madre.
   *
   * No pasa por `verificarCredencial`: esa comprueba que la cuenta pueda operar
   * la estrategia -modo cobertura, margen aislado, apalancamiento- y una cuenta
   * madre no opera nada. Exigirle eso la rechazaria por no cumplir requisitos
   * que no le corresponden.
   *
   * A cambio se le hace la comprobacion que si le corresponde, y que es
   * funcional: **preguntarle por sus subcuentas**. Una clave valida de una
   * cuenta que no es madre de nadie responde `00000` con la lista vacia, y sin
   * este aviso el operador se quedaria mirando una pantalla de saldos en blanco
   * sin saber que la culpa es de la clave. Es exactamente lo que ocurrio el
   * 03/09/2026 con la clave del `.env`: valida, con permisos de sobra, y de una
   * cuenta distinta a la madre de las subcuentas del panel.
   */
  async agregarMadre(alta: AltaMadre): Promise<ResultadoAltaMadre> {
    const { vault } = this.exigirAbierta();

    const etiqueta = alta.etiqueta.trim();
    if (etiqueta === '') {
      return {
        ok: false,
        motivo: 'Falta el nombre de la cuenta principal.',
        advertencias: [],
        madre: null
      };
    }

    /* Se recortan los tres, la passphrase incluida. Mismo motivo que en `agregar`. */
    const credencial: Credencial = {
      apiKey: alta.apiKey.trim(),
      secretKey: alta.secretKey.trim(),
      passphrase: alta.passphrase.trim()
    };

    let info;
    try {
      info = await obtenerInfoCuenta(this.cliente, credencial);
    } catch (e) {
      return {
        ok: false,
        motivo:
          e instanceof ErrorBitget
            ? `No se pudo comprobar la credencial: ${e.message}`
            : 'No se pudo comprobar la credencial: no hay conexion con Bitget.',
        advertencias: [],
        madre: null
      };
    }

    const advertencias: { codigo: string; mensaje: string }[] = [];
    const permisos = info.datos.authorities;
    const ips = (info.datos.ips ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    /* Prueba funcional: ¿es madre de alguien? */
    let subcuentasVistas: number;
    try {
      const saldos = await obtenerSaldosSubcuentas(
        this.cliente,
        credencial,
        MERCADOS[this.mercado].productType
      );
      subcuentasVistas = saldos.datos.length;
    } catch (e) {
      /*
       * Un fallo aqui no invalida la clave -puede ser la lista blanca de IP, que
       * en los endpoints de subcuentas si se aplica- pero tiene que decirse: sin
       * esta lectura la pantalla de saldos no tiene nada que pintar.
       */
      return {
        ok: false,
        motivo:
          e instanceof ErrorBitget
            ? `La clave autentica, pero no puede leer las subcuentas: ${e.message}`
            : 'La clave autentica, pero no se pudo leer la lista de subcuentas.',
        advertencias: [],
        madre: null
      };
    }

    if (subcuentasVistas === 0) {
      advertencias.push({
        codigo: 'sin-subcuentas',
        mensaje:
          'Esta clave es valida, pero Bitget no le reporta ninguna subcuenta. Comprueba que sea ' +
          'la API Key de la cuenta principal de la que cuelgan tus subcuentas: la pantalla de ' +
          'saldos se vera vacia mientras no lo sea.'
      });
    }

    if (ips.length === 0) {
      advertencias.push({
        codigo: 'sin-ip-ligada',
        mensaje:
          'La API Key no tiene IP ligada. Funciona, pero esta clave puede mover saldo entre tus ' +
          'cuentas: si se filtrara, seria utilizable desde cualquier sitio.'
      });
    }

    const madre = vault.agregarMadre({
      uidMadre: info.datos.userId,
      etiqueta,
      apiKey: credencial.apiKey,
      secretKey: credencial.secretKey,
      passphrase: credencial.passphrase,
      permisos: {
        verificadoEn: new Date().toISOString(),
        authorities: permisos,
        ipsPermitidas: ips
      }
    });
    await vault.guardar();
    this.avisarCredenciales();
    this.anunciar();

    return {
      ok: true,
      motivo: null,
      advertencias,
      madre: {
        id: madre.id,
        uidMadre: madre.uidMadre,
        etiqueta: madre.etiqueta,
        apiKeyEnmascarada: madre.apiKeyEnmascarada,
        altaEn: madre.altaEn,
        subcuentasVistas
      }
    };
  }

  /** Cuentas madre registradas, sin secretos. */
  listarMadres(): MadreIpc[] {
    if (this.vault === null || this.vault.estaCerrado) return [];
    return this.vault.listarMadres().map((m) => ({
      id: m.id,
      uidMadre: m.uidMadre,
      etiqueta: m.etiqueta,
      apiKeyEnmascarada: m.apiKeyEnmascarada,
      altaEn: m.altaEn,
      subcuentasVistas: null
    }));
  }

  /**
   * Baja de una cuenta madre. **Exige la contrasena de paso**, como la de una
   * subcuenta: es la credencial mas poderosa del almacen, y borrarla sin freno
   * seria mas facil que borrar cualquiera de las que solo operan.
   */
  async eliminarMadre(uidMadre: string, contrasenaPaso: string): Promise<ResultadoBaja> {
    const { vault } = this.exigirAbierta();

    if (!(await vault.comprobarPaso(contrasenaPaso))) return 'paso-incorrecto';

    if (!vault.eliminarMadre(uidMadre)) return 'no-estaba';

    await vault.guardar();
    this.avisarCredenciales();
    this.anunciar();
    return 'borrada';
  }

  /**
   * Saldos de las subcuentas de una cuenta madre.
   *
   * Una sola peticion a Bitget, cruzada con las cuentas que el panel tiene dadas
   * de alta. Ver `resumirSaldos` para por que se muestran las dos listas y no su
   * interseccion.
   *
   * Sin `uidMadre` usa la unica madre registrada. Con varias, hay que decir cual:
   * la alternativa -elegir por orden- seria enseñar los saldos de una cuenta
   * mientras el operador cree estar mirando los de otra.
   */
  async saldosSubcuentas(uidMadre?: string): Promise<SaldosPantalla> {
    const { vault, registro } = this.exigirAbierta();

    const credencial = vault.credencialMadre(uidMadre);
    if (credencial === null) {
      const cuantas = vault.cantidadMadres;
      throw new Error(
        cuantas === 0
          ? 'No hay ninguna cuenta principal registrada. Da de alta su API Key para ver los saldos.'
          : 'Hay varias cuentas principales registradas: indica de cual quieres ver los saldos.'
      );
    }

    const madre = vault.listarMadres().find((m) => (uidMadre ? m.uidMadre === uidMadre : true));
    const uid = madre?.uidMadre ?? uidMadre ?? '';

    const saldos = await obtenerSaldosSubcuentas(
      this.cliente,
      credencial,
      MERCADOS[this.mercado].productType
    );

    /*
     * El saldo de la propia madre, que `sub-account-assets` no trae.
     *
     * Ese endpoint reporta a la madre el saldo de **sus subcuentas** y nunca el
     * suyo, asi que la cuenta desde la que se reparte era la unica de la
     * pantalla sin cifra: aparecia en el desplegable de traspaso sin importe y
     * en la confirmacion como «saldo desconocido». Se lee aparte, con su propia
     * credencial, del mismo endpoint que usa el panel para los saldos de
     * futuros. Preguntado por el operador el 05/09/2026.
     *
     * Si falla no se rompe la pantalla: se queda en `null` -«no se sabe»- y todo
     * sigue funcionando como antes. Un saldo de menos es molesto; una pantalla
     * de saldos que no carga por una peticion secundaria, mucho peor.
     */
    const disponibleMadre: Cantidad | null = await obtenerCuentasFuturos(
      this.cliente,
      credencial,
      MERCADOS[this.mercado].productType
    ).then(
      (propio) => propio.datos.find((c) => c.marginCoin === MONEDA_TRASPASOS)?.available ?? null,
      () => null
    );

    /*
     * Solo las cuentas de esta madre. Cruzar con todas mezclaria en la misma
     * pantalla subcuentas de dos cuentas principales distintas, y un traspaso
     * entre ellas es justo lo que el contrato excluye.
     *
     * Las cuentas dadas de alta antes de que existiera `uidPadre` lo traen
     * vacio; se incluyen igual porque dejarlas fuera las haria desaparecer de la
     * pantalla sin motivo visible, y el cruce por UID ya las coloca bien.
     */
    const cuentas = registro.listarCuentas().filter((c) => c.uidPadre === uid || c.uidPadre === '');

    const resumen = resumirSaldos(saldos.datos, cuentas);

    return {
      uidMadre: uid,
      etiquetaMadre: madre?.etiqueta ?? '',
      disponibleMadre,
      moneda: MONEDA_TRASPASOS,
      obtenidoEn: new Date().toISOString(),
      ...resumen
    };
  }

  /* ---------------- traspaso entre subcuentas ---------------- */

  /**
   * Calcula el traspaso y comprueba que se pueda hacer. **No envía nada.**
   *
   * Vuelve a leer los saldos antes de calcular, y no reutiliza los que la
   * pantalla tenga en la mano: el máximo transferible cambia en cuanto se abre o
   * se cierra una posición, y validar contra un número de hace un minuto
   * autorizaría lo que Bitget ya no admite.
   */
  async planificarTraspaso(peticion: {
    uidOrigen: string;
    uidDestino: string;
    importe: string;
    /*
     * `| undefined` explicito: con `exactOptionalPropertyTypes` un objeto que
     * trae la propiedad valiendo `undefined` -lo que devuelve Zod al parsear un
     * campo opcional ausente- no encaja en un `?:` a secas.
     */
    uidMadre?: string | undefined;
  }): Promise<PlanTraspaso> {
    this.exigirAbierta();

    const hoja = await this.saldosSubcuentas(peticion.uidMadre);
    const id = randomUUID().replace(/-/g, '').slice(0, 12);

    const plan = planificarTraspaso(
      {
        uidOrigen: peticion.uidOrigen,
        uidDestino: peticion.uidDestino,
        importe: peticion.importe,
        uidMadre: hoja.uidMadre,
        etiquetaMadre: hoja.etiquetaMadre,
        disponibleMadre: hoja.disponibleMadre,
        moneda: hoja.moneda,
        /*
         * Derivado del id del plan, no aleatorio: dos envíos del mismo plan
         * producen el mismo identificador, y eso es lo que hace que un reenvío
         * accidental sea rechazado por Bitget en vez de mover el dinero dos
         * veces. Mismo criterio que `clientOidDe` en el motor de lotes.
         */
        clientOid: `pcbtr${id}`,
        id,
        ahora: new Date(this.ahoraMs()).toISOString()
      },
      hoja.filas.map((f) => ({
        uid: f.uid,
        cuentaId: f.cuentaId,
        etiqueta: f.etiqueta,
        disponible: f.disponible,
        maxTransferible: f.maxTransferible,
        equity: f.equity,
        soloEnBitget: f.soloEnBitget,
        sinDatos: f.sinDatos
      }))
    );

    this.purgarPlanesTraspaso();
    this.planesTraspaso.set(plan.id, { plan, creadoMs: this.ahoraMs() });
    return plan;
  }

  private purgarPlanesTraspaso(): void {
    for (const [id, guardado] of this.planesTraspaso) {
      if (this.ahoraMs() - guardado.creadoMs > PLAN_VIGENCIA_MS) this.planesTraspaso.delete(id);
    }
  }

  /**
   * Envía un traspaso ya aprobado. **Aquí se mueve el dinero.**
   *
   * ==========================================================================
   * El orden de estas cuatro cosas no es negociable
   * ==========================================================================
   *   1. Se comprueba la contraseña de paso.
   *   2. Se anota el intento **en disco**.
   *   3. Se envía.
   *   4. Se anota el desenlace.
   *
   * El paso 2 va antes del 3 a propósito: si el proceso muere entre el envío y
   * la respuesta, la intención ya está escrita y el traspaso queda señalado como
   * pendiente en vez de desaparecer. Si esa escritura falla, **no se envía**:
   * mover dinero sin dejar rastro es peor que no moverlo.
   *
   * Y lo que no se hace nunca: reenviar por iniciativa propia. Un envío sin
   * respuesta se resuelve mirando el saldo, no repitiendo el movimiento.
   */
  async ejecutarTraspaso(planId: string, contrasenaPaso: string): Promise<ResultadoTraspaso> {
    const { vault } = this.exigirAbierta();

    this.purgarPlanesTraspaso();
    const guardado = this.planesTraspaso.get(planId);
    if (guardado === undefined) {
      throw new ErrorPlan(
        'plan-desconocido',
        'Ese traspaso ya no está vigente. Vuelve a revisarlo antes de enviarlo.'
      );
    }
    const { plan } = guardado;

    /*
     * La contraseña de paso, la misma que exige enviar órdenes. El contrato pide
     * «el mismo mecanismo de confirmación que ya aplica a la apertura de
     * posiciones», y esto mueve dinero igual que aquella.
     */
    if (!(await vault.comprobarPaso(contrasenaPaso))) {
      return { ok: false, motivo: 'paso-incorrecto', mensaje: null, transferId: null, plan };
    }

    const credencial = vault.credencialMadre(plan.uidMadre);
    if (credencial === null) {
      return {
        ok: false,
        motivo: 'sin-credencial',
        mensaje: 'Ya no hay credencial guardada para esa cuenta principal.',
        transferId: null,
        plan
      };
    }

    /* Paso 2: en disco antes de salir a la red. Si esto falla, no se envía. */
    await this.traspasos.anotarIntento({
      clientOid: plan.clientOid,
      uidMadre: plan.uidMadre,
      uidOrigen: plan.origen.uid,
      etiquetaOrigen: plan.origen.etiqueta,
      uidDestino: plan.destino.uid,
      etiquetaDestino: plan.destino.etiqueta,
      importe: plan.importe,
      moneda: plan.moneda
    });

    /*
     * El plan se retira antes de enviar, no después.
     *
     * Así una segunda pulsación del botón no llega ni a intentarlo: encuentra el
     * plan ausente y responde «ya no está vigente». Sin esto, dos envíos del
     * mismo plan producirían dos intentos anotados —el `clientOid` los haría
     * rechazar en Bitget, pero el registro contaría una historia confusa.
     */
    this.planesTraspaso.delete(planId);

    try {
      const respuesta = await traspasarEntreSubcuentas(this.cliente, credencial, {
        uidOrigen: plan.origen.uid,
        uidDestino: plan.destino.uid,
        importe: plan.importe,
        clientOid: plan.clientOid,
        moneda: plan.moneda
      });

      const transferId = respuesta.datos.transferId ?? null;
      await this.traspasos.anotarResuelta({
        clientOid: plan.clientOid,
        resultado: 'exito',
        transferId
      });
      this.anunciar();

      return { ok: true, motivo: null, mensaje: null, transferId, plan };
    } catch (e) {
      const err = e instanceof ErrorBitget ? e : null;
      const desenlace = await this.resolverEnvio(plan.clientOid, plan.moneda, credencial, err);

      if (desenlace.estado === 'entro') {
        return {
          ok: true,
          motivo: null,
          mensaje: null,
          transferId: desenlace.transferId,
          plan
        };
      }

      if (desenlace.estado === 'indeterminado') {
        return {
          ok: false,
          motivo: 'indeterminado',
          mensaje: desenlace.mensaje,
          transferId: null,
          plan
        };
      }

      return { ok: false, motivo: 'rechazado', mensaje: desenlace.mensaje, transferId: null, plan };
    }
  }

  /**
   * Que hacer cuando un envio de dinero termina en excepcion.
   *
   * ==========================================================================
   * «No respondio» no es «no entro»
   * ==========================================================================
   * `errors.ts` separa el rechazo -Bitget contesto que no- del **indeterminado**:
   * se envio y no hubo respuesta. Tratarlos igual es el error caro, y no por
   * pulcritud: si al operador se le dice «fallo», replanificara, y un plan nuevo
   * lleva un `clientOid` **nuevo**. La proteccion contra duplicados del envio
   * original deja de aplicar y el mismo dinero se mueve dos veces.
   *
   * Ante un indeterminado se consulta a Bitget por el `clientOid`. Y se respeta
   * la asimetria: **encontrarlo demuestra que entro; no encontrarlo no demuestra
   * nada** -Bitget puede tardar en registrarlo, o la consulta puede fallar-. Por
   * eso el caso sin respuesta clara no se cierra: se queda como `pendiente` en el
   * registro, sin linea de resuelta, que es exactamente lo que significa.
   */
  private async resolverEnvio(
    clientOid: string,
    moneda: string,
    credencial: { apiKey: string; secretKey: string; passphrase: string },
    err: ErrorBitget | null
  ): Promise<
    | { estado: 'entro'; transferId: string | null; mensaje: null }
    | { estado: 'rechazado'; mensaje: string }
    | { estado: 'indeterminado'; mensaje: string }
  > {
    const mensaje = err?.message ?? 'No se pudo enviar el traspaso.';

    if (err?.clase !== 'indeterminada') {
      await this.traspasos.anotarResuelta({
        clientOid,
        resultado: 'fallo',
        codigoBitget: err?.codigo ?? null,
        mensaje
      });
      return { estado: 'rechazado', mensaje };
    }

    try {
      const encontrado = (
        await buscarTraspaso(this.cliente, credencial, { clientOid, moneda })
      ).datos.find((r) => r.clientOid === clientOid);

      if (encontrado !== undefined) {
        const transferId = encontrado.transferId ?? null;
        await this.traspasos.anotarResuelta({ clientOid, resultado: 'exito', transferId });
        this.anunciar();
        return { estado: 'entro', transferId, mensaje: null };
      }
    } catch {
      /* La consulta tampoco respondio. Sigue sin saberse, que ya es la respuesta. */
    }

    /*
     * Sin linea de resuelta a proposito: el registro lo deja como `pendiente`,
     * y esa es la verdad. Anotar «fallo» aqui seria afirmar que no entro.
     */
    return {
      estado: 'indeterminado',
      mensaje:
        'El traspaso se envió y Bitget no confirmó si entró. Queda registrado como pendiente: ' +
        'comprueba los saldos antes de repetirlo, porque volver a enviarlo lo movería dos veces.'
    };
  }

  /* ---------------- reparto y recogida masiva (Fase 4) ---------------- */

  /**
   * Calcula un reparto de la madre hacia varias subcuentas. **No envía nada.**
   *
   * Relee los saldos, igual que el traspaso suelto y por lo mismo: el nivel al
   * que hay que igualar depende de lo que cada subcuenta tenga **ahora**.
   */
  async planificarReparto(peticion: {
    destinos: readonly string[];
    total: string;
    modo: ModoReparto;
    uidMadre?: string | undefined;
  }): Promise<PlanReparto> {
    this.exigirAbierta();

    const hoja = await this.saldosSubcuentas(peticion.uidMadre);
    const id = randomUUID().replace(/-/g, '').slice(0, 12);

    const plan = planificarReparto(
      {
        id,
        uidMadre: hoja.uidMadre,
        etiquetaMadre: hoja.etiquetaMadre || 'Cuenta principal',
        moneda: hoja.moneda,
        ahora: new Date(this.ahoraMs()).toISOString(),
        destinos: peticion.destinos,
        total: peticion.total,
        modo: peticion.modo
      },
      hoja.filas
    );

    this.purgarPlanesReparto();
    this.planesReparto.set(plan.id, { plan, creadoMs: this.ahoraMs() });
    return plan;
  }

  /** Calcula la devolución del saldo de varias subcuentas a la madre. No envía nada. */
  async planificarRecogida(peticion: {
    origenes: readonly string[];
    uidMadre?: string | undefined;
  }): Promise<PlanReparto> {
    this.exigirAbierta();

    const hoja = await this.saldosSubcuentas(peticion.uidMadre);
    const id = randomUUID().replace(/-/g, '').slice(0, 12);

    const plan = planificarRecogida(
      {
        id,
        uidMadre: hoja.uidMadre,
        etiquetaMadre: hoja.etiquetaMadre || 'Cuenta principal',
        moneda: hoja.moneda,
        ahora: new Date(this.ahoraMs()).toISOString(),
        origenes: peticion.origenes
      },
      hoja.filas
    );

    this.purgarPlanesReparto();
    this.planesReparto.set(plan.id, { plan, creadoMs: this.ahoraMs() });
    return plan;
  }

  private purgarPlanesReparto(): void {
    for (const [id, guardado] of this.planesReparto) {
      if (this.ahoraMs() - guardado.creadoMs > PLAN_VIGENCIA_MS) this.planesReparto.delete(id);
    }
  }

  /**
   * Envía un reparto o una recogida ya aprobados. **Aquí se mueve el dinero.**
   *
   * ==========================================================================
   * Uno detrás de otro, y un fallo no detiene a los demás
   * ==========================================================================
   * Los traspasos salen **en serie**, no en paralelo. Con cien subcuentas el
   * paralelo ahorraría segundos y a cambio dejaría cien movimientos de dinero en
   * vuelo a la vez contra un endpoint cuyo límite de peticiones no está
   * verificado. Aquí los segundos no valen ese riesgo.
   *
   * Si uno falla, los demás siguen: es la misma regla que las seis operaciones
   * -«falla esa cuenta, el lote continúa»- y por el mismo motivo. Abortar a la
   * mitad dejaría un reparto hecho a medias sin que nadie hubiera decidido cuál
   * era la mitad buena.
   *
   * **Sin rollback.** Deshacer los traspasos que ya entraron porque uno falló
   * sería mover dinero por iniciativa propia, que es justo lo que el contrato
   * prohíbe. Se informa de qué entró y qué no, y decide el operador.
   */
  async ejecutarReparto(planId: string, contrasenaPaso: string): Promise<ResultadoReparto> {
    const { vault } = this.exigirAbierta();

    this.purgarPlanesReparto();
    const guardado = this.planesReparto.get(planId);
    if (guardado === undefined) {
      throw new ErrorPlan(
        'plan-desconocido',
        'Ese reparto ya no está vigente. Vuelve a revisarlo antes de enviarlo.'
      );
    }
    const { plan } = guardado;

    if (!(await vault.comprobarPaso(contrasenaPaso))) {
      return {
        ok: false,
        motivo: 'paso-incorrecto',
        plan,
        resultados: [],
        enviados: 0,
        fallidos: 0,
        indeterminados: 0
      };
    }

    const credencial = vault.credencialMadre(plan.uidMadre);
    if (credencial === null) {
      return {
        ok: false,
        motivo: 'sin-credencial',
        plan,
        resultados: [],
        enviados: 0,
        fallidos: 0,
        indeterminados: 0
      };
    }

    /* Se retira antes de enviar: una segunda pulsación no repite el reparto. */
    this.planesReparto.delete(planId);

    const resultados: ResultadoMovimientoIpc[] = [];
    let enviados = 0;
    let fallidos = 0;
    /* Enviados sin respuesta: ni exito ni fallo. Ver `resolverEnvio`. */
    let indeterminados = 0;

    for (const m of plan.movimientos) {
      /* En disco antes de salir a la red, uno por uno. */
      await this.traspasos.anotarIntento({
        clientOid: m.clientOid,
        uidMadre: plan.uidMadre,
        uidOrigen: m.uidOrigen,
        etiquetaOrigen: m.etiquetaOrigen,
        uidDestino: m.uidDestino,
        etiquetaDestino: m.etiquetaDestino,
        importe: m.importe,
        moneda: plan.moneda
      });

      try {
        const respuesta = await traspasarEntreSubcuentas(this.cliente, credencial, {
          uidOrigen: m.uidOrigen,
          uidDestino: m.uidDestino,
          importe: m.importe,
          clientOid: m.clientOid,
          moneda: plan.moneda
        });

        const transferId = respuesta.datos.transferId ?? null;
        await this.traspasos.anotarResuelta({
          clientOid: m.clientOid,
          resultado: 'exito',
          transferId
        });
        resultados.push({
          clientOid: m.clientOid,
          etiquetaOrigen: m.etiquetaOrigen,
          etiquetaDestino: m.etiquetaDestino,
          importe: m.importe,
          ok: true,
          mensaje: null
        });
        enviados += 1;
      } catch (e) {
        const err = e instanceof ErrorBitget ? e : null;
        const desenlace = await this.resolverEnvio(m.clientOid, plan.moneda, credencial, err);

        /* Un envio sin respuesta que la consulta confirma cuenta como enviado. */
        if (desenlace.estado === 'entro') {
          resultados.push({
            clientOid: m.clientOid,
            etiquetaOrigen: m.etiquetaOrigen,
            etiquetaDestino: m.etiquetaDestino,
            importe: m.importe,
            ok: true,
            mensaje: null
          });
          enviados += 1;
          continue;
        }

        resultados.push({
          clientOid: m.clientOid,
          etiquetaOrigen: m.etiquetaOrigen,
          etiquetaDestino: m.etiquetaDestino,
          importe: m.importe,
          ok: false,
          mensaje: desenlace.mensaje
        });
        /*
         * Los indeterminados se cuentan aparte de los fallos. Un lote «18
         * enviados · 2 sin confirmar» pide comprobar dos saldos; uno que los
         * llamara fallidos invitaria a reenviarlos, y reenviar lo que quiza
         * entro es como se mueve el dinero dos veces.
         */
        if (desenlace.estado === 'indeterminado') indeterminados += 1;
        else fallidos += 1;
      }
    }

    this.anunciar();
    return {
      ok: fallidos === 0 && indeterminados === 0,
      motivo: null,
      plan,
      resultados,
      enviados,
      fallidos,
      indeterminados
    };
  }

  /**
   * Traspasos enviados de los que no se sabe el desenlace.
   *
   * Es la lista que hay que mirar antes de repetir nada: cada uno de estos pudo
   * entrar o no, y volver a enviarlo -con un plan nuevo, y por tanto con otro
   * `clientOid`- movería el dinero dos veces.
   */
  async traspasosPendientes(): Promise<MovimientoTraspasoIpc[]> {
    return this.traspasos.pendientes();
  }

  /** Historial de traspasos, lo más reciente primero. */
  async historialTraspasos(limite = 100): Promise<MovimientoTraspasoIpc[]> {
    return this.traspasos.listar(limite);
  }

  /* ---------------- estado global ---------------- */

  async estadoApp(): Promise<EstadoApp> {
    const resumen = this.conexiones.resumen();
    return {
      vault: await this.estadoVault(),
      /* El desbloqueo rapido por PIN es de una fase posterior. */
      pinIntentosRestantes: null,
      cuentasRegistradas: this.registro?.listarCuentas().length ?? 0,
      cuentasConectadas: resumen.conectada + resumen['modo-rest'],
      socketsCalientes: this.sockets
    };
  }
}
