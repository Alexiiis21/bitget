/**
 * El vigía de operaciones externas, con Bitget y Telegram de mentira.
 *
 * Lo que se prueba es lo que el operador notaría si fallara: que la primera
 * vez no lleguen 90 días de golpe, que lo del panel no avise, que nada se
 * pierda si Telegram falla, que nada se repita y que bloquear el panel a mitad
 * no deje la marca avanzada sobre lo que no se envió.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BitacoraAcciones } from '@main/storage/bitacora-acciones';
import type { FuentesCuenta } from '@main/alertas/fuentes';
import { ErrorTelegram, type ClienteTelegram } from '@main/alertas/telegram';
import type { AjustesSimbolo, EventoCuenta } from '@main/alertas/tipos';
import { VENTANA_MAXIMA_MS, VigiaOperaciones, type CuentaVigilada } from '@main/alertas/vigia';

const T0 = Date.parse('2026-10-15T15:00:00Z');
const HORA = 3_600_000;

let carpeta: string;
beforeEach(async () => {
  carpeta = await mkdtemp(join(tmpdir(), 'pcb-vigia-'));
});
afterEach(async () => {
  await rm(carpeta, { recursive: true, force: true });
});

const ev = (
  parcial: Partial<EventoCuenta> & Pick<EventoCuenta, 'clave' | 'tipo' | 'cuandoMs'>
): EventoCuenta => ({
  simbolo: 'BTCUSDT',
  lado: 'long',
  cantidad: '0.01',
  precio: '115000',
  importe: null,
  origen: 'app',
  clientOid: '123',
  orderId: '9',
  automatico: false,
  detalle: null,
  ...parcial
});

/** Un Bitget de una subcuenta: lo que tiene se cambia desde la prueba. */
function bitget() {
  const estado = {
    eventos: [] as EventoCuenta[],
    ajustes: { BTCUSDT: { modo: 'isolated', largo: '10', corto: '10', cruzado: '10' } } as Record<
      string,
      AjustesSimbolo
    >,
    consultas: [] as { desdeMs: number; hastaMs: number }[],
    freno: null as Promise<void> | null,
    lecturasAjustes: 0
  };
  const fuentes: FuentesCuenta = {
    async eventos(desdeMs, hastaMs) {
      estado.consultas.push({ desdeMs, hastaMs });
      if (estado.freno) await estado.freno;
      return estado.eventos.filter((e) => e.cuandoMs >= desdeMs && e.cuandoMs <= hastaMs);
    },
    ajustes: () => {
      estado.lecturasAjustes++;
      return Promise.resolve(structuredClone(estado.ajustes));
    }
  };
  return { estado, fuentes };
}

function telegram() {
  const enviados: string[] = [];
  let fallos = 0;
  const cliente: ClienteTelegram = {
    comprobarBot: () => Promise.resolve({ usuario: 'pcb_bot', nombre: 'PCB' }),
    chatsRecientes: () => Promise.resolve([]),
    enviar: (_t, _c, texto) => {
      if (fallos > 0) {
        fallos--;
        return Promise.reject(new ErrorTelegram('red', 'No hay conexión con Telegram.'));
      }
      enviados.push(texto);
      return Promise.resolve();
    }
  };
  return { cliente, enviados, fallar: (n: number) => (fallos = n) };
}

function montar(opciones: { configurado?: boolean } = {}) {
  let ahora = T0;
  const b = bitget();
  const tg = telegram();
  const bitacora = new BitacoraAcciones(join(carpeta, 'propias.jsonl'));
  const cuenta: CuentaVigilada = {
    cuentaId: 'cta_1',
    uid: '111',
    identificador: 'PCB-1-A-1',
    etiqueta: 'Sub-01',
    grupo: 'A',
    huella: 'h1',
    simbolos: ['BTCUSDT'],
    fuentes: b.fuentes
  };
  const crear = () =>
    new VigiaOperaciones({
      rutaEstado: join(carpeta, 'estado.json'),
      bitacora,
      traspasosPanel: () => Promise.resolve([]),
      cuentas: () => Promise.resolve([cuenta]),
      destino: () =>
        opciones.configurado === false ? null : { cliente: tg.cliente, token: 't', chatId: '-100' },
      ahoraMs: () => ahora,
      zona: 'America/Mexico_City',
      numeroPanel: () => 1,
      moneda: 'USDT',
      dormir: () => Promise.resolve(),
      pausaMensajesMs: 0
    });
  return {
    vigia: crear(),
    crear,
    b,
    tg,
    bitacora,
    avanzar: (ms: number) => {
      ahora += ms;
    },
    ahora: () => ahora
  };
}

