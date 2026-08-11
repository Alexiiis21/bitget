/**
 * Supervisor de reconexion.
 *
 * Cubre la pieza que faltaba en RNF-004: que el backoff calculado por
 * `RegistroConexiones` se convierta en reintentos reales sin que el operador
 * toque nada.
 *
 * Ninguna prueba usa temporizadores reales ni red. El latido se dispara
 * llamando a `ciclo()`, que es lo que el temporizador haria; asi se comprueba
 * el comportamiento sin esperar segundos de reloj.
 */
import { describe, expect, it, vi } from 'vitest';
import { RegistroConexiones } from '@main/domain/estado-conexion';
import { SupervisorReconexion, type FuenteReintentos } from '@main/execution/supervisor-reconexion';
import { ErrorBitget } from '@main/bitget/errors';

/** Fuente de mentira con el control en la mano de la prueba. */
function fuenteFalsa(opciones: Partial<FuenteReintentos> = {}): {
  fuente: FuenteReintentos;
  verificadas: string[];
  pendientes: Set<string>;
} {
  const verificadas: string[] = [];
  const pendientes = new Set<string>();

  const fuente: FuenteReintentos = {
    pendientesDeReintento: () => [...pendientes],
    verificar: async (id) => {
      verificadas.push(id);
      return { ok: true };
    },
    operativa: () => true,
    ...opciones
  };

  return { fuente, verificadas, pendientes };
}

describe('SupervisorReconexion', () => {
  it('reintenta las cuentas cuyo plazo ya vencio', async () => {
    const { fuente, verificadas, pendientes } = fuenteFalsa();
    pendientes.add('acc-1');
    pendientes.add('acc-2');

    const supervisor = new SupervisorReconexion(fuente);
    await supervisor.ciclo();

    expect(verificadas).toEqual(['acc-1', 'acc-2']);
  });

  it('no toca nada con el panel bloqueado', async () => {
    const { fuente, verificadas, pendientes } = fuenteFalsa({ operativa: () => false });
    pendientes.add('acc-1');

    const supervisor = new SupervisorReconexion(fuente);
    await supervisor.ciclo();

    /*
     * Sin vault abierto no hay credencial que probar. Llamar a verificar aqui
     * lanzaria «El panel esta bloqueado», y el supervisor pintaria de rojo una
     * cuenta que solo esta esperando a que el operador desbloquee.
     */
    expect(verificadas).toEqual([]);
  });

  it('no lanza un segundo reintento sobre una cuenta que ya lo tiene en vuelo', async () => {
    /* El reintento queda colgado hasta que la prueba lo suelta. */
    const enEspera = { soltar: () => undefined as void };
    const verificadas: string[] = [];
    const pendientes = new Set<string>(['acc-1']);

    const fuente: FuenteReintentos = {
      pendientesDeReintento: () => [...pendientes],
      /* La cuenta sigue figurando como vencida mientras se la verifica. */
      verificar: async (id) => {
        verificadas.push(id);
        await new Promise<void>((resolver) => {
          enEspera.soltar = resolver;
        });
      },
      operativa: () => true
    };

    const supervisor = new SupervisorReconexion(fuente);

    const primero = supervisor.ciclo();
    await Promise.resolve();
    expect(supervisor.enCurso).toEqual(['acc-1']);

    /* Segundo ciclo mientras el primero sigue abierto: no debe duplicar. */
    await supervisor.ciclo();
    expect(verificadas).toEqual(['acc-1']);

    enEspera.soltar();
    await primero;
    expect(supervisor.enCurso).toEqual([]);
  });

  it('respeta el tope de concurrencia', async () => {
    const { fuente, verificadas, pendientes } = fuenteFalsa();
    for (let i = 1; i <= 10; i += 1) pendientes.add(`acc-${i}`);

    const supervisor = new SupervisorReconexion(fuente, { concurrenciaMaxima: 3 });
    await supervisor.ciclo();

    /*
     * Al desbloquear, las 100 cuentas vencen a la vez. Abrir 100 promesas no
     * acelera nada -el limitador las serializa igual- y desordena el turno.
     */
    expect(verificadas).toEqual(['acc-1', 'acc-2', 'acc-3']);
  });

  it('un reintento que revienta no impide los de las demas cuentas', async () => {
    const verificadas: string[] = [];
    const fallos: string[] = [];
    const pendientes = new Set<string>(['acc-1', 'acc-2', 'acc-3']);

    const fuente: FuenteReintentos = {
      pendientesDeReintento: () => [...pendientes],
      verificar: async (id) => {
        verificadas.push(id);
        if (id === 'acc-2') throw new Error('el panel se bloqueo a mitad');
      },
      operativa: () => true
    };

    const supervisor = new SupervisorReconexion(fuente, {
      alFallar: (id) => fallos.push(id)
    });

    await expect(supervisor.ciclo()).resolves.toBeUndefined();

    expect(verificadas).toEqual(['acc-1', 'acc-2', 'acc-3']);
    expect(fallos).toEqual(['acc-2']);
    /* Y la cuenta rota no se queda marcada como en vuelo para siempre. */
    expect(supervisor.enCurso).toEqual([]);
  });

  it('iniciar y detener gobiernan el latido sin duplicar temporizadores', () => {
    const { fuente } = fuenteFalsa();
    const programar = vi.fn(() => 'id-temporizador');
    const cancelar = vi.fn();

    const supervisor = new SupervisorReconexion(fuente, { programar, cancelar });

    supervisor.iniciar();
    supervisor.iniciar();
    expect(programar).toHaveBeenCalledTimes(1);
    expect(supervisor.estaEncendido).toBe(true);

    supervisor.detener();
    expect(cancelar).toHaveBeenCalledWith('id-temporizador');
    expect(supervisor.estaEncendido).toBe(false);
  });
});

