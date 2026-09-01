import type { CSSProperties } from 'react';
import {
  BOTON_PRIMARIO,
  ESTADO_ACCION_FABRICA,
  ESTADO_ACCION_ROTULO,
  FUENTE,
  SOMBRA,
  T,
  VELO,
  type ClaveColorEstado
} from '@/lib/tokens';
import { usarPanel } from '@/store/panel';

/**
 * Colores de estado de la matriz (`ColorsModal`).
 *
 * Los tres que el operador mira de un vistazo sobre las casillas: verde
 * realizada, rojo pendiente, amarillo error. El cliente pidió poder cambiarlos,
 * y la razón de fondo es de accesibilidad —hay quien no distingue este rojo de
 * este verde—, no de gusto.
 *
 * --------------------------------------------------------------------------
 * Por qué no hay botón de guardar
 * --------------------------------------------------------------------------
 * El diálogo no tapa la matriz entera: se ve el color aplicándose detrás
 * mientras se elige, porque cambiarlo es reescribir una variable de CSS y no
 * re-renderizar nada. Con el resultado a la vista, un «guardar» solo añadiría
 * una manera de perder lo que ya se estaba viendo puesto. Se deshace con
 * *Restablecer* o eligiendo otra vez.
 */

const velo: CSSProperties = { position: 'fixed', inset: 0, zIndex: 78, background: VELO.seguridad, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 28 };
const tarjeta: CSSProperties = { width: 460, maxWidth: '100%', background: T.superficie, borderRadius: 14, overflow: 'hidden', boxShadow: SOMBRA.seguridad };
const cuerpo: CSSProperties = { padding: '20px 24px 24px', display: 'flex', flexDirection: 'column', gap: 16 };
const fila: CSSProperties = { display: 'flex', alignItems: 'center', gap: 12 };
const rotulo: CSSProperties = { flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 };

/** El orden en que se presentan: el mismo que la leyenda de la matriz. */
const CLAVES: ClaveColorEstado[] = ['realizada', 'pendiente', 'error'];

const QUE_PINTA: Record<ClaveColorEstado, string> = {
  realizada: 'La casilla tiene la posición abierta y la acción hecha.',
  pendiente: 'La casilla está sin abrir, o la acción sigue sin aplicarse.',
  error: 'La subcuenta no responde, o el activo está suspendido.'
};

/**
 * Una casilla de la matriz en miniatura.
 *
 * Reproduce la barra de 4 px del pie, que es donde el color se lee de verdad.
 * Enseñar una muestra cuadrada de color grande engañaría: sobre 4 píxeles, dos
 * tonos que se distinguen en grande pueden dejar de distinguirse.
 */
function Muestra({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      style={{ flex: 'none', width: 44, height: 46, borderRadius: 7, border: `1.5px solid ${T.borde}`, background: T.superficie, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, padding: '3px 2px 0', overflow: 'hidden' }}
    >
      <span style={{ fontSize: 11.5, fontWeight: 700, fontFamily: FUENTE.mono, color: T.texto2 }}>7</span>
      <span style={{ fontSize: 9, fontWeight: 600, fontFamily: FUENTE.mono, color: T.texto3 }}>500</span>
      <span style={{ width: '100%', height: 4, borderRadius: 2, background: color, marginTop: 1 }} />
    </span>
  );
}

export function DialogoColores() {
  const abierta = usarPanel((s) => s.coloresAbierto);
  const colores = usarPanel((s) => s.coloresEstado);
  const cerrar = usarPanel((s) => s.cerrarColores);
  const fijarColor = usarPanel((s) => s.fijarColorEstado);
  const restablecer = usarPanel((s) => s.restablecerColores);

  if (!abierta) return null;

  const deFabrica = CLAVES.every((c) => colores[c] === ESTADO_ACCION_FABRICA[c]);

  return (
    <div style={velo}>
      <div style={tarjeta}>
        <div style={{ padding: '20px 24px', background: T.marca, color: '#ffffff', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.14em', color: '#8ccdf5', fontFamily: FUENTE.mono, whiteSpace: 'nowrap' }}>COLORES</span>
            <span style={{ fontSize: 18, fontWeight: 600 }}>Estados de la matriz</span>
          </div>
          <button type="button" className="pcb-boton-barra" onClick={cerrar} title="Cerrar" style={{ flex: 'none', width: 28, height: 28, borderRadius: 8, border: '1px solid #ffffff2e', background: '#ffffff14', color: '#ffffff', fontSize: 14, cursor: 'pointer' }}>
            ×
          </button>
        </div>

        <div style={cuerpo}>
          <div style={{ fontSize: 12.5, lineHeight: 1.5, color: T.texto2 }}>
            El cambio se aplica al instante sobre la matriz que hay detrás, y se guarda en este
            equipo. No afecta a las cuentas ni a nada de Bitget.
          </div>

          {CLAVES.map((clave) => (
            <div key={clave} style={fila}>
              <Muestra color={colores[clave]} />
              <label htmlFor={`color-${clave}`} style={rotulo}>
                <span style={{ fontSize: 13, fontWeight: 600, color: T.texto }}>
                  {ESTADO_ACCION_ROTULO[clave]}
                </span>
                <span style={{ fontSize: 11.5, lineHeight: 1.4, color: T.texto3 }}>
                  {QUE_PINTA[clave]}
                </span>
              </label>
              <span style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 11.5, fontFamily: FUENTE.mono, color: T.texto3, whiteSpace: 'nowrap' }}>
                  {colores[clave]}
                </span>
                <input
                  id={`color-${clave}`}
                  type="color"
                  value={colores[clave]}
                  onChange={(e) => fijarColor(clave, e.target.value)}
                  style={{ flex: 'none', width: 44, height: 30, padding: 2, borderRadius: 7, border: `1px solid ${T.bordeFuerte}`, background: T.campoFondo, cursor: 'pointer' }}
                />
              </span>
            </div>
          ))}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="pcb-boton-claro"
              onClick={restablecer}
              disabled={deFabrica}
              title={deFabrica ? 'Ya están los colores de fábrica' : 'Volver al verde, rojo y amarillo originales'}
              style={{ padding: '10px 15px', borderRadius: 9, fontSize: 13, fontWeight: 500, cursor: deFabrica ? 'default' : 'pointer', border: `1px solid ${T.bordeFuerte}`, background: T.superficie, color: deFabrica ? T.texto3 : T.texto }}
            >
              Restablecer
            </button>
            <button
              type="button"
              className="pcb-boton-oscuro"
              onClick={cerrar}
              style={{ padding: '10px 17px', borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: `1px solid ${BOTON_PRIMARIO.borde}`, background: BOTON_PRIMARIO.fondo, color: BOTON_PRIMARIO.texto }}
            >
              Listo
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
