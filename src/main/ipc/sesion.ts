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
  CuentaPanel,
  EstadoApp,
  EstadoVault,
  FilaCuenta,
  ResultadoAlta,
  ResultadoPrueba,
  ResultadoVault
} from '@shared/ipc-contract';
import { PLAN_VIGENCIA_MS } from '@shared/constants';
import type { EstadoConexion, Lado, Lote } from '@shared/types';
import { ErrorBitget } from '../bitget/errors';
import { MERCADOS, type ClaveMercado } from '../bitget/mercado';
import type { ClienteBitget } from '../bitget/rest/client';
import type { Credencial } from '../bitget/rest/signer';
import { verificarCredencial, type ResultadoVerificacion } from '../bitget/verificacion';
import { catalogoActivos, preciosDe, type ActivoOperable } from '../bitget/catalogo-activos';
import { RegistroConexiones } from '../domain/estado-conexion';
import { RegistroCuentas } from '../domain/registro-cuentas';
import {
  ErrorPlan,
  MotorLotes,
  type ApalancamientoCuenta,
  type CuentaEjecutable,
  type FuenteCuentas,
  type PlanApalancamiento,
  type PlanApertura,
  type PlanCierre,
  type PlanMargen,
  type PlanQuitarTakeProfit,
  type PlanTakeProfit
} from '../execution/motor-lotes';
import { ErrorVault, Vault, estadoEnDisco } from '../security/vault';

export interface RutasSesion {
  vault: string;
  cuentas: string;
}

export interface OpcionesSesion {
  /** Mercado contra el que se opera. Lo fija `config.json`, nunca el renderer. */
  mercado?: ClaveMercado;
  /** Se inyecta en las pruebas; en produccion lo construye la propia sesion. */
  motor?: MotorLotes;
  ahora?: () => number;
}

export class Sesion implements FuenteCuentas {
  private readonly rutas: RutasSesion;
  private readonly cliente: ClienteBitget;
  private readonly mercado: ClaveMercado;
  private readonly motor: MotorLotes;
  private readonly ahoraMs: () => number;
  /**
   * Planes calculados y aun sin ejecutar.
   *
   * Viven aqui y no en el renderer a proposito: la pantalla recibe el plan para
   * ensenarlo y devuelve solo su `id`. Asi ninguna cantidad, ningun precio y
   * ninguna cuenta pueden alterarse entre lo que el operador aprueba y lo que
   * sale hacia Bitget.
   */
  /** Catalogo del mercado activo. Se lee una vez por sesion. */
  private activosCache: ActivoOperable[] | null = null;
  private readonly planes = new Map<string, PlanApertura>();
  /** Lo mismo para los cierres. Se guardan aparte porque no caducan igual. */
  private readonly planesCierre = new Map<string, PlanCierre>();
  private readonly planesTp = new Map<string, PlanTakeProfit>();
  private readonly planesQuitarTp = new Map<string, PlanQuitarTakeProfit>();
  private readonly planesMargen = new Map<string, PlanMargen>();
  private readonly planesApalancamiento = new Map<string, PlanApalancamiento>();
  /**
   * Estado de conexion de la sesion en curso.
   *
   * Se tira al bloquear el panel, no se conserva. Con el panel bloqueado no se
   * consulta a Bitget, asi que el estado envejece; conservarlo pintaria de
   * verde al desbloquear cuentas que llevan horas sin comprobarse. RF-002.
   */
  private conexiones = new RegistroConexiones();
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
  private desuscribirConexiones: (() => void) | null = null;

  constructor(rutas: RutasSesion, cliente: ClienteBitget, opciones: OpcionesSesion = {}) {
    this.rutas = rutas;
    this.cliente = cliente;
    this.mercado = opciones.mercado ?? 'simulado';
    this.ahoraMs = opciones.ahora ?? Date.now;
    this.motor =
      opciones.motor ??
      new MotorLotes(cliente, this, {
        alProgresar: (lote) => {
          for (const oyente of this.oyentesLote) oyente(lote);
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
    return this.abrirCon(() => Vault.crear(this.rutas.vault, contrasena));
  }

  async abrir(contrasena: string): Promise<ResultadoVault> {
    return this.abrirCon(() => Vault.abrir(this.rutas.vault, contrasena));
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
    return Vault.comprobarContrasena(this.rutas.vault, contrasena);
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
    this.planesQuitarTp.clear();
    this.planesMargen.clear();
    this.planesApalancamiento.clear();
    this.conexiones = new RegistroConexiones();
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
        altaEn: cuenta.altaEn
      };
    });
  }

