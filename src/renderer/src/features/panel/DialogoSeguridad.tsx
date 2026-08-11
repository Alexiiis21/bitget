import type { CSSProperties, KeyboardEvent } from 'react';
import { BOTON_PRIMARIO, CAJA_ERROR, FUENTE, SOMBRA, T, VELO } from '@/lib/tokens';
import { usarPanel } from '@/store/panel';

/**
 * Cambio de la contraseña de paso (`SecurityModal`).
 *
 * Dos etapas a propósito: la maestra primero y el cambio después. Quien se
 * levanta de la silla deja el panel abierto, y sin ese primer paso cualquiera
 * podría fijar una contraseña de paso conocida y abrir posiciones con ella.
 */

const velo: CSSProperties = { position: 'fixed', inset: 0, zIndex: 78, background: VELO.seguridad, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 28 };
const tarjeta: CSSProperties = { width: 460, maxWidth: '100%', background: T.superficie, borderRadius: 14, overflow: 'hidden', boxShadow: SOMBRA.seguridad };
const cuerpo: CSSProperties = { padding: '20px 24px 24px', display: 'flex', flexDirection: 'column', gap: 14 };
const cajaError: CSSProperties = { padding: '10px 12px', borderRadius: 9, border: `1px solid ${CAJA_ERROR.borde}`, borderLeft: `4px solid ${CAJA_ERROR.acento}`, background: CAJA_ERROR.fondo, fontSize: 12, lineHeight: 1.45, color: CAJA_ERROR.texto };
const etiquetaPaso: CSSProperties = { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11.5, fontWeight: 600, letterSpacing: '.06em', color: T.texto2 };
const campoPaso: CSSProperties = { padding: '11px 13px', borderRadius: 9, border: `1px solid ${T.bordeFuerte}`, fontSize: 19, fontWeight: 500, letterSpacing: '.3em', textAlign: 'center', fontFamily: FUENTE.mono, background: T.campoFondo, color: T.campoTexto, outline: 'none' };

export function DialogoSeguridad() {
  const abierta = usarPanel((s) => s.seguridadAbierta);
  const etapa = usarPanel((s) => s.etapaSeguridad);
  const maestra = usarPanel((s) => s.maestraSeguridad);
  const error = usarPanel((s) => s.errorSeguridad);
  const pasoNuevo = usarPanel((s) => s.pasoNuevo);
  const pasoNuevo2 = usarPanel((s) => s.pasoNuevo2);
  const cerrarSeguridad = usarPanel((s) => s.cerrarSeguridad);
  const escribirMaestra = usarPanel((s) => s.escribirMaestraSeguridad);
  const verificarMaestra = usarPanel((s) => s.verificarMaestra);
  const escribirPasoNuevo = usarPanel((s) => s.escribirPasoNuevo);
  const guardarPaso = usarPanel((s) => s.guardarPaso);

  if (!abierta) return null;

  const alPulsarTecla = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') void verificarMaestra();
  };

  return (
    <div style={velo}>
      <div style={tarjeta}>
        <div style={{ padding: '20px 24px', background: T.marca, color: '#ffffff', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.14em', color: '#8ccdf5', fontFamily: FUENTE.mono, whiteSpace: 'nowrap' }}>SEGURIDAD</span>
            <span style={{ fontSize: 18, fontWeight: 600 }}>Contraseña de paso</span>
          </div>
          <button type="button" className="pcb-boton-barra" onClick={cerrarSeguridad} title="Cerrar" style={{ flex: 'none', width: 28, height: 28, borderRadius: 8, border: '1px solid #ffffff2e', background: '#ffffff14', color: '#ffffff', fontSize: 14, cursor: 'pointer' }}>
            ×
          </button>
        </div>

        {etapa === 'maestra' ? (
          <div style={cuerpo}>
            <div style={{ fontSize: 12.5, lineHeight: 1.5, color: T.texto2 }}>
              Para cambiar la contraseña de paso primero confirme la <strong style={{ color: T.texto }}>contraseña maestra</strong> del panel.
            </div>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11.5, fontWeight: 600, letterSpacing: '.06em', color: T.texto2 }}>
              CONTRASEÑA MAESTRA
              <input
                className="pcb-campo"
                type="password"
                placeholder="••••••••"
                value={maestra}
                onChange={(e) => escribirMaestra(e.target.value)}
                onKeyDown={alPulsarTecla}
                autoFocus
                style={{ padding: '11px 13px', borderRadius: 9, border: `1px solid ${T.bordeFuerte}`, fontSize: 15, fontWeight: 500, letterSpacing: '.18em', background: T.campoFondo, color: T.campoTexto, outline: 'none' }}
              />
            </label>
            {error !== '' && <div style={cajaError}>{error}</div>}
            <button
              type="button"
              className="pcb-boton-oscuro"
              onClick={() => void verificarMaestra()}
              style={{ padding: '11px 16px', borderRadius: 9, fontSize: 13.5, fontWeight: 600, cursor: 'pointer', border: `1px solid ${BOTON_PRIMARIO.borde}`, background: BOTON_PRIMARIO.fondo, color: BOTON_PRIMARIO.texto }}
            >
              Continuar
            </button>
          </div>
        ) : (
          <div style={cuerpo}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 12px', borderRadius: 9, background: '#eff7fd', border: '1px solid #cfe4f5', fontSize: 12, color: '#14568f' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#2f9e44', display: 'block', flex: 'none' }} />
              Contraseña maestra verificada
            </div>
            <div style={{ fontSize: 12.5, lineHeight: 1.5, color: T.texto2 }}>
              Clave libre (letras, números y símbolos, mínimo 3 caracteres) que el panel pedirá cada vez que se abra o se cierre una posición.
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <label style={etiquetaPaso}>
                NUEVA
                <input className="pcb-campo" style={campoPaso} type="password" autoComplete="new-password" placeholder="•••" value={pasoNuevo} onChange={(e) => escribirPasoNuevo('pasoNuevo', e.target.value)} autoFocus />
              </label>
              <label style={etiquetaPaso}>
                CONFIRMAR
                <input className="pcb-campo" style={campoPaso} type="password" autoComplete="new-password" placeholder="•••" value={pasoNuevo2} onChange={(e) => escribirPasoNuevo('pasoNuevo2', e.target.value)} />
              </label>
            </div>
            {error !== '' && <div style={cajaError}>{error}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="pcb-boton-claro" onClick={cerrarSeguridad} style={{ padding: '10px 15px', borderRadius: 9, fontSize: 13, fontWeight: 500, cursor: 'pointer', border: `1px solid ${T.bordeFuerte}`, background: T.superficie, color: T.texto }}>
                Cancelar
              </button>
              <button type="button" className="pcb-boton-oscuro" onClick={() => void guardarPaso()} style={{ padding: '10px 17px', borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: `1px solid ${BOTON_PRIMARIO.borde}`, background: BOTON_PRIMARIO.fondo, color: BOTON_PRIMARIO.texto }}>
                Guardar contraseña
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