describe('primera revisión', () => {
  it('sin bot configurado no lee nada de Bitget', async () => {
    const m = montar({ configurado: false });
    const r = await m.vigia.revisar();
    expect(r.envio).toBe('sin-configurar');
    expect(m.b.estado.consultas).toHaveLength(0);
  });

  it('solo toma la foto de partida: no avisa lo de antes', async () => {
    const m = montar();
    m.b.estado.eventos.push(ev({ clave: 'orden:viejo', tipo: 'abrir', cuandoMs: T0 - 5 * HORA }));

    const r = await m.vigia.revisar();

    expect(r).toMatchObject({ nuevas: 1, detectadas: 0, envio: 'sin-novedades' });
    expect(m.b.estado.consultas).toHaveLength(0);
    expect(m.tg.enviados).toHaveLength(0);
  });
});

describe('revisiones siguientes', () => {
  it('avisa lo externo, y ni lo del panel ni lo automático', async () => {
    const m = montar();
    await m.vigia.revisar();
    m.avanzar(2 * HORA);
    m.b.estado.eventos.push(
      ev({ clave: 'orden:app', tipo: 'abrir', cuandoMs: T0 + HORA }),
      ev({ clave: 'orden:pcb', tipo: 'abrir', cuandoMs: T0 + HORA, clientOid: 'pcbabc0l' }),
      ev({ clave: 'orden:tp', tipo: 'cerrar', cuandoMs: T0 + HORA, automatico: true })
    );

    const r = await m.vigia.revisar();

    expect(r).toMatchObject({ detectadas: 1, enviadas: 1, pendientes: 0, envio: 'ok' });
    expect(m.tg.enviados).toHaveLength(1);
    expect(m.tg.enviados[0]).toContain('PCB-1-A-1');
    expect(m.tg.enviados[0]).toContain('Abrió LONG BTCUSDT · 0.01 @ 115000');
    expect(m.tg.enviados[0]).toContain('App');
  });

  it('pregunta desde la marca anterior menos el solape, pero nunca antes de activar', async () => {
    const m = montar();
    await m.vigia.revisar();
    m.avanzar(HORA);
    await m.vigia.revisar();
    m.avanzar(HORA);
    await m.vigia.revisar();
    /* La segunda revisión no mira antes de la foto de partida, aunque el solape alcanzaría. */
    expect(m.b.estado.consultas[0]).toEqual({ desdeMs: T0, hastaMs: T0 + HORA });
    expect(m.b.estado.consultas[1]).toEqual({
      desdeMs: T0 + HORA - 10 * 60_000,
      hastaMs: T0 + 2 * HORA
    });
  });

  it('lo de los minutos previos a activar no se avisa', async () => {
    const m = montar();
    m.b.estado.eventos.push(
      ev({ clave: 'orden:previa', tipo: 'abrir', cuandoMs: T0 - 5 * 60_000 })
    );
    await m.vigia.revisar();
    m.avanzar(HORA);
    const r = await m.vigia.revisar();
    expect(r.detectadas).toBe(0);
    expect(m.tg.enviados).toHaveLength(0);
  });

  it('lo que vuelve a aparecer por el solape no se avisa dos veces', async () => {
    const m = montar();
    await m.vigia.revisar();
    m.avanzar(HORA);
    m.b.estado.eventos.push(
      ev({ clave: 'orden:borde', tipo: 'abrir', cuandoMs: T0 + HORA - 60_000 })
    );
    await m.vigia.revisar();
    m.avanzar(5 * 60_000);
    const r = await m.vigia.revisar();

    expect(r.detectadas).toBe(0);
    expect(m.tg.enviados).toHaveLength(1);
  });

  it('un cierre del panel sin pcb no avisa: lo reconoce la bitácora', async () => {
    const m = montar();
    await m.vigia.revisar();
    m.avanzar(HORA);
    await m.bitacora.anotar({
      ts: T0 + HORA - 2 * 60_000,
      cuenta: 'h1',
      metodo: 'POST',
      ruta: '/api/v2/mix/order/close-positions',
      cuerpo: { symbol: 'BTCUSDT', holdSide: 'long' }
    });
    m.b.estado.eventos.push(
      ev({ clave: 'orden:cierre', tipo: 'cerrar', cuandoMs: T0 + HORA - 115_000 })
    );

    const r = await m.vigia.revisar();
    expect(r.detectadas).toBe(0);
  });
});

