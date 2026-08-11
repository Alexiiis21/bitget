import { useId, useState, type CSSProperties } from 'react';
import { BOTON_PRIMARIO, DISTINTIVO_API, FUENTE, T } from '@/lib/tokens';
import { usarPanel } from '@/store/panel';
import { EsqueletoFilas, EstadoVacio } from './Esqueleto';
import type { FormularioApiKey } from './tipos';

/**
 * Gestión de API keys de las subcuentas (`ApiKeysModal`).
 *
 * La lista solo muestra la clave enmascarada: el valor completo entra una
 * vez, se cifra en el equipo y no vuelve a salir del proceso principal.
 * RNF-001. Secret Key y Passphrase no se guardan en el formulario después de
 * guardar.
 */

const REJILLA = '150px 80px minmax(150px,1fr) 130px 160px';
const ANCHO_MINIMO = 660;

const recorte: CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const etiquetaCampo: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5, fontSize: 11.5, fontWeight: 600, letterSpacing: '.06em', color: T.texto2 };
const campo: CSSProperties = { padding: '9px 11px', borderRadius: 8, border: `1px solid ${T.bordeFuerte}`, fontSize: 13.5, fontWeight: 500, background: T.campoFondo, color: T.campoTexto, fontFamily: FUENTE.mono, outline: 'none' };
const botonFila: CSSProperties = { padding: '6px 10px', borderRadius: 6, fontSize: 12, fontWeight: 500, cursor: 'pointer', background: T.superficie };

/* El envoltorio lleva el marco; el input de dentro va desnudo. Así el botón de revelar queda dentro del campo. */
const envoltorioSecreto: CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, padding: '0 5px 0 11px', borderRadius: 8, border: `1px solid ${T.bordeFuerte}`, background: T.campoFondo };
const campoDesnudo: CSSProperties = { flex: '1 1 0', minWidth: 0, padding: '9px 0', border: 'none', outline: 'none', background: 'transparent', fontSize: 13.5, fontWeight: 500, color: T.campoTexto, fontFamily: FUENTE.mono };

interface CampoFormulario {
  clave: keyof FormularioApiKey;
  rotulo: string;
  marcador: string;
  secreto?: boolean;
}

const CAMPOS: CampoFormulario[] = [
  { clave: 'subcuenta', rotulo: 'NOMBRE DE LA SUBCUENTA', marcador: 'Sub-12' },
  { clave: 'cuenta', rotulo: 'CUENTA PRINCIPAL', marcador: 'A' },
  { clave: 'apiKey', rotulo: 'API KEY', marcador: 'bg_xxxxxxxxxxxx' },
  { clave: 'secretKey', rotulo: 'SECRET KEY', marcador: '••••••••••••', secreto: true },
  { clave: 'passphrase', rotulo: 'PASSPHRASE', marcador: '••••••••', secreto: true }
];

/**
 * Campo secreto, con botón para revelar lo tecleado.
 *
 * Arranca oculto y se olvida al guardar, porque el formulario entero se vacía.
 * Revelar lo que uno acaba de escribir no contradice RNF-001: esa regla protege
 * las credenciales **ya guardadas**, que solo se muestran enmascaradas y nunca
 * vuelven a cruzar el IPC. Aquí el valor sigue en la pantalla de quien lo
 * escribió, y poder comprobarlo antes de enviarlo evita el alta rechazada por
 * un espacio pegado de más — que con claves de 64 caracteres es el error más
 * común y el más difícil de ver a ciegas.
 */