  /**
   * La matriz de seleccion: cuentas principales con sus subcuentas.
   *
   * Las subcuentas van ordenadas por casilla y no por antiguedad ni por nombre,
   * porque la casilla es lo que el operador tiene memorizado. Con el panel
   * bloqueado devuelve una lista vacia en lugar de fallar: es la respuesta
   * correcta, no un error.
   */
  cuentasPanel(): CuentaPanel[] {
    if (this.vault === null || this.registro === null || this.vault.estaCerrado) return [];
    const registro = this.registro;

    return registro
      .listarGrupos()
      .sort((a, b) => a.orden - b.orden)
      .map((grupo) => ({
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

  /* ---------------- catalogo de activos ---------------- */

  /**
   * Los activos operables del mercado activo, con sus limites reales.
   *
   * Se cachea porque el catalogo de Bitget no cambia en una sesion: los topes
   * de apalancamiento y los decimales de un contrato son estables, y volver a
   * pedirlos cada vez que la pantalla se dibuja gastaria cupo sin aportar nada.
   * Un reinicio del panel lo vuelve a leer, que es la frecuencia adecuada.
   */
  async activos(): Promise<ActivoOperable[]> {
    if (this.activosCache === null) {
      this.activosCache = await catalogoActivos(this.cliente, MERCADOS[this.mercado]);
    }
    return this.activosCache;
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
  cuentaEjecutable(cuentaId: string): CuentaEjecutable | null {
    if (this.vault === null || this.registro === null || this.vault.estaCerrado) return null;

    const cuenta = this.registro.cuenta(cuentaId);
    if (cuenta === undefined) return null;

    const credencial = this.vault.credencialDe(cuentaId);
    if (credencial === null) return null;

    return {
      cuentaId,
      etiqueta: cuenta.etiqueta,
      credencial,
      saldoDisponible: this.saldos.get(cuentaId) ?? '0',
      modoMargen: cuenta.modoMargen === 'aislado' ? 'isolated' : 'crossed',
      ...(this.apalancamientos.has(cuentaId)
        ? { apalancamiento: this.apalancamientos.get(cuentaId) as ApalancamientoCuenta }
        : {})
    };
  }

  /** Avisa del avance de un lote en curso. Lo consume el evento `lote:progreso`. */
  alProgresarLote(oyente: (lote: Lote) => void): () => void {
    this.oyentesLote.add(oyente);
    return () => {
      this.oyentesLote.delete(oyente);
    };
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
  }): Promise<PlanApertura> {
    this.exigirAbierta();

    const plan = await this.motor.planificar({
      mercado: MERCADOS[this.mercado],
      simbolo: peticion.simbolo,
      objetivos: peticion.objetivos,
      margenInicial: peticion.margenInicial,
      apalancamiento: peticion.apalancamiento,
      precioLimite: peticion.precioLimite
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
   * Calcula donde queda el Take Profit de cada posicion. **No coloca nada.**
   *
   * El porcentaje es ganancia sobre el margen inicial, no movimiento del
   * precio: el precio de cada posicion sale de su entrada y su apalancamiento.
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

    const oids =
      soloEstos === undefined
        ? undefined
        : plan.entradas
            .filter((e) => soloEstos.some((s) => s.cuentaId === e.cuentaId && s.lado === e.lado))
            .map((e) => e.clientOid);

    const lote = await this.motor.ejecutarTakeProfit(plan, oids);

    if (soloEstos === undefined && lote.jobs.every((j) => j.estado !== 'fallo')) {
      this.planesTp.delete(planId);
    }

    return lote;
  }

  /** Un plan calculado, si sigue vigente. */
  plan(planId: string): PlanApertura | undefined {
    return this.planes.get(planId);
  }

  planCierre(planId: string): PlanCierre | undefined {
    return this.planesCierre.get(planId);
  }

  planTakeProfit(planId: string): PlanTakeProfit | undefined {
    return this.planesTp.get(planId);
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
   * Calcula cuanto margen se agrega a cada posicion. **No envia nada.**
   *
   * Comprueba lo critico antes de salir a la red: que exista la posicion, que
   * este en margen aislado -Bitget no admite otra cosa- y que la cuenta tenga
   * saldo, porque es dinero nuevo saliendo del disponible.
   */
  async planificarMargen(peticion: {
    simbolo: string;
    objetivos: { cuentaId: string; lado: Lado }[];
    cantidad: string;
  }): Promise<PlanMargen> {
    this.exigirAbierta();

    const plan = await this.motor.planificarMargen({
      mercado: MERCADOS[this.mercado],
      simbolo: peticion.simbolo,
      objetivos: peticion.objetivos,
      cantidad: peticion.cantidad
    });

    this.purgarPlanes();
    this.planesMargen.set(plan.id, plan);
    return plan;
  }

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

    const oids = this.oidsDe(plan.entradas, soloEstos);
    const lote = await this.motor.ejecutarMargen(plan, oids);

    if (soloEstos === undefined && lote.jobs.every((j) => j.estado !== 'fallo')) {
      this.planesMargen.delete(planId);
    }
    return lote;
  }

  planMargen(planId: string): PlanMargen | undefined {
    return this.planesMargen.get(planId);
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

    const lote = await this.motor.ejecutar(plan, oids);

    /*
     * Un plan solo se ejecuta entero una vez. Se conserva mientras queden
     * cuentas por reintentar, y se retira cuando ya no hay nada que reintentar.
     */
    if (soloEstos === undefined && lote.jobs.every((j) => j.estado !== 'fallo')) {
      this.planes.delete(planId);
    }

    return lote;
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
    this.saldos.set(cuentaId, verificacion.saldoDisponible);
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
    const estorbo = registro.comprobarCabida(grupoNombre, etiqueta);
    if (estorbo !== null) {
      return { ok: false, veredicto: null, motivo: estorbo.message, advertencias: [], cuenta: null };
    }

    const credencial: Credencial = {
      apiKey: alta.apiKey.trim(),
      secretKey: alta.secretKey.trim(),
      passphrase: alta.passphrase
    };

    let verificacion: ResultadoVerificacion;
    try {
      verificacion = await verificarCredencial(this.cliente, credencial, { mercado: MERCADOS[this.mercado] });
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
        advertencias: verificacion.advertencias.map((a) => ({ codigo: a.codigo, mensaje: a.mensaje })),
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

    const cuenta = registro.agregar({
      id: cuentaId,
      grupoNombre,
      etiqueta,
      uid: verificacion.uid ?? '',
      uidPadre: verificacion.uidPadre ?? '',
      credencialId: publica.id,
      apiKeyEnmascarada: publica.apiKeyEnmascarada,
      modoPosicion: verificacion.modoPosicion ?? 'unilateral',
      modoMargen: verificacion.modoMargen ?? 'cruzado'
    });

    /*
     * El vault primero: si fallara la segunda escritura quedaria una credencial
     * sin cuenta, que es invisible y se reaprovecha al repetir el alta. Al
     * reves quedaria una cuenta sin credencial, y esa si se veria en pantalla.
     */
    await vault.guardar();
    await registro.guardar();

    this.anotarSaldo(cuentaId, verificacion);
    this.conexiones.registrarVerificacion(cuentaId, verificacion);
    this.anunciar();

    return {
      ok: true,
      veredicto: 'valida',
      motivo: null,
      advertencias: verificacion.advertencias.map((a) => ({ codigo: a.codigo, mensaje: a.mensaje })),
      cuenta: {
        id: cuenta.id,
        etiqueta: cuenta.etiqueta,
        grupoNombre,
        uid: cuenta.uid,
        uidPadre: cuenta.uidPadre,
        apiKeyEnmascarada: cuenta.apiKeyEnmascarada,
        estado: 'conectada',
        motivo: null,
        altaEn: cuenta.altaEn
      }
    };
  }

  /** Baja de una subcuenta: se van a la vez la credencial y la cuenta. */
  async eliminar(cuentaId: string): Promise<boolean> {
    const { vault, registro } = this.exigirAbierta();

    const habia = registro.eliminar(cuentaId);
    vault.eliminar(cuentaId);
    this.conexiones.olvidar(cuentaId);
    this.saldos.delete(cuentaId);

    if (!habia) return false;

    await vault.guardar();
    await registro.guardar();
    this.anunciar();
    return true;
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
      verificacion = await verificarCredencial(this.cliente, credencial, { mercado: MERCADOS[this.mercado] });
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

  /* ---------------- estado global ---------------- */

  async estadoApp(): Promise<EstadoApp> {
    const resumen = this.conexiones.resumen();
    return {
      vault: await this.estadoVault(),
      /* El desbloqueo rapido por PIN es de una fase posterior. */
      pinIntentosRestantes: null,
      cuentasRegistradas: this.registro?.listarCuentas().length ?? 0,
      cuentasConectadas: resumen.conectada + resumen['modo-rest'],
      socketsCalientes: 0
    };
  }
}
