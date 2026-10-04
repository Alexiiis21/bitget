import type { CSSProperties, KeyboardEvent } from 'react';
import { BOTON_PRIMARIO, CAJA_ERROR, FUENTE, SOMBRA, T, VELO } from '@/lib/tokens';
import { usarPanel } from '@/store/panel';

/**
 * Confirmación de la baja de una API key.
 *
 * --------------------------------------------------------------------------
 * Por qué esto pide contraseña y «Probar» no
 * --------------------------------------------------------------------------
 * Lo pidió el cliente el 31/08/2026. Dar de baja una credencial saca la
 * subcuenta del panel y borra del almacén cifrado lo único que sirve para
 * firmar por ella: no se deshace pulsando otra vez —hay que volver a Bitget,
 * generar otra API Key y teclear tres claves de 64 caracteres—. Es la misma
 * clase de acto que abrir y cerrar posiciones, y por eso pide la misma clave
 * (ver `PIDE_PASO`). Probar una credencial, en cambio, no cambia nada.
 *
 * El diálogo es lo que el operador ve; el freno de verdad está en el proceso
 * principal, que rechaza la baja sin la clave correcta. Aquí no se comprueba
 * nada por separado: lo tecleado viaja **con** la baja, de modo que no hay
 * rendija entre comprobar y borrar.
 */

const velo: CSSProperties = { position: 'fixed', inset: 0, zIndex: 88, background: VELO.paso, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 28 };
const tarjeta: CSSProperties = { width: 460, maxWidth: '100%', background: T.superficie, borderRadius: 14, overflow: 'hidden', boxShadow: SOMBRA.paso, display: 'flex', flexDirection: 'column' };
const cuerpo: CSSProperties = { padding: '18px 24px 22px', display: 'flex', flexDirection: 'column', gap: 14 };
const cajaError: CSSProperties = { padding: '10px 12px', borderRadius: 9, border: `1px solid ${CAJA_ERROR.borde}`, borderLeft: `4px solid ${CAJA_ERROR.acento}`, background: CAJA_ERROR.fondo, fontSize: 12, lineHeight: 1.45, color: CAJA_ERROR.texto };

export function DialogoBajaApi() {
  const baja = usarPanel((s) => s.bajaApi);
  const pin = usarPanel((s) => s.pinBaja);
  const error = usarPanel((s) => s.errorBaja);
  const ocupado = usarPanel((s) => s.ocupado);
  const escribirPinBaja = usarPanel((s) => s.escribirPinBaja);
  const confirmarBajaApi = usarPanel((s) => s.confirmarBajaApi);
  const cancelarBajaApi = usarPanel((s) => s.cancelarBajaApi);

  if (baja === null) return null;

  const alPulsarTecla = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') void confirmarBajaApi();
  };

  return (
    <div style={velo}>
      <div style={tarjeta}>
        <div style={{ flex: 'none', padding: '16px 24px', background: T.marca, color: '#ffffff', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.14em', color: '#ffb3b3', fontFamily: FUENTE.mono, whiteSpace: 'nowrap' }}>
            BAJA DE API KEY · NO SE PUEDE DESHACER
          </span>
          <span style={{ fontSize: 18, fontWeight: 600 }}>{baja.etiqueta}</span>
          <span style={{ fontSize: 12, color: '#c8e4f5' }}>Cuenta {baja.cuenta}</span>
        </div>

        <div style={cuerpo}>
          <div style={{ fontSize: 12.5, lineHeight: 1.5, color: T.texto2 }}>
            Se borrará la credencial cifrada de <strong style={{ color: T.texto }}>{baja.etiqueta}</strong> y
            su casilla quedará libre. El panel dejará de poder operar esa subcuenta; para volver a usarla hay
            que dar de alta una API Key nueva desde Bitget.
          </div>
          {/*
            * Lo que la baja no toca, dicho aquí y no después.
            *
            * Es la duda que tiene cualquiera antes de pulsar: esto es el registro
            * de este panel, no la cuenta de Bitget. Las posiciones que esa
            * subcuenta tenga abiertas siguen abiertas en el exchange —lo que se
            * pierde es la forma de cerrarlas desde aquí—.
            */}
          <div style={{ fontSize: 12, lineHeight: 1.5, color: T.texto3 }}>
            No se cierra nada en Bitget: si esa subcuenta tiene posiciones abiertas, seguirán abiertas y este
            panel ya no podrá tocarlas.
          </div>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 7, fontSize: 11.5, fontWeight: 600, letterSpacing: '.06em', color: T.texto2, alignItems: 'center' }}>
            CONTRASEÑA DE PASO
            <input
              className="pcb-campo"
              type="password"
              placeholder="•••"
              value={pin}
              onChange={(e) => escribirPinBaja(e.target.value)}
              onKeyDown={alPulsarTecla}
              autoComplete="off"
              autoFocus
              disabled={!baja.hayPaso}
              style={{ width: 210, padding: 12, borderRadius: 10, border: `1.5px solid ${T.bordeFuerte}`, fontSize: 20, fontWeight: 500, letterSpacing: '.2em', textAlign: 'center', fontFamily: FUENTE.mono, background: T.campoFondo, color: T.campoTexto, outline: 'none', opacity: baja.hayPaso ? 1 : 0.55 }}
            />
          </label>
          <span style={{ fontSize: 11.5, lineHeight: 1.45, color: T.texto3, textAlign: 'center' }}>
            La misma que pide abrir posiciones.
          </span>

          {error !== '' && <div style={cajaError}>{error}</div>}

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="pcb-boton-claro"
              onClick={cancelarBajaApi}
              style={{ flex: 1, padding: '11px 15px', borderRadius: 9, fontSize: 13, fontWeight: 500, cursor: 'pointer', border: `1px solid ${T.bordeFuerte}`, background: T.superficie, color: T.texto }}
            >
              Cancelar
            </button>
            {/*
              * Sin contraseña de paso configurada el botón se apaga y el motivo
              * está en el recuadro de arriba. Se deja a la vista en lugar de
              * esconderlo: un botón que desaparece se lee como un fallo de la
              * pantalla.
              */}
            <button
              type="button"
              className="pcb-boton-oscuro"
              disabled={ocupado || !baja.hayPaso}
              onClick={() => void confirmarBajaApi()}
              style={{ flex: 1.4, padding: '11px 15px', borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: !baja.hayPaso ? 'not-allowed' : ocupado ? 'wait' : 'pointer', opacity: ocupado || !baja.hayPaso ? 0.55 : 1, border: `1px solid ${BOTON_PRIMARIO.borde}`, background: BOTON_PRIMARIO.fondo, color: BOTON_PRIMARIO.texto }}
            >
              {ocupado ? 'Dando de baja…' : 'Eliminar API key'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
