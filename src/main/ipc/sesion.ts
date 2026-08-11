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
  EstadoApp,
  EstadoVault,
  FilaCuenta,
  ResultadoAlta,
  ResultadoPrueba,
  ResultadoVault
} from '@shared/ipc-contract';
import type { EstadoConexion } from '@shared/types';
import { ErrorBitget } from '../bitget/errors';
import type { ClienteBitget } from '../bitget/rest/client';
import type { Credencial } from '../bitget/rest/signer';
import { verificarCredencial, type ResultadoVerificacion } from '../bitget/verificacion';
import { RegistroConexiones } from '../domain/estado-conexion';
import { RegistroCuentas } from '../domain/registro-cuentas';
import { ErrorVault, Vault, estadoEnDisco } from '../security/vault';

export interface RutasSesion {
  vault: string;
  cuentas: string;
}

export class Sesion {
  private readonly rutas: RutasSesion;
  private readonly cliente: ClienteBitget;
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

  constructor(rutas: RutasSesion, cliente: ClienteBitget) {
    this.rutas = rutas;
    this.cliente = cliente;
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
    this.conexiones = new RegistroConexiones();
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
        apiKeyEnmascarada: cuenta.apiKeyEnmascarada,
        estado: estado?.estado ?? 'desconectada',
        motivo: estado?.motivo ?? null,
        altaEn: cuenta.altaEn
      };
    });
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

    const credencial: Credencial = {
      apiKey: alta.apiKey.trim(),
      secretKey: alta.secretKey.trim(),
      passphrase: alta.passphrase
    };

    let verificacion: ResultadoVerificacion;
    try {
      verificacion = await verificarCredencial(this.cliente, credencial);
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

    const cuentaId = registro.reservarId(grupoNombre, etiqueta);
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

    this.conexiones.registrarVerificacion(cuentaId, verificacion);

    return {
      ok: true,
      veredicto: 'valida',
      motivo: null,
      advertencias: verificacion.advertencias.map((a) => ({ codigo: a.codigo, mensaje: a.mensaje })),
      cuenta: {
        id: cuenta.id,
        etiqueta: cuenta.etiqueta,
        grupoNombre,
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

    if (!habia) return false;

    await vault.guardar();
    await registro.guardar();
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
      verificacion = await verificarCredencial(this.cliente, credencial);
    } catch (e) {
      /* Fallo de transporte: es la red la que falla, no la credencial. */
      const estado = this.conexiones.registrarFallo(cuentaId, e);
      return {
        ok: false,
        estado,
        motivo: e instanceof Error ? e.message : String(e),
        latenciaMs: 0,
        advertencias: []
      };
    }

    const estado: EstadoConexion = this.conexiones.registrarVerificacion(cuentaId, verificacion);

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
