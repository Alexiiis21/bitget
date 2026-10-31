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
 * Recuperar las credenciales al cambiar de versión
 * --------------------------------------------------------------------------
 * El binario es portable y guarda sus datos junto al `.exe`. Al recibir una
 * versión nueva y abrirla desde otra carpeta —Descargas, el escritorio—, el
 * panel no encuentra la carpeta anterior y arranca en blanco. Pasó el
 * 05/09/2026 y la conclusión del operador fue la peor posible: «no se pasaron
 * las API keys». No se habían perdido; seguían donde estaban.
 *
 * Hay dos salidas, y el orden en que se ofrecen es el diseño:
 *
 *  1. **El respaldo, si lo encuentra solo.** Un `.pcbak` en Documentos, que el
 *     panel busca al arrancar. Si está, la pantalla lo dice con su fecha y su
 *     número de subcuentas y ofrece **un botón**. Sin navegar carpetas, sin
 *     escribir nada: es el caso que se quiere que ocurra siempre.
 *  2. **La carpeta anterior**, lo que ya existía. Queda como salida secundaria
 *     para quien nunca llegó a respaldar.
 *
 * La oferta de restaurar se enseña **también con un almacén ya creado**, y eso
 * es deliberado aunque parezca una invitación a destruirlo: es exactamente
 * donde se encuentra quien abrió el `.exe` nuevo, se inventó una contraseña y
 * solo entonces se dio cuenta. Esconder la salida ahí sería repetir el fracaso
 * del 05/09/2026 con otra forma. La puerta no es esconder el botón, es el
 * diálogo de confirmación con la maestra —y lo que se reemplaza se aparta, no
 * se borra—.
 *
 * El de importar por carpeta sí sigue siendo solo del primer arranque: el
 * proceso principal rechaza esa importación con un vault ya creado, y un botón
 * que solo puede dar error no debe estar en pantalla.
 */

const fondo: CSSProperties = { position: 'fixed', inset: 0, zIndex: 90, background: VELO.login, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 28 };
const tarjeta: CSSProperties = { width: 420, maxWidth: '100%', background: T.superficie, borderRadius: 16, overflow: 'hidden', boxShadow: SOMBRA.login };
const botonSecundario = (apagado: boolean): CSSProperties => ({ flex: '1 1 auto', padding: '9px 12px', borderRadius: 9, fontSize: 12.5, fontWeight: 600, cursor: apagado ? 'default' : 'pointer', border: `1px solid ${T.bordeFuerte}`, background: T.superficie, color: T.texto, opacity: apagado ? 0.6 : 1 });

/** «13/09/2026 a las 14:25». Vacío si el respaldo no traía fecha legible. */
const cuando = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} a las ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const cuantas = (n: number | null): string => (n === null ? '' : ` con ${n} ${n === 1 ? 'subcuenta' : 'subcuentas'}`);

/**
 * `2:59`: la espera que corre delante del operador.
 *
 * Aquí no vale el «3 minutos» de `textoEspera` —que es el de los mensajes, y se
 * queda quieto—: lo que hace llevadera una espera es verla bajar. Se redondea
 * hacia arriba para que el reloj no llegue a cero un segundo antes de que el
 * proceso principal admita el intento.
 */
