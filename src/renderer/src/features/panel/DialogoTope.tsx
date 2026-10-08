import type { CSSProperties, KeyboardEvent } from 'react';
import { BOTON_PRIMARIO, CAJA_ERROR, FUENTE, SOMBRA, T, VELO } from '@/lib/tokens';
import { usarPanel } from '@/store/panel';

/**
 * Pide el tope de margen inicial del panel.
 *
 * Aparece al entrar en un panel sin tope -recién instalado- y cada vez que el
 * tope cumple sus 24 horas. El valor se escribe dos veces, como una contraseña:
 * es justo el número que no se puede corregir durante un día entero.
 *
 * Se puede cerrar sin fijarlo -cerrar posiciones o quitar un Take Profit no
 * dependen del tope-, pero entonces no se abre nada: el botón de abrir vuelve a
 * traer aquí.
 */

const velo: CSSProperties = { position: 'fixed', inset: 0, zIndex: 78, background: VELO.seguridad, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 28 };
const tarjeta: CSSProperties = { width: 480, maxWidth: '100%', background: T.superficie, borderRadius: 14, overflow: 'hidden', boxShadow: SOMBRA.seguridad };
const cuerpo: CSSProperties = { padding: '20px 24px 24px', display: 'flex', flexDirection: 'column', gap: 14 };
const cajaError: CSSProperties = { padding: '10px 12px', borderRadius: 9, border: `1px solid ${CAJA_ERROR.borde}`, borderLeft: `4px solid ${CAJA_ERROR.acento}`, background: CAJA_ERROR.fondo, fontSize: 12, lineHeight: 1.45, color: CAJA_ERROR.texto };
const etiqueta: CSSProperties = { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11.5, fontWeight: 600, letterSpacing: '.06em', color: T.texto2 };
const campo: CSSProperties = { padding: '11px 13px', borderRadius: 9, border: `1px solid ${T.bordeFuerte}`, fontSize: 19, fontWeight: 600, textAlign: 'center', fontFamily: FUENTE.mono, background: T.campoFondo, color: T.campoTexto, outline: 'none' };

export function DialogoTope() {
  const abierto = usarPanel((s) => s.topeAbierto);
  const tope = usarPanel((s) => s.tope);
  const valor = usarPanel((s) => s.topeValor);
  const valor2 = usarPanel((s) => s.topeValor2);
  const error = usarPanel((s) => s.errorTope);
  const guardando = usarPanel((s) => s.guardandoTope);
  const escribir = usarPanel((s) => s.escribirTope);
  const guardar = usarPanel((s) => s.guardarTope);
  const cerrar = usarPanel((s) => s.cerrarTope);

  if (!abierto) return null;

  const moneda = tope?.currency ?? 'USDT';
  const vencido = tope?.status === 'expired';

  const alPulsarTecla = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') void guardar();
  };

  return (
    <div style={velo}>
      <div style={tarjeta}>
        <div style={{ padding: '20px 24px', background: T.marca, color: '#ffffff', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.14em', color: '#8ccdf5', fontFamily: FUENTE.mono, whiteSpace: 'nowrap' }}>ANTES DE OPERAR</span>
            <span style={{ fontSize: 18, fontWeight: 600 }}>Margen inicial máximo</span>
          </div>
          <button type="button" className="pcb-boton-barra" onClick={cerrar} title="Cerrar sin fijar: no se podrán abrir posiciones" style={{ flex: 'none', width: 28, height: 28, borderRadius: 8, border: '1px solid #ffffff2e', background: '#ffffff14', color: '#ffffff', fontSize: 14, cursor: 'pointer' }}>
            ×
          </button>
        </div>

        <div style={cuerpo}>
          {vencido && tope?.value != null && (
            <div style={{ padding: '10px 12px', borderRadius: 9, background: '#fff8e6', border: '1px solid #f2d68a', fontSize: 12, lineHeight: 1.45, color: '#7a5600' }}>
              El tope anterior, de <strong>{tope.value} {moneda}</strong>, cumplió sus 24 horas. Fije el de hoy.
            </div>
          )}
          <div style={{ fontSize: 12.5, lineHeight: 1.55, color: T.texto2 }}>
            Ninguna apertura de este panel podrá llevar más margen inicial por casilla que este valor.{' '}
            <strong style={{ color: T.texto }}>Durante 24 horas no se podrá cambiar, ni para subirlo ni para bajarlo.</strong>{' '}
            No afecta a «agregar margen».
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <label style={etiqueta}>
              TOPE ({moneda})
              <input className="pcb-campo" style={campo} inputMode="decimal" placeholder="0.5" value={valor} onChange={(e) => escribir('topeValor', e.target.value)} onKeyDown={alPulsarTecla} autoFocus />
            </label>
            <label style={etiqueta}>
              REPETIR
              <input className="pcb-campo" style={campo} inputMode="decimal" placeholder="0.5" value={valor2} onChange={(e) => escribir('topeValor2', e.target.value)} onKeyDown={alPulsarTecla} />
            </label>
          </div>
          {error !== '' && <div style={cajaError}>{error}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="pcb-boton-claro" onClick={cerrar} style={{ padding: '10px 15px', borderRadius: 9, fontSize: 13, fontWeight: 500, cursor: 'pointer', border: `1px solid ${T.bordeFuerte}`, background: T.superficie, color: T.texto }}>
              Ahora no
            </button>
            <button type="button" className="pcb-boton-oscuro" disabled={guardando} onClick={() => void guardar()} style={{ padding: '10px 17px', borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: guardando ? 'wait' : 'pointer', border: `1px solid ${BOTON_PRIMARIO.borde}`, background: BOTON_PRIMARIO.fondo, color: BOTON_PRIMARIO.texto, opacity: guardando ? 0.7 : 1 }}>
              {guardando ? 'Fijando…' : 'Fijar por 24 horas'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
