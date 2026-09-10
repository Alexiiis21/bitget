import { useEffect, useRef, type CSSProperties } from 'react';
import type { TransferResult } from '@shared/domain/panel-view';
import { cifra } from '@/lib/formato';
import { BOTON_PRIMARIO, FUENTE, SOMBRA, T, VELO } from '@/lib/tokens';

/**
 * Cómo acabó un traspaso. **No mueve nada: solo cuenta lo que ya pasó.**
 *
 * --------------------------------------------------------------------------
 * Por qué es un diálogo y no el aviso en línea que había
 * --------------------------------------------------------------------------
 * El desenlace salía en una banda sobre la tabla, y la banda tiene un problema
 * que aquí importa más que en otras pantallas: aparece **arriba**, mientras el
 * operador está mirando el formulario de abajo, y la pantalla se recarga en ese
 * mismo momento porque los saldos ya no son los de antes. Un traspaso que falló
 * se podía quedar sin leer, y lo peor: un traspaso `indeterminado` también.
 *
 * Un diálogo obliga a cerrarlo. Es la misma razón por la que la confirmación es
 * un diálogo y no un panel lateral: lo que tiene que ver el operador antes y
 * después de mover dinero no puede depender de dónde tenga puesta la vista.
 *
 * --------------------------------------------------------------------------
 * Tres desenlaces, no dos
 * --------------------------------------------------------------------------
 * `indeterminado` no es un fallo. Se envió, Bitget no confirmó, y el dinero pudo
 * salir. Pintarlo de rojo invitaría a repetirlo, y repetir un traspaso sin
 * confirmar es la única forma de moverlo dos veces: el reenvío llevaría otro
 * `clientOid` y el exchange no lo rechazaría. Por eso lleva su propio color, su
 * propio título y una instrucción distinta —comprobar, no repetir—.
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
  width: 480,
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

const mono: CSSProperties = { fontFamily: FUENTE.mono, fontVariantNumeric: 'tabular-nums' };

/** Lo que cambia entre los tres desenlaces. Lo demás es igual en los tres. */
interface Aspecto {
  rotulo: string;
  titulo: string;
  fondo: string;
  texto: string;
}

const ASPECTO: Record<'exito' | 'sinConfirmar' | 'fallo', Aspecto> = {
  exito: {
    rotulo: 'TRASPASO COMPLETADO',
    titulo: 'El dinero se movió',
    fondo: T.largo,
    texto: '#ffffff'
  },
  sinConfirmar: {
    rotulo: 'SIN CONFIRMAR',
    titulo: 'Se envió y Bitget no contestó',
    fondo: '#f2b705',
    texto: '#3d2a00'
  },
  fallo: {
    rotulo: 'TRASPASO RECHAZADO',
    titulo: 'No se movió nada',
    fondo: T.corto,
    texto: '#ffffff'
  }
};

export function DialogoResultadoTraspaso({
  resultado,
  alCerrar
}: {
  resultado: TransferResult;
  alCerrar: () => void;
}) {
  const boton = useRef<HTMLButtonElement>(null);

  /*
   * El foco va al botón al abrir, y Escape cierra.
   *
   * No es adorno: este diálogo aparece **solo**, sin que nadie lo haya pulsado
   * —lo dispara el final del envío—, así que el foco está donde estuviera antes,
   * probablemente en un campo del formulario que hay detrás.
   */
  useEffect(() => {
    boton.current?.focus();
    const alPulsar = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') alCerrar();
    };
    window.addEventListener('keydown', alPulsar);
    return () => window.removeEventListener('keydown', alPulsar);
  }, [alCerrar]);

  const sinConfirmar = !resultado.ok && resultado.failure === 'indeterminado';
  const aspecto = ASPECTO[resultado.ok ? 'exito' : sinConfirmar ? 'sinConfirmar' : 'fallo'];
  const { plan } = resultado;

  return (
    <div style={velo} role="dialog" aria-modal="true" aria-label={aspecto.titulo}>
      <div style={tarjeta}>
        <div
          style={{
            padding: '18px 24px',
            background: aspecto.fondo,
            color: aspecto.texto,
            display: 'flex',
            flexDirection: 'column',
            gap: 4
          }}
        >
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: '.14em',
              fontFamily: FUENTE.mono,
              opacity: 0.85
            }}
          >
            {aspecto.rotulo}
          </span>
          <span style={{ fontSize: 18, fontWeight: 600 }}>{aspecto.titulo}</span>
        </div>

        <div style={cuerpo}>
          {/*
            * El importe y las dos puntas se enseñan **en los tres casos**.
            *
            * También cuando se rechazó: quien lee «no se movió nada» necesita
            * saber de qué traspaso se le está hablando, sobre todo si acaba de
            * lanzar varios seguidos.
            */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
            <span
              style={{
                ...mono,
                fontSize: 28,
                fontWeight: 700,
                color: resultado.ok ? T.texto : T.texto2
              }}
            >
              {cifra(plan.amount)}
            </span>
            <span style={{ fontSize: 12, fontWeight: 600, color: T.texto2 }}>{plan.currency}</span>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              padding: '12px 14px',
              borderRadius: 10,
              border: `1px solid ${T.borde}`,
              background: T.superficie2,
              fontSize: 13,
              color: T.texto
            }}
          >
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {plan.from.label}
            </span>
            <span style={{ flex: 'none', color: T.texto3, fontSize: 16 }}>→</span>
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {plan.to.label}
            </span>
          </div>

          <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: T.texto2 }}>
            {resultado.ok ? (
              <>
                Los saldos de la pantalla ya se han vuelto a leer. El movimiento queda anotado en{' '}
                <strong>Movimientos</strong>, con su fecha y su referencia.
              </>
            ) : sinConfirmar ? (
              <>
                La orden salió y Bitget no dijo si entró, así que{' '}
                <strong>el dinero pudo moverse</strong>.{' '}
                <strong>Compruebe los saldos antes de repetirlo:</strong> un envío nuevo lleva otro
                identificador y el exchange no lo rechazaría, de modo que repetir a ciegas es la
                única forma de moverlo dos veces. Queda anotado como pendiente.
              </>
            ) : (
              <>{resultado.message ?? 'Bitget rechazó el traspaso.'} No salió el dinero.</>
            )}
          </p>

          {/* La referencia es lo único con lo que se puede reclamar un movimiento. */}
          {resultado.transferId !== null && resultado.transferId !== '' && (
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 8,
                padding: '9px 12px',
                borderRadius: 8,
                background: T.superficie2,
                border: `1px solid ${T.bordeSuave}`,
                fontSize: 11.5,
                color: T.texto3,
                userSelect: 'text'
              }}
            >
              <span style={{ flex: 'none', fontWeight: 600 }}>Referencia de Bitget</span>
              <span style={{ ...mono, minWidth: 0, color: T.texto2, wordBreak: 'break-all' }}>
                {resultado.transferId}
              </span>
            </div>
          )}

          <button
            ref={boton}
            type="button"
            onClick={alCerrar}
            style={{
              alignSelf: 'flex-end',
              padding: '10px 20px',
              borderRadius: 9,
              fontSize: 13.5,
              fontWeight: 600,
              cursor: 'pointer',
              border: `1px solid ${BOTON_PRIMARIO.borde}`,
              background: BOTON_PRIMARIO.fondo,
              color: BOTON_PRIMARIO.texto
            }}
          >
            Entendido
          </button>
        </div>
      </div>
    </div>
  );
}
