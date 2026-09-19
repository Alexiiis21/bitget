/**
 * El respaldo que se hace solo.
 *
 * ==========================================================================
 * Por que existe
 * ==========================================================================
 * El boton manual resuelve el problema **si el operador se acuerda de
 * pulsarlo**. La version nueva llega, la abre desde Descargas y se encuentra el
 * panel vacio: en ese momento ya es tarde para respaldar. Esto cierra esa
 * ventana: tras cada alta y cada baja el respaldo se reescribe solo, de modo
 * que el archivo de Documentos siempre trae lo ultimo.
 *
 * ==========================================================================
 * Tres decisiones, y lo que pasa si se cambian
 * ==========================================================================
 *  1. **Es silencioso.** Ni aviso, ni evento hacia el renderer, ni dialogo. Un
 *     mecanismo automatico que grita rompe justo el flujo al que debia ser
 *     invisible: el operador esta dando de alta veinte subcuentas, no pensando
 *     en respaldos. Si falla cinco veces, se entera al pulsar el boton manual,
 *     que es cuando de verdad lo necesita y cuando el mensaje sirve para algo.
 *
 *  2. **Espera antes de escribir.** Un operador pegando veinte subcuentas
 *     seguidas escribiria veinte archivos y podaria diez en un minuto. Con la
 *     espera, la rafaga se agrupa en uno solo -y el que sobrevive es el que lo
 *     tiene todo, que es el unico que valia-. No mas espera que eso, porque el
 *     panel se puede cerrar justo despues del ultimo alta.
 *
 *  3. **Nunca dos a la vez.** Una cola de una plaza: si ya hay un respaldo en
 *     vuelo, el siguiente aviso marca «hay que repetir» y se corre **una sola
 *     vez** al terminar. Sin esto, dos escrituras concurrentes sobre el mismo
 *     alias podrian entrelazarse.
 *
 * No puede filtrar nada: `crearRespaldo` copia bytes cifrados y no necesita la
 * contrasena maestra. Ver la cabecera de `respaldo-credenciales.ts`.
 */
import { crearRespaldo, type OpcionesRespaldo, type OrigenRespaldo } from './respaldo-credenciales';

/** Espera tras el ultimo cambio antes de escribir. Ver la decision 2. */
export const ESPERA_RESPALDO_MS = 3_000;

export interface OpcionesAutomatico {
  origen: OrigenRespaldo;
  carpeta: string;
  respaldo: OpcionesRespaldo;
  /** Sobrescribible en pruebas. */
  esperaMs?: number;
  /** Que hacer cuando falla. En produccion, una linea en la bitacora. */
  alFallar?: (e: unknown) => void;
}

export interface RespaldoProgramado {
  /** Rearma el temporizador. Sincrono, no lanza y no devuelve nada. */
  pedir(): void;
  /** Vacia lo pendiente y deja de programar. Se espera al cerrar el panel. */
  parar(): Promise<void>;
}

export function programarRespaldo(opciones: OpcionesAutomatico): RespaldoProgramado {
  const espera = opciones.esperaMs ?? ESPERA_RESPALDO_MS;
  const alFallar = opciones.alFallar ?? ((): void => undefined);

  let temporizador: ReturnType<typeof setTimeout> | null = null;
  let enVuelo: Promise<void> | null = null;
  let pendiente = false;
  let parado = false;

  const escribir = async (): Promise<void> => {
    try {
      const r = await crearRespaldo(opciones.origen, opciones.carpeta, opciones.respaldo);
      /*
       * `sin-vault` no es un fallo del que avisar: es un panel recien
       * instalado, donde no hay nada que respaldar todavia.
       */
      if (!r.ok && r.motivo !== 'sin-vault') alFallar(new Error(r.mensaje));
    } catch (e) {
      alFallar(e);
    }
  };

  /** La cola de una plaza. Ver la decision 3. */
  const correr = (): void => {
    if (enVuelo !== null) {
      pendiente = true;
      return;
    }
    enVuelo = escribir().finally(() => {
      enVuelo = null;
      if (pendiente && !parado) {
        pendiente = false;
        correr();
      }
    });
  };

  return {
    pedir: () => {
      if (parado) return;
      if (temporizador !== null) clearTimeout(temporizador);
      temporizador = setTimeout(() => {
        temporizador = null;
        correr();
      }, espera);
      /* Un respaldo pendiente no debe impedir que el proceso termine. */
      temporizador.unref?.();
    },

    parar: async () => {
      parado = true;
      if (temporizador !== null) {
        clearTimeout(temporizador);
        temporizador = null;
        /* Habia uno esperando su turno: se escribe ahora en vez de perderlo. */
        pendiente = false;
        await escribir();
      }
      /* Y se espera a lo que ya estuviera en vuelo, mas su repeticion si la habia. */
      while (enVuelo !== null) await enVuelo;
    }
  };
}
