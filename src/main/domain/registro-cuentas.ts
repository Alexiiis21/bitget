/**
 * Registro de cuentas (`cuentas.json`).
 *
 * Guarda lo que se puede leer sin descifrar nada: que subcuentas hay, en que
 * cuenta principal estan y con que credencial se corresponden. Los secretos
 * viven en `vault.enc` y no se duplican aqui -ni siquiera la API Key completa-,
 * de modo que este archivo se puede abrir con un editor de texto sin exponer
 * nada. docs/03-modelo-de-datos.md secciones 4 y 5.
 *
 * La relacion con el vault es por `cuentaId`: el vault guarda una credencial
 * por cuenta y este archivo, una cuenta por credencial. Si uno de los dos se
 * pierde el otro sigue siendo legible, y `sincronizar()` deja fuera las cuentas
 * que se quedaron sin credencial en lugar de fingir que existen.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { CUENTAS_MADRE_MAX, SUBCUENTAS_POR_GRUPO } from '@shared/constants';
import type { Cuenta, Grupo, ModoMargen, ModoPosicion } from '@shared/types';
import { escribirAtomico, existe, rotarRespaldo } from '../storage/atomic-write';

/**
 * Version 3: se guarda el UID de la cuenta principal (`uidPadre`).
 *
 * Historial, y por que se siguen leyendo los archivos viejos:
 *
 *   v1 -> v2  la casilla del operador (`slot`) sustituyo al orden de insercion.
 *             Un `orden` -indice desde cero- se traduce a la casilla al cargar.
 *   v2 -> v3  se anadio `uidPadre`. Los archivos anteriores no lo traen y se
 *             cargan con la cadena vacia; se rellena solo la proxima vez que se
 *             valide esa credencial, porque el dato lo da Bitget y no se puede
 *             inventar al migrar.
 *
 * En ningun caso se convierte el archivo por las bravas: se reescribe con el
 * formato nuevo la proxima vez que se guarde.
 */
const VERSION_ACTUAL = 3;

const esquemaGrupo = z.object({
  id: z.string(),
  nombre: z.string(),
  orden: z.number().int().nonnegative(),
  colapsado: z.boolean()
});

const esquemaCuenta = z.object({
  id: z.string(),
  grupoId: z.string(),
  etiqueta: z.string(),
  uid: z.string(),
  /** Formato v3. Ausente en archivos anteriores: se carga como cadena vacia. */
  uidPadre: z.string().default(''),
  credencialId: z.string(),
  apiKeyEnmascarada: z.string(),
  slot: z.number().int().positive().optional(),
  /** Formato v1. Solo se lee; no se vuelve a escribir. */
  orden: z.number().int().nonnegative().optional(),
  activa: z.boolean(),
  modoPosicion: z.enum(['cobertura', 'unilateral']),
  modoMargen: z.enum(['aislado', 'cruzado']),
  altaEn: z.string()
});

const esquemaArchivo = z.object({
  version: z.number().int().positive(),
  grupos: z.array(esquemaGrupo),
  cuentas: z.array(esquemaCuenta)
});

/** Datos de alta de una cuenta. La casilla la asigna el registro; el `id`, `reservarId`. */
export interface AltaCuentaRegistro {
  id: string;
  grupoNombre: string;
  etiqueta: string;
  /** UID de Bitget. Lo trae la verificacion, nunca el formulario. */
  uid: string;
  /** UID de la cuenta principal segun Bitget, o cadena vacia si no lo informa. */
  uidPadre: string;
  credencialId: string;
  apiKeyEnmascarada: string;
  modoPosicion: ModoPosicion;
  modoMargen: ModoMargen;
}

/** Motivo por el que un alta no cabe en el registro. */
export type MotivoRegistro = 'grupos-llenos' | 'casillas-llenas';

export class ErrorRegistro extends Error {
  readonly motivo: MotivoRegistro;

  constructor(motivo: MotivoRegistro, mensaje: string) {
    super(mensaje);
    this.name = 'ErrorRegistro';
    this.motivo = motivo;
  }
}

/**
 * Deja cada subcuenta con una casilla valida y unica dentro de su grupo.
 *
 * Cubre tres casos a la vez: el archivo de version 1, que solo trae `orden`; un
 * archivo editado a mano con casillas repetidas o fuera de rango; y el caso
 * normal, en el que no cambia nada. Se respeta la casilla que ya tuviera cada
 * cuenta siempre que se pueda, porque es la que el operador tiene memorizada.
 */
