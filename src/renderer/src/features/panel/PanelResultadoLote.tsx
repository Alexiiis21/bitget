import type { BatchFailure } from '@shared/domain/panel-view';
import { T } from '@/lib/tokens';
import { usarPanel } from '@/store/panel';

/**
 * Resultado del último lote enviado.
 *
 * Aparece sobre la matriz de cuentas tras cualquier acción masiva. Distingue
 * **cuatro** desenlaces por casilla, no dos:
 *
 *   correcta        entró.
 *   con error       no entró, y con el motivo exacto que dio Bitget.
 *   omitida         no aplicaba: la casilla no tenía posición de ese lado.
 *   sin confirmar   se envió y no se sabe si entró.
 *
 * El cuarto es el que obliga a separarlos. Contarlo como error invitaría a
 * reintentarlo, y reintentar a ciegas algo que quizá entró es lo único capaz de
 * duplicar una posición. Por eso sale aparte, con su propio aviso, y
 * «reintentar solo las fallidas» **no lo incluye**: ese botón reenvía el mismo
 * plan acotado a lo que falló de verdad, reutilizando sus identificadores de
 * orden, que es lo que hace inofensivo el reintento.
 */
/** Las casillas de un desenlace, con su motivo. Igual para fallos y dudas. */
function Lista({
  casillas,
  punto,
  nombreSub
}: {
  casillas: readonly BatchFailure[];
  punto: string;
  nombreSub: (id: string) => string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {casillas.map((f) => (
        <div key={`${f.subAccountId}-${f.side}`} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10.5, minWidth: 0 }}>
          <span style={{ flex: 'none', width: 5, height: 5, borderRadius: '50%', background: punto, display: 'block' }} />
          <span style={{ flex: 'none', fontWeight: 600, color: T.texto }}>{nombreSub(f.subAccountId)}</span>
          <span style={{ flex: 'none', padding: '0 5px', borderRadius: 4, fontSize: 8.5, fontWeight: 700, color: '#ffffff', background: f.side === 'long' ? T.largo : T.corto }}>
            {f.side === 'long' ? 'LONG' : 'SHORT'}
          </span>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: T.texto2 }}>{f.reason}</span>
        </div>
      ))}
    </div>
  );
}

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
          {batch.undetermined.length > 0 && ` · ${batch.undetermined.length} sin confirmar`}
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

      {batch.failures.length > 0 && <Lista casillas={batch.failures} punto="#e03131" nombreSub={nombreSub} />}

      {batch.undetermined.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.08em', color: '#b7791f' }}>
            SIN CONFIRMAR · COMPRUÉBELAS EN BITGET ANTES DE REPETIR
          </span>
          <Lista casillas={batch.undetermined} punto="#d9a441" nombreSub={nombreSub} />
        </div>
      )}
    </div>
  );
}
