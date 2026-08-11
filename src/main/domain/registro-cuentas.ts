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
import type { Cuenta, Grupo, ModoMargen, ModoPosicion } from '@shared/types';
import { escribirAtomico, existe, rotarRespaldo } from '../storage/atomic-write';

const VERSION_ACTUAL = 1;

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
  credencialId: z.string(),
  apiKeyEnmascarada: z.string(),
  orden: z.number().int().nonnegative(),
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

/** Datos de alta de una cuenta. El orden lo pone el registro; el `id`, `reservarId`. */
export interface AltaCuentaRegistro {
  id: string;
  grupoNombre: string;
  etiqueta: string;
  uid: string;
  credencialId: string;
  apiKeyEnmascarada: string;
  modoPosicion: ModoPosicion;
  modoMargen: ModoMargen;
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
      return new RegistroCuentas(ruta, archivo.grupos, archivo.cuentas);
    } catch {
      return new RegistroCuentas(ruta, [], []);
    }
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
  private existente(grupoNombre: string, etiqueta: string): Cuenta | undefined {
    const nombre = grupoNombre.trim().toLowerCase();
    const grupo = this.grupos.find((g) => g.nombre.toLowerCase() === nombre);
    if (grupo === undefined) return undefined;
    const clave = etiqueta.trim().toLowerCase();
    return this.cuentas.find((c) => c.grupoId === grupo.id && c.etiqueta.toLowerCase() === clave);
  }

  /**
   * Id que le corresponde a esta subcuenta: el que ya tiene, o uno nuevo.
   *
   * No modifica nada. Hace falta porque el vault indexa las credenciales por
   * `cuentaId`, asi que hay que conocer el id antes de guardar la credencial y
   * antes de saber si el alta va a prosperar.
   */
  reservarId(grupoNombre: string, etiqueta: string): string {
    return this.existente(grupoNombre, etiqueta)?.id ?? `cta_${randomUUID().slice(0, 8)}`;
  }

  /**
   * Da de alta una subcuenta, o actualiza la que ya tuviera esa etiqueta en esa
   * cuenta principal: registrar dos veces la misma es rotar su API Key, no
   * duplicarla.
   */
  agregar(alta: AltaCuentaRegistro): Cuenta {
    const grupo = this.grupoPorNombre(alta.grupoNombre);
    const previa = this.cuentas.find((c) => c.id === alta.id);

    const cuenta: Cuenta = {
      id: alta.id,
      grupoId: grupo.id,
      etiqueta: alta.etiqueta.trim(),
      uid: alta.uid,
      credencialId: alta.credencialId,
      apiKeyEnmascarada: alta.apiKeyEnmascarada,
      orden: previa?.orden ?? this.cuentas.length,
      activa: true,
      modoPosicion: alta.modoPosicion,
      modoMargen: alta.modoMargen,
      altaEn: previa?.altaEn ?? new Date().toISOString()
    };

    if (previa === undefined) this.cuentas.push(cuenta);
    else this.cuentas.splice(this.cuentas.indexOf(previa), 1, cuenta);

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