function normalizarCasillas(cuentas: z.infer<typeof esquemaCuenta>[]): Cuenta[] {
  const ocupadasPorGrupo = new Map<string, Set<number>>();

  const reservar = (grupoId: string, deseada: number | undefined): number => {
    let ocupadas = ocupadasPorGrupo.get(grupoId);
    if (ocupadas === undefined) {
      ocupadas = new Set<number>();
      ocupadasPorGrupo.set(grupoId, ocupadas);
    }
    if (deseada !== undefined && deseada >= 1 && deseada <= SUBCUENTAS_POR_GRUPO && !ocupadas.has(deseada)) {
      ocupadas.add(deseada);
      return deseada;
    }
    for (let n = 1; n <= SUBCUENTAS_POR_GRUPO; n += 1) {
      if (!ocupadas.has(n)) {
        ocupadas.add(n);
        return n;
      }
    }
    /* Mas de 20 subcuentas en un grupo: el archivo viene de otra parte. */
    throw new ErrorRegistro(
      'casillas-llenas',
      `El registro trae más de ${SUBCUENTAS_POR_GRUPO} subcuentas en una misma cuenta principal.`
    );
  };

  return cuentas.map(({ orden, ...resto }) => ({
    ...resto,
    /* `orden` es un indice desde cero; la casilla empieza en uno. */
    slot: reservar(resto.grupoId, resto.slot ?? (orden === undefined ? undefined : orden + 1))
  }));
}

export class RegistroCuentas {
  private readonly ruta: string;
  private grupos: Grupo[];
  private cuentas: Cuenta[];

  private constructor(ruta: string, grupos: Grupo[], cuentas: Cuenta[]) {
    this.ruta = ruta;
    this.grupos = grupos;
    this.cuentas = cuentas;
  }

  /**
   * Carga el registro, o arranca uno vacio si no existe.
   *
   * Un archivo ilegible tampoco es motivo para detenerse: el panel arranca sin
   * cuentas y el archivo anterior se conserva. Perder el listado es molesto;
   * sobrescribirlo con uno vacio seria irreversible.
   */
  static async cargar(ruta: string): Promise<RegistroCuentas> {
    if (!(await existe(ruta))) return new RegistroCuentas(ruta, [], []);

    try {
      const archivo = esquemaArchivo.parse(JSON.parse(await readFile(ruta, 'utf8')));
      return new RegistroCuentas(ruta, archivo.grupos, normalizarCasillas(archivo.cuentas));
    } catch {
      return new RegistroCuentas(ruta, [], []);
    }
  }

  /* ---- casillas ---- */

  /**
   * Primera casilla libre de la cuenta principal.
   *
   * Se reutiliza el hueco que deja una baja en vez de seguir contando: con 20
   * casillas por cuenta, no reutilizarlas dejaria la rejilla sin sitio despues
   * de 20 altas y bajas aunque estuviera medio vacia.
   */
  private casillaLibre(grupoId: string): number {
    const ocupadas = new Set(this.cuentas.filter((c) => c.grupoId === grupoId).map((c) => c.slot));
    for (let n = 1; n <= SUBCUENTAS_POR_GRUPO; n += 1) {
      if (!ocupadas.has(n)) return n;
    }
    throw new ErrorRegistro(
      'casillas-llenas',
      `Esta cuenta principal ya tiene sus ${SUBCUENTAS_POR_GRUPO} subcuentas. ` +
        'Dé de baja una antes de registrar otra, o use otra cuenta principal.'
    );
  }

  listarCuentas(): Cuenta[] {
    return this.cuentas.map((c) => ({ ...c }));
  }

  listarGrupos(): Grupo[] {
    return this.grupos.map((g) => ({ ...g }));
  }

  cuenta(cuentaId: string): Cuenta | undefined {
    const c = this.cuentas.find((x) => x.id === cuentaId);
    return c === undefined ? undefined : { ...c };
  }

  grupo(grupoId: string): Grupo | undefined {
    const g = this.grupos.find((x) => x.id === grupoId);
    return g === undefined ? undefined : { ...g };
  }

