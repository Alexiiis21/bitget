/**
 * Un socket privado, contra un servidor WebSocket local que habla el protocolo.
 *
 * Lo que se prueba es la secuencia y sus finales, que es donde esta el riesgo:
 *
 *  1. Que no se de por viva una conexion a la que le falta un canal. Media
 *     suscripcion significa media verdad en el monitor.
 *  2. Que un login rechazado **no** se reintente: el presupuesto de conexiones
 *     por IP es de 300 cada 5 minutos y una clave mala lo agota sola.
 *  3. Que cada caida avise **una** vez. Tirar un socket dispara su propio
 *     `close`, y dos avisos son dos reconexiones para la misma cuenta.
 *  4. Que el latido de aplicacion funcione en los dos sentidos: se manda `ping`
 *     y, si no vuelve `pong`, la conexion se da por muerta aunque el sistema
 *     operativo aun no lo sepa.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MERCADO_SIMULADO } from '@main/bitget/mercado';
import {
  ConexionBitget,
  type AvisosConexion,
  type MotivoCaida
} from '@main/bitget/ws/conexion';
import { cadenaPrefirma, firmar } from '@main/bitget/rest/signer';
import {
  empujonPlanes,
  empujonPosiciones,
  iniciarWsSimulado,
  type WsSimulado
} from '../mock-exchange/ws-servidor';

const CREDENCIAL = { apiKey: 'bg_key', secretKey: 'secreto', passphrase: 'frase' };

interface Registro {
  empujones: { canal: string; accion: string; datos: readonly unknown[] }[];
  caidas: { motivo: MotivoCaida; codigo: string | null; mensaje: string | null }[];
  vivas: number;
}

function registrador(): { avisos: AvisosConexion; registro: Registro } {
  const registro: Registro = { empujones: [], caidas: [], vivas: 0 };
  return {
    registro,
    avisos: {
      alEmpujar: (canal, accion, datos) => registro.empujones.push({ canal, accion, datos }),
      alQuedarViva: () => (registro.vivas += 1),
      alCaer: (motivo, detalle) => registro.caidas.push({ motivo, ...detalle })
    }
  };
}

let servidor: WsSimulado;
const abiertas: ConexionBitget[] = [];

function crear(avisos: AvisosConexion, opciones = {}): ConexionBitget {
  const conexion = new ConexionBitget('cta_001', CREDENCIAL, MERCADO_SIMULADO, avisos, {
    url: servidor.url,
    pingMs: 40,
    pongTimeoutMs: 60,
    esperaLoginMs: 200,
    ...opciones
  });
  abiertas.push(conexion);
  return conexion;
}

beforeEach(async () => {
  servidor = await iniciarWsSimulado();
});

afterEach(async () => {
  for (const c of abiertas) c.cerrar();
  abiertas.length = 0;
  await servidor.cerrar();
});

describe('secuencia de arranque', () => {
  it('autentica, suscribe los dos canales y queda viva', async () => {
    const { avisos, registro } = registrador();
    const conexion = crear(avisos);

    conexion.conectar();
    await vi.waitFor(() => expect(conexion.estaViva).toBe(true));

    expect(registro.vivas).toBe(1);
    expect(servidor.operaciones().slice(0, 2)).toEqual(['login', 'subscribe']);
  });

  it('firma el login con el timestamp en segundos, no en milisegundos', async () => {
    const { avisos } = registrador();
    /* Reloj fijo: asi la firma esperada es una constante y no una aproximacion. */
    const instante = 1_755_000_000_000;
    const conexion = crear(avisos, { ahora: () => instante });

    conexion.conectar();
    await vi.waitFor(() => expect(servidor.recibidos.length).toBeGreaterThan(0));

    const login = JSON.parse(servidor.recibidos[0] ?? '{}') as {
      args?: { timestamp?: string; sign?: string; apiKey?: string }[];
    };
    const arg = login.args?.[0];

    expect(arg?.timestamp).toBe('1755000000');
    expect(arg?.apiKey).toBe('bg_key');
    expect(arg?.sign).toBe(firmar('secreto', '1755000000GET/user/verify'));
  });

  it('la cadena firmada del socket no es la de REST', () => {
    /*
     * Las dos usan HMAC-SHA256 en base64 y ahi se acaba el parecido: el socket
     * firma segundos y una ruta fija, REST firma milisegundos y la ruta real
     * con su consulta. Confundirlas produce «firma invalida» sin decir por que.
     */
    const delSocket = firmar('secreto', '1755000000GET/user/verify');
    const deRest = firmar(
      'secreto',
      cadenaPrefirma({
        timestampMs: 1_755_000_000_000,
        metodo: 'GET',
        rutaCompleta: '/user/verify',
        cuerpo: ''
      })
    );

    expect(delSocket).not.toBe(deRest);
  });

  it('no se da por viva con un solo canal suscrito', async () => {
    servidor.configurar({ canalesQueFallan: ['orders-algo'] });
    const { avisos, registro } = registrador();
    const conexion = crear(avisos);

    conexion.conectar();
    await vi.waitFor(() => expect(registro.caidas).toHaveLength(1));

    expect(conexion.estaViva).toBe(false);
    expect(registro.vivas).toBe(0);
    expect(registro.caidas[0]?.motivo).toBe('suscripcion');
  });
});

