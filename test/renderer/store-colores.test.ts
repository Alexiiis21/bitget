/**
 * Los colores de estado que elige el operador.
 *
 * --------------------------------------------------------------------------
 * Que se prueba aqui y por que importa
 * --------------------------------------------------------------------------
 * Es el punto 11 del cliente, y su razon de fondo no es de gusto: hay quien no
 * distingue el rojo del verde de la matriz, y sobre una barra de cuatro pixeles
 * eso convierte «posicion abierta» y «casilla vacia» en la misma cosa.
 *
 * Dos invariantes, y las dos son sobre lo que pasa **al arrancar**:
 *
 *   1. La eleccion sobrevive a cerrar el panel. Un color que hay que volver a
 *      poner cada manana es un color que no sirve.
 *   2. Un `localStorage` a medias no puede dejar la matriz sin color. Cada uno
 *      de los tres se valida por separado y lo que no sea un hex de seis
 *      digitos vuelve al de fabrica, sin arrastrar a los otros dos.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ESTADO_ACCION_FABRICA } from '@/lib/tokens';

/* El store importa el servicio al cargarse; ninguna prueba de aqui lo llama. */
vi.mock('@/services/panel-service', () => ({
  panelService: {
    getSystemInfo: async () => ({ appVersion: '1.0.0', panelNumber: 1, portable: true }),
    listAssets: async () => [],
    subscribeAssetPrices: () => () => undefined
  }
}));

const CLAVE = 'pcb.colores-estado';

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

/*
 * Se siembra **antes** de importar el store: los colores se leen una sola vez,
 * al construirlo, que es exactamente el momento que estas pruebas vigilan.
 *
 * La semilla trae un color bueno, uno con formato invalido y uno ausente, para
 * que la primera prueba cubra los tres caminos de la validacion de una vez.
 */
almacen.set(CLAVE, JSON.stringify({ realizada: '#123456', pendiente: 'azul celeste' }));

const { usarPanel } = await import('@/store/panel');

describe('al arrancar', () => {
  it('recupera lo guardado y descarta solo lo que no es un color', () => {
    expect(usarPanel.getState().coloresEstado).toEqual({
      realizada: '#123456',
      pendiente: ESTADO_ACCION_FABRICA.pendiente,
      error: ESTADO_ACCION_FABRICA.error
    });
  });
});

describe('cambiar un color', () => {
  beforeEach(() => {
    usarPanel.getState().restablecerColores();
  });

  it('lo aplica y lo deja guardado en el equipo', () => {
    usarPanel.getState().fijarColorEstado('pendiente', '#0000ff');

    expect(usarPanel.getState().coloresEstado.pendiente).toBe('#0000ff');
    expect(JSON.parse(almacen.get(CLAVE) ?? '{}')).toEqual({
      ...ESTADO_ACCION_FABRICA,
      pendiente: '#0000ff'
    });
  });

  it('no arrastra a los otros dos', () => {
    usarPanel.getState().fijarColorEstado('realizada', '#0000ff');

    const colores = usarPanel.getState().coloresEstado;
    expect(colores.pendiente).toBe(ESTADO_ACCION_FABRICA.pendiente);
    expect(colores.error).toBe(ESTADO_ACCION_FABRICA.error);
  });

  /*
   * Restablecer **borra** la clave en vez de escribir los de fabrica. Asi el
   * dia que se cambien los valores por defecto en styles/index.css, un panel
   * que nunca los toco recibe los nuevos en lugar de quedarse clavado en los
   * viejos porque alguien pulso «Restablecer» una vez.
   */
  it('restablecer vuelve a fabrica y no deja nada escrito', () => {
    usarPanel.getState().fijarColorEstado('error', '#0000ff');
    expect(almacen.has(CLAVE)).toBe(true);

    usarPanel.getState().restablecerColores();

    expect(usarPanel.getState().coloresEstado).toEqual(ESTADO_ACCION_FABRICA);
    expect(almacen.has(CLAVE)).toBe(false);
  });
});
