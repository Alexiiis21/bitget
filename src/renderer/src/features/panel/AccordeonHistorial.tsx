import { FUENTE, T } from '@/lib/tokens';
import { cifra, cifraConSigno } from '@/lib/formato';
import { usarPanel } from '@/store/panel';
import { EsqueletoLineas, EstadoVacio } from './Esqueleto';
import type { Account, ClosedPosition } from '@shared/domain/panel-view';

/**
 * Historial de posiciones — acordeón por cuenta.
 *
 * Las N subcuentas de la cuenta están siempre presentes, tengan o no
 * historial: a diferencia del monitoreo, aquí no hay nada que aparezca o
 * desaparezca solo. Máximo `HISTORIAL_MAXIMO` operaciones cerradas por
 * subcuenta, de la más reciente a la más antigua — ya vienen así de
 * `PanelService.getHistory`.
 */

const CERRADO_POR: Record<ClosedPosition['closedBy'], string> = {
  'take-profit': 'Take Profit',
  liquidacion: 'Liquidación',
  manual: 'Manual'
};

const colorCerradoPor = (por: ClosedPosition['closedBy']): string =>
  por === 'liquidacion' ? T.corto : por === 'manual' ? T.texto3 : '#2f7a4f';

export function AccordeonHistorial({ cuenta }: { cuenta: Account }) {
  const historial = usarPanel((s) => s.historial);
  const histSubAbierto = usarPanel((s) => s.histSubAbierto);
  const alternarHistSub = usarPanel((s) => s.alternarHistSub);
  const carga = usarPanel((s) => s.cargaHistorial[cuenta.id] ?? 'inicial');

  /*
   * Mientras llega, la silueta de las subcuentas. Se piden todas de golpe al
   * desplegar, asi que o estan todas o no esta ninguna.
   */
  if (carga === 'inicial' || carga === 'cargando') {
    return (
      <div style={{ background: T.superficie }}>
        <EsqueletoLineas filas={Math.min(cuenta.subAccounts.length, 6)} sangria={26} />
      </div>
    );
  }

  if (carga === 'error') {
    return (
      <div style={{ background: T.superficie }}>
        <EstadoVacio
          compacto
          tono="error"
          titulo="No se pudo leer el historial"
          cuerpo="Vuelva a plegar y desplegar esta sección para reintentarlo. El historial no afecta a las posiciones abiertas ni a las órdenes en curso."
        />
      </div>
    );
  }

  return (
    <div style={{ background: T.superficie }}>
      {cuenta.subAccounts.map((sub) => {
        const filas = historial[sub.id] ?? [];
        const neto = filas.reduce((t, h) => t + Number.parseFloat(h.pnl), 0);
        const abierto = histSubAbierto[sub.id] ?? false;

        return (
          <div key={sub.id}>
            <div
              onClick={() => alternarHistSub(sub.id)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px 4px 26px', borderBottom: `1px solid ${T.bordeSuave}`, cursor: 'pointer', userSelect: 'none', background: abierto ? T.seleccionSuave : T.superficie }}
            >
              <span style={{ fontSize: 8, lineHeight: 1, color: T.texto3, width: 8, display: 'flex', justifyContent: 'center' }}>{abierto ? '▼' : '▶'}</span>
              <span style={{ fontSize: 10.5, fontWeight: 600, color: T.texto, fontFamily: FUENTE.mono, whiteSpace: 'nowrap' }}>{sub.label}</span>
              <span style={{ fontSize: 9.5, color: T.texto3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
                {filas.length} {filas.length === 1 ? 'operación cerrada' : 'operaciones cerradas'}
              </span>
              <span style={{ marginLeft: 'auto', flex: 'none', whiteSpace: 'nowrap', fontSize: 10, fontWeight: 700, fontFamily: FUENTE.mono, color: neto >= 0 ? '#2f7a4f' : T.corto }}>
                {cifraConSigno(neto)} USDT
              </span>
            </div>

            {abierto && (
              <div style={{ background: T.superficie3, borderBottom: `1px solid ${T.borde}` }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,.6fr) repeat(3,minmax(0,1fr)) minmax(0,1fr) minmax(0,1fr) minmax(0,1.1fr)', alignItems: 'center', padding: '3px 12px 3px 46px', fontSize: 9, fontWeight: 600, letterSpacing: '.05em', color: T.texto3, borderBottom: `1px solid ${T.bordeSuave}` }}>
                  <div>LADO</div>
                  <div style={{ textAlign: 'right' }}>Entrada</div>
                  <div style={{ textAlign: 'right' }}>Cierre</div>
                  <div style={{ textAlign: 'right' }}>M. inicial</div>
                  <div style={{ textAlign: 'right' }}>Resultado</div>
                  <div style={{ textAlign: 'center' }}>Cerrado por</div>
                  <div style={{ textAlign: 'right' }}>Fecha · hora</div>
                </div>
                {filas.length === 0 && <div style={{ padding: '8px 12px 8px 46px', fontSize: 10, color: T.texto3 }}>Sin operaciones cerradas.</div>}
                {filas.map((h) => (
                  <div key={h.id} className="pcb-fila-historial" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,.6fr) repeat(3,minmax(0,1fr)) minmax(0,1fr) minmax(0,1fr) minmax(0,1.1fr)', alignItems: 'center', padding: '2px 12px 2px 46px', borderBottom: `1px solid ${T.bordeSuave}` }}>
                    <div>
                      <span style={{ display: 'inline-flex', padding: '0 5px', borderRadius: 4, fontSize: 8, fontWeight: 700, letterSpacing: '.05em', color: '#ffffff', background: h.side === 'long' ? T.largo : T.corto }}>
                        {h.side === 'long' ? 'LONG' : 'SHORT'}
                      </span>
                    </div>
                    <div style={{ textAlign: 'right', fontFamily: FUENTE.mono, fontSize: 9.5, color: T.texto2 }}>{cifra(h.entryPrice)}</div>
                    <div style={{ textAlign: 'right', fontFamily: FUENTE.mono, fontSize: 9.5, color: T.texto2 }}>{cifra(h.exitPrice)}</div>
                    <div style={{ textAlign: 'right', fontFamily: FUENTE.mono, fontSize: 9.5, fontWeight: 600, color: T.texto2 }}>{cifra(h.initialMargin)}</div>
                    <div style={{ textAlign: 'right', fontFamily: FUENTE.mono, fontSize: 10, fontWeight: 700, color: Number.parseFloat(h.pnl) < 0 ? T.corto : '#2f7a4f' }}>{cifraConSigno(h.pnl)}</div>
                    <div style={{ textAlign: 'center', fontSize: 9, fontWeight: 600, color: colorCerradoPor(h.closedBy) }}>{CERRADO_POR[h.closedBy]}</div>
                    <div style={{ textAlign: 'right', fontFamily: FUENTE.mono, fontSize: 9, color: T.texto3 }}>{new Date(h.closedAt).toLocaleString('es-MX', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