describe('finales', () => {
  it('una credencial rechazada no se reintenta y deja la conexion invalida', async () => {
    servidor.configurar({ login: { ok: false, code: '30012', msg: 'invalid sign' } });
    const { avisos, registro } = registrador();
    const conexion = crear(avisos);

    conexion.conectar();
    await vi.waitFor(() => expect(registro.caidas).toHaveLength(1));

    expect(registro.caidas[0]).toMatchObject({ motivo: 'credencial', codigo: '30012' });
    expect(conexion.estado).toBe('invalida');
    /* No se llego a suscribir nada: la secuencia se corta en el login. */
    expect(servidor.operaciones()).not.toContain('subscribe');
  });

  it('avisa una sola vez por caida, aunque el socket dispare su propio close', async () => {
    const { avisos, registro } = registrador();
    const conexion = crear(avisos);

    conexion.conectar();
    await vi.waitFor(() => expect(conexion.estaViva).toBe(true));

    servidor.cortar();
    await vi.waitFor(() => expect(registro.caidas.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 60));

    expect(registro.caidas).toHaveLength(1);
  });

  it('cerrar un socket que todavia se esta abriendo no tumba el proceso', async () => {
    /*
     * `ws` emite `error` al abortar una conexion a medio abrir, y un `error`
     * sin escuchas en un EventEmitter lanza una excepcion que ningun `try`
     * atrapa, porque llega en otro turno del bucle. Con cien cuentas
     * promoviendose y enfriandose, cerrar durante el saludo es lo normal, no un
     * caso raro.
     */
    const { avisos, registro } = registrador();
    const conexion = crear(avisos);

    conexion.conectar();
    /* Sin esperar a que abra: se cierra en pleno saludo. */
    conexion.cerrar();

    await new Promise((r) => setTimeout(r, 80));

    expect(registro.caidas).toHaveLength(1);
    expect(registro.caidas[0]?.motivo).toBe('cerrado-local');
  });

  it('cerrar por decision propia se distingue de una caida', async () => {
    const { avisos, registro } = registrador();
    const conexion = crear(avisos);

    conexion.conectar();
    await vi.waitFor(() => expect(conexion.estaViva).toBe(true));

    conexion.cerrar();

    expect(registro.caidas).toHaveLength(1);
    expect(registro.caidas[0]?.motivo).toBe('cerrado-local');
  });

  it('un login sin respuesta acaba en caida, no en espera indefinida', async () => {
    /*
     * El servidor acepta la conexion y se queda callado. Es el caso que un
     * `close` no cubre: el socket sigue abierto y sano a ojos del sistema
     * operativo, y sin un plazo la cuenta se quedaria en `autenticando` para
     * siempre, ocupando uno de los 80 huecos de socket sin dar un solo dato.
     */
    servidor.configurar({ responderLogin: false });
    const { avisos, registro } = registrador();
    const conexion = crear(avisos, { esperaLoginMs: 60 });

    conexion.conectar();
    await vi.waitFor(() => expect(registro.caidas).toHaveLength(1), { timeout: 2_000 });

    expect(registro.caidas[0]?.motivo).toBe('red');
    expect(conexion.estaViva).toBe(false);
  });
});

describe('latido', () => {
  it('manda ping de aplicacion y sigue viva mientras conteste', async () => {
    const { avisos, registro } = registrador();
    const conexion = crear(avisos);

    conexion.conectar();
    await vi.waitFor(() => expect(conexion.estaViva).toBe(true));
    await vi.waitFor(() => expect(servidor.operaciones().filter((o) => o === 'ping').length).toBeGreaterThanOrEqual(2));

    expect(conexion.estaViva).toBe(true);
    expect(registro.caidas).toHaveLength(0);
  });

  it('sin pong, la conexion se da por muerta', async () => {
    const { avisos, registro } = registrador();
    const conexion = crear(avisos);

    conexion.conectar();
    await vi.waitFor(() => expect(conexion.estaViva).toBe(true));

    servidor.configurar({ responderPong: false });
    await vi.waitFor(() => expect(registro.caidas).toHaveLength(1), { timeout: 2_000 });

    expect(registro.caidas[0]?.motivo).toBe('sin-pong');
    expect(conexion.estaViva).toBe(false);
  });
});

describe('empujones', () => {
  it('clasifica por canal y conserva la accion', async () => {
    const { avisos, registro } = registrador();
    const conexion = crear(avisos);

    conexion.conectar();
    await vi.waitFor(() => expect(conexion.estaViva).toBe(true));

    servidor.empujar(empujonPosiciones('snapshot', [{ symbol: 'SBTCSUSDT', holdSide: 'long' }]));
    servidor.empujar(empujonPlanes('update', [{ orderId: 'plan_1' }]));

    await vi.waitFor(() => expect(registro.empujones).toHaveLength(2));

    expect(registro.empujones[0]).toMatchObject({ canal: 'positions', accion: 'snapshot' });
    expect(registro.empujones[1]).toMatchObject({ canal: 'orders-algo', accion: 'update' });
  });

  it('una accion desconocida se trata como update, nunca como snapshot', async () => {
    /*
     * Es la direccion segura del error: un `update` de mas deja una posicion
     * de mas hasta el siguiente barrido, mientras que un `snapshot` de mas
     * borra del monitor todas las demas posiciones de la cuenta.
     */
    const { avisos, registro } = registrador();
    const conexion = crear(avisos);

    conexion.conectar();
    await vi.waitFor(() => expect(conexion.estaViva).toBe(true));

    servidor.empujar({ action: 'lo-que-sea', arg: { channel: 'positions' }, data: [] });
    await vi.waitFor(() => expect(registro.empujones).toHaveLength(1));

    expect(registro.empujones[0]?.accion).toBe('update');
  });

  it('un mensaje que no es JSON no rompe la conexion', async () => {
    const { avisos, registro } = registrador();
    const conexion = crear(avisos);

    conexion.conectar();
    await vi.waitFor(() => expect(conexion.estaViva).toBe(true));

    servidor.empujar('esto no es json');
    await new Promise((r) => setTimeout(r, 30));

    expect(conexion.estaViva).toBe(true);
    expect(registro.empujones).toHaveLength(0);
  });
});
