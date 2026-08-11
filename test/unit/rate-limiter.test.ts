/**
 * Limitador de peticiones.
 *
 * El reloj y la espera se inyectan: `dormir` adelanta el reloj falso en lugar
 * de esperar de verdad, asi que estas pruebas ejercitan tiempos de minutos en
 * milisegundos y no dependen de la velocidad de la maquina.
 */
import { describe, expect, it } from 'vitest';
import { BucketTokens, LimitadorPeticiones } from '@main/execution/rate-limiter';

/** Reloj falso con una espera que simplemente adelanta el tiempo. */
function relojFalso(inicio = 1_000_000) {
  let t = inicio;
  return {
    ahora: () => t,
    dormir: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
    avanzar: (ms: number) => {
      t += ms;
    }
  };
}

describe('BucketTokens', () => {
  it('arranca lleno y se vacia al consumir', () => {
    const reloj = relojFalso();
    const b = new BucketTokens(3, 1, reloj.ahora);

    expect(b.disponibles).toBe(3);
    b.consumir();
    b.consumir();
    b.consumir();
    expect(b.hayToken()).toBe(false);
  });

  it('se rellena por tiempo transcurrido, sin temporizadores', () => {
    const reloj = relojFalso();
    const b = new BucketTokens(10, 4, reloj.ahora);

    for (let i = 0; i < 10; i++) b.consumir();
    expect(b.hayToken()).toBe(false);

    reloj.avanzar(250); /* 4 por segundo -> 1 token en 250 ms */
    expect(b.hayToken()).toBe(true);
    expect(b.disponibles).toBe(1);
  });

  it('no acumula mas alla de su capacidad', () => {
    const reloj = relojFalso();
    const b = new BucketTokens(5, 10, reloj.ahora);

    reloj.avanzar(60_000);
    expect(b.disponibles).toBe(5);
  });

  it('calcula cuanto falta para el proximo token', () => {
    const reloj = relojFalso();
    const b = new BucketTokens(1, 2, reloj.ahora); /* 1 token cada 500 ms */

    b.consumir();
    expect(b.esperaMs()).toBe(500);
    reloj.avanzar(200);
    expect(b.esperaMs()).toBe(300);
  });

  /*
   * Tras un 429 no basta con esperar: hay que vaciar. Seguir gastando los
   * tokens acumulados justo despues de que el exchange diga «vas rapido» es
   * insistir en el error que provoca el bloqueo de 5 minutos.
   */
  it('al penalizar vacia el bucket, no solo espera', () => {
    const reloj = relojFalso();
    const b = new BucketTokens(10, 10, reloj.ahora);

    b.penalizar(1_000);
    expect(b.penalizado).toBe(true);
    expect(b.hayToken()).toBe(false);

    reloj.avanzar(1_000);
    expect(b.penalizado).toBe(false);
    /* Pasada la penalizacion se rellena desde cero, no desde los 10 de antes. */
    expect(b.disponibles).toBeLessThan(10);
  });
});