describe('apalancamiento y modo', () => {
  it('un cambio que no hizo el panel se avisa, sin hora exacta', async () => {
    const m = montar();
    await m.vigia.revisar();
    m.avanzar(HORA);
    m.b.estado.ajustes['BTCUSDT'] = { modo: 'crossed', largo: '20', corto: '20', cruzado: '20' };

    await m.vigia.revisar();

    expect(m.tg.enviados[0]).toContain('Cambió el apalancamiento de BTCUSDT: 10x → 20x');
    expect(m.tg.enviados[0]).toContain('Cambió el modo de margen de BTCUSDT: aislado → cruzado');
    expect(m.tg.enviados[0]).toContain('entre');
  });

  it('uno hecho por el panel no', async () => {
    const m = montar();
    await m.vigia.revisar();
    m.avanzar(HORA);
    await m.bitacora.anotar({
      ts: T0 + 30 * 60_000,
      cuenta: 'h1',
      metodo: 'POST',
      ruta: '/api/v2/mix/account/set-leverage',
      cuerpo: { symbol: 'BTCUSDT', leverage: '20' }
    });
    m.b.estado.ajustes['BTCUSDT'] = { modo: 'isolated', largo: '20', corto: '20', cruzado: '20' };

    const r = await m.vigia.revisar();
    expect(r.detectadas).toBe(0);
  });
});

describe('Telegram caído', () => {
  it('lo detectado se queda en la cola y sale en la siguiente apertura', async () => {
    const m = montar();
    await m.vigia.revisar();
    m.avanzar(HORA);
    m.b.estado.eventos.push(ev({ clave: 'orden:a', tipo: 'abrir', cuandoMs: T0 + HORA - 1 }));
    m.tg.fallar(1);

    const r1 = await m.vigia.revisar();
    expect(r1).toMatchObject({ envio: 'fallo', pendientes: 1, enviadas: 0 });

    /* Otra sesión: el estado viene del disco. */
    m.avanzar(HORA);
    const r2 = await m.crear().revisar();
    expect(r2).toMatchObject({ envio: 'ok', enviadas: 1, pendientes: 0, detectadas: 0 });
    expect(m.tg.enviados).toHaveLength(1);
  });
});

