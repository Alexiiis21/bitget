import type { CSSProperties, KeyboardEvent } from 'react';
import { CAJA_ERROR, FUENTE, SOMBRA, T, VELO } from '@/lib/tokens';
import { usarPanel } from '@/store/panel';

/**
 * Confirmación de apertura (`GateModal`).
 *
 * El único paso del panel que exige teclear algo antes de enviar órdenes.
 * Solo la apertura pasa por aquí -es la única acción que compromete dinero
 * nuevo-; cerrar no la necesita.
 */

const velo: CSSProperties = { position: 'fixed', inset: 0, zIndex: 85, background: VELO.paso, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 28 };
const tarjeta: CSSProperties = { width: 400, maxWidth: '100%', background: T.superficie, borderRadius: 14, overflow: 'hidden', boxShadow: SOMBRA.paso };
const renglon: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 10 };
const valorMono: CSSProperties = { fontWeight: 600, color: T.texto, fontFamily: FUENTE.mono };

export function DialogoPaso() {
  const pendiente = usarPanel((s) => s.pendiente);
  const pin = usarPanel((s) => s.pinPaso);
  const error = usarPanel((s) => s.errorPaso);
  const escribirPin = usarPanel((s) => s.escribirPin);
  const confirmarPaso = usarPanel((s) => s.confirmarPaso);
  const cancelarPaso = usarPanel((s) => s.cancelarPaso);
  const activos = usarPanel((s) => s.activos);
  const activoId = usarPanel((s) => s.activoId);
  const tipoOrden = usarPanel((s) => s.tipoOrden);
  const limitPrice = usarPanel((s) => s.limitPrice);

  if (!pendiente) return null;
  const activo = activos.find((a) => a.id === activoId);

  const alPulsarTecla = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') void confirmarPaso();
  };

  return (
    <div style={velo}>
      <div style={tarjeta}>
        <div style={{ padding: '18px 22px', background: T.marca, color: '#ffffff', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.14em', color: '#8ccdf5', fontFamily: FUENTE.mono, whiteSpace: 'nowrap' }}>
            CONFIRMAR APERTURA
          </span>
          <span style={{ fontSize: 18, fontWeight: 600 }}>Contraseña de paso</span>
        </div>

        <div style={{ padding: '18px 22px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7, padding: 12, borderRadius: 9, background: T.superficie2, border: `1px solid ${T.borde}`, fontSize: 12.5 }}>
            <div style={renglon}>
              <span style={{ color: T.texto2 }}>Acción</span>
              <span style={{ fontWeight: 600, color: T.texto }}>{pendiente.etiqueta}</span>
            </div>
            <div style={renglon}>
              <span style={{ color: T.texto2 }}>Activo</span>
              <span style={valorMono}>{activo?.label ?? '—'}</span>
            </div>
            <div style={renglon}>
              <span style={{ color: T.texto2 }}>Tipo de orden</span>
              <span style={valorMono}>{tipoOrden === 'limit' ? `Limit · ${limitPrice || 'sin precio'}` : 'Market'}</span>
            </div>
            <div style={renglon}>
              <span style={{ color: T.texto2 }}>Alcance</span>
              <span style={valorMono}>{pendiente.alcanceTexto}</span>
            </div>
            <div style={renglon}>
              <span style={{ color: T.texto2 }}>Margen inicial</span>
              <span style={valorMono}>{pendiente.margenInicial ? `${pendiente.margenInicial} USDT` : '—'}</span>
            </div>
          </div>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 7, fontSize: 11.5, fontWeight: 600, letterSpacing: '.06em', color: T.texto2, alignItems: 'center' }}>
            CONTRASEÑA DE PASO
            <input
              className="pcb-campo"
              type="password"
              placeholder="•••"
              value={pin}
              onChange={(e) => escribirPin(e.target.value)}
              onKeyDown={alPulsarTecla}
              autoComplete="off"
              autoFocus
              style={{ width: 210, padding: 13, borderRadius: 10, border: `1.5px solid ${T.bordeFuerte}`, fontSize: 22, fontWeight: 500, letterSpacing: '.2em', textAlign: 'center', fontFamily: FUENTE.mono, background: T.campoFondo, color: T.campoTexto, outline: 'none' }}
            />
          </label>

          {error !== '' && (
            <div style={{ padding: '10px 12px', borderRadius: 9, border: `1px solid ${CAJA_ERROR.borde}`, borderLeft: `4px solid ${CAJA_ERROR.acento}`, background: CAJA_ERROR.fondo, fontSize: 12, lineHeight: 1.45, color: CAJA_ERROR.texto }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="pcb-boton-claro"
              onClick={cancelarPaso}
              style={{ flex: 1, padding: '11px 15px', borderRadius: 9, fontSize: 13, fontWeight: 500, cursor: 'pointer', border: `1px solid ${T.bordeFuerte}`, background: T.superficie, color: T.texto }}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="pcb-boton-acento"
              onClick={() => void confirmarPaso()}
              style={{ flex: 1.4, padding: '11px 15px', borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: `1px solid ${T.marcaRelleno}`, background: T.marcaRelleno, color: '#ffffff' }}
            >
              Abrir posición
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