/**
 * El supervisor contra el registro de verdad.
 *
 * Las pruebas de arriba usan una fuente de mentira para aislar al supervisor.
 * Esta usa el `RegistroConexiones` real con el reloj inyectado: es la que
 * demuestra que las dos piezas encajan -que lo que el registro llama «vencido»
 * es lo que el supervisor reintenta- y que una credencial invalida no entra
 * nunca en el bucle.
 */
describe('SupervisorReconexion sobre el registro real', () => {
  const errorTransitorio = (): ErrorBitget =>
    new ErrorBitget('Se corto la conexion con Bitget. Se reintenta la consulta.', {
      clase: 'retryable',
      codigo: 'UND_ERR_SOCKET',
      mensajeOriginal: 'socket hang up',
      httpStatus: null,
      reintentarEnMs: null
    });

  const errorCredencial = (): ErrorBitget =>
    new ErrorBitget('La API Key no existe, o la passphrase no coincide con ella.', {
      clase: 'fatal-cuenta',
      codigo: '40012',
      mensajeOriginal: 'apikey/password is incorrect',
      httpStatus: 401,
      reintentarEnMs: null
    });

  it('reintenta una cuenta caida cuando su backoff vence, y no antes', async () => {
    let reloj = 1_000_000;
    const registro = new RegistroConexiones({ ahora: () => reloj, azar: () => 0.5 });

    registro.registrar('acc-1');
    registro.registrarExito('acc-1', 100);
    registro.registrarFallo('acc-1', errorTransitorio());

    const verificadas: string[] = [];
    const supervisor = new SupervisorReconexion({
      pendientesDeReintento: () => registro.pendientesDeReintento(),
      verificar: async (id) => {
        verificadas.push(id);
        registro.registrarExito(id, 80);
      },
      operativa: () => true
    });

    /* Aun no vence: con azar()=0.5 el jitter es cero y la espera es de 1 s. */
    await supervisor.ciclo();
    expect(verificadas).toEqual([]);

    reloj += 1_000;
    await supervisor.ciclo();
    expect(verificadas).toEqual(['acc-1']);

    /* Y tras el exito la cuenta sale del bucle: ya no vence nada. */
    expect(registro.estado('acc-1')?.estado).toBe('conectada');
    await supervisor.ciclo();
    expect(verificadas).toEqual(['acc-1']);
  });

  it('nunca reintenta una credencial que Bitget rechazo', async () => {
    let reloj = 1_000_000;
    const registro = new RegistroConexiones({ ahora: () => reloj, azar: () => 0.5 });

    registro.registrar('acc-1');
    registro.registrarFallo('acc-1', errorCredencial());

    const verificadas: string[] = [];
    const supervisor = new SupervisorReconexion({
      pendientesDeReintento: () => registro.pendientesDeReintento(),
      verificar: async (id) => {
        verificadas.push(id);
      },
      operativa: () => true
    });

    /*
     * Una API Key mal escrita no se arregla sola. Reintentarla cada segundo
     * gastaria cupo de las 99 cuentas que si funcionan, para siempre.
     */
    reloj += 60_000;
    await supervisor.ciclo();

    expect(verificadas).toEqual([]);
    expect(registro.estado('acc-1')?.proximoIntento).toBeNull();
  });

  it('la caida de una cuenta no arrastra a las demas al bucle de reintentos', async () => {
    let reloj = 1_000_000;
    const registro = new RegistroConexiones({ ahora: () => reloj, azar: () => 0.5 });

    for (const id of ['acc-1', 'acc-2', 'acc-3']) {
      registro.registrar(id);
      registro.registrarExito(id, 100);
    }
    registro.registrarFallo('acc-2', errorTransitorio());

    const verificadas: string[] = [];
    const supervisor = new SupervisorReconexion({
      pendientesDeReintento: () => registro.pendientesDeReintento(),
      verificar: async (id) => {
        verificadas.push(id);
      },
      operativa: () => true
    });

    reloj += 1_000;
    await supervisor.ciclo();

    /* RNF-004: solo se reintenta la que cayo. */
    expect(verificadas).toEqual(['acc-2']);
    expect(registro.estado('acc-1')?.estado).toBe('conectada');
    expect(registro.estado('acc-3')?.estado).toBe('conectada');
  });
});
