import type { CSSProperties, KeyboardEvent } from 'react';
import { BOTON_PRIMARIO, CAJA_ERROR, FUENTE, SOMBRA, T, VELO } from '@/lib/tokens';
import { usarPanel } from '@/store/panel';

/**
 * Confirmación de una restauración que reemplaza credenciales.
 *
 * --------------------------------------------------------------------------
 * Cuándo aparece, y cuándo no
 * --------------------------------------------------------------------------
 * **Solo cuando hay algo que perder.** En un panel recién estrenado se restaura
 * de un clic desde la pantalla de desbloqueo: no hay almacén que destruir y
 * pedir una contraseña ahí sería ceremonia sin motivo. Esto se abre cuando ya
 * existe un `vault.enc` que el respaldo va a reemplazar.
 *
 * --------------------------------------------------------------------------
 * Por qué la maestra y no la contraseña de paso
 * --------------------------------------------------------------------------
 * La de paso protege operaciones —abrir, cerrar, dar de baja—. Esto no es una
 * operación: sustituye el almacén entero. La maestra es la que demuestra ser
 * dueño de lo que se sustituye, y además es la única que se puede comprobar con
 * el panel bloqueado, que es el estado en el que esto ocurre siempre.
 *
 * Y la que se pide es la de **este** panel, no la del respaldo. Son dos claves
 * distintas y la pantalla tiene que decirlo: la primera autoriza el reemplazo,
 * la segunda hará falta después, para abrir lo restaurado.
 *
 * Va por encima del velo del desbloqueo (z 90) porque se invoca desde allí.
 */

const velo: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 92,
  background: VELO.paso,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 28
};
const tarjeta: CSSProperties = {
  width: 460,
  maxWidth: '100%',
  background: T.superficie,
  borderRadius: 14,
  overflow: 'hidden',
  boxShadow: SOMBRA.paso,
  display: 'flex',
  flexDirection: 'column'
};
const cuerpo: CSSProperties = {
  padding: '18px 24px 22px',
  display: 'flex',
  flexDirection: 'column',
  gap: 14
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

/** «13/09/2026 14:25», o vacío si el respaldo no traía fecha legible. */
const cuando = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function DialogoRestaurarRespaldo() {
  const restauracion = usarPanel((s) => s.restauracion);
  const maestra = usarPanel((s) => s.maestraRestauracion);
  const error = usarPanel((s) => s.errorRestauracion);
  const restaurando = usarPanel((s) => s.restaurando);
  const escribir = usarPanel((s) => s.escribirMaestraRestauracion);
  const confirmar = usarPanel((s) => s.confirmarRestauracion);
  const cancelar = usarPanel((s) => s.cancelarRestauracion);

  if (restauracion === null) return null;

  const alPulsarTecla = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') void confirmar();
  };

  const fecha = cuando(restauracion.creadoEn);
  const cuantas =
    restauracion.cuentas === null
      ? ''
      : `${restauracion.cuentas} ${restauracion.cuentas === 1 ? 'subcuenta' : 'subcuentas'}`;

  return (
    <div style={velo}>
      <div style={tarjeta}>
        <div
          style={{
            flex: 'none',
            padding: '16px 24px',
            background: T.marca,
            color: '#ffffff',
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
              color: '#ffb3b3',
              fontFamily: FUENTE.mono,
              whiteSpace: 'nowrap'
            }}
          >
            RESTAURAR · SE REEMPLAZAN LAS CREDENCIALES DE ESTE PANEL
          </span>
          <span style={{ fontSize: 17, fontWeight: 600 }}>
            {restauracion.desdeArchivo
              ? 'Elegir un archivo de respaldo'
              : restauracion.nombre || 'Respaldo encontrado'}
          </span>
          {!restauracion.desdeArchivo && (fecha !== '' || cuantas !== '') && (
            <span style={{ fontSize: 12, color: '#c8e4f5' }}>
              {[fecha, cuantas].filter((s) => s !== '').join(' · ')}
            </span>
          )}
        </div>

        <div style={cuerpo}>
          <div style={{ fontSize: 12.5, lineHeight: 1.5, color: T.texto2 }}>
            {restauracion.desdeArchivo ? (
              <>
                Se le pedirá el archivo de respaldo y este panel pasará a tener las subcuentas que
                contenga. Las que tiene ahora dejarán de estar registradas.
              </>
            ) : (
              <>
                Este panel pasará a tener{' '}
                <strong style={{ color: T.texto }}>
                  {cuantas || 'las subcuentas del respaldo'}
                </strong>
                . Las que tiene ahora dejarán de estar registradas.
              </>
            )}
          </div>

          {/*
           * Lo que NO se pierde, dicho aquí y no después.
           *
           * Es la duda de cualquiera antes de pulsar, y la respuesta es lo que
           * permite que este botón exista: el almacén anterior no se borra.
           */}
          <div style={{ fontSize: 12, lineHeight: 1.5, color: T.texto3 }}>
            El almacén actual no se borra: se guarda al lado como{' '}
            <code style={{ fontFamily: FUENTE.mono, fontSize: 11.5 }}>vault.enc.reemplazado-…</code>
            , en la carpeta de datos del panel. No se toca nada en Bitget.
          </div>

          <label
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 7,
              fontSize: 11.5,
              fontWeight: 600,
              letterSpacing: '.06em',
              color: T.texto2,
              alignItems: 'center'
            }}
          >
            CONTRASEÑA MAESTRA DE ESTE PANEL
            <input
              className="pcb-campo"
              type="password"
              placeholder="••••••••"
              value={maestra}
              onChange={(e) => escribir(e.target.value)}
              onKeyDown={alPulsarTecla}
              autoComplete="off"
              autoFocus
              style={{
                width: 240,
                padding: 12,
                borderRadius: 10,
                border: `1.5px solid ${T.bordeFuerte}`,
                fontSize: 16,
                fontWeight: 500,
                letterSpacing: '.18em',
                textAlign: 'center',
                fontFamily: FUENTE.mono,
                background: T.campoFondo,
                color: T.campoTexto,
                outline: 'none'
              }}
            />
          </label>
          <span style={{ fontSize: 11.5, lineHeight: 1.45, color: T.texto3, textAlign: 'center' }}>
            La de desbloquear el panel, no la de paso.
          </span>

          {error !== '' && <div style={cajaError}>{error}</div>}

          {/* Lo que pasará después, para que nadie se quede a medias. */}
          <div style={{ fontSize: 11.5, lineHeight: 1.45, color: T.texto3 }}>
            Después tendrá que desbloquear con la contraseña maestra del respaldo, que puede ser
            otra. Esa contraseña no está dentro del archivo.
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="pcb-boton-claro"
              onClick={cancelar}
              style={{
                flex: 1,
                padding: '11px 15px',
                borderRadius: 9,
                fontSize: 13,
                fontWeight: 500,
                cursor: 'pointer',
                border: `1px solid ${T.bordeFuerte}`,
                background: T.superficie,
                color: T.texto
              }}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="pcb-boton-oscuro"
              disabled={restaurando}
              onClick={() => void confirmar()}
              style={{
                flex: 1.4,
                padding: '11px 15px',
                borderRadius: 9,
                fontSize: 13,
                fontWeight: 600,
                cursor: restaurando ? 'wait' : 'pointer',
                opacity: restaurando ? 0.55 : 1,
                border: `1px solid ${BOTON_PRIMARIO.borde}`,
                background: BOTON_PRIMARIO.fondo,
                color: BOTON_PRIMARIO.texto
              }}
            >
              {restaurando ? 'Restaurando…' : 'Restaurar y reemplazar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
