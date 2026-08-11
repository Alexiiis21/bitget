import { ANCHO_MINIMO_MONITOR, FUENTE, REALCE, REJILLA_MONITOR, T } from '@/lib/tokens';
import { cifra, cifraConSigno, restar } from '@/lib/formato';
import { usarPanel } from '@/store/panel';
import { distintivosDe } from './distintivos';
import type { Account, Position } from '@shared/domain/panel-view';

/**
 * Centro de Monitoreo de Posiciones — acordeón por cuenta.
 *
 * Solo lectura. Solo lista subcuentas con posición abierta, en orden de
 * casilla: si la Sub-13 abre, aparece entre la 12 y la 14; si cierra,
 * desaparece sin desplazar al resto. La entrada resaltada es la primera de
 * la cuenta -la más baja en long, la más alta en short-, la referencia
 * contra la que el operador compara el resto.
 */

function primeraEntrada(
  vivas: { sub: Account['subAccounts'][number]; long?: Position | undefined; short?: Position | undefined }[],
  lado: 'long' | 'short'
): number | null {
  const entradas = vivas
    .map((v) => (lado === 'long' ? v.long : v.short))
    .filter((p): p is Position => p !== undefined)
    .map((p) => Number.parseFloat(p.entryPrice));
  if (entradas.length === 0) return null;
  return lado === 'long' ? Math.min(...entradas) : Math.max(...entradas);
}