const cuentaAtras = (ms: number): string => {
  const total = Math.ceil(ms / 1_000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

export function PantallaDesbloqueo() {
  const numeroPanel = usarPanel((s) => s.numeroPanel);
  const contrasena = usarPanel((s) => s.contrasena);
  const error = usarPanel((s) => s.errorContrasena);
  const escribir = usarPanel((s) => s.escribirContrasena);
  const desbloquear = usarPanel((s) => s.desbloquear);
  const respaldo = usarPanel((s) => s.respaldoDetectado);
  const buscarRespaldo = usarPanel((s) => s.buscarRespaldo);
  const pedirRestauracion = usarPanel((s) => s.pedirRestauracion);
  const restaurando = usarPanel((s) => s.restaurando);
  const avisoRestauracion = usarPanel((s) => s.avisoRestauracion);
  const esperaMs = usarPanel((s) => s.esperaMaestraMs);
  /*
   * Ver la contraseña antes de enviarla. Cada fallo alarga la espera del freno,
   * y un error de tecleo —Bloq Mayús, la «ñ», un espacio— es la causa más
   * común; poder leer lo escrito evita gastar un intento en él. Se vuelve a
   * ocultar al desbloquear, porque el componente desaparece.
   */
  const [verContrasena, fijarVerContrasena] = useState(false);
  const [mayusculas, fijarMayusculas] = useState(false);

  /*
   * Con la espera en curso no se puede intentar, y el botón lo dice en vez de
   * dejar pulsar para recibir una negativa. El freno de verdad está en el
   * proceso principal —ver `security/freno-maestra.ts`—: esto es lo que evita
   * que el operador gaste intentos sin saberlo, no lo que impide gastarlos.
   */
  const frenado = esperaMs > 0;

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
    /*
     * Se sondea siempre, no solo en el primer arranque: con un almacén ya
     * creado la oferta se enseña apagada, pero se enseña. Ver la cabecera.
     */
    void buscarRespaldo();
    return () => {
      vivo = false;
    };
  }, [buscarRespaldo]);

  /*
   * Tras restaurar con éxito ya no es un primer arranque: hay almacén, y lo que
   * toca es desbloquearlo. Se deriva en vez de guardarlo en otro estado —el
   * dato ya está en `avisoRestauracion` y duplicarlo solo daría dos versiones
   * de la verdad que se pueden desincronizar—.
   */
  const restaurado = avisoRestauracion?.ok === true;
  const sinAlmacen = primerArranque === true && !restaurado;
  const conAlmacen = primerArranque === false || restaurado;
  const ofrecible = respaldo !== null && !respaldo.tooNew;

  const alPulsarTecla = (e: KeyboardEvent<HTMLInputElement>) => {
    fijarMayusculas(e.getModifierState('CapsLock'));
    if (e.key === 'Enter' && !frenado) void desbloquear();
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
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="pcb-campo"
                type={verContrasena ? 'text' : 'password'}
                placeholder="••••••••"
                value={contrasena}
                onChange={(e) => escribir(e.target.value)}
                onKeyDown={alPulsarTecla}
                onKeyUp={(e) => fijarMayusculas(e.getModifierState('CapsLock'))}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                style={{ flex: 1, minWidth: 0, padding: '12px 13px', borderRadius: 9, border: `1px solid ${T.bordeFuerte}`, fontSize: 15, fontWeight: 500, letterSpacing: verContrasena ? '.04em' : '.18em', fontFamily: verContrasena ? FUENTE.mono : undefined, background: T.campoFondo, color: T.campoTexto, outline: 'none' }}
              />
              <button
                type="button"
                className="pcb-boton-claro"
                onClick={() => fijarVerContrasena((v) => !v)}
                aria-pressed={verContrasena}
                aria-label={verContrasena ? 'Ocultar la contraseña' : 'Ver la contraseña'}
                title={verContrasena ? 'Ocultar la contraseña' : 'Ver la contraseña'}
                style={{ flex: 'none', padding: '0 14px', borderRadius: 9, border: `1px solid ${T.bordeFuerte}`, background: T.superficie, color: T.texto, fontSize: 12.5, fontWeight: 600, letterSpacing: 0, cursor: 'pointer' }}
              >
                {verContrasena ? 'Ocultar' : 'Ver'}
              </button>
            </div>
            {mayusculas && (
              <span style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: 0, color: CAJA_ERROR.texto }}>
                Bloq Mayús está activado.
              </span>
            )}
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

          {avisoRestauracion !== null && (
            <div style={{ padding: '10px 12px', borderRadius: 9, fontSize: 12, lineHeight: 1.5, border: `1px solid ${avisoRestauracion.ok ? T.borde : CAJA_ERROR.borde}`, background: avisoRestauracion.ok ? T.superficie2 : CAJA_ERROR.fondo, color: avisoRestauracion.ok ? T.texto2 : CAJA_ERROR.texto }}>
              {avisoRestauracion.texto}
            </div>
          )}

          {/*
            * La oferta principal: el respaldo que el panel encontró solo.
            *
            * Va **encima** del botón de desbloquear y solo sin almacén, porque
            * ahí es la acción que el operador necesita: sin credenciales,
            * desbloquear solo crea un almacén vacío. Un clic y listo, sin
            * diálogo: no hay nada que destruir.
            */}
          {sinAlmacen && ofrecible && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 13px', borderRadius: 9, border: `1px solid ${T.bordeFuerte}`, background: T.superficie2 }}>
              <span style={{ fontSize: 12.5, lineHeight: 1.5, color: T.texto, fontWeight: 600 }}>
                Encontramos un respaldo{respaldo.createdAt === '' ? '' : ` del ${cuando(respaldo.createdAt)}`}
                {cuantas(respaldo.accounts)}.
              </span>
              <button
                type="button"
                className="pcb-boton-oscuro"
                onClick={() => void pedirRestauracion(false)}
                disabled={restaurando}
                style={{ padding: '11px 16px', borderRadius: 9, fontSize: 13.5, fontWeight: 600, cursor: restaurando ? 'default' : 'pointer', border: `1px solid ${BOTON_PRIMARIO.borde}`, background: BOTON_PRIMARIO.fondo, color: BOTON_PRIMARIO.texto, opacity: restaurando ? 0.6 : 1 }}
              >
                {restaurando ? 'Restaurando…' : 'Restaurar mis cuentas'}
              </button>
              <span style={{ fontSize: 11.5, lineHeight: 1.45, color: T.texto3 }}>
                Necesitará la contraseña maestra que usaba en ese panel: no viaja dentro del respaldo.
              </span>
            </div>
          )}

          {/* Un botón que solo puede dar error no debe estar en pantalla: se dice y ya. */}
          {respaldo !== null && respaldo.tooNew && (
            <div style={{ padding: '10px 12px', borderRadius: 9, fontSize: 11.5, lineHeight: 1.5, border: `1px solid ${T.borde}`, background: T.superficie2, color: T.texto2 }}>
              Hay un respaldo en Documentos, pero lo hizo una versión más nueva del panel
              {respaldo.appVersion === '' ? '' : ` (${respaldo.appVersion})`}. Actualice el panel antes de restaurarlo.
            </div>
          )}

          <button
            type="button"
            className="pcb-boton-oscuro"
            onClick={() => void desbloquear()}
            disabled={frenado}
            style={{ padding: '12px 16px', borderRadius: 9, fontSize: 14, fontWeight: 600, cursor: frenado ? 'not-allowed' : 'pointer', border: `1px solid ${BOTON_PRIMARIO.borde}`, background: BOTON_PRIMARIO.fondo, color: BOTON_PRIMARIO.texto, opacity: frenado ? 0.55 : 1 }}
          >
            {frenado ? `Espere ${cuentaAtras(esperaMs)}` : 'Desbloquear panel'}
          </button>

          {/*
            * Por qué se explica y no solo se apaga el botón
            * ------------------------------------------------------------------
            * Un botón apagado con un reloj al lado no dice **por qué**, y lo que
            * el operador necesita saber es que su contraseña puede estar bien y
            * que no hay nada que arreglar: solo esperar. Sin esta línea, la
            * conclusión natural es que el panel se ha estropeado o que le han
            * bloqueado las credenciales.
            */}
          {frenado && (
            <div
              role="status"
              style={{ padding: '10px 12px', borderRadius: 9, fontSize: 11.5, lineHeight: 1.5, border: `1px solid ${T.borde}`, background: T.superficie2, color: T.texto2 }}
            >
              Demasiados intentos seguidos con la contraseña maestra. Vuelva a intentarlo en{' '}
              {cuentaAtras(esperaMs)}; la espera crece con cada fallo y se borra en cuanto acierte.
              No hay nada que reparar, y cerrar el panel no la adelanta.
            </div>
          )}

          {/*
            * Las salidas secundarias. Ver la cabecera de este archivo.
            *
            * Van debajo del botón principal y sin color de acción: lo normal es
            * escribir la contraseña, y esto es para quien acaba de cambiar de
            * versión y ve el panel vacío.
            *
            * «Buscar un archivo» se enseña también con un almacén ya creado; la
            * de importar por carpeta no, porque el proceso principal la
            * rechazaría.
            */}
          {(sinAlmacen || respaldo !== null) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7, paddingTop: 4, borderTop: `1px solid ${T.bordeSuave}` }}>
              {sinAlmacen && respaldo === null && (
                <span style={{ fontSize: 11.5, lineHeight: 1.5, color: T.texto3 }}>
                  ¿Viene de una versión anterior y no ve sus API keys? No se han perdido: están en la
                  carpeta de datos que hay junto al panel antiguo, o en un respaldo si llegó a hacerlo.
                </span>
              )}

              {/*
                * Con almacén ya creado la oferta se enseña apagada, pero se
                * enseña: es donde está quien abrió el .exe nuevo y se inventó
                * una contraseña antes de darse cuenta. La puerta es el diálogo.
                */}
              {conAlmacen && ofrecible && (
                <span style={{ fontSize: 11.5, lineHeight: 1.5, color: T.texto3 }}>
                  Hay un respaldo{respaldo.createdAt === '' ? '' : ` del ${cuando(respaldo.createdAt)}`}
                  {cuantas(respaldo.accounts)} en Documentos.
                </span>
              )}

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
                {conAlmacen && ofrecible && (
                  <button
                    type="button"
                    className="pcb-boton-claro"
                    onClick={() => void pedirRestauracion(false)}
                    disabled={restaurando}
                    title="Reemplaza las credenciales de este panel por las del respaldo. El almacén actual no se borra: se aparta."
                    style={botonSecundario(restaurando)}
                  >
                    {restaurando ? 'Restaurando…' : 'Restaurar mis cuentas…'}
                  </button>
                )}

                <button
                  type="button"
                  className="pcb-boton-claro"
                  onClick={() => void pedirRestauracion(true)}
                  disabled={restaurando}
                  title="Elija un archivo .pcbak guardado en otro sitio: un USB, otra carpeta."
                  style={botonSecundario(restaurando)}
                >
                  Buscar un archivo de respaldo…
                </button>

                {sinAlmacen && (
                  <button
                    type="button"
                    className="pcb-boton-claro"
                    onClick={() => void importar()}
                    disabled={importando}
                    title="Copia el almacén cifrado de una instalación anterior. No borra nada de la carpeta de origen."
                    style={botonSecundario(importando)}
                  >
                    {importando ? 'Importando…' : 'Importar desde una carpeta…'}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
