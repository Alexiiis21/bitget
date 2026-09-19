/**
 * El orden en que se enseñan las cuentas principales.
 *
 * ==========================================================================
 * Por que tiene archivo propio
 * ==========================================================================
 * Esta regla estuvo escrita dentro de `PantallaApis.tsx`, y por tanto **sin
 * ninguna prueba**: la suite corre en `node`, sin jsdom, asi que no monta
 * componentes. La matriz, que vive en el proceso principal, resolvia el orden
 * por su cuenta y salia distinto —el aviso del cliente que origino el arreglo—.
 *
 * Al extraer el comparador a `@shared/constants` la regla queda cubierta por
 * primera vez, y la cubre para los dos lados a la vez: la pantalla de API Keys
 * y la matriz ya no pueden discrepar porque comparan con la misma funcion.
 */
import { describe, expect, it } from 'vitest';
import { compararCuentaMadre, NOMBRES_CUENTA_MADRE } from '@shared/constants';

const ordenar = (nombres: readonly string[]): string[] => [...nombres].sort(compararCuentaMadre);

describe('orden de las cuentas principales', () => {
  it('ordena por el abecedario y no por el orden de entrada', () => {
    expect(ordenar(['C', 'A', 'B'])).toEqual(['A', 'B', 'C']);
  });

  /*
   * El caso exacto que reporto el cliente, reducido a la regla: dar de alta la
   * B antes que la A no puede cambiar donde salen.
   */
  it('la B dada de alta antes que la A sigue yendo despues', () => {
    expect(ordenar(['B', 'A'])).toEqual(['A', 'B']);
  });

  it('las quince van en su orden, y ordenarlas no las mueve', () => {
    expect(ordenar(NOMBRES_CUENTA_MADRE)).toEqual([...NOMBRES_CUENTA_MADRE]);
  });

  /*
   * Antes del 28/08/2026 el nombre de la cuenta principal se escribia a mano,
   * asi que un `cuentas.json` de entonces puede traer cualquier cosa. No se
   * descarta: se manda al final, que es donde no estorba.
   */
  it('un nombre de fuera de A-O va al final', () => {
    expect(ordenar(['Cuenta Madre 1', 'B', 'A'])).toEqual(['A', 'B', 'Cuenta Madre 1']);
  });

  it('dos nombres de fuera de A-O quedan alfabeticos entre si', () => {
    expect(ordenar(['Zeta', 'Alfa'])).toEqual(['Alfa', 'Zeta']);
  });

  /*
   * La unica conducta nueva respecto de lo que hacia el renderer. El registro
   * empareja los grupos sin distinguir mayusculas pero guarda el nombre tal
   * como llego, asi que una ficha antigua puede decir «a»: sin normalizar
   * caeria detras de la O en vez de encabezar la lista.
   */
  it('una minuscula de un archivo antiguo se ordena como su letra', () => {
    expect(ordenar(['B', 'a'])).toEqual(['a', 'B']);
    expect(ordenar(['b', 'A'])).toEqual(['A', 'b']);
  });

  it('tolera los espacios de un nombre tecleado a mano', () => {
    expect(ordenar(['B', ' A '])).toEqual([' A ', 'B']);
  });
});
