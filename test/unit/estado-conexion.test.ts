/**
 * Estado de conexion por cuenta.
 *
 * Lo que se prueba aqui no es que el estado cambie, sino **cuando no cambia**:
 * la mayor parte del valor de este modulo esta en no pintar 100 cuentas en
 * rojo por un microcorte.
 */
import { describe, expect, it } from 'vitest';
import { ErrorBitget } from '@main/bitget/errors';
import { esperaReconexion, RegistroConexiones } from '@main/domain/estado-conexion';
import { FALLOS_PARA_DESCONECTAR, RECONEXION_TOPE_MS } from '@shared/constants';

function relojFalso(inicio = 1_000_000) {
  let t = inicio;
  return {
    ahora: () => t,
    avanzar: (ms: number) => {
      t += ms;
    }
  };
}

const errorTransitorio = (): ErrorBitget =>
  new ErrorBitget('El exchange esta limitando las peticiones.', {
    clase: 'retryable',
    codigo: '429',
    mensajeOriginal: 'rate limit',
    httpStatus: 429,
    reintentarEnMs: null
  });

const errorCredencial = (): ErrorBitget =>
  new ErrorBitget('La API Key no existe, o la passphrase no coincide con ella.', {
    clase: 'fatal-cuenta',
    codigo: '40012',
    mensajeOriginal: 'apikey does not exist',
    httpStatus: 200,
    reintentarEnMs: null
  });

describe('ciclo normal', () => {
  it('arranca desconectada, porque todavia no ha conectado', () => {
    const r = new RegistroConexiones();
    r.registrar('acc-1');

    expect(r.estado('acc-1')?.estado).toBe('desconectada');
    expect(r.estado('acc-1')?.ultimoExito).toBeNull();
  });

  it('pasa a conectada y guarda la latencia', () => {
    const reloj = relojFalso();
    const r = new RegistroConexiones({ ahora: reloj.ahora });
    r.registrar('acc-1');

    r.marcarConectando('acc-1');
    expect(r.estado('acc-1')?.estado).toBe('conectando');

    r.registrarExito('acc-1', 187);
    const e = r.estado('acc-1');
    expect(e?.estado).toBe('conectada');
    expect(e?.latenciaMs).toBe(187);
    expect(e?.motivo).toBeNull();
    expect(e?.proximoIntento).toBeNull();
  });

  it('un exito borra el historial de fallos', () => {
    const r = new RegistroConexiones();
    r.registrar('acc-1');

    r.registrarFallo('acc-1', errorTransitorio());
    r.registrarFallo('acc-1', errorTransitorio());
    expect(r.estado('acc-1')?.fallosConsecutivos).toBe(2);

    r.registrarExito('acc-1', 100);
    expect(r.estado('acc-1')?.fallosConsecutivos).toBe(0);
  });
});

describe('un fallo no es una desconexion', () => {
  /*
   * El comportamiento central del modulo. Un 429 o un corte de un segundo deja
   * la cuenta en `conectando`, no en rojo: si cada microcorte pintara las 100
   * cuentas en rojo, el operador dejaria de mirar el color.
   */
  it('un fallo transitorio deja la cuenta en conectando, no en desconectada', () => {
    const r = new RegistroConexiones();
    r.registrar('acc-1');
    r.registrarExito('acc-1', 100);

    const estado = r.registrarFallo('acc-1', errorTransitorio());

    expect(estado).toBe('conectando');
    expect(r.estado('acc-1')?.proximoIntento).not.toBeNull();
  });

  it('tras tres fallos seguidos ya no es un microcorte: desconectada', () => {
    const r = new RegistroConexiones();
    r.registrar('acc-1');

    for (let i = 1; i < FALLOS_PARA_DESCONECTAR; i++) {
      expect(r.registrarFallo('acc-1', errorTransitorio())).toBe('conectando');
    }
    expect(r.registrarFallo('acc-1', errorTransitorio())).toBe('desconectada');
  });

  /*
   * La excepcion: una credencial invalida no mejora reintentando. Marcarla en
   * rojo de inmediato es correcto, y ademas evita gastar cupo de peticiones en
   * algo que va a fallar siempre.
   */
  it('un fallo de credencial desconecta a la primera y no programa reintento', () => {
    const r = new RegistroConexiones();
    r.registrar('acc-1');
    r.registrarExito('acc-1', 100);

    const estado = r.registrarFallo('acc-1', errorCredencial());

    expect(estado).toBe('desconectada');
    expect(r.estado('acc-1')?.proximoIntento).toBeNull();
    expect(r.estado('acc-1')?.codigoBitget).toBe('40012');
  });

  it('un error que no es de Bitget se trata como transitorio', () => {
    const r = new RegistroConexiones();
    r.registrar('acc-1');

    expect(r.registrarFallo('acc-1', new Error('cable desconectado'))).toBe('conectando');
  });
});

