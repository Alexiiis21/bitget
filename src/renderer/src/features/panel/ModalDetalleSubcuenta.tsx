import type { CSSProperties, MouseEvent } from 'react';
import { BOTON_PRIMARIO, DISTINTIVO_POSICION, FUENTE, SOMBRA, T, VELO } from '@/lib/tokens';
import { cifra, cifraConSigno, restar } from '@/lib/formato';
import { usarPanel } from '@/store/panel';
import { distintivosDe } from './distintivos';
import type { Position, Side } from '@shared/domain/panel-view';

/**
 * Detalle de una subcuenta.
 *
 * Se abre al pulsar una fila del Centro de Monitoreo y enfrenta las dos
 * puntas. Solo lectura salvo «Reintentar conexión», que ni siquiera llama al
 * backend todavía -ver `reintentarConexion` en el store-: es la única salida
 * que tiene el operador cuando una subcuenta deja de responder, y hoy solo
 * confirma visualmente la intención mientras no exista un canal real de
 * reconexión por subcuenta.
 */

const velo: CSSProperties = { position: 'fixed', inset: 0, zIndex: 70, background: VELO.detalle, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 28 };
const tarjeta: CSSProperties = { width: 560, maxWidth: '100%', background: T.superficie, borderRadius: 14, overflow: 'hidden', boxShadow: SOMBRA.detalle, display: 'flex', flexDirection: 'column' };
const renglon: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 10 };

function Dato({ rotulo, valor, estilo }: { rotulo: string; valor: string; estilo?: CSSProperties }) {
  return (
    <div style={renglon}>
      <span style={{ color: T.texto2 }}>{rotulo}</span>
      <span style={{ fontFamily: FUENTE.mono, color: T.texto, ...estilo }}>{valor}</span>
    </div>
  );
}

function BloquePunta({ posicion, lado }: { posicion: Position | undefined; lado: Side }) {
  const color = lado === 'long' ? T.largo : T.corto;
  const rotulo = lado === 'long' ? 'LONG' : 'SHORT';
  const distintivo = posicion === undefined ? DISTINTIVO_POSICION.ninguna : posicion.actions.oe ? DISTINTIVO_POSICION.abierta : DISTINTIVO_POSICION.cerrada;

  return (
    <div style={{ background: T.superficie, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.12em', color }}>{rotulo}</span>
        <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 5, background: distintivo.fondo, color: distintivo.texto }}>{distintivo.etiqueta}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, fontSize: 12.5 }}>
        <Dato rotulo="Entrada" valor={cifra(posicion?.entryPrice)} estilo={{ fontWeight: 600 }} />
        <Dato rotulo="Liquidación" valor={cifra(posicion?.liquidationPrice)} />
        <Dato rotulo="Margen inicial" valor={posicion ? `${cifra(posicion.initialMarginAccum)} USDT` : '—'} estilo={{ fontWeight: 600 }} />
        <Dato rotulo="Take Profit" valor={cifra(posicion?.takeProfitPrice)} estilo={{ color }} />
      </div>
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
        {distintivosDe(posicion, rotulo).map((d) => (
          <span key={d.clave} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
            <span title={d.pista} style={{ minWidth: 34, height: 21, borderRadius: 5, padding: '0 6px', fontSize: 10, fontWeight: 600, color: '#ffffff', display: 'flex', alignItems: 'center', justifyContent: 'center', background: d.color }}>
              {d.etiqueta}
            </span>
            <span style={{ fontSize: 9, fontWeight: 600, color: T.texto3, fontFamily: FUENTE.mono, lineHeight: 1 }}>{d.valor}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function ModalDetalleSubcuenta() {
  const detalle = usarPanel((s) => s.detalle);
  const cuentas = usarPanel((s) => s.cuentas);
  const posiciones = usarPanel((s) => s.posiciones);
  const cerrarDetalle = usarPanel((s) => s.cerrarDetalle);
  const reintentarConexion = usarPanel((s) => s.reintentarConexion);

  if (!detalle) return null;
  const cuenta = cuentas.find((c) => c.id === detalle.accountId);
  const sub = cuenta?.subAccounts.find((s) => s.id === detalle.subAccountId);
  if (!cuenta || !sub) return null;

  const long = posiciones.find((p) => p.subAccountId === sub.id && p.side === 'long');
  const short = posiciones.find((p) => p.subAccountId === sub.id && p.side === 'short');
  const hayError = long?.hasError || short?.hasError;
  const hayAbierta = long?.actions.oe || short?.actions.oe;
  const distancia = long && short ? restar(short.entryPrice, long.entryPrice) : null;

  const detener = (e: MouseEvent<HTMLDivElement>) => e.stopPropagation();

  return (
    <div style={velo} onClick={cerrarDetalle}>
      <div style={tarjeta} onClick={detener}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, padding: '18px 20px', background: T.marca, color: '#ffffff' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.14em', color: '#8ccdf5', fontFamily: FUENTE.mono, whiteSpace: 'nowrap' }}>{cuenta.name}</span>
            <span style={{ fontSize: 19, fontWeight: 600 }}>{sub.label}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 'none' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '5px 10px', borderRadius: 20, fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap', background: hayError ? '#f2b70526' : '#ffffff1a', color: hayError ? '#ffe08a' : '#d6efe7' }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: hayError ? '#f2b705' : hayAbierta ? '#35b6f5' : '#ef6b58', display: 'block' }} />
              {hayError ? 'error de conexión' : hayAbierta ? 'posición abierta' : 'posición cerrada'}
            </span>
            <button type="button" className="pcb-boton-barra" onClick={cerrarDetalle} title="Cerrar" style={{ width: 28, height: 28, borderRadius: 8, border: '1px solid #ffffff2e', background: '#ffffff14', color: '#ffffff', fontSize: 14, cursor: 'pointer' }}>
              ×
            </button>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, background: T.borde }}>
          <BloquePunta posicion={long} lado="long" />
          <BloquePunta posicion={short} lado="short" />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '14px 20px', background: T.superficie2, borderTop: `1px solid ${T.borde}` }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 'none' }}>
            <span style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.1em', color: T.texto3, whiteSpace: 'nowrap' }}>DISTANCIA L/S</span>
            <span style={{ fontSize: 17, fontWeight: 700, fontFamily: FUENTE.mono, color: T.texto }}>{cifraConSigno(distancia)}</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="pcb-boton-claro"
              onClick={() => reintentarConexion(cuenta.id, sub.id)}
              style={{ padding: '9px 14px', borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: 'pointer', border: `1px solid ${T.bordeFuerte}`, background: T.superficie, color: T.texto }}
            >
              Reintentar conexión
            </button>
            <button
              type="button"
              className="pcb-boton-oscuro"
              onClick={cerrarDetalle}
              style={{ padding: '9px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: `1px solid ${BOTON_PRIMARIO.borde}`, background: BOTON_PRIMARIO.fondo, color: BOTON_PRIMARIO.texto }}
            >
              Cerrar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