  /** Nombre de la cuenta principal de una subcuenta, o cadena vacia si se perdio. */
  nombreDeGrupo(grupoId: string): string {
    return this.grupos.find((g) => g.id === grupoId)?.nombre ?? '';
  }

  /** Busca la cuenta principal por nombre, y la crea si es la primera vez. */
  private grupoPorNombre(nombre: string): Grupo {
    const limpio = nombre.trim();
    const existente = this.grupos.find((g) => g.nombre.toLowerCase() === limpio.toLowerCase());
    if (existente !== undefined) return existente;

    if (this.grupos.length >= CUENTAS_MADRE_MAX) {
      throw new ErrorRegistro(
        'grupos-llenos',
        `El panel admite hasta ${CUENTAS_MADRE_MAX} cuentas principales y ya están todas. ` +
          'Registre la subcuenta en una de las existentes.'
      );
    }

    const grupo: Grupo = {
      id: `grp_${randomUUID().slice(0, 8)}`,
      nombre: limpio,
      orden: this.grupos.length,
      colapsado: false
    };
    this.grupos.push(grupo);
    return grupo;
  }

  /** La subcuenta que ya ocupa esa etiqueta en esa cuenta principal, si la hay. */
  /**
   * La ficha que ya corresponde a esta subcuenta, si la hay.
   *
   * --------------------------------------------------------------------------
   * El UID manda sobre el nombre, y no es un detalle
   * --------------------------------------------------------------------------
   * El nombre lo escribe el operador y puede cambiar; la API Key se rota; lo
   * unico que Bitget mantiene fijo es el UID. Emparejar por nombre significaba
   * que volver a registrar la misma subcuenta con otra etiqueta creaba una
   * **ficha duplicada**: dos casillas en la rejilla y dos credenciales para una
   * sola subcuenta real, sin que nada avisara.
   *
   * Por eso se busca primero por UID, y en todo el registro y no solo dentro de
   * la cuenta principal indicada: si el operador ademas se equivoco de grupo,
   * sigue siendo la misma subcuenta y hay que reconocerla.
   *
   * El nombre queda como respaldo para las fichas de archivos antiguos, que
   * pueden no tener UID hasta que se validen otra vez.
   */
  private existente(grupoNombre: string, etiqueta: string, uid?: string): Cuenta | undefined {
    if (uid !== undefined && uid !== '') {
      const porUid = this.cuentas.find((c) => c.uid === uid);
      if (porUid !== undefined) return porUid;
    }

    const nombre = grupoNombre.trim().toLowerCase();
    const grupo = this.grupos.find((g) => g.nombre.toLowerCase() === nombre);
    if (grupo === undefined) return undefined;
    const clave = etiqueta.trim().toLowerCase();
    return this.cuentas.find((c) => c.grupoId === grupo.id && c.etiqueta.toLowerCase() === clave);
  }

  /**
   * ¿Cabe esta subcuenta? Devuelve el estorbo, o `null` si cabe.
   *
   * Se consulta **antes** de preguntar a Bitget. Comprobarlo despues costaria
   * dos peticiones del cupo para acabar rechazando el alta de todos modos, y
   * dejaria la credencial ya cifrada en memoria sin cuenta a la que pertenecer.
   * Dar de alta una subcuenta que ya existe siempre cabe: es rotar su clave.
   */
  comprobarCabida(grupoNombre: string, etiqueta: string): ErrorRegistro | null {
    if (this.existente(grupoNombre, etiqueta) !== undefined) return null;

    const nombre = grupoNombre.trim().toLowerCase();
    const grupo = this.grupos.find((g) => g.nombre.toLowerCase() === nombre);

    if (grupo === undefined) {
      if (this.grupos.length < CUENTAS_MADRE_MAX) return null;
      return new ErrorRegistro(
        'grupos-llenos',
        `El panel admite hasta ${CUENTAS_MADRE_MAX} cuentas principales y ya están todas. ` +
          'Registre la subcuenta en una de las existentes.'
      );
    }

    const ocupadas = this.cuentas.filter((c) => c.grupoId === grupo.id).length;
    if (ocupadas < SUBCUENTAS_POR_GRUPO) return null;
    return new ErrorRegistro(
      'casillas-llenas',
      `La cuenta principal «${grupo.nombre}» ya tiene sus ${SUBCUENTAS_POR_GRUPO} subcuentas. ` +
        'Dé de baja una antes de registrar otra, o use otra cuenta principal.'
    );
  }

