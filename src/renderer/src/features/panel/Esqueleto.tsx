import type { CSSProperties, ReactNode } from 'react';
import { BOTON_PRIMARIO, CASILLAS_POR_CUENTA, FUENTE, T } from '@/lib/tokens';

/**
 * Piezas de relleno para las secciones que traen datos de fuera.
 *
 * Dos estados, y la diferencia entre ellos importa:
 *
 *  - **Esqueleto** mientras se está pidiendo el dato. Reproduce la silueta de
 *    lo que va a aparecer -no un aro girando- para que la pantalla no dé un
 *    salto al llegar los datos y para que se lea de un vistazo *cuánto* viene.
 *  - **EstadoVacio** cuando ya se sabe la respuesta y no hay nada que pintar.
 *    Una tabla vacía sin explicación es indistinguible de una tabla rota: el
 *    operador no puede saber si no tiene cuentas registradas, si falló la
 *    conexión o si el panel se quedó colgado. Aquí siempre se dice cuál de las
 *    tres es, y cuando hay algo que hacer, se ofrece el botón que lo hace.
 */

/** Bloque gris con latido. `ancho` admite cualquier medida CSS. */
export function Esqueleto({
  ancho = '100%',
  alto = 12,
  radio = 4,
  estilo
}: {
  ancho?: number | string;
  alto?: number;
  radio?: number;
  estilo?: CSSProperties;
}) {
  return (
    <span
      className="pcb-esqueleto"
      style={{ display: 'block', width: ancho, height: alto, borderRadius: radio, background: T.borde, ...estilo }}
    />
  );
}

/**
 * Silueta de una cuenta principal completa: cabecera, dos filas de casillas y
 * las bandas de los dos acordeones. Es la forma exacta de `BloqueCuenta`.
 */
