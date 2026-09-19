/**
 * Respaldar y restaurar, desde la pantalla.
 *
 * --------------------------------------------------------------------------
 * Qué se prueba aquí y por qué importa
 * --------------------------------------------------------------------------
 * Que el proceso principal no sobrescriba un almacén sin permiso lo prueban
 * `test/unit/respaldo-credenciales.test.ts` y el manejador de IPC, y ese es el
 * freno que cuenta. Aquí se prueba la otra mitad, la que el cliente ve: que el
 * diálogo de confirmación **solo aparece cuando hay algo que perder**, que
 * cancelar no restaura nada, y que una contraseña equivocada deja el diálogo
 * abierto en vez de obligar a empezar de cero.
 *
 * Como en `store-baja-api.test.ts`, el servicio es de mentira y apunta cada
 * llamada: «no se restauró nada» se comprueba contando llamadas, no confiando
 * en que no las haya.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackupInfo, BackupResult, RestoreResult } from '@shared/domain/panel-view';

/** Cada llamada a los métodos de respaldo, en orden. */
const llamadas: string[] = [];
/** Las contraseñas con las que se pidió restaurar. `undefined` es «sin contraseña». */
const maestras: (string | undefined)[] = [];

/** `true` = este panel ya tiene almacén, así que restaurar reemplaza. */
let hayVault = false;
let respaldoEnDisco: BackupInfo | null = null;
let resultadoRespaldo: BackupResult = {
  ok: true,
  reason: null,
  message: 'Respaldo guardado.',
  fileName: 'respaldo-pcb-2026-09-13-142507.pcbak',
  folder: 'C:\\Users\\op\\Documents\\Panel de Control Bitget\\respaldos',
  accounts: 24
};
let resultadoRestauracion: RestoreResult = {
  cancelled: false,
  ok: true,
  reason: null,
  message: 'Credenciales restauradas.',
  accounts: 24,
  replaced: null
};

const RESPALDO: BackupInfo = {
  fileName: 'respaldo-pcb-ultimo.pcbak',
  folder: 'C:\\Users\\op\\Documents\\Panel de Control Bitget\\respaldos',
  createdAt: '2026-09-13T14:25:07.412Z',
  appVersion: '0.9.0',
  accounts: 24,
  market: 'real',
  panel: 3,
  tooNew: false
};

vi.mock('@/services/panel-service', () => ({
  panelService: {
    getSystemInfo: async () => ({
      appVersion: '1.0.0',
      panelNumber: 1,
      portable: true,
      market: 'simulado'
    }),
    listAssetSlots: async () => [],
    subscribeAssetPrices: () => () => undefined,
    listApiKeys: async () => [],
    hasStepPassword: async () => true,
    isFirstRun: async () => !hayVault,
    backupAccounts: async (): Promise<BackupResult> => {
      llamadas.push('backup');
      return resultadoRespaldo;
    },
    openBackupFolder: async (): Promise<void> => {
      llamadas.push('openFolder');
    },
    findBackup: async (): Promise<BackupInfo | null> => {
      llamadas.push('find');
      return respaldoEnDisco;
    },
    restoreBackup: async (maestra?: string): Promise<RestoreResult> => {
      llamadas.push('restore');
      maestras.push(maestra);
      return resultadoRestauracion;
    },
    restoreBackupFromFile: async (maestra?: string): Promise<RestoreResult> => {
      llamadas.push('restoreFile');
      maestras.push(maestra);
      return resultadoRestauracion;
    }
  }
}));

const almacen = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => almacen.get(k) ?? null,
    setItem: (k: string, v: string) => almacen.set(k, v),
    removeItem: (k: string) => almacen.delete(k)
  },
  configurable: true
});
Object.defineProperty(globalThis, 'window', {
  value: { matchMedia: () => ({ matches: false }) },
  configurable: true
});

const { usarPanel } = await import('@/store/panel');

