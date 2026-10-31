/**
 * El vigía: al abrir el panel, revisa qué se hizo fuera de él y lo manda a
 * Telegram.
 *
 * ==========================================================================
 * El panel es el despertador
 * ==========================================================================
 * Decisión del 15/10/2026: no hace falta tiempo real. Al desbloquear, el
 * vigía mira cada subcuenta desde su última revisión (su **marca**), separa
 * lo externo con `clasificar` y lo envía en un resumen por cuenta madre.
 * Desde el 16/10/2026, con el panel abierto se repite cada 15 minutos
 * (`Sesion.cicloVigia`): las revisiones son baratas porque cada una solo pide
 * lo ocurrido desde la anterior.
 *
 * ==========================================================================
 * Lo que no puede pasar, y cómo se evita
 * ==========================================================================
 *   Avisar 90 días de golpe   La primera vez que ve una subcuenta solo toma
 *                             la foto de partida: marca = ahora.
 *   Perder un aviso           Lo detectado y la marca nueva se guardan en
 *                             **una sola** escritura atómica (`estado.json`):
 *                             o están las dos cosas o ninguna. Un evento sale
 *                             de la cola solo cuando Telegram confirma.
 *   Repetir un aviso          Las revisiones se solapan `SOLAPE_MS` para no
 *                             perder lo que cae en el borde; lo ya visto se
 *                             recuerda por su clave durante ese solape.
 *   Mezclar sesiones          `detener()` al bloquear: lo que estaba en curso
 *                             ya no guarda nada ni envía, y la marca no avanza.
 *   Dos revisiones a la vez   Una sola en curso; quien llega comparte su
 *                             resultado. Todo cambio de estado va en cola.
 *
 * Un fallo de Telegram deja los eventos en la cola: la siguiente apertura los
 * vuelve a intentar. Riesgo que queda: un corte justo entre que Telegram
 * acepta y se guarda la confirmación repite ese mensaje. Repetido, nunca
 * perdido.
 *
 * ==========================================================================
 * Rastro en la bitácora
 * ==========================================================================
 * Hasta la v0.16.3 el vigía no anotaba nada: con el cliente diciendo «no me
 * llega ninguna alerta», el log no distinguía un bot sin configurar de una red
 * caída o de un Telegram que rechaza. Ahora cada revisión deja `vigia-revision`,
 * cada operación externa `alerta-detectada`, y cada mensaje `alerta-enviada` o
 * `alerta-fallida` con el código de Telegram. El token no sale nunca: ni
 * `ErrorTelegram` lo lleva ni se anota la URL.
 */
import { readFile, rm } from 'node:fs/promises';
import { anotarEvento } from '../diagnostico/bitacora';
import { redactarTexto } from '../security/redact';
import { escribirAtomico, existe } from '../storage/atomic-write';
import type { AccionPropia, BitacoraAcciones } from '../storage/bitacora-acciones';
import { dormirReal } from '../historial/reintento';
import {
  ajustePropio,
  ANTES_MS,
  clasificar,
  unirTpDeApertura,
  type TraspasoDelPanel
} from './clasificador';
import { VENTANA_ORDENES_MS, type FuentesCuenta } from './fuentes';
import { mensajesTelegram } from './mensajes';
import { ErrorTelegram, type ClienteTelegram } from './telegram';
import type { AjustesSimbolo, EventoCuenta, EventoPendiente } from './tipos';

/** Solape entre revisiones: lo que Bitget publica con retraso no se pierde. */
export const SOLAPE_MS = 10 * 60_000;
/** Más atrás no se puede pedir: Bitget no entrega más de 90 días. */
export const VENTANA_MAXIMA_MS = VENTANA_ORDENES_MS;
/** Subcuentas revisadas a la vez. Pocas: esto va por detrás de lo que opera el operador. */
export const CONCURRENCIA = 3;
/** Entre mensajes: Telegram admite unos 20 por minuto en un grupo. */
export const PAUSA_MENSAJES_MS = 3_100;
/**
 * Apalancamiento y modo se leen como mucho una vez por hora y subcuenta.
 *
 * En Classic son 8 de las 12 peticiones de una revisión —una por activo—, y
 * con el panel abierto se revisa cada pocos minutos. Órdenes, TP/SL y
 * movimientos van en cada revisión; estos dos, que Bitget ni siquiera fecha,
 * no necesitan más.
 */
