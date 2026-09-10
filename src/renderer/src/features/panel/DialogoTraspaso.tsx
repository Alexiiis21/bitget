import { useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { TransferPlan, TransferResult } from '@shared/domain/panel-view';
import { cifra } from '@/lib/formato';
import { BOTON_PRIMARIO, CAJA_ERROR, FUENTE, SOMBRA, T, VELO } from '@/lib/tokens';
import { panelService } from '@/services/panel-service';

/**
 * Confirmación de un traspaso. **Es la última pantalla antes de mover dinero.**
 *
 * Enseña lo que exige el contrato —origen, destino, importe y cómo quedan los
 * dos saldos— y pide la contraseña de paso, la misma que la apertura de
 * posiciones.
 *
 * --------------------------------------------------------------------------
 * Lo que este diálogo NO manda
 * --------------------------------------------------------------------------
 * Al ejecutar solo viaja el `id` del plan y la contraseña. Ningún importe, ningún
 * UID. Los números se calcularon en el proceso principal, se enseñaron aquí y
 * son los que se envían: si esta pantalla pudiera mandar una cantidad, podría
 * mandar una distinta de la que el operador acaba de aprobar.
 *
 * --------------------------------------------------------------------------
 * Por qué el saldo del destino puede salir vacío
 * --------------------------------------------------------------------------
 * Cuando la cuenta principal no reporta el saldo de la subcuenta de destino, el
 * dinero llega igual pero no se sabe cómo queda. Se enseña un guion en vez de
 * sumar sobre un cero que nadie ha confirmado.
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
  width: 520,
  maxWidth: '100%',
  background: T.superficie,
  borderRadius: 14,
  overflow: 'hidden',
  boxShadow: SOMBRA.seguridad
};
const cuerpo: CSSProperties = {
  padding: '20px 24px 24px',
  display: 'flex',
  flexDirection: 'column',
  gap: 16
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

/** Una punta del movimiento: de cuánto viene y en cuánto queda. */
function Punta({
  rotulo,
  etiqueta,
  antes,
  despues,
  moneda,
  esMadre
}: {
  rotulo: string;
  etiqueta: string;
  antes: string;
  despues: string;
  moneda: string;
  /** La cuenta principal no se reporta a sí misma: su saldo no se conoce nunca. */
  esMadre: boolean;
}) {
  const conocido = antes !== '' && despues !== '';

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.1em', color: T.texto3 }}>
        {rotulo}
      </span>
      <span
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: T.texto,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}
        title={etiqueta}
      >
        {etiqueta}
      </span>
      {conocido ? (
        <span style={{ ...mono, fontSize: 12.5, color: T.texto2 }}>
          {cifra(antes)} <span style={{ color: T.texto3 }}>→</span>{' '}
          <strong style={{ color: T.texto }}>{cifra(despues)}</strong>{' '}
          <span style={{ fontSize: 11, color: T.texto3 }}>{moneda}</span>
        </span>
      ) : (
        <span
          style={{ ...mono, fontSize: 12.5, color: T.texto3 }}
          title={
            esMadre
              ? 'Bitget no informa del saldo de la propia cuenta principal, solo del de sus subcuentas. El dinero se mueve igual, pero no se puede decir cómo queda.'
              : 'La cuenta principal no informa del saldo de esta subcuenta. El dinero llega igual, pero no se puede decir cómo queda.'
          }
        >
          — saldo desconocido
        </span>
      )}
    </div>
  );
}

export function DialogoTraspaso({
  plan,
  alCerrar,
  alTerminar
}: {
  plan: TransferPlan;
  alCerrar: () => void;
  alTerminar: (r: TransferResult) => void;
}) {
  const [paso, fijarPaso] = useState('');
  const [error, fijarError] = useState<string | null>(null);
  const [enviando, fijarEnviando] = useState(false);

  const enviar = async (): Promise<void> => {
    if (enviando || paso === '') return;
    fijarEnviando(true);
    fijarError(null);
    try {
      const r = await panelService.executeTransfer(plan.id, paso);
      if (!r.ok) {
        /*
         * Una clave equivocada se puede corregir sin rehacer el plan; un rechazo
         * del exchange no, porque el plan ya se consumió al enviarlo.
         */
        if (r.failure === 'paso-incorrecto') {
          fijarError('La contraseña de paso no es correcta.');
          fijarPaso('');
          return;
        }
        alTerminar(r);
        return;
      }
      alTerminar(r);
    } catch (e) {
      fijarError(e instanceof Error ? e.message : 'No se pudo enviar el traspaso.');
    } finally {
      fijarEnviando(false);
    }
  };

  const alPulsar = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') void enviar();
  };

  /*
   * Se mueve todo lo que puede salir: conviene que se vea antes de aprobar.
   *
   * Saliendo de la cuenta principal no hay tope conocido -llega vacío-, así que
   * este aviso no aplica y no se enseña.
   */
  const alMaximo = plan.maxTransferable !== '' && plan.amount === plan.maxTransferable;

  const desdeMadre = plan.from.uid === plan.parentUid;
  const haciaMadre = plan.to.uid === plan.parentUid;
  /* El título dice la dirección: «entre subcuentas» sería falso en dos de los tres casos. */
  const titulo = desdeMadre
    ? 'Traspaso de la cuenta principal'
    : haciaMadre
      ? 'Traspaso a la cuenta principal'
      : 'Traspaso entre subcuentas';

  return (
    <div style={velo}>
      <div style={tarjeta}>
        <div
          style={{
            padding: '20px 24px',
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
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
            <span style={{ ...mono, fontSize: 30, fontWeight: 700, color: T.texto }}>
              {cifra(plan.amount)}
            </span>
            <span style={{ fontSize: 12, fontWeight: 600, color: T.texto2 }}>{plan.currency}</span>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 14,
              padding: '14px 16px',
              borderRadius: 10,
              border: `1px solid ${T.borde}`,
              background: T.superficie2
            }}
          >
            <Punta
              rotulo="DESDE"
              etiqueta={plan.from.label}
              antes={plan.from.before}
              despues={plan.from.after}
              moneda={plan.currency}
              esMadre={desdeMadre}
            />
            <span style={{ flex: 'none', alignSelf: 'center', fontSize: 20, color: T.texto3 }}>
              →
            </span>
            <Punta
              rotulo="HACIA"
              etiqueta={plan.to.label}
              antes={plan.to.before}
              despues={plan.to.after}
              moneda={plan.currency}
              esMadre={haciaMadre}
            />
          </div>

          {alMaximo && (
            <div
              style={{
                padding: '9px 12px',
                borderRadius: 8,
                border: `1px solid ${T.alertaAvisoBorde}`,
                background: T.alertaAvisoFondo,
                color: T.alertaAvisoTexto,
                fontSize: 12,
                lineHeight: 1.45
              }}
            >
              Se mueve <strong>todo</strong> lo que puede salir de {plan.from.label}. La subcuenta
              queda sin saldo transferible.
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
              {enviando ? 'Enviando…' : 'Enviar traspaso'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
