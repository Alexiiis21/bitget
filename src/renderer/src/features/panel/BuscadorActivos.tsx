import type { CSSProperties, KeyboardEvent } from 'react';
import { ESTADO_ACCION, FUENTE, SOMBRA, T, VELO } from '@/lib/tokens';
import { usarPanel } from '@/store/panel';

/**
 * Buscador de activos: qué va en cada una de las ocho casillas.
 *
 * --------------------------------------------------------------------------
 * Por qué esto es un diálogo y no una lista más larga
 * --------------------------------------------------------------------------
 * El panel opera ocho activos y el selector tiene ocho huecos. Lo que el cliente
 * pidió el 28/08/2026 no fue poder operar más, sino poder decidir **cuáles**
 * son esos ocho —quitar BTC de la casilla 1 y poner DOGE—. Los 754 contratos del
 * exchange viven aquí dentro y no en la barra lateral por la razón de siempre:
 * un selector de 754 entradas convierte una elección de un vistazo en una
 * búsqueda, y con ella llega el riesgo de operar por error un activo que no es
 * el suyo. Buscar es un acto aparte: se abre, se elige y se cierra.
 *
 * Elegir aquí **no envía ninguna orden ni toca ninguna posición**: cambia qué
 * activo se puede seleccionar después. Las posiciones abiertas en el activo que
 * se quita siguen abiertas en Bitget, y eso se dice en el pie del diálogo, que
 * es donde el operador lo va a leer.
 */

const velo: CSSProperties = { position: 'fixed', inset: 0, zIndex: 76, background: VELO.seguridad, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 28 };
const tarjeta: CSSProperties = { width: 520, maxWidth: '100%', maxHeight: '100%', background: T.superficie, borderRadius: 14, overflow: 'hidden', boxShadow: SOMBRA.seguridad, display: 'flex', flexDirection: 'column' };
const fila: CSSProperties = { width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8, cursor: 'pointer', textAlign: 'left', border: `1px solid ${T.borde}`, background: T.superficie };