describe('carreras', () => {
  it('dos revisiones a la vez son la misma', async () => {
    const m = montar();
    await m.vigia.revisar();
    m.avanzar(HORA);
    const a = m.vigia.revisar();
    const b = m.vigia.revisar();
    expect(b).toBe(a);
    await a;
    expect(m.b.estado.consultas).toHaveLength(1);
  });

  it('bloquear a mitad no guarda nada ni avanza la marca', async () => {
    const m = montar();
    await m.vigia.revisar();
    m.avanzar(HORA);
    m.b.estado.eventos.push(ev({ clave: 'orden:a', tipo: 'abrir', cuandoMs: T0 + 30 * 60_000 }));

    let soltar: () => void = () => undefined;
    m.b.estado.freno = new Promise((r) => {
      soltar = r;
    });
    const enCurso = m.vigia.revisar();
    await new Promise((r) => setTimeout(r, 0));
    m.vigia.detener();
    soltar();
    const r = await enCurso;

    expect(r.envio).toBe('abortado');
    expect(m.tg.enviados).toHaveLength(0);

    /* La siguiente sesión vuelve a preguntar desde la marca de antes y sí lo avisa. */
    m.b.estado.freno = null;
    m.avanzar(HORA);
    const otra = m.crear();
    const r2 = await otra.revisar();
    expect(m.b.estado.consultas.at(-1)?.desdeMs).toBe(T0);
    expect(r2.detectadas).toBe(1);
  });
});

describe('ventana de Bitget', () => {
  it('si pasaron más de 90 días, avisa que pueden faltar operaciones', async () => {
    const m = montar();
    await m.vigia.revisar();
    m.avanzar(VENTANA_MAXIMA_MS + 5 * 86_400_000);

    await m.vigia.revisar();

    expect(m.b.estado.consultas[0]?.desdeMs).toBe(m.ahora() - VENTANA_MAXIMA_MS);
    expect(m.tg.enviados[0]).toContain('pueden faltar operaciones');
  });

  it('reiniciar vuelve a tomar la foto de partida', async () => {
    const m = montar();
    await m.vigia.revisar();
    await m.vigia.reiniciar();
    m.avanzar(HORA);
    const r = await m.vigia.revisar();
    expect(r.nuevas).toBe(1);
  });
});

describe('con el panel abierto, revisando cada pocos minutos', () => {
  it('un cierre del panel anotado mientras se revisaba no se avisa', async () => {
    const m = montar();
    await m.vigia.revisar();
    m.avanzar(HORA);

    let soltar: () => void = () => undefined;
    m.b.estado.freno = new Promise((r) => {
      soltar = r;
    });
    const enCurso = m.vigia.revisar();
    await new Promise((r) => setTimeout(r, 0));

    /* Mientras se lee Bitget, el operador cierra desde el panel. */
    await m.bitacora.anotar({
      ts: T0 + HORA - 2_000,
      cuenta: 'h1',
      metodo: 'POST',
      ruta: '/api/v2/mix/order/close-positions',
      cuerpo: { symbol: 'BTCUSDT', holdSide: 'long' }
    });
    m.b.estado.eventos.push(
      ev({ clave: 'orden:cierre-en-vuelo', tipo: 'cerrar', cuandoMs: T0 + HORA - 1_000 })
    );
    soltar();

    const r = await enCurso;
    expect(r.detectadas).toBe(0);
    expect(m.tg.enviados).toHaveLength(0);
  });

  it('apalancamiento y modo se leen como mucho una vez por hora', async () => {
    const m = montar();
    await m.vigia.revisar();
    expect(m.b.estado.lecturasAjustes).toBe(1);

    m.avanzar(15 * 60_000);
    await m.vigia.revisar();
    m.avanzar(15 * 60_000);
    await m.vigia.revisar();
    expect(m.b.estado.lecturasAjustes).toBe(1);

    m.avanzar(30 * 60_000);
    await m.vigia.revisar();
    expect(m.b.estado.lecturasAjustes).toBe(2);
  });

  it('un cambio de apalancamiento hecho entre lecturas se avisa en la siguiente lectura horaria', async () => {
    const m = montar();
    await m.vigia.revisar();
    m.avanzar(15 * 60_000);
    m.b.estado.ajustes['BTCUSDT'] = { modo: 'isolated', largo: '25', corto: '25', cruzado: '25' };
    const r1 = await m.vigia.revisar();
    expect(r1.detectadas).toBe(0);

    m.avanzar(HORA);
    const r2 = await m.vigia.revisar();
    expect(r2.detectadas).toBe(1);
    expect(m.tg.enviados[0]).toContain('10x → 25x');
  });
});
