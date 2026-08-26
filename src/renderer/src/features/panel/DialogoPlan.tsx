import type { CSSProperties, KeyboardEvent } from 'react';
import { CAJA_ERROR, FUENTE, SOMBRA, T, VELO } from '@/lib/tokens';
import { PIDE_PASO, usarPanel } from '@/store/panel';

/**
 * Lo que se va a enviar, antes de enviarlo.
 *
 * --------------------------------------------------------------------------
 * Este diálogo es el requisito, no un adorno
 * --------------------------------------------------------------------------
 * El contrato promete que el operador aprueba cantidades concretas, no
 * intenciones: no «abrir 100 USDT a 150x», sino «0,0157 BTC en estas 34
 * casillas, y estas 3 no pueden porque les falta saldo». Todo lo que se ve aquí
 * lo calculó el proceso principal con el precio y el saldo de ese momento, y
 * mientras esta pantalla esté abierta **no ha salido ninguna orden**.
 *
 * Las casillas descartadas se enseñan junto a las que sí salen, y a propósito:
 * una subcuenta que no operó y que no aparece en ninguna lista es una subcuenta
 * cuyo estado el operador va a suponer, y suponer es lo que no debe hacer.
 *
 * La contraseña de paso aparece al **abrir y al cerrar**: la primera compromete
 * dinero nuevo y la segunda realiza el resultado, y ninguna de las dos se
 * deshace pulsando otra vez. Las otras cuatro se aprueban solo con el plan a la
 * vista: confirmar devuelve únicamente el identificador del plan, así que no
 * hay forma de que salga algo distinto de lo aprobado. Ver `PIDE_PASO`.
 */

const velo: CSSProperties = { position: 'fixed', inset: 0, zIndex: 85, background: VELO.paso, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 28 };
const tarjeta: CSSProperties = { width: 560, maxWidth: '100%', maxHeight: '88vh', background: T.superficie, borderRadius: 14, overflow: 'hidden', boxShadow: SOMBRA.paso, display: 'flex', flexDirection: 'column' };
const valorMono: CSSProperties = { fontWeight: 600, color: T.texto, fontFamily: FUENTE.mono };
const fila: CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 10, padding: '6px 0', borderBottom: `1px solid ${T.bordeSuave}` };

const LADO: Record<'long' | 'short', string> = { long: 'LONG', short: 'SHORT' };