describe('resultado de una verificacion de credencial', () => {
  /*
   * La costura que fallo al integrar: `verificarCredencial` devuelve veredicto
   * en vez de lanzar, y convertirlo a mano en un Error corriente hacia pasar
   * por transitorio un rechazo definitivo. El panel reintentaria eternamente
   * una API Key muerta.
   */
  it('un rechazo definitivo desconecta sin programar reintento', () => {
    const r = new RegistroConexiones();
    r.registrar('acc-1');

    const estado = r.registrarVerificacion('acc-1', {
      veredicto: 'invalida',
      motivo: 'La API Key no existe, o la passphrase no coincide con ella.',
      codigoBitget: '40012',
      latenciaMs: 120
    });

    expect(estado).toBe('desconectada');
    expect(r.estado('acc-1')?.proximoIntento).toBeNull();
    expect(r.estado('acc-1')?.codigoBitget).toBe('40012');
  });

  it('una credencial rechazada por permisos tampoco se reintenta', () => {
    const r = new RegistroConexiones();
    r.registrar('acc-1');

    r.registrarVerificacion('acc-1', {
      veredicto: 'rechazada',
      motivo: 'Permisos que el panel no reconoce.',
      codigoBitget: null,
      latenciaMs: 90
    });

    expect(r.estado('acc-1')?.estado).toBe('desconectada');
    expect(r.estado('acc-1')?.proximoIntento).toBeNull();
  });

  it('una verificacion correcta deja la cuenta conectada', () => {
    const r = new RegistroConexiones();
    r.registrar('acc-1');

    r.registrarVerificacion('acc-1', {
      veredicto: 'valida',
      motivo: null,
      codigoBitget: null,
      latenciaMs: 187
    });

    expect(r.estado('acc-1')?.estado).toBe('conectada');
    expect(r.estado('acc-1')?.latenciaMs).toBe(187);
  });
});

describe('reintentos', () => {
  it('solo devuelve las cuentas cuyo momento ya llego', () => {
    const reloj = relojFalso();
    const r = new RegistroConexiones({ ahora: reloj.ahora, azar: () => 0.5 });

    r.registrar('acc-1');
    r.registrarFallo('acc-1', errorTransitorio());

    expect(r.pendientesDeReintento()).toEqual([]);
    reloj.avanzar(60_000);
    expect(r.pendientesDeReintento()).toEqual(['acc-1']);
  });

  it('una cuenta con credencial invalida nunca entra en la cola de reintento', () => {
    const reloj = relojFalso();
    const r = new RegistroConexiones({ ahora: reloj.ahora });

    r.registrar('acc-1');
    r.registrarFallo('acc-1', errorCredencial());

    reloj.avanzar(3_600_000);
    expect(r.pendientesDeReintento()).toEqual([]);
  });
});