export const INTERVALO_AJUSTES_MS = 60 * 60_000;

export interface CuentaVigilada {
  cuentaId: string;
  uid: string;
  /** `PCB-1-A-1`. */
  identificador: string;
  etiqueta: string;
  grupo: string;
  /** Huella de su API Key: la que lleva su parte de la bitácora. */
  huella: string;
  /** Símbolos en los que se vigilan apalancamiento y modo: los de las casillas. */
  simbolos: string[];
  fuentes: FuentesCuenta;
}

export interface DestinoTelegram {
  cliente: ClienteTelegram;
  token: string;
  chatId: string;
}

export type ResultadoEnvio = 'ok' | 'sin-novedades' | 'fallo' | 'sin-configurar' | 'abortado';

export interface ResumenRevision {
  inicioMs: number;
  finMs: number;
  cuentas: number;
  revisadas: number;
  /** Subcuentas vistas por primera vez: solo se tomó su foto de partida. */
  nuevas: number;
  /** Operaciones externas encontradas en esta revisión. */
  detectadas: number;
  /** Operaciones avisadas por Telegram en esta revisión (incluye pendientes de antes). */
  enviadas: number;
  /** Las que siguen esperando a enviarse. */
  pendientes: number;
  errores: { identificador: string; mensaje: string }[];
  envio: ResultadoEnvio;
  mensajeEnvio: string | null;
}

interface EstadoCuenta {
  uid: string;
  /**
   * Cuándo se tomó la foto de partida. Ninguna revisión mira antes: el solape
   * de la segunda revisión, si no, alcanzaría lo de los minutos previos a
   * activar, que no se avisa. Ausente en estados de antes de este campo.
   */
  inicioMs?: number;
  marcaMs: number;
  /** Clave → fecha del evento, de lo ya avisado dentro del solape. */
  vistos: Record<string, number>;
  ajustes: Record<string, AjustesSimbolo>;
  ajustesMs: number;
}

interface EstadoArchivo {
  version: 1;
  cuentas: Record<string, EstadoCuenta>;
  pendientes: EventoPendiente[];
  ultimaRevision: ResumenRevision | null;
}

const vacio = (): EstadoArchivo => ({
  version: 1,
  cuentas: {},
  pendientes: [],
  ultimaRevision: null
});

export interface DependenciasVigia {
  rutaEstado: string;
  bitacora: BitacoraAcciones;
  traspasosPanel: () => Promise<TraspasoDelPanel[]>;
  /** Las subcuentas a revisar ahora. Vacío con el panel bloqueado. */
  cuentas: () => Promise<CuentaVigilada[]>;
  /** El bot configurado, o `null` si no hay: entonces no se revisa nada. */
  destino: () => DestinoTelegram | null;
  ahoraMs: () => number;
  zona: string;
  numeroPanel: () => number;
  moneda: string;
  dormir?: (ms: number) => Promise<void>;
  pausaMensajesMs?: number;
}

class Abortada extends Error {}

/** Un error, dicho para la bitácora: recortado, redactado y sin el token del bot. */
function mensajeParaLog(e: unknown, token: string | null): string {
  let texto = e instanceof Error ? e.message : String(e);
  if (token !== null && token !== '') texto = texto.split(token).join('[token]');
  return redactarTexto(texto).slice(0, 300);
}

const NOMBRE_MODO: Record<string, string> = { isolated: 'aislado', crossed: 'cruzado' };