export function AccordeonMonitor({ cuenta }: { cuenta: Account }) {
  const posiciones = usarPanel((s) => s.posiciones);
  const abrirDetalle = usarPanel((s) => s.abrirDetalle);

  const vivas = cuenta.subAccounts
    .map((sub) => ({
      sub,
      long: posiciones.find((p) => p.subAccountId === sub.id && p.side === 'long' && p.actions.oe),
      short: posiciones.find((p) => p.subAccountId === sub.id && p.side === 'short' && p.actions.oe)
    }))
    .filter((v) => v.long || v.short);

  if (vivas.length === 0) {
    return <div style={{ padding: '10px 12px', fontSize: 10.5, color: T.texto3 }}>Ninguna subcuenta de esta cuenta tiene posición abierta en este momento.</div>;
  }

  const primeraLong = primeraEntrada(vivas, 'long');
  const primeraShort = primeraEntrada(vivas, 'short');

  return (
    <div>
      <div style={{ display: 'grid', minWidth: ANCHO_MINIMO_MONITOR, gridTemplateColumns: REJILLA_MONITOR, alignItems: 'end', padding: '5px 12px 0', fontSize: 9.5, fontWeight: 600, letterSpacing: '.09em', color: T.texto3 }}>
        <div />
        <div />
        <div style={{ textAlign: 'right', color: T.largo }}>LONG</div>
        <div />
        <div />
        <div style={{ textAlign: 'center', color: T.largo, padding: '0 6px' }}>ESTADO LONG</div>
        <div style={{ textAlign: 'center', fontWeight: 800, color: T.texto, padding: '0 2px', whiteSpace: 'nowrap' }}>DIST. L/S</div>
        <div />
        <div style={{ textAlign: 'right', color: T.corto }}>SHORT</div>
        <div />
        <div />
        <div style={{ textAlign: 'center', color: T.corto, padding: '0 6px' }}>ESTADO SHORT</div>
      </div>
      <div style={{ display: 'grid', minWidth: ANCHO_MINIMO_MONITOR, gridTemplateColumns: REJILLA_MONITOR, alignItems: 'end', padding: '2px 12px 4px', borderBottom: `1px solid ${T.borde}`, fontSize: 9.5, color: T.texto3, letterSpacing: '.04em' }}>
        <div style={{ fontWeight: 600, letterSpacing: '.09em' }}>SUBCUENTA</div>
        <div style={{ textAlign: 'right' }}>Liquidación</div>
        <div style={{ textAlign: 'right' }}>Entrada</div>
        <div style={{ textAlign: 'right', fontWeight: 600 }}>M. inicial</div>
        <div style={{ textAlign: 'right' }}>Take Profit</div>
        <div />
        <div />
        <div style={{ textAlign: 'right' }}>Liquidación</div>
        <div style={{ textAlign: 'right' }}>Entrada</div>
        <div style={{ textAlign: 'right', fontWeight: 600 }}>M. inicial</div>
        <div style={{ textAlign: 'right' }}>Take Profit</div>
        <div />
      </div>

      {vivas.map(({ sub, long, short }) => {
        const hayError = long?.hasError || short?.hasError;
        const punto = hayError ? '#f2b705' : '#2f9e44';
        const distancia = long && short ? restar(short.entryPrice, long.entryPrice) : null;
        const destacadaLong = long !== undefined && Number.parseFloat(long.entryPrice) === primeraLong;
        const destacadaShort = short !== undefined && Number.parseFloat(short.entryPrice) === primeraShort;

        return (
          <div
            key={sub.id}
            className="pcb-fila-monitor"
            onClick={() => abrirDetalle(cuenta.id, sub.id)}
            title="Ver detalle de la subcuenta"
            style={{ display: 'grid', minWidth: ANCHO_MINIMO_MONITOR, gridTemplateColumns: REJILLA_MONITOR, alignItems: 'center', padding: '2px 12px', borderBottom: `1px solid ${T.bordeSuave}`, cursor: 'pointer' }}
          >
            <div style={{ fontSize: 10.5, fontWeight: 600, paddingLeft: 2, display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
              <span style={{ width: 7, height: 7, flex: 'none', borderRadius: '50%', background: punto, display: 'block' }} />
              <span style={{ flex: 'none' }}>{sub.label}</span>
            </div>
            <div style={{ textAlign: 'right', fontFamily: FUENTE.mono, fontSize: 9.5, color: T.texto2 }}>{cifra(long?.liquidationPrice)}</div>
            <div style={{ textAlign: 'right', fontFamily: FUENTE.mono, fontSize: 9.5, color: T.texto2 }}>
              <span style={{ borderRadius: 4, padding: '0 3px', marginRight: -3, fontWeight: destacadaLong ? 700 : 400, color: destacadaLong ? REALCE.largoTexto : T.texto2, background: destacadaLong ? REALCE.largoFondo : 'transparent' }}>
                {cifra(long?.entryPrice)}
              </span>
            </div>
            <div title="Margen inicial acumulado: apertura + reposicionamientos" style={{ textAlign: 'right', fontFamily: FUENTE.mono, fontSize: 9.5, fontWeight: 600, color: T.texto2 }}>
              {long ? cifra(long.initialMarginAccum) : '—'}
            </div>
            <div style={{ textAlign: 'right', fontFamily: FUENTE.mono, fontSize: 9.5, fontWeight: 500, color: T.largo }}>{cifra(long?.takeProfitPrice)}</div>
            <Distintivos posicion={long} etiquetaLado="Long" />
            <div style={{ textAlign: 'center', fontFamily: FUENTE.mono, fontSize: 10, fontWeight: 700, color: T.texto }}>{cifraConSigno(distancia)}</div>
            <div style={{ textAlign: 'right', fontFamily: FUENTE.mono, fontSize: 9.5, color: T.texto2 }}>{cifra(short?.liquidationPrice)}</div>
            <div style={{ textAlign: 'right', fontFamily: FUENTE.mono, fontSize: 9.5, color: T.texto2 }}>
              <span style={{ borderRadius: 4, padding: '0 3px', marginRight: -3, fontWeight: destacadaShort ? 700 : 400, color: destacadaShort ? REALCE.cortoTexto : T.texto2, background: destacadaShort ? REALCE.cortoFondo : 'transparent' }}>
                {cifra(short?.entryPrice)}
              </span>
            </div>
            <div title="Margen inicial acumulado: apertura + reposicionamientos" style={{ textAlign: 'right', fontFamily: FUENTE.mono, fontSize: 9.5, fontWeight: 600, color: T.texto2 }}>
              {short ? cifra(short.initialMarginAccum) : '—'}
            </div>
            <div style={{ textAlign: 'right', fontFamily: FUENTE.mono, fontSize: 9.5, fontWeight: 500, color: T.corto }}>{cifra(short?.takeProfitPrice)}</div>
            <Distintivos posicion={short} etiquetaLado="Short" />
          </div>
        );
      })}
    </div>
  );
}

function Distintivos({ posicion, etiquetaLado }: { posicion: Position | undefined; etiquetaLado: string }) {
  const lista = distintivosDe(posicion, etiquetaLado);
  return (
    <div style={{ display: 'flex', justifyContent: 'center', gap: 3, padding: '0 3px', minWidth: 0, overflow: 'hidden' }}>
      {lista.map((d) => (
        <span key={d.clave} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 0, flex: '0 1 auto' }}>
          <span title={d.pista} style={{ minWidth: 20, height: 13, borderRadius: 4, padding: '0 2px', fontSize: 8, fontWeight: 600, letterSpacing: '.04em', color: '#ffffff', display: 'flex', alignItems: 'center', justifyContent: 'center', background: d.color }}>
            {d.etiqueta}
          </span>
          <span style={{ fontSize: 7, fontWeight: 600, color: T.texto3, fontFamily: FUENTE.mono, lineHeight: 1.1 }}>{d.valor}</span>
        </span>
      ))}
    </div>
  );
}
