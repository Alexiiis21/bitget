import { useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { SpreadPlan, SpreadResult } from '@shared/domain/panel-view';
import { cifra } from '@/lib/formato';
import { BOTON_PRIMARIO, CAJA_ERROR, FUENTE, SOMBRA, T, VELO } from '@/lib/tokens';
import { panelService } from '@/services/panel-service';

/**
 * Confirmación de un reparto o una recogida. **Es lo último antes de mover
 * dinero en varias cuentas a la vez.**
 *
 * --------------------------------------------------------------------------
 * Se enseña la lista entera, no un resumen
 * --------------------------------------------------------------------------
 * Un «se reparten 5.000 entre 20 subcuentas» es un resumen que el operador no
 * puede comprobar. Aquí van los veinte movimientos con su importe y su saldo
 * resultante, y también las subcuentas **descartadas** con el motivo: una que se
 * queda fuera en silencio es la que se descubre tarde.
 *
 * Y el total que se enseña es la suma de lo que de verdad va a moverse, no lo
 * que se escribió: si se descartaron subcuentas, el número baja.
 */

const velo: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 80,
  background: VELO.seguridad,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 28
};
const tarjeta: CSSProperties = {
  width: 620,
  maxWidth: '100%',
  maxHeight: '90vh',
  background: T.superficie,
  borderRadius: 14,
  overflow: 'hidden',
  boxShadow: SOMBRA.seguridad,
  display: 'flex',
  flexDirection: 'column'
};
const cuerpo: CSSProperties = {
  padding: '18px 24px 22px',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  overflow: 'auto'
};
const cajaError: CSSProperties = {
  padding: '10px 12px',
  borderRadius: 9,
  border: `1px solid ${CAJA_ERROR.borde}`,
  borderLeft: `4px solid ${CAJA_ERROR.acento}`,
  background: CAJA_ERROR.fondo,
  fontSize: 12,
  lineHeight: 1.45,
  color: CAJA_ERROR.texto
};
const mono: CSSProperties = { fontFamily: FUENTE.mono, fontVariantNumeric: 'tabular-nums' };

