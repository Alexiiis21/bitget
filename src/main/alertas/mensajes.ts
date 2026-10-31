/**
 * El texto de los avisos de Telegram. Puro: recibe eventos, devuelve mensajes.
 *
 * ==========================================================================
 * Un mensaje por cuenta madre, no por operación
 * ==========================================================================
 * Telegram deja escribir unos 20 mensajes por minuto en un grupo. Con 300
 * subcuentas, un mensaje por operación tardaría más de lo que el operador está
 * dispuesto a esperar, y enterraría el chat. Se agrupa por cuenta madre (A–O),
 * y dentro por subcuenta, cada una encabezada con su identificador
 * `PCB-1-A-1`: el mismo de la pantalla de historial y del CSV.
 *
 * Un mensaje no pasa de `LIMITE_TEXTO` caracteres (Telegram corta en 4 096).
 * Si una cuenta madre no cabe, sigue en otro mensaje marcado «(continuación)».
 * Cada mensaje lleva las claves de los eventos que contiene: al confirmarse el
 * envío, esos —y solo esos— salen de la cola.
 */
import type { EventoPendiente } from './tipos';

export const LIMITE_TEXTO = 3_800;

export interface MensajeTelegram {
  texto: string;
  claves: string[];
}

export interface OpcionesMensajes {
  numeroPanel: number;
  zona: string;
  moneda: string;
  ahoraMs: number;
}

/** Telegram interpreta `<`, `>` y `&` en modo HTML: todo lo que viene de fuera se escapa. */
export const escapar = (t: string): string =>
  t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function fecha(ms: number, zona: string): string {
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: zona,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(new Date(ms));
}

const LADO: Record<string, string> = { long: 'LONG', short: 'SHORT' };

const ORIGEN: Record<string, string> = {
  web: 'Web',
  wap: 'Web móvil',
  app: 'App',
  ios: 'App iOS',
  android: 'App Android',
  api: 'API (otro programa)',
  /** Lo crea Bitget a partir de otra cosa: el TP que va con una orden. */
  sys: 'Bitget'
};

/** Qué se hizo, en una línea, sin la hora. */
export function describir(e: EventoPendiente, moneda: string): string {
  const s = e.simbolo ?? '';
  const l = e.lado === null ? '' : ` ${LADO[e.lado] ?? e.lado}`;
  const cantidadPrecio =
    e.cantidad !== null && e.precio !== null
      ? ` · ${e.cantidad} @ ${e.precio}`
      : e.cantidad !== null
        ? ` · ${e.cantidad}`
        : '';
  const importe = e.importe === null ? '' : ` · ${e.importe} ${moneda}`;

  switch (e.tipo) {
    case 'abrir':
      return `Abrió${l} ${s}${cantidadPrecio}${e.detalle === null ? '' : ` · con ${e.detalle}`}`;
    case 'cerrar':
      return `Cerró${l} ${s}${cantidadPrecio}`;
    case 'orden':
      return `Orden ejecutada ${s}${cantidadPrecio}`;
    case 'tp-sl-puesto': {
      /* Uno parcial cubre solo parte de la posición: sin la cantidad no se entiende. */
      const parte =
        e.detalle?.endsWith('parcial') === true && e.cantidad !== null ? ` · ${e.cantidad}` : '';
      return `Puso ${e.detalle ?? 'TP/SL'} ${s}${l}${parte}${e.precio === null ? '' : ` a ${e.precio}`}`;
    }
    case 'tp-sl-quitado':
      return `Quitó ${e.detalle ?? 'TP/SL'} ${s}${l}`;
    case 'margen-agregado':
      return `Agregó margen ${s}${l}${importe}`.replace('  ', ' ');
    case 'margen-quitado':
      return `Quitó margen ${s}${l}${importe}`.replace('  ', ' ');
    case 'traspaso-entrada':
      return `Recibió un traspaso${importe}`;
    case 'traspaso-salida':
      return `Envió un traspaso${importe}`;
    case 'apalancamiento':
      return `Cambió el apalancamiento de ${s}: ${e.detalle ?? ''}`;
    case 'modo-margen':
      return `Cambió el modo de margen de ${s}: ${e.detalle ?? ''}`;
    case 'nota':
      return e.detalle ?? '';
  }
}

/** La línea completa: cuándo, qué y desde dónde. */
function linea(e: EventoPendiente, o: OpcionesMensajes): string {
  if (e.tipo === 'nota') return `⚠️ ${escapar(describir(e, o.moneda))}`;
  const cuando =
    e.desdeMs === undefined
      ? fecha(e.cuandoMs, o.zona)
      : `entre ${fecha(e.desdeMs, o.zona)} y ${fecha(e.cuandoMs, o.zona)}`;
  const origen = e.origen === null ? '' : ` · ${ORIGEN[e.origen.toLowerCase()] ?? e.origen}`;
  return `• ${escapar(cuando)} · ${escapar(describir(e, o.moneda))}${escapar(origen)}`;
}

/** Los avisos listos para enviar, agrupados por cuenta madre y partidos por tamaño. */
export function mensajesTelegram(
  eventos: readonly EventoPendiente[],
  o: OpcionesMensajes
): MensajeTelegram[] {
  const porGrupo = new Map<string, EventoPendiente[]>();
  for (const e of [...eventos].sort((a, b) => a.cuandoMs - b.cuandoMs)) {
    const lista = porGrupo.get(e.grupo) ?? [];
    lista.push(e);
    porGrupo.set(e.grupo, lista);
  }

  const salida: MensajeTelegram[] = [];
  for (const grupo of [...porGrupo.keys()].sort()) {
    const delGrupo = porGrupo.get(grupo) ?? [];
    const cabecera = (continuacion: boolean): string =>
      `<b>🔔 Operaciones fuera del panel · PCB-${o.numeroPanel} · Cuenta ${escapar(grupo)}</b>` +
      `${continuacion ? ' (continuación)' : ''}\n` +
      `Revisión del ${escapar(fecha(o.ahoraMs, o.zona))}`;

    /* Por subcuenta, en el orden de su identificador. */
    const porSub = new Map<string, EventoPendiente[]>();
    for (const e of delGrupo) {
      const lista = porSub.get(e.identificador) ?? [];
      lista.push(e);
      porSub.set(e.identificador, lista);
    }
    const subs = [...porSub.keys()].sort((a, b) => a.localeCompare(b, 'es', { numeric: true }));

    let texto = cabecera(false);
    let claves: string[] = [];
    const cerrar = (): void => {
      if (claves.length > 0) salida.push({ texto, claves });
      texto = cabecera(true);
      claves = [];
    };

    for (const id of subs) {
      const lista = porSub.get(id) ?? [];
      const primera = lista[0];
      const titulo = `\n\n<b>${escapar(id)}</b>${primera ? ` · ${escapar(primera.etiqueta)}` : ''}`;
      if (texto.length + titulo.length > LIMITE_TEXTO) cerrar();
      texto += titulo;

      for (const e of lista) {
        const l = `\n${linea(e, o)}`;
        if (texto.length + l.length > LIMITE_TEXTO) {
          cerrar();
          texto += titulo;
        }
        texto += l;
        claves.push(e.clave);
      }
    }
    cerrar();
  }
  return salida;
}

export function mensajePrueba(numeroPanel: number): string {
  return (
    `<b>✅ Panel PCB-${numeroPanel} conectado</b>\n` +
    'Aquí llegarán las operaciones que se hagan <b>fuera del panel</b> ' +
    '(desde la app, la web de Bitget u otro programa): al desbloquear el panel y, ' +
    'mientras esté abierto, cada 15 minutos.'
  );
}