beforeEach(() => {
  llamadas.length = 0;
  maestras.length = 0;
  hayVault = false;
  respaldoEnDisco = RESPALDO;
  resultadoRespaldo = {
    ok: true,
    reason: null,
    message: 'Respaldo guardado.',
    fileName: 'respaldo-pcb-2026-09-13-142507.pcbak',
    folder: 'C:\\Users\\op\\Documents\\Panel de Control Bitget\\respaldos',
    accounts: 24
  };
  resultadoRestauracion = {
    cancelled: false,
    ok: true,
    reason: null,
    message: 'Credenciales restauradas.',
    accounts: 24,
    replaced: null
  };
  usarPanel.setState({
    avisos: [],
    respaldando: false,
    respaldoDetectado: null,
    restauracion: null,
    maestraRestauracion: '',
    errorRestauracion: '',
    restaurando: false,
    avisoRestauracion: null
  });
});

describe('respaldar', () => {
  it('deja un aviso que nombra el archivo y la carpeta', async () => {
    await usarPanel.getState().respaldarCuentas();

    const aviso = usarPanel.getState().avisos[0];
    expect(llamadas).toEqual(['backup']);
    expect(aviso?.tipo).toBe('ok');
    expect(aviso?.cuerpo).toContain('respaldo-pcb-2026-09-13-142507.pcbak');
    expect(aviso?.cuerpo).toContain('24 subcuentas');
    /* La frase que sostiene toda la seguridad del archivo. */
    expect(aviso?.cuerpo).toContain('contraseña maestra no va dentro');
  });

  /* Un doble clic no debe escribir dos archivos ni dejar dos avisos. */
  it('dos pulsaciones seguidas no respaldan dos veces', async () => {
    const primera = usarPanel.getState().respaldarCuentas();
    const segunda = usarPanel.getState().respaldarCuentas();
    await Promise.all([primera, segunda]);

    expect(llamadas).toEqual(['backup']);
  });

  it('un fallo se cuenta y no deja el botón bloqueado', async () => {
    resultadoRespaldo = {
      ok: false,
      reason: 'no-se-pudo-escribir',
      message: 'No se pudo escribir en Documentos: OneDrive está sincronizando.',
      fileName: null,
      folder: null,
      accounts: null
    };

    await usarPanel.getState().respaldarCuentas();

    expect(usarPanel.getState().avisos[0]?.tipo).toBe('error');
    expect(usarPanel.getState().avisos[0]?.cuerpo).toContain('OneDrive');
    expect(usarPanel.getState().respaldando).toBe(false);
  });
});

describe('encontrar el respaldo', () => {
  it('guarda lo que el panel encontró solo', async () => {
    await usarPanel.getState().buscarRespaldo();

    expect(usarPanel.getState().respaldoDetectado?.accounts).toBe(24);
  });

  /* Sin respaldo la pantalla sigue igual: sondear no puede romper el desbloqueo. */
  it('no encontrar nada no es un error', async () => {
    respaldoEnDisco = null;

    await usarPanel.getState().buscarRespaldo();

    expect(usarPanel.getState().respaldoDetectado).toBeNull();
    expect(usarPanel.getState().avisos).toHaveLength(0);
  });
});