describe('LimitadorPeticiones', () => {
  it('deja pasar la rafaga inicial sin esperar', async () => {
    const reloj = relojFalso();
    const l = new LimitadorPeticiones({
      rafagaGlobal: 5,
      rafagaCuenta: 5,
      limiteGlobalPorSegundo: 1,
      limiteCuentaPorSegundo: 1,
      ahora: reloj.ahora,
      dormir: reloj.dormir
    });

    const t0 = reloj.ahora();
    for (let i = 0; i < 5; i++) {
      await l.adquirir('uid-1');
      l.liberar();
    }
    expect(reloj.ahora()).toBe(t0);
  });

  it('frena cuando se agota el bucket de la cuenta', async () => {
    const reloj = relojFalso();
    const l = new LimitadorPeticiones({
      rafagaGlobal: 100,
      rafagaCuenta: 2,
      limiteGlobalPorSegundo: 100,
      limiteCuentaPorSegundo: 2 /* 1 token cada 500 ms */,
      ahora: reloj.ahora,
      dormir: reloj.dormir
    });

    const t0 = reloj.ahora();
    for (let i = 0; i < 4; i++) {
      await l.adquirir('uid-1');
      l.liberar();
    }
    /* 2 de rafaga gratis + 2 a 500 ms cada uno. */
    expect(reloj.ahora() - t0).toBeGreaterThanOrEqual(1_000);
  });

  it('el techo global frena aunque cada cuenta tenga cupo de sobra', async () => {
    const reloj = relojFalso();
    const l = new LimitadorPeticiones({
      rafagaGlobal: 2,
      rafagaCuenta: 50,
      limiteGlobalPorSegundo: 2 /* 1 token cada 500 ms */,
      limiteCuentaPorSegundo: 50,
      ahora: reloj.ahora,
      dormir: reloj.dormir
    });

    const t0 = reloj.ahora();
    /* Cuentas distintas: el bucket por cuenta nunca es la restriccion. */
    for (let i = 0; i < 4; i++) {
      await l.adquirir(`uid-${i}`);
      l.liberar();
    }
    expect(reloj.ahora() - t0).toBeGreaterThanOrEqual(1_000);
  });

  /*
   * La razon de consultar los dos buckets antes de gastar ninguno. Si se
   * consumiera el global y despues se viera que la cuenta no tiene token, ese
   * token global quedaria tirado y el techo real seria mas bajo del pactado.
   */
  it('no desperdicia cupo global cuando la cuenta esta sin tokens', async () => {
    const reloj = relojFalso();
    const l = new LimitadorPeticiones({
      rafagaGlobal: 10,
      rafagaCuenta: 1,
      limiteGlobalPorSegundo: 10,
      limiteCuentaPorSegundo: 1,
      ahora: reloj.ahora,
      dormir: reloj.dormir
    });

    await l.adquirir('uid-1');
    l.liberar();

    const antes = l.diagnostico().tokensGlobales;

    /* uid-1 esta seco; uid-2 debe poder salir gastando un solo token global. */
    await l.adquirir('uid-2');
    l.liberar();

    expect(l.diagnostico().tokensGlobales).toBe(antes - 1);
  });

  /*
   * El caso que justifica no usar FIFO ciega: una cuenta sin cupo propio no
   * puede dejar clavadas a las demas. En un lote de 100 cuentas eso seria el
   * panel entero parado por culpa de una.
   *
   * Se satura primero la concurrencia para que las dos entren en la cola antes
   * de que el limitador evalue; si no, evaluaria con la cola a medio llenar y
   * la prueba no ejerceria el salto.
   */
  it('una cuenta sin cupo no bloquea a las que si lo tienen', async () => {
    const reloj = relojFalso();
    const l = new LimitadorPeticiones({
      rafagaGlobal: 100,
      limiteGlobalPorSegundo: 100,
      rafagaCuenta: 1,
      limiteCuentaPorSegundo: 0.5 /* un token cada 2 s: espera larga y visible */,
      concurrenciaMaxima: 1,
      ahora: reloj.ahora,
      dormir: reloj.dormir
    });

    /* Agota el unico token de la cuenta lenta y deja ocupado el hueco. */
    await l.adquirir('uid-lenta');

    const orden: string[] = [];
    const lenta = l.adquirir('uid-lenta').then(() => {
      orden.push('lenta');
      l.liberar();
    });
    const rapida = l.adquirir('uid-rapida').then(() => {
      orden.push('rapida');
      l.liberar();
    });

    /* Al liberar el hueco, ambas estan encoladas: debe salir la que puede. */
    l.liberar();

    await rapida;
    expect(orden).toEqual(['rapida']);

    await lenta;
    expect(orden).toEqual(['rapida', 'lenta']);
  });

  it('respeta el limite de peticiones en vuelo', async () => {
    const reloj = relojFalso();
    const l = new LimitadorPeticiones({
      rafagaGlobal: 100,
      rafagaCuenta: 100,
      limiteGlobalPorSegundo: 100,
      limiteCuentaPorSegundo: 100,
      concurrenciaMaxima: 2,
      ahora: reloj.ahora,
      dormir: reloj.dormir
    });

    await l.adquirir('a');
    await l.adquirir('b');
    expect(l.diagnostico().enVuelo).toBe(2);

    let tercera = false;
    const p = l.adquirir('c').then(() => {
      tercera = true;
    });

    await Promise.resolve();
    expect(tercera).toBe(false); /* no cabe una tercera */

    l.liberar();
    await p;
    expect(tercera).toBe(true);
  });
});

describe('reaccion ante un 429', () => {
  it('penaliza el bucket global y el de la cuenta', () => {
    const reloj = relojFalso();
    const l = new LimitadorPeticiones({ ahora: reloj.ahora, dormir: reloj.dormir });

    l.registrar429('uid-1', 3_000);

    const d = l.diagnostico();
    expect(d.globalPenalizado).toBe(true);
    expect(d.cuentasPenalizadas).toContain('uid-1');
  });

  it('ejecutar penaliza solo cuando el error es un 429, y propaga el fallo', async () => {
    const reloj = relojFalso();
    const l = new LimitadorPeticiones({ ahora: reloj.ahora, dormir: reloj.dormir });

    const err429 = Object.assign(new Error('limitado'), { codigo: '429', reintentarEnMs: 2_000 });
    await expect(l.ejecutar('uid-1', () => Promise.reject(err429))).rejects.toThrow('limitado');
    expect(l.diagnostico().globalPenalizado).toBe(true);

    const l2 = new LimitadorPeticiones({ ahora: reloj.ahora, dormir: reloj.dormir });
    const otro = Object.assign(new Error('saldo'), { codigo: '43012' });
    await expect(l2.ejecutar('uid-1', () => Promise.reject(otro))).rejects.toThrow('saldo');
    expect(l2.diagnostico().globalPenalizado).toBe(false);
  });

  it('libera el hueco de concurrencia aunque la peticion falle', async () => {
    const reloj = relojFalso();
    const l = new LimitadorPeticiones({
      concurrenciaMaxima: 1,
      ahora: reloj.ahora,
      dormir: reloj.dormir
    });

    await expect(l.ejecutar('uid-1', () => Promise.reject(new Error('x')))).rejects.toThrow();
    expect(l.diagnostico().enVuelo).toBe(0);

    /* Si no se hubiera liberado, esta segunda quedaria colgada para siempre. */
    await expect(l.ejecutar('uid-1', () => Promise.resolve('ok'))).resolves.toBe('ok');
  });
});
