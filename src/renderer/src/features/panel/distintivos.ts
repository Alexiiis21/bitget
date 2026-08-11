import { ESTADO_ACCION } from '@/lib/tokens';
import { CLAVES_ACCION } from './tipos';
import type { Position } from '@shared/domain/panel-view';

/**
 * Distintivos TP · MGA · AP · OE de una punta.
 *
 * Los usan `AccordeonMonitor`, `AccordeonHistorial` (indirectamente, vía la
 * punta viva) y `ModalDetalleSubcuenta`. Calculados en un solo sitio para
 * que ninguno de los tres pueda desalinearse del resto en la lectura de
 * color.
 */
export interface Distintivo {
  clave: string;
  etiqueta: string;
  valor: string;
  pista: string;
  color: string;
}

const valorDe = (p: Position, clave: 'tp' | 'mg' | 'ap' | 'oe'): string => {
  if (clave === 'oe') return '';
  if (clave === 'tp') return p.actions.tpDisplay || '—';
  if (clave === 'mg') return p.actions.mgDisplay || '—';
  return p.actions.apDisplay || '—';
};

export function distintivosDe(posicion: Position | undefined, nombreLado: string): Distintivo[] {
  if (!posicion) return [];
  return CLAVES_ACCION.map((accion) => {
    const hecha = posicion.actions[accion.clave];
    const valor = valorDe(posicion, accion.clave);
    return {
      clave: accion.clave,
      etiqueta: accion.etiqueta,
      valor,
      pista: `${nombreLado} · ${accion.nombre} · ${hecha ? 'realizada' : 'pendiente'}${valor && valor !== '—' ? ` · ${valor}` : ''}`,
      color: hecha ? ESTADO_ACCION.realizada : ESTADO_ACCION.pendiente
    };
  });
}