/** Una línea por revisión: es la prueba de que el vigía sigue vivo. */
function anotarRevision(r: ResumenRevision): void {
  anotarEvento({
    evento: 'vigia-revision',
    datos: {
      cuentas: r.cuentas,
      revisadas: r.revisadas,
      nuevas: r.nuevas,
      detectadas: r.detectadas,
      enviadas: r.enviadas,
      pendientes: r.pendientes,
      errores: r.errores.length,
      envio: r.envio,
      ms: r.finMs - r.inicioMs
    }
  });
}

/** Los cambios de apalancamiento y modo que no hizo el panel. */
export function cambiosDeAjustes(
  antes: Record<string, AjustesSimbolo>,
  ahora: Record<string, AjustesSimbolo>,
  desdeMs: number,
  hastaMs: number,
  bitacora: readonly AccionPropia[]
): EventoCuenta[] {
  const salida: EventoCuenta[] = [];
  for (const [simbolo, act] of Object.entries(ahora)) {
    const prev = antes[simbolo];
    if (prev === undefined || ajustePropio(bitacora, simbolo, desdeMs)) continue;

    const base = {
      cuandoMs: hastaMs,
      desdeMs,
      simbolo,
      lado: null,
      cantidad: null,
      precio: null,
      importe: null,
      origen: null,
      clientOid: null,
      orderId: null,
      automatico: false
    };

    if (prev.modo !== null && act.modo !== null && prev.modo !== act.modo) {
      salida.push({
        ...base,
        clave: `ajuste:${simbolo}:modo:${hastaMs}`,
        tipo: 'modo-margen',
        detalle: `${NOMBRE_MODO[prev.modo] ?? prev.modo} → ${NOMBRE_MODO[act.modo] ?? act.modo}`
      });
    }

    const pares = (
      [
        ['long', prev.largo, act.largo],
        ['short', prev.corto, act.corto],
        ['cruzado', prev.cruzado, act.cruzado]
      ] as const
    ).filter(([, a, b]) => a !== null && b !== null && Number(a) !== Number(b));
    if (pares.length > 0) {
      const todosIguales = pares.every(([, a, b]) => a === pares[0]?.[1] && b === pares[0]?.[2]);
      salida.push({
        ...base,
        clave: `ajuste:${simbolo}:apalancamiento:${hastaMs}`,
        tipo: 'apalancamiento',
        detalle: todosIguales
          ? `${pares[0]?.[1]}x → ${pares[0]?.[2]}x`
          : pares.map(([n, a, b]) => `${n} ${a}x → ${b}x`).join(', ')
      });
    }
  }
  return salida;
}

export class VigiaOperaciones {
  private readonly deps: DependenciasVigia;
  private estado: EstadoArchivo | null = null;
  private cola: Promise<void> = Promise.resolve();
  private enCurso: Promise<ResumenRevision> | null = null;
  private generacion = 0;

  constructor(deps: DependenciasVigia) {
    this.deps = deps;
  }

  get revisando(): boolean {
    return this.enCurso !== null;
  }

  /** Todo cambio de estado, uno detrás de otro, y guardado al terminar. */
  private exclusivo<T>(tarea: (e: EstadoArchivo) => T | Promise<T>): Promise<T> {
    const esta = this.cola.then(async () => {
      const e = await this.cargar();
      const r = await tarea(e);
      await escribirAtomico(this.deps.rutaEstado, JSON.stringify(e));
      return r;
    });
    this.cola = esta.then(
      () => undefined,
      () => undefined
    );
    return esta;
  }

  private async cargar(): Promise<EstadoArchivo> {
    if (this.estado !== null) return this.estado;
    try {
      if (await existe(this.deps.rutaEstado)) {
        const e = JSON.parse(await readFile(this.deps.rutaEstado, 'utf8')) as EstadoArchivo;
        if (e.version === 1 && typeof e.cuentas === 'object' && Array.isArray(e.pendientes)) {
          this.estado = e;
          return e;
        }
      }
    } catch {
      /* Ilegible: se empieza de cero. Lo peor es tomar otra vez la foto de partida. */
    }
    this.estado = vacio();
    return this.estado;
  }