describe('restaurar', () => {
  /*
   * El requisito llevado hasta el final: en un panel recién estrenado no hay
   * nada que destruir, así que no se pregunta nada. Un clic y listo.
   */
  it('sin almacén restaura de un clic, sin diálogo ni contraseña', async () => {
    hayVault = false;
    usarPanel.setState({ respaldoDetectado: RESPALDO });

    await usarPanel.getState().pedirRestauracion(false);

    expect(llamadas).toContain('restore');
    expect(maestras).toEqual([undefined]);
    expect(usarPanel.getState().restauracion).toBeNull();
    expect(usarPanel.getState().avisoRestauracion?.ok).toBe(true);
  });

  /* Con almacén sí hay algo que perder: se abre el diálogo y no se restaura nada. */
  it('con almacén abre la confirmación sin tocar nada', async () => {
    hayVault = true;
    usarPanel.setState({ respaldoDetectado: RESPALDO });

    await usarPanel.getState().pedirRestauracion(false);

    expect(llamadas).not.toContain('restore');
    expect(usarPanel.getState().restauracion?.cuentas).toBe(24);
  });

  it('la contraseña viaja con la restauración', async () => {
    hayVault = true;
    usarPanel.setState({ respaldoDetectado: RESPALDO });
    await usarPanel.getState().pedirRestauracion(false);

    usarPanel.getState().escribirMaestraRestauracion('la-de-este-panel');
    await usarPanel.getState().confirmarRestauracion();

    expect(maestras).toEqual(['la-de-este-panel']);
    expect(usarPanel.getState().restauracion).toBeNull();
  });

  /*
   * Un fallo de tecleo no puede obligar a empezar de cero: el diálogo se queda
   * abierto con el error dentro.
   */
  it('una contraseña equivocada deja el diálogo abierto', async () => {
    hayVault = true;
    resultadoRestauracion = {
      cancelled: false,
      ok: false,
      reason: 'maestra-incorrecta',
      message: 'Esa no es la contraseña maestra de este panel.',
      accounts: null,
      replaced: null
    };
    usarPanel.setState({ respaldoDetectado: RESPALDO });
    await usarPanel.getState().pedirRestauracion(false);

    usarPanel.getState().escribirMaestraRestauracion('la-que-no-es');
    await usarPanel.getState().confirmarRestauracion();

    expect(usarPanel.getState().restauracion).not.toBeNull();
    expect(usarPanel.getState().errorRestauracion).toContain('contraseña maestra');
  });

  /* Lo que no se arregla insistiendo sí cierra el diálogo, y se cuenta fuera. */
  it('un respaldo de una versión futura cierra el diálogo y lo explica', async () => {
    hayVault = true;
    resultadoRestauracion = {
      cancelled: false,
      ok: false,
      reason: 'version-futura',
      message: 'Ese respaldo lo hizo una versión más nueva del panel (0.9.5).',
      accounts: null,
      replaced: null
    };
    usarPanel.setState({ respaldoDetectado: RESPALDO });
    await usarPanel.getState().pedirRestauracion(false);
    usarPanel.getState().escribirMaestraRestauracion('la-de-este-panel');

    await usarPanel.getState().confirmarRestauracion();

    expect(usarPanel.getState().restauracion).toBeNull();
    expect(usarPanel.getState().avisoRestauracion?.ok).toBe(false);
    expect(usarPanel.getState().avisoRestauracion?.texto).toContain('más nueva');
  });

  /* «No se restauró nada» se comprueba contando llamadas. */
  it('cancelar no llama al servicio', async () => {
    hayVault = true;
    usarPanel.setState({ respaldoDetectado: RESPALDO });
    await usarPanel.getState().pedirRestauracion(false);
    llamadas.length = 0;

    usarPanel.getState().cancelarRestauracion();

    expect(llamadas).toHaveLength(0);
    expect(usarPanel.getState().restauracion).toBeNull();
    expect(usarPanel.getState().maestraRestauracion).toBe('');
  });

  it('confirmar sin escribir nada no llama al servicio', async () => {
    hayVault = true;
    usarPanel.setState({ respaldoDetectado: RESPALDO });
    await usarPanel.getState().pedirRestauracion(false);
    llamadas.length = 0;

    await usarPanel.getState().confirmarRestauracion();

    expect(llamadas).toHaveLength(0);
    expect(usarPanel.getState().errorRestauracion).not.toBe('');
  });

  /* Cerrar el selector de archivos no es un fallo y no deja aviso de error. */
  it('cancelar el selector de archivos no dice nada', async () => {
    hayVault = false;
    resultadoRestauracion = {
      cancelled: true,
      ok: false,
      reason: null,
      message: '',
      accounts: null,
      replaced: null
    };

    await usarPanel.getState().pedirRestauracion(true);

    expect(llamadas).toContain('restoreFile');
    expect(usarPanel.getState().avisoRestauracion).toBeNull();
  });

  /* Lo que se apartó se nombra: el operador tiene que saber dónde está. */
  it('el aviso nombra el almacén que se apartó', async () => {
    hayVault = true;
    resultadoRestauracion = {
      cancelled: false,
      ok: true,
      reason: null,
      message: 'Credenciales restauradas.',
      accounts: 24,
      replaced: 'vault.enc.reemplazado-2026-09-13-160000'
    };
    usarPanel.setState({ respaldoDetectado: RESPALDO });
    await usarPanel.getState().pedirRestauracion(false);
    usarPanel.getState().escribirMaestraRestauracion('la-de-este-panel');

    await usarPanel.getState().confirmarRestauracion();

    expect(usarPanel.getState().avisoRestauracion?.texto).toContain(
      'vault.enc.reemplazado-2026-09-13-160000'
    );
    expect(usarPanel.getState().avisoRestauracion?.texto).toContain('no se ha borrado');
  });
});