export function DialogoReparto({
  plan,
  alCerrar,
  alTerminar
}: {
  plan: SpreadPlan;
  alCerrar: () => void;
  alTerminar: (r: SpreadResult) => void;
}) {
  const [paso, fijarPaso] = useState('');
  const [error, fijarError] = useState<string | null>(null);
  const [enviando, fijarEnviando] = useState(false);

  const enviar = async (): Promise<void> => {
    if (enviando || paso === '') return;
    fijarEnviando(true);
    fijarError(null);
    try {
      const r = await panelService.executeSpread(plan.id, paso);
      if (!r.ok && r.failure === 'paso-incorrecto') {
        fijarError('La contraseña de paso no es correcta.');
        fijarPaso('');
        return;
      }
      alTerminar(r);
    } catch (e) {
      fijarError(e instanceof Error ? e.message : 'No se pudo enviar el reparto.');
    } finally {
      fijarEnviando(false);
    }
  };

  const alPulsar = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') void enviar();
  };

  const esRecogida = plan.kind === 'recogida';
  const titulo = esRecogida ? 'Recoger saldo a la cuenta principal' : 'Repartir saldo';
  const subtitulo = esRecogida
    ? `${plan.moves.length} subcuentas devuelven su saldo`
    : plan.mode === 'igualar'
      ? `${plan.moves.length} subcuentas, igualando saldos`
      : `${plan.moves.length} subcuentas, a partes iguales`;

  return (
    <div style={velo}>
      <div style={tarjeta}>
        <div
          style={{
            flex: 'none',
            padding: '18px 24px',
            background: T.marca,
            color: '#ffffff',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 14
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: '.14em',
                color: '#8ccdf5',
                fontFamily: FUENTE.mono,
                whiteSpace: 'nowrap'
              }}
            >
              REVISAR ANTES DE ENVIAR
            </span>
            <span style={{ fontSize: 18, fontWeight: 600 }}>{titulo}</span>
            <span style={{ fontSize: 12, color: '#95c9ea' }}>{subtitulo}</span>
          </div>
          <button
            type="button"
            className="pcb-boton-barra"
            onClick={alCerrar}
            title="Cancelar: no se envía nada"
            style={{
              flex: 'none',
              width: 28,
              height: 28,
              borderRadius: 8,
              border: '1px solid #ffffff2e',
              background: '#ffffff14',
              color: '#ffffff',
              fontSize: 14,
              cursor: 'pointer'
            }}
          >
            ×
          </button>
        </div>

        <div style={cuerpo}>
          <div
            style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 8 }}
          >
            <span style={{ ...mono, fontSize: 28, fontWeight: 700, color: T.texto }}>
              {cifra(plan.total)}
            </span>
            <span style={{ fontSize: 12, fontWeight: 600, color: T.texto2 }}>{plan.currency}</span>
            <span style={{ fontSize: 12, color: T.texto3 }}>
              en {plan.moves.length} {plan.moves.length === 1 ? 'traspaso' : 'traspasos'}
            </span>
          </div>

          <div style={{ border: `1px solid ${T.borde}`, borderRadius: 9, overflow: 'hidden' }}>
            {plan.moves.map((m) => (
              <div
                key={`${m.fromUid}-${m.toUid}`}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 10,
                  padding: '7px 12px',
                  borderTop: `1px solid ${T.bordeSuave}`,
                  fontSize: 12.5
                }}
              >
                <span
                  style={{
                    flex: '1 1 auto',
                    minWidth: 0,
                    color: T.texto,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {esRecogida ? m.fromLabel : m.toLabel}
                </span>
                <span style={{ ...mono, flex: 'none', fontSize: 11.5, color: T.texto3 }}>
                  {cifra(m.before)} → {cifra(m.after)}
                </span>
                <span
                  style={{
                    ...mono,
                    flex: 'none',
                    width: 96,
                    textAlign: 'right',
                    fontWeight: 600,
                    color: T.texto
                  }}
                >
                  {esRecogida ? '−' : '+'}
                  {cifra(m.amount)}
                </span>
              </div>
            ))}
          </div>

          {plan.skipped.length > 0 && (
            <div
              style={{
                padding: '10px 12px',
                borderRadius: 8,
                border: `1px solid ${T.alertaAvisoBorde}`,
                background: T.alertaAvisoFondo,
                color: T.alertaAvisoTexto,
                fontSize: 12,
                lineHeight: 1.5
              }}
            >
              <strong>
                {plan.skipped.length}{' '}
                {plan.skipped.length === 1
                  ? 'subcuenta se queda fuera'
                  : 'subcuentas se quedan fuera'}
                :
              </strong>
              <ul style={{ margin: '5px 0 0', paddingLeft: 18 }}>
                {plan.skipped.map((d) => (
                  <li key={d.uid}>
                    {d.label} — {d.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {error !== null && <div style={cajaError}>{error}</div>}

          <label
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              fontSize: 11.5,
              fontWeight: 600,
              letterSpacing: '.06em',
              color: T.texto2
            }}
          >
            CONTRASEÑA DE PASO
            <input
              className="pcb-campo"
              type="password"
              autoFocus
              autoComplete="off"
              value={paso}
              onChange={(e) => fijarPaso(e.target.value)}
              onKeyDown={alPulsar}
              style={{
                padding: '11px 13px',
                borderRadius: 9,
                border: `1px solid ${T.bordeFuerte}`,
                fontSize: 19,
                fontWeight: 500,
                letterSpacing: '.3em',
                textAlign: 'center',
                fontFamily: FUENTE.mono,
                background: T.campoFondo,
                color: T.campoTexto,
                outline: 'none'
              }}
            />
          </label>

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={alCerrar}
              disabled={enviando}
              style={{
                padding: '10px 16px',
                borderRadius: 9,
                border: `1px solid ${T.bordeFuerte}`,
                background: T.superficie,
                color: T.texto,
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => void enviar()}
              disabled={enviando || paso === ''}
              style={{
                ...BOTON_PRIMARIO,
                opacity: enviando || paso === '' ? 0.55 : 1,
                cursor: enviando || paso === '' ? 'default' : 'pointer'
              }}
            >
              {enviando ? 'Enviando…' : `Enviar ${plan.moves.length}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