export function DialogoPlan() {
  const plan = usarPanel((s) => s.plan);
  const enviando = usarPanel((s) => s.enviando);
  const cola = usarPanel((s) => s.cola);
  const pin = usarPanel((s) => s.pinPaso);
  const error = usarPanel((s) => s.errorPaso);
  const escribirPin = usarPanel((s) => s.escribirPin);
  const confirmarPlan = usarPanel((s) => s.confirmarPlan);
  const cancelarPlan = usarPanel((s) => s.cancelarPlan);
  const activos = usarPanel((s) => s.activos);
  const activoId = usarPanel((s) => s.activoId);
  const tp = usarPanel((s) => s.valores.tp);
  const mga = usarPanel((s) => s.valores.mga);
  const modoMargen = usarPanel((s) => s.modoMargen);
  const mercado = usarPanel((s) => s.mercado);

  if (!plan) return null;

  const activo = activos.find((a) => a.id === activoId);
  /*
   * La misma lista que comprueba `confirmarPlan`, no una copia. Duplicarla
   * dejaría abierta la posibilidad de enseñar el campo sin comprobarlo, o de
   * comprobarlo sin enseñarlo —que es no poder confirmar nunca—.
   */
  const pidePaso = PIDE_PASO.has(plan.kind);

  const alPulsarTecla = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') void confirmarPlan();
  };

  return (
    <div style={velo}>
      <div style={tarjeta}>
        <div style={{ flex: 'none', padding: '16px 22px', background: T.marca, color: '#ffffff', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {/*
            * El mercado va en la primera línea que se lee, no escondido en la
            * cabecera del panel: esta es la pantalla donde se aprueba el envío,
            * y «real» aquí significa que lo que se confirma mueve dinero.
            */}
          <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.14em', color: '#8ccdf5', fontFamily: FUENTE.mono, whiteSpace: 'nowrap' }}>
            REVISAR ANTES DE ENVIAR ·{' '}
            <span style={{ color: mercado === 'real' ? '#ffb3b3' : '#8ccdf5' }}>
              {mercado === 'real' ? 'MERCADO REAL' : 'MERCADO SIMULADO'}
            </span>
            {cola.length > 0 ? ` · QUEDAN ${cola.length}` : ''}
          </span>
          <span style={{ fontSize: 18, fontWeight: 600 }}>{plan.title}</span>
          <span style={{ fontSize: 12, color: '#c8e4f5' }}>{plan.summary}</span>
        </div>

        <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '14px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 12.5 }}>
            <span style={{ color: T.texto2 }}>
              Activo <span style={valorMono}>{activo?.label ?? '—'}</span>
            </span>
            {plan.reference !== null && (
              <span style={{ color: T.texto2 }}>
                Precio de referencia <span style={valorMono}>{plan.reference}</span>
              </span>
            )}
            <span style={{ color: T.texto2 }}>
              Casillas <span style={valorMono}>{plan.entries.length}</span>
            </span>
            {/*
              * El Take Profit sale **con esta misma orden** desde el 25/08/2026.
              *
              * Antes no: era un segundo plan con su segunda confirmación, y aquí
              * se rotulaba «se pone aparte». El rótulo decía la verdad y aun así
              * el operador leía el porcentaje dentro de la confirmación de abrir
              * y daba por hecho que salía con ella —lo dijo en la reunión del 25
              * de agosto—, de modo que quedaban posiciones sin protección
              * creyendo que la tenían. Ahora sale de verdad, y el rótulo lo dice.
              */}
            {plan.kind === 'open' && (
              <span
                style={{ color: T.texto2 }}
                title="El Take Profit se coloca con esta misma orden, en cuanto la posición queda abierta. El precio definitivo se calcula con el precio de entrada real de cada posición; el que se enseña en cada casilla es aproximado, calculado con el precio de referencia."
              >
                Take Profit <span style={valorMono}>{tp.trim() === '' ? '—' : `${tp.trim()} %`}</span>
                <span style={{ marginLeft: 6, fontSize: 10.5, color: T.texto3 }}>
                  {tp.trim() === '' ? 'sin Take Profit' : 'sale con esta orden'}
                </span>
              </span>
            )}
            {/*
              * El margen adicional sale con la orden desde el 26/08/2026, por lo
              * mismo que el Take Profit: se escribe en el mismo formulario y en
              * la misma pulsación. En cruzado no se llega hasta aquí —el plan se
              * rechaza antes—, así que si aparece es que se va a agregar.
              */}
            {plan.kind === 'open' && (
              <span
                style={{ color: T.texto2 }}
                title="El margen adicional se agrega a cada posición en cuanto queda abierta. Bitget solo lo admite en margen aislado."
              >
                Margen adicional{' '}
                <span style={valorMono}>{mga.trim() === '' ? '—' : mga.trim()}</span>
                <span style={{ marginLeft: 6, fontSize: 10.5, color: T.texto3 }}>
                  {mga.trim() === '' ? 'no se agrega' : 'sale con esta orden'}
                </span>
              </span>
            )}
            {/*
              * El modo de margen se enseña porque **abrir lo cambia**: viaja
              * dentro de la orden, así que una apertura en aislado deja el activo
              * en aislado. Es un efecto de lo que se está aprobando, no un ajuste
              * previo que el operador pudiera dar por sabido.
              */}
            {plan.kind === 'open' && (
              <span
                style={{ color: T.texto2 }}
                title="El modo viaja dentro de la orden: si el activo está en el otro modo, esta apertura lo cambia en Bitget. En cruzado no se puede agregar margen a una posición."
              >
                Modo <span style={valorMono}>{modoMargen === 'isolated' ? 'AISLADO' : 'CRUZADO'}</span>
              </span>
            )}
          </div>

          <div>
            <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.1em', color: T.texto3 }}>
              SE VA A ENVIAR A {plan.entries.length} {plan.entries.length === 1 ? 'CASILLA' : 'CASILLAS'}
            </span>
            <div style={{ marginTop: 5 }}>
              {plan.entries.map((e) => (
                <div key={`${e.subAccountId}-${e.side}`} style={fila}>
                  <span style={{ flex: 'none', width: 46, fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', color: e.side === 'long' ? T.largo : T.corto }}>
                    {LADO[e.side]}
                  </span>
                  <span style={{ flex: 'none', width: 130, fontSize: 12, fontWeight: 600, color: T.texto, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {e.label}
                  </span>
                  <span style={{ flex: '1 1 auto', minWidth: 0, fontSize: 11.5, fontFamily: FUENTE.mono, color: T.texto2 }}>
                    {e.detail}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {plan.discards.length > 0 && (
            <div>
              <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.1em', color: T.texto3 }}>
                SE QUEDAN FUERA · {plan.discards.length}
              </span>
              <div style={{ marginTop: 5 }}>
                {plan.discards.map((d) => (
                  <div key={`${d.subAccountId}-${d.side}`} style={{ ...fila, opacity: 0.75 }}>
                    <span style={{ flex: 'none', width: 46, fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', color: T.texto3 }}>
                      {LADO[d.side]}
                    </span>
                    <span style={{ flex: 'none', width: 130, fontSize: 12, fontWeight: 600, color: T.texto2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {d.label}
                    </span>
                    <span style={{ flex: '1 1 auto', minWidth: 0, fontSize: 11.5, color: T.texto3 }}>{d.reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {pidePaso && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 7, fontSize: 11.5, fontWeight: 600, letterSpacing: '.06em', color: T.texto2, alignItems: 'center' }}>
              CONTRASEÑA DE PASO
              <input
                className="pcb-campo"
                type="password"
                placeholder="•••"
                value={pin}
                onChange={(e) => escribirPin(e.target.value)}
                onKeyDown={alPulsarTecla}
                autoComplete="off"
                autoFocus
                style={{ width: 210, padding: 12, borderRadius: 10, border: `1.5px solid ${T.bordeFuerte}`, fontSize: 20, fontWeight: 500, letterSpacing: '.2em', textAlign: 'center', fontFamily: FUENTE.mono, background: T.campoFondo, color: T.campoTexto, outline: 'none' }}
              />
            </label>
          )}

          {error !== '' && (
            <div style={{ padding: '10px 12px', borderRadius: 9, border: `1px solid ${CAJA_ERROR.borde}`, borderLeft: `4px solid ${CAJA_ERROR.acento}`, background: CAJA_ERROR.fondo, fontSize: 12, lineHeight: 1.45, color: CAJA_ERROR.texto }}>
              {error}
            </div>
          )}
        </div>

        <div style={{ flex: 'none', display: 'flex', gap: 8, padding: '14px 22px', borderTop: `1px solid ${T.borde}` }}>
          <button
            type="button"
            className="pcb-boton-claro"
            onClick={cancelarPlan}
            style={{ flex: 1, padding: '11px 15px', borderRadius: 9, fontSize: 13, fontWeight: 500, cursor: 'pointer', border: `1px solid ${T.bordeFuerte}`, background: T.superficie, color: T.texto }}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="pcb-boton-acento"
            disabled={enviando}
            onClick={() => void confirmarPlan()}
            style={{ flex: 1.4, padding: '11px 15px', borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: enviando ? 'wait' : 'pointer', opacity: enviando ? 0.6 : 1, border: `1px solid ${T.marcaRelleno}`, background: T.marcaRelleno, color: '#ffffff' }}
          >
            {enviando ? 'Enviando…' : `Confirmar · ${plan.entries.length}`}
          </button>
        </div>
      </div>
    </div>
  );
}