  /** Lo que la pantalla enseña: última revisión y cuántos esperan a enviarse. */
  async resumen(): Promise<{ ultimaRevision: ResumenRevision | null; pendientes: number }> {
    await this.cola;
    const e = await this.cargar();
    return { ultimaRevision: e.ultimaRevision, pendientes: e.pendientes.length };
  }

  /** Al bloquear el panel: lo que esté en curso ya no guarda ni envía nada. */
  detener(): void {
    this.generacion++;
  }

  /** Una subcuenta dada de baja deja de vigilarse. Sus avisos pendientes se envían igual. */
  olvidar(cuentaId: string): Promise<void> {
    return this.exclusivo((e) => {
      delete e.cuentas[cuentaId];
    });
  }

  /** Al desactivar las alertas: se borra todo, para que reactivarlas no avise lo de entretanto. */
  async reiniciar(): Promise<void> {
    this.generacion++;
    await this.cola;
    this.estado = vacio();
    await rm(this.deps.rutaEstado, { force: true });
  }

  revisar(): Promise<ResumenRevision> {
    if (this.enCurso !== null) return this.enCurso;
    const promesa = this.recorrer().finally(() => {
      if (this.enCurso === promesa) this.enCurso = null;
    });
    this.enCurso = promesa;
    return promesa;
  }

  private async recorrer(): Promise<ResumenRevision> {
    const gen = this.generacion;
    const inicioMs = this.deps.ahoraMs();
    const resumen: ResumenRevision = {
      inicioMs,
      finMs: inicioMs,
      cuentas: 0,
      revisadas: 0,
      nuevas: 0,
      detectadas: 0,
      enviadas: 0,
      pendientes: 0,
      errores: [],
      envio: 'sin-configurar',
      mensajeEnvio: null
    };

    if (this.deps.destino() === null) {
      resumen.mensajeEnvio = 'No hay un bot de Telegram configurado.';
      anotarRevision(resumen);
      return resumen;
    }

    const cuentas = await this.deps.cuentas();
    resumen.cuentas = cuentas.length;

    /* Varias subcuentas a la vez, pocas: el cupo es de lo que opera el operador. */
    let siguiente = 0;
    const trabajador = async (): Promise<void> => {
      while (siguiente < cuentas.length) {
        const c = cuentas[siguiente++];
        if (c === undefined || gen !== this.generacion) return;
        try {
          await this.revisarCuenta(c, gen, resumen);
          resumen.revisadas++;
        } catch (e) {
          if (e instanceof Abortada) return;
          /* La marca no avanza: la próxima revisión vuelve a pedir este tramo. */
          resumen.errores.push({
            identificador: c.identificador,
            mensaje: e instanceof Error ? e.message : String(e)
          });
          anotarEvento({
            evento: 'vigia-error-cuenta',
            datos: {
              cuenta: c.identificador,
              codigo: (e as { codigo?: string | null }).codigo ?? null,
              mensaje: mensajeParaLog(e, null)
            }
          });
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCIA }, trabajador));

    if (gen !== this.generacion) {
      resumen.envio = 'abortado';
      resumen.mensajeEnvio = 'Se bloqueó el panel durante la revisión; se repetirá al abrirlo.';
      anotarRevision(resumen);
      return resumen;
    }

    await this.enviarPendientes(gen, resumen);
    resumen.finMs = this.deps.ahoraMs();
    await this.exclusivo((e) => {
      resumen.pendientes = e.pendientes.length;
      e.ultimaRevision = resumen;
    }).catch(() => undefined);
    anotarRevision(resumen);
    return resumen;
  }

