import { AVISO, SOMBRA, T } from '@/lib/tokens';
import { usarPanel } from '@/store/panel';

/**
 * Pila de avisos emergentes.
 *
 * Abajo a la izquierda, sobre todo lo demás y sin robar el foco. La capa no
 * intercepta el ratón para que un aviso no bloquee una casilla justo debajo.
 *
 * --------------------------------------------------------------------------
 * Los cierra el operador. Ninguno se va solo
 * --------------------------------------------------------------------------
 * Los de error siempre esperaron; el resto se iban a los 4,2 segundos, y desde
 * el 31/08/2026 esperan todos. El motivo está en `avisar`: guardar una API key
 * deja en pantalla la confirmación y detrás los avisos de permisos de esa
 * clave, y cuatro segundos no dan para leerlos. Lo que desaparece no se puede
 * volver a mirar —no hay historial de avisos—.
 *
 * De ahí «Cerrar todos»: en cuanto hay más de uno, vaciarlos es un clic y no
 * uno por aviso. Aparece solo con dos o más, porque con uno sería un segundo
 * botón que hace lo mismo que la × de al lado.
 */
export function Avisos() {
  const avisos = usarPanel((s) => s.avisos);
  const cerrarAviso = usarPanel((s) => s.cerrarAviso);
  const cerrarAvisos = usarPanel((s) => s.cerrarAvisos);

  if (avisos.length === 0) return null;

  return (
    <div style={{ position: 'fixed', left: 26, bottom: 26, zIndex: 95, display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start', pointerEvents: 'none' }}>
      {avisos.length > 1 && (
        <button
          type="button"
          className="pcb-boton-claro"
          onClick={cerrarAvisos}
          style={{ pointerEvents: 'auto', alignSelf: 'flex-end', padding: '5px 12px', borderRadius: 8, border: `1px solid ${T.bordeFuerte}`, background: T.superficie, color: T.texto2, fontSize: 11.5, fontWeight: 600, cursor: 'pointer', boxShadow: SOMBRA.aviso }}
        >
          Cerrar todos · {avisos.length}
        </button>
      )}

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
            {/*
              * La × es ahora la única salida del aviso, así que se ve: con
              * borde y contraste propio en vez de un aspa suelta sobre el
              * fondo. Un cierre que hay que adivinar es un aviso que se queda.
              */}
            <button
              type="button"
              className="pcb-cerrar-aviso"
              onClick={() => cerrarAviso(aviso.id)}
              title="Cerrar aviso"
              aria-label={`Cerrar aviso: ${aviso.titulo}`}
              style={{ flex: 'none', width: 24, height: 24, borderRadius: 7, border: `1px solid ${paleta.borde}`, background: '#ffffff80', color: '#48545f', fontSize: 14, cursor: 'pointer', lineHeight: 1 }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
