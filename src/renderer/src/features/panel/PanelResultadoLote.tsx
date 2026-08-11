import { T } from '@/lib/tokens';
import { usarPanel } from '@/store/panel';

/**
 * Resultado del último lote enviado.
 *
 * Aparece sobre la matriz de cuentas tras cualquier acción masiva. Distingue
 * tres desenlaces por casilla: correcta, con error (con el motivo exacto que
 * dio Bitget) y omitida (la casilla no tenía posición de ese lado, así que
 * la acción no aplicaba). «Reintentar solo las fallidas» reconstruye el
 * mismo lote acotado a los objetivos que fallaron.
 */
export function PanelResultadoLote() {
  const batch = usarPanel((s) => s.batch);
  const reintentarFallidas = usarPanel((s) => s.reintentarFallidas);
  const cerrarLote = usarPanel((s) => s.cerrarLote);
  const cuentas = usarPanel((s) => s.cuentas);

  if (!batch) return null;

  const nombreSub = (subAccountId: string): string => {
    for (const cuenta of cuentas) {
      const sub = cuenta.subAccounts.find((s) => s.id === subAccountId);
      if (sub) return `${sub.label} · ${cuenta.name.replace('Cuenta principal - ', '')}`;
    }
    return subAccountId;
  };

  const acento = batch.failures.length > 0 ? '#e03131' : T.marcaRelleno;

  return (
    <div style={{ flex: 'none', display: 'flex', flexDirection: 'column', gap: 7, padding: '9px 12px', background: T.superficie2, borderBottom: `1px solid ${T.bordeFuerte}`, borderLeft: `5px solid ${acento}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: T.texto, whiteSpace: 'nowrap' }}>Resultado del lote · {batch.label}</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: T.texto2, whiteSpace: 'nowrap' }}>
          {batch.ok} correctas · {batch.failures.length} con error · {batch.skipped} omitidas
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {reintentarFallidas && (
            <button
              type="button"
              onClick={() => void reintentarFallidas()}
              style={{ padding: '5px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer', border: `1px solid ${T.marcaRelleno}`, background: T.marcaRelleno, color: '#ffffff' }}
            >
              Reintentar solo las fallidas
            </button>
          )}
          <button
            type="button"
            onClick={cerrarLote}
            style={{ padding: '5px 10px', borderRadius: 6, fontSize: 11, fontWeight: 500, cursor: 'pointer', border: `1px solid ${T.bordeFuerte}`, background: T.superficie, color: T.texto2 }}
          >
            Ocultar
          </button>
        </span>
      </div>

      {batch.failures.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {batch.failures.map((f) => (
            <div key={`${f.subAccountId}-${f.side}`} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10.5, minWidth: 0 }}>
              <span style={{ flex: 'none', width: 5, height: 5, borderRadius: '50%', background: '#e03131', display: 'block' }} />
              <span style={{ flex: 'none', fontWeight: 600, color: T.texto }}>{nombreSub(f.subAccountId)}</span>
              <span style={{ flex: 'none', padding: '0 5px', borderRadius: 4, fontSize: 8.5, fontWeight: 700, color: '#ffffff', background: f.side === 'long' ? T.largo : T.corto }}>
                {f.side === 'long' ? 'LONG' : 'SHORT'}
              </span>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: T.texto2 }}>{f.reason}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
