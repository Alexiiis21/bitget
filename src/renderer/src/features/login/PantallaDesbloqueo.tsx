import { useState, type CSSProperties, type KeyboardEvent } from 'react';
import { BOTON_PRIMARIO, CAJA_ERROR, FUENTE, SOMBRA, T, VELO } from '@/lib/tokens';
import { usarPanel } from '@/store/panel';

/**
 * Pantalla de desbloqueo (`LockScreen`).
 *
 * Lo primero que ve el operador. Mientras está visible, el panel no ha
 * hablado con Bitget: no hay sockets abiertos ni claves en memoria del
 * proceso principal.
 */

const fondo: CSSProperties = { position: 'fixed', inset: 0, zIndex: 90, background: VELO.login, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 28 };
const tarjeta: CSSProperties = { width: 420, maxWidth: '100%', background: T.superficie, borderRadius: 16, overflow: 'hidden', boxShadow: SOMBRA.login };

export function PantallaDesbloqueo() {
  const numeroPanel = usarPanel((s) => s.numeroPanel);
  const contrasena = usarPanel((s) => s.contrasena);
  const error = usarPanel((s) => s.errorContrasena);
  const escribir = usarPanel((s) => s.escribirContrasena);
  const desbloquear = usarPanel((s) => s.desbloquear);
  /*
   * Ver la contraseña mientras se escribe. Es estado de este componente y no
   * del store a propósito: al desbloquear o bloquear la pantalla se desmonta y
   * el campo vuelve a ocultarse solo, sin que nadie tenga que acordarse.
   */
  const [visible, fijarVisible] = useState(false);

  const alPulsarTecla = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') void desbloquear();
  };

  return (
    <div style={fondo}>
      <div style={tarjeta}>
        <div style={{ padding: '26px 26px 20px', display: 'flex', flexDirection: 'column', gap: 6, background: T.marca, color: '#ffffff' }}>
          <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.16em', color: '#8ccdf5', fontFamily: FUENTE.mono, whiteSpace: 'nowrap' }}>
            PCB · PANEL #{numeroPanel}
          </span>
          <span style={{ fontSize: 21, fontWeight: 600 }}>Contraseña maestra</span>
          <span style={{ fontSize: 12.5, lineHeight: 1.5, color: '#a7c8e2' }}>
            El panel permanece bloqueado. Las API keys de las subcuentas están cifradas hasta que se desbloquee.
          </span>
        </div>

        <div style={{ padding: '22px 26px 26px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11.5, fontWeight: 600, letterSpacing: '.06em', color: T.texto3 }}>
            CONTRASEÑA
            <span style={{ position: 'relative', display: 'flex' }}>
              <input
                className="pcb-campo"
                type={visible ? 'text' : 'password'}
                placeholder="••••••••"
                value={contrasena}
                onChange={(e) => escribir(e.target.value)}
                onKeyDown={alPulsarTecla}
                autoFocus
                autoComplete="current-password"
                spellCheck={false}
                style={{ flex: 1, minWidth: 0, padding: '12px 92px 12px 13px', borderRadius: 9, border: `1px solid ${T.bordeFuerte}`, fontSize: 15, fontWeight: 500, letterSpacing: visible ? '.04em' : '.18em', fontFamily: visible ? FUENTE.mono : undefined, background: T.campoFondo, color: T.campoTexto, outline: 'none' }}
              />
              <button
                type="button"
                onClick={() => fijarVisible((v) => !v)}
                aria-pressed={visible}
                aria-label={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                title={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', padding: '5px 9px', borderRadius: 6, border: `1px solid ${T.bordeFuerte}`, background: T.superficie, color: T.texto2, fontSize: 11.5, fontWeight: 600, letterSpacing: 0, cursor: 'pointer' }}
              >
                {visible ? 'Ocultar' : 'Mostrar'}
              </button>
            </span>
          </label>

          {error !== '' && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '10px 12px', borderRadius: 9, border: `1px solid ${CAJA_ERROR.borde}`, borderLeft: `4px solid ${CAJA_ERROR.acento}`, background: CAJA_ERROR.fondo, fontSize: 12, lineHeight: 1.45, color: CAJA_ERROR.texto }}>
              {error}
            </div>
          )}

          <button
            type="button"
            className="pcb-boton-oscuro"
            onClick={() => void desbloquear()}
            style={{ padding: '12px 16px', borderRadius: 9, fontSize: 14, fontWeight: 600, cursor: 'pointer', border: `1px solid ${BOTON_PRIMARIO.borde}`, background: BOTON_PRIMARIO.fondo, color: BOTON_PRIMARIO.texto }}
          >
            Desbloquear panel
          </button>
        </div>
      </div>
    </div>
  );
}