  /**
   * Id que le corresponde a esta subcuenta: el que ya tiene, o uno nuevo.
   *
   * No modifica nada. Hace falta porque el vault indexa las credenciales por
   * `cuentaId`, asi que hay que conocer el id antes de guardar la credencial y
   * antes de saber si el alta va a prosperar.
   */
  reservarId(grupoNombre: string, etiqueta: string, uid?: string): string {
    return this.existente(grupoNombre, etiqueta, uid)?.id ?? `cta_${randomUUID().slice(0, 8)}`;
  }

  /**
   * Da de alta una subcuenta, o actualiza la ficha que ya le correspondia:
   * registrar dos veces la misma es rotar su API Key, no duplicarla.
   *
   * Cual es «la que ya le correspondia» lo decidio `reservarId` a partir del
   * UID de Bitget, asi que aqui basta con buscar por `id`. Puede llegar con el
   * nombre cambiado, con otra clave o incluso en otra cuenta principal: sigue
   * siendo la misma subcuenta y conserva su ficha.
   */
  agregar(alta: AltaCuentaRegistro): Cuenta {
    const grupo = this.grupoPorNombre(alta.grupoNombre);
    const previa = this.cuentas.find((c) => c.id === alta.id);
    /* Rotar la clave no mueve de casilla; cambiar de cuenta principal, si. */
    const sigueEnSuGrupo = previa !== undefined && previa.grupoId === grupo.id;

    const cuenta: Cuenta = {
      id: alta.id,
      grupoId: grupo.id,
      etiqueta: alta.etiqueta.trim(),
      uid: alta.uid,
      uidPadre: alta.uidPadre,
      credencialId: alta.credencialId,
      apiKeyEnmascarada: alta.apiKeyEnmascarada,
      slot: sigueEnSuGrupo ? previa.slot : this.casillaLibre(grupo.id),
      activa: true,
      modoPosicion: alta.modoPosicion,
      modoMargen: alta.modoMargen,
      altaEn: previa?.altaEn ?? new Date().toISOString()
    };

    if (previa === undefined) this.cuentas.push(cuenta);
    else this.cuentas.splice(this.cuentas.indexOf(previa), 1, cuenta);

    /* Una cuenta principal que se queda sin subcuentas no pinta nada. */
    if (previa !== undefined && !sigueEnSuGrupo) {
      const viejo = previa.grupoId;
      if (!this.cuentas.some((c) => c.grupoId === viejo)) {
        this.grupos = this.grupos.filter((g) => g.id !== viejo);
      }
    }

    return { ...cuenta };
  }

  /** Baja de una subcuenta. La cuenta principal vacia se retira con ella. */
  eliminar(cuentaId: string): boolean {
    const indice = this.cuentas.findIndex((c) => c.id === cuentaId);
    if (indice === -1) return false;

    const [fuera] = this.cuentas.splice(indice, 1);
    if (fuera !== undefined && !this.cuentas.some((c) => c.grupoId === fuera.grupoId)) {
      this.grupos = this.grupos.filter((g) => g.id !== fuera.grupoId);
    }
    return true;
  }

  /**
   * Retira las cuentas cuya credencial ya no esta en el vault.
   *
   * Pasa si alguien copia `cuentas.json` de otra maquina o restaura un
   * `vault.enc` viejo. Mostrar una cuenta que no puede firmar nada es peor que
   * no mostrarla: el operador la contaria como operativa.
   */
  sincronizar(cuentaIdsConCredencial: readonly string[]): boolean {
    const validos = new Set(cuentaIdsConCredencial);
    const antes = this.cuentas.length;
    this.cuentas = this.cuentas.filter((c) => validos.has(c.id));
    if (this.cuentas.length === antes) return false;

    const usados = new Set(this.cuentas.map((c) => c.grupoId));
    this.grupos = this.grupos.filter((g) => usados.has(g.id));
    return true;
  }

  async guardar(): Promise<void> {
    await rotarRespaldo(this.ruta);
    await escribirAtomico(
      this.ruta,
      JSON.stringify({ version: VERSION_ACTUAL, grupos: this.grupos, cuentas: this.cuentas }, null, 2)
    );
  }
}