function CampoSecreto({
  rotulo,
  marcador,
  valor,
  alEscribir
}: {
  rotulo: string;
  marcador: string;
  valor: string;
  alEscribir: (v: string) => void;
}) {
  const [visible, fijarVisible] = useState(false);
  const id = useId();

  return (
    <div style={etiquetaCampo}>
      <label htmlFor={id}>{rotulo}</label>
      <span style={envoltorioSecreto}>
        <input
          id={id}
          className="pcb-campo"
          style={campoDesnudo}
          type={visible ? 'text' : 'password'}
          autoComplete="off"
          spellCheck={false}
          placeholder={marcador}
          value={valor}
          onChange={(e) => alEscribir(e.target.value)}
        />
        <button
          type="button"
          onClick={() => fijarVisible((v) => !v)}
          aria-pressed={visible}
          title={visible ? 'Ocultar el valor' : 'Mostrar el valor para comprobarlo'}
          style={{ flex: 'none', padding: '4px 8px', borderRadius: 5, border: `1px solid ${T.campoBorde}`, background: 'transparent', color: T.campoTexto, fontSize: 10.5, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}
        >
          {visible ? 'Ocultar' : 'Mostrar'}
        </button>
      </span>
    </div>
  );
}

export function PantallaApis() {
  const abierta = usarPanel((s) => s.apisAbierto);
  const apiKeys = usarPanel((s) => s.apiKeys);
  const cerrarApis = usarPanel((s) => s.cerrarApis);
  const formulario = usarPanel((s) => s.formulario);
  const escribirFormulario = usarPanel((s) => s.escribirFormulario);
  const guardarApi = usarPanel((s) => s.guardarApi);
  const probarApi = usarPanel((s) => s.probarApi);
  const eliminarApi = usarPanel((s) => s.eliminarApi);
  const carga = usarPanel((s) => s.cargaApis);
  const motivo = usarPanel((s) => s.motivoApis);
  const refrescarApis = usarPanel((s) => s.refrescarApis);

  if (!abierta) return null;
  const conectadas = apiKeys.filter((a) => a.status === 'ok').length;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 75, background: T.fondo, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '16px 26px', background: T.marca, color: '#ffffff' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.14em', color: '#8ccdf5', fontFamily: FUENTE.mono }}>API</span>
          <span style={{ fontSize: 18, fontWeight: 600 }}>Gestión de API keys · subcuentas</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12, color: '#95c9ea', fontFamily: FUENTE.mono, whiteSpace: 'nowrap' }}>{conectadas} de {apiKeys.length} conectadas</span>
          <button
            type="button"
            className="pcb-boton-barra"
            onClick={cerrarApis}
            title="Volver al panel"
            style={{ padding: '8px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: '1px solid #ffffff2e', background: '#ffffff14', color: '#ffffff', whiteSpace: 'nowrap' }}
          >
            Volver al panel
          </button>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 20, padding: '20px 26px', overflow: 'auto' }}>
        <div style={{ flex: '1 1 620px', minWidth: 0, background: T.superficie, border: `1px solid ${T.bordeFuerte}`, borderRadius: 12, overflow: 'hidden', alignSelf: 'stretch' }}>
          <div style={{ overflowX: 'auto' }}>
            <div style={{ display: 'grid', minWidth: ANCHO_MINIMO, gridTemplateColumns: REJILLA, gap: 12, padding: '12px 18px', borderBottom: `1px solid ${T.borde}`, fontSize: 11, fontWeight: 600, letterSpacing: '.09em', color: T.texto3 }}>
              <div style={{ whiteSpace: 'nowrap' }}>SUBCUENTA</div>
              <div>CUENTA</div>
              <div style={{ whiteSpace: 'nowrap' }}>API KEY</div>
              <div style={{ whiteSpace: 'nowrap' }}>ESTADO</div>
              <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>ACCIONES</div>
            </div>

            {(carga === 'inicial' || carga === 'cargando') && (
              <EsqueletoFilas rejilla={REJILLA} anchoMinimo={ANCHO_MINIMO} />
            )}

            {carga === 'error' && (
              <EstadoVacio
                compacto
                tono="error"
                titulo="No se pudo leer el registro"
                cuerpo="No se ha podido consultar el registro de API keys. Las credenciales guardadas siguen cifradas en el equipo y no se han modificado."
                detalle={motivo}
                accion={{ rotulo: 'Reintentar', alClic: () => void refrescarApis() }}
              />
            )}

            {carga === 'listo' && apiKeys.length === 0 && (
              <EstadoVacio
                compacto
                titulo="Ninguna API key registrada"
                cuerpo="Use el formulario de la derecha para dar de alta la primera subcuenta. Su credencial se prueba contra Bitget antes de guardarse, de modo que aquí solo aparecen claves que funcionan."
              />
            )}

            {apiKeys.map((fila) => {
              const distintivo = DISTINTIVO_API[fila.status];
              return (
                <div key={fila.id} style={{ display: 'grid', minWidth: ANCHO_MINIMO, gridTemplateColumns: REJILLA, gap: 12, alignItems: 'center', padding: '11px 18px', borderBottom: `1px solid ${T.bordeSuave}` }}>
                  <div style={{ ...recorte, fontSize: 13.5, fontWeight: 600, color: T.texto }}>{fila.subAccountLabel}</div>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: T.marcaTexto, fontFamily: FUENTE.mono }}>{fila.accountName}</div>
                  <div style={{ ...recorte, fontSize: 12.5, fontFamily: FUENTE.mono, color: T.texto2 }}>{fila.maskedKey || '— sin credenciales —'}</div>
                  <div style={{ minWidth: 0 }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 9px', borderRadius: 20, fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap', background: distintivo.fondo, color: distintivo.texto }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: distintivo.punto, display: 'block' }} />
                      {distintivo.etiqueta}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, minWidth: 0 }}>
                    <button type="button" className="pcb-boton-claro" onClick={() => void probarApi(fila.id)} style={{ ...botonFila, border: `1px solid ${T.bordeFuerte}`, color: T.texto }}>
                      Probar
                    </button>
                    <button type="button" className="pcb-boton-peligro" onClick={() => void eliminarApi(fila.id)} style={{ ...botonFila, border: '1px solid #f0d6d2', color: T.corto }}>
                      Eliminar
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ flex: '0 1 340px', minWidth: 280, background: T.superficie, border: `1px solid ${T.bordeFuerte}`, borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ fontSize: 14.5, fontWeight: 700, color: T.texto }}>Registrar subcuenta</span>
            <span style={{ fontSize: 12, lineHeight: 1.45, color: T.texto2 }}>Las claves se guardan cifradas en este equipo. Nunca se muestran completas después de guardar.</span>
          </div>

          {CAMPOS.map((c) =>
            c.secreto === true ? (
              <CampoSecreto
                key={c.clave}
                rotulo={c.rotulo}
                marcador={c.marcador}
                valor={formulario[c.clave]}
                alEscribir={(v) => escribirFormulario(c.clave, v)}
              />
            ) : (
              <label key={c.clave} style={etiquetaCampo}>
                {c.rotulo}
                <input className="pcb-campo" style={campo} type="text" placeholder={c.marcador} value={formulario[c.clave]} onChange={(e) => escribirFormulario(c.clave, e.target.value)} />
              </label>
            )
          )}

          <button
            type="button"
            className="pcb-boton-oscuro"
            onClick={() => void guardarApi()}
            style={{ padding: '11px 16px', borderRadius: 9, fontSize: 13.5, fontWeight: 600, cursor: 'pointer', border: `1px solid ${BOTON_PRIMARIO.borde}`, background: BOTON_PRIMARIO.fondo, color: BOTON_PRIMARIO.texto }}
          >
            Guardar y validar
          </button>
        </div>
      </div>
    </div>
  );
}