  private async revisarCuenta(
    c: CuentaVigilada,
    gen: number,
    resumen: ResumenRevision
  ): Promise<void> {
    const ahora = this.deps.ahoraMs();
    const previo = (await this.cargar()).cuentas[c.cuentaId];

    /* Primera vez —o la casilla es ya otra subcuenta—: solo la foto de partida. */
    if (previo === undefined || previo.uid !== c.uid) {
      const ajustes = await c.fuentes.ajustes(c.simbolos).catch(() => ({}));
      await this.exclusivo((e) => {
        if (gen !== this.generacion) throw new Abortada();
        e.cuentas[c.cuentaId] = {
          uid: c.uid,
          inicioMs: ahora,
          marcaMs: ahora,
          vistos: {},
          ajustes,
          ajustesMs: ahora
        };
      });
      resumen.nuevas++;
      return;
    }

    const limite = ahora - VENTANA_MAXIMA_MS;
    const desde = Math.max(previo.marcaMs - SOLAPE_MS, previo.inicioMs ?? 0, limite);
    const incompleto = previo.marcaMs - SOLAPE_MS < limite;

    const eventos = await c.fuentes.eventos(desde, ahora);
    const tocaAjustes = ahora - previo.ajustesMs >= INTERVALO_AJUSTES_MS;
    const ajustes = tocaAjustes ? await c.fuentes.ajustes(c.simbolos) : null;

    /*
     * La bitácora y los traspasos del panel se leen DESPUÉS de leer Bitget, y
     * el orden es lo que evita avisar de más. El panel anota cada acción antes
     * de enviarla: todo lo suyo que Bitget ya enseñe está, por fuerza, anotado
     * cuando se lee ahora. Leída al empezar la revisión, un cierre hecho desde
     * el panel mientras se revisaba habría llegado al chat como del cliente.
     */
    /* Desde lo que se compara: el evento más viejo posible o la última foto de ajustes. */
    const desdeBitacora = Math.min(desde - ANTES_MS, previo.ajustesMs) - 60_000;
    const propias = (await this.deps.bitacora.leerDesde(desdeBitacora)).filter(
      (a) => a.cuenta === c.huella
    );
    const traspasos = eventos.some(
      (x) => x.tipo === 'traspaso-entrada' || x.tipo === 'traspaso-salida'
    )
      ? await this.deps.traspasosPanel()
      : [];

    const externos = [
      ...clasificar(eventos, { bitacora: propias, traspasos, uid: c.uid }),
      ...(ajustes === null
        ? []
        : cambiosDeAjustes(previo.ajustes, ajustes, previo.ajustesMs, ahora, propias))
    ];

    let detectados: EventoCuenta[] = [];
    await this.exclusivo((e) => {
      if (gen !== this.generacion) throw new Abortada();
      const st = e.cuentas[c.cuentaId];
      if (st === undefined) return; // se dio de baja mientras se leía

      /* Se juntan después de filtrar: un TP ya avisado por separado no se vuelve a meter. */
      const nuevos = unirTpDeApertura(externos.filter((x) => !(x.clave in st.vistos)));
      detectados = nuevos;
      const pendiente = (x: EventoCuenta): EventoPendiente => ({
        ...x,
        cuentaId: c.cuentaId,
        identificador: c.identificador,
        etiqueta: c.etiqueta,
        grupo: c.grupo
      });
      e.pendientes.push(...nuevos.map(pendiente));
      if (incompleto) {
        e.pendientes.push(
          pendiente({
            clave: `nota:${c.cuentaId}:${ahora}`,
            tipo: 'nota',
            cuandoMs: ahora,
            simbolo: null,
            lado: null,
            cantidad: null,
            precio: null,
            importe: null,
            origen: null,
            clientOid: null,
            orderId: null,
            automatico: false,
            detalle:
              'Esta subcuenta pasó más de 90 días sin revisarse: Bitget ya no entrega lo de antes ' +
              'y pueden faltar operaciones.'
          })
        );
      }
      resumen.detectadas += nuevos.length;

      /* Lo visto se recuerda solo mientras puede volver a aparecer: dentro del solape. */
      const corte = ahora - SOLAPE_MS - 60_000;
      const vistos: Record<string, number> = {};
      for (const [k, t] of Object.entries(st.vistos)) if (t >= corte) vistos[k] = t;
      for (const x of nuevos) {
        vistos[x.clave] = x.cuandoMs;
        for (const k of x.incluye ?? []) vistos[k] = x.cuandoMs;
      }

      e.cuentas[c.cuentaId] = {
        uid: st.uid,
        ...(st.inicioMs === undefined ? {} : { inicioMs: st.inicioMs }),
        marcaMs: ahora,
        vistos,
        ajustes: ajustes === null ? st.ajustes : { ...st.ajustes, ...ajustes },
        ajustesMs: ajustes === null ? st.ajustesMs : ahora
      };
    });

    /* Ya guardados en la cola: desde aquí no se pierden aunque falle el envío. */
    for (const x of detectados) {
      anotarEvento({
        evento: 'alerta-detectada',
        datos: {
          cuenta: c.identificador,
          operacion: x.tipo,
          simbolo: x.simbolo,
          lado: x.lado,
          cuando: new Date(x.cuandoMs).toISOString(),
          clave: x.clave
        }
      });
    }
  }

