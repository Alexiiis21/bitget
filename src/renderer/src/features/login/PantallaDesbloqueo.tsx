import { useEffect, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { BOTON_PRIMARIO, CAJA_ERROR, FUENTE, SOMBRA, T, VELO } from '@/lib/tokens';
import { panelService } from '@/services/panel-service';
import { usarPanel } from '@/store/panel';

/**
 * Pantalla de desbloqueo (`LockScreen`).
 *
 * Lo primero que ve el operador. Mientras está visible, el panel no ha
 * hablado con Bitget: no hay sockets abiertos ni claves en memoria del
 * proceso principal.
 *
 * --------------------------------------------------------------------------
 * «Ya tengo credenciales», y por qué solo en el primer arranque
 * --------------------------------------------------------------------------
 * El binario es portable y guarda sus datos junto al `.exe`. Al recibir una
 * versión nueva y abrirla desde otra carpeta —Descargas, el escritorio—, el
 * panel no encuentra la carpeta anterior y arranca en blanco. Pasó el
 * 05/09/2026 y la conclusión del operador fue la peor posible: «no se pasaron
 * las API keys». No se habían perdido; seguían donde estaban.
 *
 * El botón solo aparece cuando **no hay almacén todavía**. Con uno ya creado
 * sería una invitación a destruirlo, y aunque el proceso principal rechaza esa
 * importación —no sobrescribe nunca un `vault.enc`—, un botón que solo puede
 * dar error no debe estar en pantalla.
 */

const fondo: CSSProperties = { position: 'fixed', inset: 0, zIndex: 90, background: VELO.login, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 28 };
const tarjeta: CSSProperties = { width: 420, maxWidth: '100%', background: T.superficie, borderRadius: 16, overflow: 'hidden', boxShadow: SOMBRA.login };

export function PantallaDesbloqueo() {
  const numeroPanel = usarPanel((s) => s.numeroPanel);
  const contrasena = usarPanel((s) => s.contrasena);
  const error = usarPanel((s) => s.errorContrasena);
  const escribir = usarPanel((s) => s.escribirContrasena);
  const desbloquear = usarPanel((s) => s.desbloquear);

  /** `null` mientras no se sabe: sin saberlo no se enseña ni se esconde el botón. */
  const [primerArranque, fijarPrimerArranque] = useState<boolean | null>(null);
  const [importando, fijarImportando] = useState(false);
  const [aviso, fijarAviso] = useState<{ ok: boolean; texto: string } | null>(null);

  useEffect(() => {
    let vivo = true;
    void panelService.isFirstRun().then(
      (v) => {
        if (vivo) fijarPrimerArranque(v);
      },
      () => {
        if (vivo) fijarPrimerArranque(false);
      }
    );
    return () => {
      vivo = false;
    };
  }, []);

  const alPulsarTecla = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') void desbloquear();
  };

  const importar = async (): Promise<void> => {
    fijarImportando(true);
    fijarAviso(null);
    try {
      const r = await panelService.importCredentials();
      /* Cerrar el selector no es un fallo: no se dice nada. */
      if (r.cancelled) return;

      fijarAviso({
        ok: r.ok,
        texto:
          r.ok && r.accounts !== null
            ? `${r.message} Se importaron ${r.accounts} ${r.accounts === 1 ? 'subcuenta' : 'subcuentas'}.`
            : r.message
      });
      /* Ya no es un primer arranque: hay almacén, y desbloquear lo abrirá. */
      if (r.ok) fijarPrimerArranque(false);
    } catch (e) {
      fijarAviso({
        ok: false,
        texto: e instanceof Error ? e.message : 'No se pudieron importar las credenciales.'
      });
    } finally {
      fijarImportando(false);
    }
  };

  return (
    <div style={fondo}>
      <div style={tarjeta}>
        <div style={{ padding: '26px 26px 20px', display: 'flex', flexDirection: 'column', gap: 6, background: T.marca, color: '#ffffff' }}>
          <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.16em', color: '#8ccdf5', fontFamily: FUENTE.mono, whiteSpace: 'nowrap' }}>
            PCB · PANEL #{numeroPanel}
          </span>
          <span style={{ fontSize: 21, fontWeight: 600 }}>Contraseña maestra</span>
          <span style={{ fontSize: 12.5, lineHeight: 1.5, color: '#a7c8e2' }}>
            El panel permanece bloqueado. Las API keys de las subcuentas están cifradas hasta que se desbloquee.
          </span>
        </div>

        <div style={{ padding: '22px 26px 26px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11.5, fontWeight: 600, letterSpacing: '.06em', color: T.texto3 }}>
            CONTRASEÑA
            <input
              className="pcb-campo"
              type="password"
              placeholder="••••••••"
              value={contrasena}
              onChange={(e) => escribir(e.target.value)}
              onKeyDown={alPulsarTecla}
              autoFocus
              style={{ padding: '12px 13px', borderRadius: 9, border: `1px solid ${T.bordeFuerte}`, fontSize: 15, fontWeight: 500, letterSpacing: '.18em', background: T.campoFondo, color: T.campoTexto, outline: 'none' }}
            />
          </label>

          {error !== '' && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '10px 12px', borderRadius: 9, border: `1px solid ${CAJA_ERROR.borde}`, borderLeft: `4px solid ${CAJA_ERROR.acento}`, background: CAJA_ERROR.fondo, fontSize: 12, lineHeight: 1.45, color: CAJA_ERROR.texto }}>
              {error}
            </div>
          )}

          {aviso !== null && (
            <div style={{ padding: '10px 12px', borderRadius: 9, fontSize: 12, lineHeight: 1.5, border: `1px solid ${aviso.ok ? T.borde : CAJA_ERROR.borde}`, background: aviso.ok ? T.superficie2 : CAJA_ERROR.fondo, color: aviso.ok ? T.texto2 : CAJA_ERROR.texto }}>
              {aviso.texto}
            </div>
          )}

          <button
            type="button"
            className="pcb-boton-oscuro"
            onClick={() => void desbloquear()}
            style={{ padding: '12px 16px', borderRadius: 9, fontSize: 14, fontWeight: 600, cursor: 'pointer', border: `1px solid ${BOTON_PRIMARIO.borde}`, background: BOTON_PRIMARIO.fondo, color: BOTON_PRIMARIO.texto }}
          >
            Desbloquear panel
          </button>

          {/*
            * Solo en el primer arranque. Ver la cabecera de este archivo.
            *
            * Va debajo del botón principal y sin color de acción: lo normal es
            * escribir la contraseña, y esto es la salida para quien acaba de
            * cambiar de versión y ve el panel vacío.
            */}
          {primerArranque === true && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7, paddingTop: 4, borderTop: `1px solid ${T.bordeSuave}` }}>
              <span style={{ fontSize: 11.5, lineHeight: 1.5, color: T.texto3 }}>
                ¿Viene de una versión anterior y no ve sus API keys? No se han perdido: están en la
                carpeta de datos que hay junto al panel antiguo.
              </span>
              <button
                type="button"
                className="pcb-boton-claro"
                onClick={() => void importar()}
                disabled={importando}
                title="Copia el almacén cifrado de una instalación anterior. No borra nada de la carpeta de origen."
                style={{ padding: '10px 14px', borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: importando ? 'default' : 'pointer', border: `1px solid ${T.bordeFuerte}`, background: T.superficie, color: T.texto, opacity: importando ? 0.6 : 1 }}
              >
                {importando ? 'Importando…' : 'Ya tengo credenciales: importarlas'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