function EsqueletoCuenta() {
  return (
    <div style={{ borderBottom: `6px solid ${T.bordeSuave}` }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', gap: 10, padding: '9px 12px', background: T.marca }}>
        <Esqueleto ancho={150} alto={10} estilo={{ background: '#ffffff2e' }} />
        <Esqueleto ancho={190} alto={14} estilo={{ background: '#ffffff3d', margin: '0 auto' }} />
        <Esqueleto ancho={78} alto={20} radio={7} estilo={{ background: '#ffffff2e', marginLeft: 'auto' }} />
      </div>

      <div style={{ padding: '7px 12px 8px', display: 'flex', flexDirection: 'column', gap: 5, background: T.superficie, borderBottom: `1px solid ${T.borde}` }}>
        {(['long', 'short'] as const).map((lado) => (
          <div key={lado} style={{ display: 'flex', alignItems: 'stretch', gap: 4 }}>
            <div style={{ flex: 'none', width: 62, display: 'flex', alignItems: 'center' }}>
              <Esqueleto ancho={46} alto={8} />
            </div>
            {Array.from({ length: CASILLAS_POR_CUENTA }, (_, i) => (
              <div
                key={i}
                className="pcb-esqueleto"
                style={{ flex: '1 1 0', minWidth: 0, height: 46, borderRadius: 7, border: `1.5px solid ${T.borde}`, background: T.superficie2 }}
              />
            ))}
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', background: T.banda, borderBottom: `1px solid ${T.borde}` }}>
        <Esqueleto ancho={230} alto={9} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', background: T.superficie2, borderBottom: `1px solid ${T.borde}` }}>
        <Esqueleto ancho={150} alto={9} />
      </div>
    </div>
  );
}

/** Dos cuentas: suficiente para llenar el alto visible sin fingir un total. */
export function EsqueletoMatriz() {
  return (
    <div aria-busy="true" aria-label="Cargando cuentas">
      <EsqueletoCuenta />
      <EsqueletoCuenta />
    </div>
  );
}

/** Filas de la tabla de API keys, con la misma rejilla que las reales. */
export function EsqueletoFilas({ rejilla, anchoMinimo, filas = 4 }: { rejilla: string; anchoMinimo: number; filas?: number }) {
  return (
    <div aria-busy="true" aria-label="Cargando registro de API keys">
      {Array.from({ length: filas }, (_, i) => (
        <div
          key={i}
          style={{ display: 'grid', minWidth: anchoMinimo, gridTemplateColumns: rejilla, gap: 12, alignItems: 'center', padding: '11px 18px', borderBottom: `1px solid ${T.bordeSuave}` }}
        >
          <Esqueleto ancho="80%" alto={11} />
          <Esqueleto ancho={26} alto={11} />
          <Esqueleto ancho="70%" alto={11} />
          <Esqueleto ancho={86} alto={18} radio={20} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
            <Esqueleto ancho={54} alto={24} radio={6} />
            <Esqueleto ancho={62} alto={24} radio={6} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Líneas sueltas, para los acordeones. */
export function EsqueletoLineas({ filas = 3, sangria = 46 }: { filas?: number; sangria?: number }) {
  return (
    <div aria-busy="true" aria-label="Cargando">
      {Array.from({ length: filas }, (_, i) => (
        <div key={i} style={{ padding: `5px 12px 5px ${sangria}px`, borderBottom: `1px solid ${T.bordeSuave}` }}>
          <Esqueleto ancho={`${72 - i * 9}%`} alto={9} />
        </div>
      ))}
    </div>
  );
}

/* ---------------- estado vacío ---------------- */

/*
 * Cada tono trae su propio color de texto, y no es un lujo.
 *
 * El tono de error se pintaba con un rosa claro fijo mientras el título y el
 * cuerpo seguían al tema: en el tema oscuro quedaba texto casi blanco sobre
 * fondo casi blanco, ilegible. Ahora ambos salen de los tokens de alerta
 * crítica, que ya tienen su pareja clara y oscura definida en `index.css`.
 */
const TONO = {
  neutro: {
    borde: T.borde,
    fondo: T.superficie2,
    titulo: T.texto,
    cuerpo: T.texto2,
    icono: T.superficie,
    iconoFondo: T.texto3,
    glifo: '—'
  },
  error: {
    borde: T.alertaCriticaBorde,
    fondo: T.alertaCriticaFondo,
    titulo: T.alertaCriticaTexto,
    cuerpo: T.alertaCriticaTexto2,
    icono: '#ffffff',
    iconoFondo: '#e03131',
    glifo: '!'
  }
} as const;

export function EstadoVacio({
  titulo,
  cuerpo,
  tono = 'neutro',
  accion,
  compacto = false,
  detalle
}: {
  titulo: string;
  cuerpo: ReactNode;
  tono?: keyof typeof TONO;
  accion?: { rotulo: string; alClic: () => void };
  compacto?: boolean;
  /** Texto técnico secundario: el motivo crudo del fallo, en monoespaciada. */
  detalle?: string | null;
}) {
  const t = TONO[tono];

  return (
    <div
      role={tono === 'error' ? 'alert' : undefined}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 9,
        textAlign: 'center',
        margin: compacto ? '10px auto' : '34px auto',
        maxWidth: 460,
        padding: compacto ? '16px 18px' : '30px 26px',
        borderRadius: 12,
        border: `1px solid ${t.borde}`,
        background: t.fondo
      }}
    >
      <span
        style={{ flex: 'none', width: 28, height: 28, borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 800, color: t.icono, background: t.iconoFondo }}
      >
        {t.glifo}
      </span>

      <span style={{ fontSize: 14, fontWeight: 700, color: t.titulo }}>{titulo}</span>
      <span style={{ fontSize: 12, lineHeight: 1.55, color: t.cuerpo }}>{cuerpo}</span>

      {detalle != null && detalle !== '' && (
        <span style={{ maxWidth: '100%', padding: '7px 10px', borderRadius: 6, border: `1px solid ${t.borde}`, background: T.superficie, fontFamily: FUENTE.mono, fontSize: 10.5, lineHeight: 1.45, color: T.texto2, overflowWrap: 'anywhere' }}>
          {detalle}
        </span>
      )}

      {accion && (
        <button
          type="button"
          className="pcb-boton-oscuro"
          onClick={accion.alClic}
          style={{ marginTop: 3, padding: '9px 16px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: `1px solid ${BOTON_PRIMARIO.borde}`, background: BOTON_PRIMARIO.fondo, color: BOTON_PRIMARIO.texto }}
        >
          {accion.rotulo}
        </button>
      )}
    </div>
  );
}