export function BuscadorActivos() {
  const indice = usarPanel((s) => s.ranuraEditando);
  const ranuras = usarPanel((s) => s.ranuras);
  const catalogo = usarPanel((s) => s.catalogo);
  const carga = usarPanel((s) => s.cargaCatalogo);
  const motivo = usarPanel((s) => s.motivoCatalogo);
  const filtro = usarPanel((s) => s.filtroCatalogo);
  const fijando = usarPanel((s) => s.fijandoRanura);
  const escribirFiltro = usarPanel((s) => s.escribirFiltroCatalogo);
  const cerrar = usarPanel((s) => s.cerrarBuscadorActivos);
  const fijarRanura = usarPanel((s) => s.fijarRanura);

  if (indice === null) return null;

  const actual = ranuras[indice] ?? null;
  const termino = filtro.trim().toUpperCase();
  /*
   * Se busca por las tres formas en que el operador conoce un activo: el nombre
   * corto que ve en el panel (`DOGE`), el símbolo que espera la API
   * (`DOGEUSDT`) y el rótulo con el par (`DOGE/USDT`). Sin el símbolo, pegar uno
   * copiado de Bitget no encontraría nada.
   */
  const resultados =
    termino === ''
      ? catalogo
      : catalogo.filter(
          (a) =>
            a.id.toUpperCase().includes(termino) ||
            a.symbol.toUpperCase().includes(termino) ||
            a.label.toUpperCase().includes(termino)
        );

  /** Dónde está ya cada activo, para decirlo en su fila en vez de al rechazarlo. */
  const casillaDe = (simbolo: string): number | null => {
    const i = ranuras.findIndex((r) => r?.symbol === simbolo);
    return i === -1 ? null : i;
  };

  const alPulsarTecla = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') cerrar();
  };

  return (
    <div style={velo} onClick={cerrar}>
      <div style={tarjeta} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '16px 20px', background: T.marca, color: '#ffffff', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.14em', color: '#8ccdf5', fontFamily: FUENTE.mono, whiteSpace: 'nowrap' }}>
              CASILLA {indice + 1} DE {ranuras.length}
            </span>
            <span style={{ fontSize: 17, fontWeight: 600 }}>
              {actual === null ? 'Elegir un activo' : `Cambiar ${actual.label}`}
            </span>
          </div>
          <button type="button" className="pcb-boton-barra" onClick={cerrar} title="Cerrar" style={{ flex: 'none', width: 28, height: 28, borderRadius: 8, border: '1px solid #ffffff2e', background: '#ffffff14', color: '#ffffff', fontSize: 14, cursor: 'pointer' }}>
            ×
          </button>
        </div>

        <div style={{ padding: '14px 20px 10px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <input
            className="pcb-campo"
            value={filtro}
            onChange={(e) => escribirFiltro(e.target.value)}
            onKeyDown={alPulsarTecla}
            placeholder="Buscar: DOGE, DOGEUSDT…"
            autoFocus
            style={{ padding: '10px 12px', borderRadius: 9, border: `1px solid ${T.bordeFuerte}`, fontSize: 14, fontFamily: FUENTE.mono, background: T.campoFondo, color: T.campoTexto, outline: 'none' }}
          />
          {actual !== null && (
            <button
              type="button"
              className="pcb-boton-claro"
              disabled={fijando}
              onClick={() => void fijarRanura(null)}
              title={`Dejar la casilla ${indice + 1} vacía`}
              style={{ padding: '7px 10px', borderRadius: 7, fontSize: 11.5, fontWeight: 600, cursor: fijando ? 'wait' : 'pointer', border: `1px dashed ${T.bordeFuerte}`, background: 'transparent', color: T.texto3 }}
            >
              Vaciar la casilla {indice + 1}
            </button>
          )}
        </div>

        <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '0 20px 14px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {carga === 'cargando' && (
            <span style={{ padding: '14px 2px', fontSize: 12, color: T.texto3 }}>Pidiendo el catálogo a Bitget…</span>
          )}
          {carga === 'error' && (
            <span style={{ padding: '14px 2px', fontSize: 12, lineHeight: 1.45, color: ESTADO_ACCION.error }}>
              No se pudo leer el catálogo de activos. {motivo ?? ''}
            </span>
          )}
          {carga === 'listo' && resultados.length === 0 && (
            <span style={{ padding: '14px 2px', fontSize: 12, color: T.texto3 }}>
              Bitget no ofrece ningún contrato que se llame así en este mercado.
            </span>
          )}
          {resultados.map((a) => {
            const ocupa = casillaDe(a.symbol);
            const aqui = ocupa === indice;
            /* Puesto en otra casilla: se enseña y no se puede elegir. Ver `setAssetSlot`. */
            const bloqueado = ocupa !== null && !aqui;
            return (
              <button
                key={a.symbol}
                type="button"
                className={bloqueado ? undefined : 'pcb-fila-monitor'}
                disabled={fijando || bloqueado}
                onClick={() => void fijarRanura(a.symbol)}
                title={
                  bloqueado
                    ? `${a.label} ya está en la casilla ${(ocupa ?? 0) + 1}`
                    : `Poner ${a.label} en la casilla ${indice + 1}`
                }
                style={{
                  ...fila,
                  cursor: fijando ? 'wait' : bloqueado ? 'default' : 'pointer',
                  opacity: bloqueado ? 0.5 : 1,
                  borderColor: aqui ? T.marcaRelleno : T.borde,
                  background: aqui ? T.seleccion : T.superficie
                }}
              >
                <span style={{ flex: 'none', width: 96, fontSize: 12.5, fontWeight: 700, fontFamily: FUENTE.mono, color: aqui ? T.marcaTexto : T.texto }}>
                  {a.label}
                </span>
                <span style={{ flex: 'none', width: 96, fontSize: 10.5, fontFamily: FUENTE.mono, color: T.texto3 }}>{a.symbol}</span>
                <span style={{ flex: 'none', fontSize: 10.5, fontFamily: FUENTE.mono, color: T.texto3 }}>máx {a.maxLeverage}x</span>
                {!a.tradable && (
                  <span style={{ flex: 'none', fontSize: 9, fontWeight: 700, letterSpacing: '.08em', color: ESTADO_ACCION.error }}>SUSPENDIDO</span>
                )}
                {ocupa !== null && (
                  <span style={{ marginLeft: 'auto', flex: 'none', fontSize: 9.5, fontWeight: 600, color: T.texto3, whiteSpace: 'nowrap' }}>
                    {aqui ? 'en esta casilla' : `en la casilla ${ocupa + 1}`}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div style={{ padding: '10px 20px 14px', borderTop: `1px solid ${T.borde}`, fontSize: 10, lineHeight: 1.4, color: T.texto3 }}>
          Cambiar una casilla no envía ninguna orden ni cierra nada: solo decide qué activo se puede
          elegir en el panel. Lo que ya esté abierto en Bitget sigue abierto.
        </div>
      </div>
    </div>
  );
}
