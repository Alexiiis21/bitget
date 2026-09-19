/**
 * El freno de los intentos contra la contrasena maestra.
 *
 * ==========================================================================
 * Que problema resuelve, y por que una espera y no un bloqueo
 * ==========================================================================
 * Hasta ahora la maestra se podia probar **sin limite**: cada intento fallido
 * devolvia «contrasena incorrecta» y ya. El unico coste era el medio segundo de
 * scrypt, que frena a dos intentos por segundo y a nadie mas.
 *
 * Bloquear el panel tras N fallos resuelve eso y crea otro problema peor: deja
 * al operador sin salida y sin nada que hacer, con el dinero abierto en Bitget
 * y un panel que no vuelve a abrirse. Lo pidio el cliente el 17/09/2026 con
 * estas palabras: una espera creciente «soluciona el problema de que hacer al
 * bloquearse, simplemente esperar».
 *
 * Asi que el castigo es tiempo, y el tiempo pasa solo:
 *
 *   fallos 1 y 2   sin espera. Teclear mal una clave larga es normal, y
 *                  castigar el primer desliz molestaria a diario a quien si
 *                  conoce la clave.
 *   fallo 3        3 min
 *   fallo 4        6 min
 *   fallo 5        12 min
 *   fallo 6        24 min
 *   fallo 7        48 min
 *   fallo 8+       60 min, que es el tope
 *
 * El tope existe por la misma razon que la espera: doblar sin limite convierte
 * el octavo despiste en medio dia sin panel, y eso vuelve a ser un bloqueo con
 * otro nombre. Una hora frena a quien tantea -sesenta intentos al dia- sin
 * dejar fuera a quien acabara acordandose de su clave.
 *
 * ==========================================================================
 * Vive en el proceso principal y en disco. Las dos cosas importan
 * ==========================================================================
 * En el renderer seria un adorno: cerrar y volver a abrir el .exe reiniciaria
 * el contador, y basta con eso para que el freno no frene nada. Aqui se impone
 * **antes** de derivar la clave, en el mismo sitio que abre el almacen, y el
 * estado se guarda junto a los demas datos del panel para que sobreviva a un
 * reinicio.
 *
 * ==========================================================================
 * Lo que este freno NO es
 * ==========================================================================
 * No es una defensa contra quien tiene el disco. Quien se lleve la carpeta
 * puede borrar este archivo, o ignorar el panel entero y atacar `vault.enc`
 * directamente; contra eso protege el KDF -scrypt N=2^17- y la longitud de la
 * contrasena, no esto. Lo que frena es el tanteo **por la interfaz**: alguien
 * que se sienta ante un panel ajeno y prueba claves.
 *
 * Adelantar el reloj de Windows tambien salta la espera. Se podria atar a un
 * reloj monotono, pero ese se reinicia con la maquina y entonces el freno se
 * saltaria reiniciando, que es mas facil todavia. Entre las dos fugas se elige
 * esta, y se deja escrita en vez de fingir que no existe. Retrasar el reloj si
 * esta cubierto: ver `restanteMs`.
 */
import { z } from 'zod';
import { esperaTrasFallos } from '@shared/espera-maestra';
import { escribirAtomico } from '../storage/atomic-write';
import { readFile } from 'node:fs/promises';

const esquemaEstado = z.object({
  /** Fallos consecutivos. Un acierto lo devuelve a cero. */
  fallos: z.number().int().min(0),
  /**
   * Cuando empezo la espera vigente, o `null` si no hay ninguna.
   *
   * Se guarda el **inicio** y la duracion en vez del instante final porque es
   * lo que permite detectar un reloj movido hacia atras: ver `restanteMs`.
   */
  esperaDesde: z.number().int().min(0).nullable(),
  duracionMs: z.number().int().min(0)
});

type EstadoFreno = z.infer<typeof esquemaEstado>;

const VACIO: EstadoFreno = { fallos: 0, esperaDesde: null, duracionMs: 0 };

export interface OpcionesFreno {
  /** Reloj. Se inyecta en las pruebas para no depender de esperas reales. */
  ahora?: () => number;
}

export class FrenoMaestra {
  private readonly ruta: string;
  private readonly ahora: () => number;
  private estado: EstadoFreno;

  private constructor(ruta: string, estado: EstadoFreno, opciones: OpcionesFreno) {
    this.ruta = ruta;
    this.estado = estado;
    this.ahora = opciones.ahora ?? Date.now;
  }

  /**
   * Lee el estado del disco. Un archivo ausente o ilegible arranca en limpio.
   *
   * No se cae por un archivo corrupto a proposito: este archivo no guarda nada
   * que no se pueda perder, y negarse a arrancar por el dejaria el panel
   * inservible por un contador de intentos.
   */
  static async cargar(ruta: string, opciones: OpcionesFreno = {}): Promise<FrenoMaestra> {
    try {
      const crudo: unknown = JSON.parse(await readFile(ruta, 'utf8'));
      const leido = esquemaEstado.safeParse(crudo);
      return new FrenoMaestra(ruta, leido.success ? leido.data : { ...VACIO }, opciones);
    } catch {
      return new FrenoMaestra(ruta, { ...VACIO }, opciones);
    }
  }

  /** Fallos consecutivos acumulados. */
  get fallos(): number {
    return this.estado.fallos;
  }

  /**
   * Milisegundos que faltan para poder volver a intentarlo. `0` si ya se puede.
   *
   * --------------------------------------------------------------------------
   * El reloj hacia atras
   * --------------------------------------------------------------------------
   * Si el reloj del equipo es **anterior** al inicio de la espera, alguien lo
   * movio -o cambio de zona horaria-. Se devuelve la espera entera en vez de
   * darla por cumplida: atrasar el reloj no puede ser la forma de saltarsela.
   */
  restanteMs(): number {
    const { esperaDesde, duracionMs } = this.estado;
    if (esperaDesde === null || duracionMs === 0) return 0;

    const t = this.ahora();
    if (t < esperaDesde) return duracionMs;

    return Math.max(0, esperaDesde + duracionMs - t);
  }

  /** `true` cuando hay una espera en curso. */
  get frenado(): boolean {
    return this.restanteMs() > 0;
  }

  /**
   * Anota un intento fallido y devuelve lo que hay que esperar ahora.
   *
   * Guardar puede fallar -disco lleno, carpeta sin permisos- y no se propaga:
   * el freno en memoria ya subio, y tumbar la pantalla de desbloqueo porque no
   * se pudo escribir un contador dejaria el panel inservible. Lo que se pierde
   * en ese caso es que la cuenta sobreviva al reinicio.
   */
  async anotarFallo(): Promise<number> {
    const fallos = this.estado.fallos + 1;
    const duracionMs = esperaTrasFallos(fallos);

    this.estado = {
      fallos,
      esperaDesde: duracionMs === 0 ? null : this.ahora(),
      duracionMs
    };

    await this.guardar();
    return duracionMs;
  }

  /** Un acierto borra el castigo entero. */
  async anotarAcierto(): Promise<void> {
    if (this.estado.fallos === 0 && this.estado.esperaDesde === null) return;
    this.estado = { ...VACIO };
    await this.guardar();
  }

  private async guardar(): Promise<void> {
    try {
      await escribirAtomico(this.ruta, JSON.stringify(this.estado));
    } catch {
      /* Ver `anotarFallo`: un contador no puede tumbar el panel. */
    }
  }
}