describe('backoff', () => {
  it('crece exponencialmente y se detiene en el tope', () => {
    const sinJitter = () => 0.5; /* factor 0 -> sin desviacion */

    expect(esperaReconexion(1, sinJitter)).toBe(1_000);
    expect(esperaReconexion(2, sinJitter)).toBe(2_000);
    expect(esperaReconexion(3, sinJitter)).toBe(4_000);
    expect(esperaReconexion(10, sinJitter)).toBe(RECONEXION_TOPE_MS);
  });

  /*
   * Sin jitter, 100 cuentas caidas a la vez reintentan a la vez. Bitget limita
   * las conexiones por IP a 300 cada 5 minutos: tres oleadas sincronizadas
   * bloquean la IP y un corte de 10 segundos se vuelve 5 minutos de panel
   * ciego. docs/01 seccion 8, Hallazgo 2.
   */
  it('reparte los reintentos para que 100 cuentas no vuelvan a la vez', () => {
    const esperas = new Set<number>();
    for (let i = 0; i < 100; i++) {
      esperas.add(esperaReconexion(3, Math.random));
    }
    /* Con jitter de +-30 % sobre 4 s, no puede haber un solo valor repetido. */
    expect(esperas.size).toBeGreaterThan(50);

    for (const e of esperas) {
      expect(e).toBeGreaterThanOrEqual(2_800);
      expect(e).toBeLessThanOrEqual(5_200);
    }
  });
});

describe('modo REST', () => {
  it('marca la degradacion sin perder el hecho de estar conectada', () => {
    const r = new RegistroConexiones();
    r.registrar('acc-1');
    r.registrarExito('acc-1', 100);

    r.marcarModoRest('acc-1', true);
    expect(r.estado('acc-1')?.estado).toBe('modo-rest');

    r.marcarModoRest('acc-1', false);
    expect(r.estado('acc-1')?.estado).toBe('conectada');
  });

  it('no reetiqueta como modo REST una cuenta que esta caida', () => {
    const r = new RegistroConexiones();
    r.registrar('acc-1');
    r.registrarFallo('acc-1', errorCredencial());

    r.marcarModoRest('acc-1', true);
    expect(r.estado('acc-1')?.estado).toBe('desconectada');
  });
});

describe('avisos a la interfaz', () => {
  it('emite solo cuando el estado cambia de verdad', () => {
    const r = new RegistroConexiones();
    r.registrar('acc-1');

    const cambios: string[] = [];
    r.alCambiar((c) => cambios.push(`${c.anterior}->${c.actual}`));

    r.registrarExito('acc-1', 100);
    r.registrarExito('acc-1', 110); /* sigue conectada: no debe emitir */
    r.registrarFallo('acc-1', errorCredencial());

    expect(cambios).toEqual(['desconectada->conectada', 'conectada->desconectada']);
  });

  it('deja de avisar tras cancelar la suscripcion', () => {
    const r = new RegistroConexiones();
    r.registrar('acc-1');

    const cambios: string[] = [];
    const cancelar = r.alCambiar((c) => cambios.push(c.actual));

    r.registrarExito('acc-1', 100);
    cancelar();
    r.registrarFallo('acc-1', errorCredencial());

    expect(cambios).toEqual(['conectada']);
  });
});

describe('resumen para la barra superior', () => {
  it('cuenta las cuentas por estado', () => {
    const r = new RegistroConexiones();
    for (const id of ['a', 'b', 'c', 'd']) r.registrar(id);

    r.registrarExito('a', 100);
    r.registrarExito('b', 100);
    r.marcarModoRest('b', true);
    r.registrarFallo('c', errorTransitorio());
    r.registrarFallo('d', errorCredencial());

    expect(r.resumen()).toEqual({
      conectada: 1,
      'modo-rest': 1,
      conectando: 1,
      desconectada: 1
    });
  });
});

describe('aislamiento entre cuentas', () => {
  /* RNF-004: la caida de una cuenta no puede afectar al resto. */
  it('el fallo de una cuenta no toca el estado de las demas', () => {
    const r = new RegistroConexiones();
    r.registrar('acc-1');
    r.registrar('acc-2');
    r.registrarExito('acc-1', 100);
    r.registrarExito('acc-2', 100);

    r.registrarFallo('acc-2', errorCredencial());

    expect(r.estado('acc-1')?.estado).toBe('conectada');
    expect(r.estado('acc-1')?.fallosConsecutivos).toBe(0);
  });

  it('la instantanea es una copia: nadie puede mutar el registro desde fuera', () => {
    const r = new RegistroConexiones();
    r.registrar('acc-1');
    r.registrarExito('acc-1', 100);

    const foto = r.instantanea();
    const primera = foto[0];
    if (primera !== undefined) primera.estado = 'desconectada';

    expect(r.estado('acc-1')?.estado).toBe('conectada');
  });
});
