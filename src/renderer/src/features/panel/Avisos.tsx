import { AVISO, SOMBRA, T } from '@/lib/tokens';
import { usarPanel } from '@/store/panel';

/**
 * Pila de avisos emergentes.
 *
 * Abajo a la izquierda, sobre todo lo demás y sin robar el foco. Los de
 * error se quedan hasta que alguien los cierre; el resto se van solos a los
 * 4,2 s. La capa no intercepta el ratón para que un aviso no bloquee una
 * casilla justo debajo.
 */
export function Avisos() {
  const avisos = usarPanel((s) => s.avisos);
  const cerrarAviso = usarPanel((s) => s.cerrarAviso);

  return (
    <div style={{ position: 'fixed', left: 26, bottom: 26, zIndex: 95, display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start', pointerEvents: 'none' }}>
      {avisos.map((aviso) => {
        const paleta = AVISO[aviso.tipo];
        return (
          <div
            key={aviso.id}
            style={{ pointerEvents: 'auto', display: 'flex', alignItems: 'flex-start', gap: 12, width: 380, padding: '13px 14px', borderRadius: 11, border: `1px solid ${paleta.borde}`, borderLeft: `5px solid ${paleta.acento}`, background: paleta.fondo, boxShadow: SOMBRA.aviso }}
          >
            <span style={{ width: 22, height: 22, borderRadius: 6, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: '#ffffff', background: paleta.acento }}>
              {paleta.icono}
            </span>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#131c26' }}>{aviso.titulo}</div>
              <div style={{ fontSize: 12, lineHeight: 1.45, color: '#48545f' }}>{aviso.cuerpo}</div>
              {aviso.meta && <div style={{ fontSize: 10.5, fontFamily: 'monospace', color: '#8794a0' }}>{aviso.meta}</div>}
            </div>
            <button
              type="button"
              className="pcb-cerrar-aviso"
              onClick={() => cerrarAviso(aviso.id)}
              title="Cerrar aviso"
              style={{ flex: 'none', width: 22, height: 22, borderRadius: 6, border: 'none', background: 'transparent', color: T.texto3, fontSize: 13, cursor: 'pointer', lineHeight: 1 }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