  /** Envía lo que haya en la cola. Cada mensaje confirmado sale de ella. */
  private async enviarPendientes(gen: number, resumen: ResumenRevision): Promise<void> {
    const destino = this.deps.destino();
    if (destino === null) {
      resumen.envio = 'sin-configurar';
      return;
    }
    const pendientes = [...(await this.cargar()).pendientes];
    if (pendientes.length === 0) {
      resumen.envio = 'sin-novedades';
      return;
    }

    const mensajes = mensajesTelegram(pendientes, {
      numeroPanel: this.deps.numeroPanel(),
      zona: this.deps.zona,
      moneda: this.deps.moneda,
      ahoraMs: this.deps.ahoraMs()
    });
    const dormir = this.deps.dormir ?? dormirReal;
    const pausa = this.deps.pausaMensajesMs ?? PAUSA_MENSAJES_MS;

    for (const [i, m] of mensajes.entries()) {
      if (gen !== this.generacion) {
        resumen.envio = 'abortado';
        return;
      }
      if (i > 0) await dormir(pausa);
      try {
        await this.enviarUno(destino, m.texto, dormir);
      } catch (e) {
        resumen.envio = 'fallo';
        resumen.mensajeEnvio =
          e instanceof Error ? e.message : 'No se pudo enviar a Telegram; se reintentará.';
        anotarEvento({
          evento: 'alerta-fallida',
          datos: {
            motivo: e instanceof ErrorTelegram ? e.motivo : 'otro',
            codigo: e instanceof ErrorTelegram ? e.codigo : null,
            mensaje: mensajeParaLog(e, destino.token),
            eventos: m.claves.length,
            enCola: pendientes.length - resumen.enviadas
          }
        });
        return;
      }
      const enviadas = new Set(m.claves);
      await this.exclusivo((e) => {
        e.pendientes = e.pendientes.filter((p) => !enviadas.has(p.clave));
      });
      resumen.enviadas += m.claves.length;
      anotarEvento({
        evento: 'alerta-enviada',
        datos: { eventos: m.claves.length, claves: m.claves.join(' ').slice(0, 500) }
      });
    }
    resumen.envio = 'ok';
  }

  /** Un mensaje, con una espera si Telegram pide calma. */
  private async enviarUno(
    d: DestinoTelegram,
    texto: string,
    dormir: (ms: number) => Promise<void>
  ): Promise<void> {
    try {
      await d.cliente.enviar(d.token, d.chatId, texto);
    } catch (e) {
      if (e instanceof ErrorTelegram && e.motivo === 'limite' && (e.reintentarEnS ?? 0) <= 60) {
        await dormir((e.reintentarEnS ?? 30) * 1000);
        await d.cliente.enviar(d.token, d.chatId, texto);
        return;
      }
      throw e;
    }
  }
}
