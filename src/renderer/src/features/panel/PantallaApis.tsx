import { useId, useState, type CSSProperties } from 'react';
import { compararCuentaMadre, NOMBRES_CUENTA_MADRE, SUBCUENTAS_POR_GRUPO } from '@shared/constants';
import type { Account, ApiKeyRow } from '@shared/domain/panel-view';
import { BOTON_PRIMARIO, DISTINTIVO_API, DISTINTIVO_MODO, FUENTE, T } from '@/lib/tokens';
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

const REJILLA = '150px 80px minmax(150px,1fr) 110px 130px 160px';
const ANCHO_MINIMO = 790;

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

/**
 * Los campos que se teclean. La cuenta principal y la casilla no están aquí.
 *
 * Las dos se eligen, no se escriben: son `SelectorDestino`. Dejarlas como texto
 * libre era lo que permitía que «A» y «a » fueran dos cuentas principales
 * distintas, y que la casilla la repartiera el panel en vez del operador.
 */
const CAMPOS: CampoFormulario[] = [
  { clave: 'subcuenta', rotulo: 'NOMBRE DE LA SUBCUENTA', marcador: 'Sub-12' },
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

/**
 * Dónde va la subcuenta: cuenta principal y casilla.
 *
 * --------------------------------------------------------------------------
 * Dos desplegables, no dos campos de texto
 * --------------------------------------------------------------------------
 * Lo acordado con el cliente el 28/08/2026. La cuenta principal es **fija, de la
 * A a la O** —quince, `NOMBRES_CUENTA_MADRE`— y no un nombre que se escribe: con
 * el campo abierto, «A» y «a » creaban dos cuentas principales distintas y el
 * tope se gastaba en duplicados. La casilla es la de 1 a 20 en la que el
 * operador quiere que aparezca esa subcuenta, y va exactamente ahí; antes la
 * repartía el panel —la primera libre— y no había forma de decidirlo.
 *
 * Las casillas ya ocupadas se ven, con el nombre de quien las ocupa, y no se
 * pueden elegir. Enterarse de que la 7 estaba pillada **después** de teclear
 * tres claves de 64 caracteres es el error que esto evita; el proceso principal
 * lo rechazaría igual, pero ya con el alta empezada.
 */
function SelectorDestino() {
  const formulario = usarPanel((s) => s.formulario);
  const escribirFormulario = usarPanel((s) => s.escribirFormulario);
  const cuentas = usarPanel((s) => s.cuentas);

  const ocupadas = new Map(
    (cuentas.find((c) => c.name === formulario.cuenta)?.subAccounts ?? []).map((s) => [s.slot, s.label])
  );
  const libres = SUBCUENTAS_POR_GRUPO - ocupadas.size;

  return (
    <div style={{ display: 'flex', gap: 10 }}>
      <label style={{ ...etiquetaCampo, flex: '1 1 0', minWidth: 0 }}>
        CUENTA PRINCIPAL
        <select
          className="pcb-campo"
          style={campo}
          value={formulario.cuenta}
          onChange={(e) => escribirFormulario('cuenta', e.target.value)}
        >
          {NOMBRES_CUENTA_MADRE.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>

      <label style={{ ...etiquetaCampo, flex: '1 1 0', minWidth: 0 }}>
        CASILLA
        <select
          className="pcb-campo"
          style={campo}
          value={formulario.casilla}
          onChange={(e) => escribirFormulario('casilla', e.target.value)}
        >
          {/* Sin casillas libres no hay nada válido que preseleccionar: se dice. */}
          {libres === 0 && <option value="">— sin casillas libres —</option>}
          {Array.from({ length: SUBCUENTAS_POR_GRUPO }, (_, i) => i + 1).map((n) => {
            const ocupante = ocupadas.get(n);
            return (
              <option key={n} value={String(n)} disabled={ocupante !== undefined}>
                {ocupante === undefined ? n : `${n} · ${ocupante}`}
              </option>
            );
          })}
        </select>
      </label>
    </div>
  );
}

/**
 * Una linea de la confirmacion posterior a validar.
 *
 * El visto va al final y no al principio a proposito: lo que confirma no es que
 * el panel haya hecho algo, sino que Bitget devolvio ese dato concreto.
 */
function Detectado({
  rotulo,
  valor,
  vacio,
  soloMarca = false
}: {
  rotulo: string;
  valor: string;
  vacio?: string;
  soloMarca?: boolean;
}) {
  const hayDato = soloMarca || valor !== '';
  return (
    <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 12.5, color: T.texto }}>
      <span style={{ fontWeight: 600 }}>{rotulo}{soloMarca ? '' : ':'}</span>
      {!soloMarca && (
        <span style={{ fontFamily: FUENTE.mono, color: hayDato ? T.texto : T.texto3 }}>
          {hayDato ? valor : (vacio ?? '—')}
        </span>
      )}
      {hayDato && <span style={{ color: T.largo, fontWeight: 700 }}>✓</span>}
    </span>
  );
}

/* ---------------- la lista, repartida en bloques ---------------- */

/**
 * Un bloque de la lista: una cuenta principal con sus subcuentas.
 *
 * --------------------------------------------------------------------------
 * Por que la lista va en bloques y no seguida
 * --------------------------------------------------------------------------
 * Lo pidio el operador el 05/09/2026, la primera vez que dio de alta una
 * segunda cuenta principal: el registro devuelve las fichas en el orden en que
 * se guardaron, asi que una subcuenta de la B queda entre dos de la A y no hay
 * forma de ver de un vistazo que tiene cada cuenta principal. Con las quince
 * cuentas llenas son trescientas filas seguidas, que es justo donde ese orden
 * deja de ser un detalle.
 *
 * El orden dentro del bloque es el de la **casilla** —la de la matriz—, no el
 * de alta ni el del nombre: es el numero que el operador tiene memorizado y con
 * el que busca. La casilla no viaja en `ApiKeyRow`, asi que sale de la matriz;
 * lo que no este en ella —una ficha recien dada de alta, antes del refresco—
 * cae al final del bloque en vez de desaparecer.
 *
 * El orden **entre** bloques ya no se decide aqui. Vivio en esta pantalla hasta
 * el 10/09/2026, y esa fue justo la razon de que la matriz —que lo resolvia por
 * su cuenta, por antiguedad— acabara enseñando las cuentas principales en otro
 * orden y el cliente lo reportara. Ahora lo pone `compararCuentaMadre`, que
 * usan las dos, asi que no pueden discrepar.
 */
interface BloqueApis {
  nombre: string;
  filas: ApiKeyRow[];
}

/** La casilla de cada subcuenta, tal como la ordena la matriz. */
function casillasDe(cuentas: readonly Account[]): Map<string, number> {
  const casillas = new Map<string, number>();
  for (const cuenta of cuentas) {
    for (const sub of cuenta.subAccounts) casillas.set(sub.id, sub.slot);
  }
  return casillas;
}

function agruparPorCuenta(
  filas: readonly ApiKeyRow[],
  casillas: ReadonlyMap<string, number>
): BloqueApis[] {
  const bloques = new Map<string, ApiKeyRow[]>();
  for (const fila of filas) {
    const suyas = bloques.get(fila.accountName);
    if (suyas === undefined) bloques.set(fila.accountName, [fila]);
    else suyas.push(fila);
  }

  /* Sin casilla conocida, al final del bloque: `MAX_SAFE_INTEGER` y no `Infinity`
     porque la resta de dos infinitos es `NaN` y desordenaría el bloque entero. */
  const casilla = (id: string): number => casillas.get(id) ?? Number.MAX_SAFE_INTEGER;

  return [...bloques.entries()]
    .sort(([a], [b]) => compararCuentaMadre(a, b))
    .map(([nombre, suyas]) => ({
      nombre,
      filas: [...suyas].sort(
        (x, y) =>
          casilla(x.id) - casilla(y.id) ||
          x.subAccountLabel.localeCompare(y.subAccountLabel, 'es', { numeric: true })
      )
    }));
}

/**
 * La cabecera de un bloque. Se pliega, y por lo mismo que existe el bloque.
 *
 * Con varias cuentas principales llenas, llegar a la ultima significa pasar por
 * las anteriores; plegado, cada cuenta principal ocupa una linea y sigue
 * diciendo lo unico que hay que saber de un vistazo: cuantas subcuentas tiene y
 * cuantas responden.
 */
function BandaBloque({
  bloque,
  plegado,
  alPlegar
}: {
  bloque: BloqueApis;
  plegado: boolean;
  alPlegar: () => void;
}) {
  const conectadas = bloque.filas.filter((f) => f.status === 'ok').length;
  const total = bloque.filas.length;

  return (
    <div
      onClick={alPlegar}
      title={`Plegar o desplegar las ${total} subcuentas de la cuenta principal ${bloque.nombre}`}
      /* `minWidth` como el de las filas: sin él la banda se quedaría corta en
         cuanto la tabla se desplace en horizontal, y las filas pasarían por debajo. */
      style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: ANCHO_MINIMO, padding: '7px 18px', background: T.banda, borderBottom: `1px solid ${T.borde}`, cursor: 'pointer', userSelect: 'none' }}
    >
      <span style={{ width: 10, display: 'flex', justifyContent: 'center', fontSize: 10, lineHeight: 1, color: T.marcaTexto }}>
        {plegado ? '▶' : '▼'}
      </span>
      <span style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: '.12em', color: T.marcaTexto, whiteSpace: 'nowrap' }}>
        CUENTA PRINCIPAL {bloque.nombre}
      </span>
      <span style={{ fontSize: 11, fontWeight: 600, color: T.texto3, fontFamily: FUENTE.mono, whiteSpace: 'nowrap' }}>
        {total} {total === 1 ? 'subcuenta' : 'subcuentas'} · {conectadas} conectadas
      </span>
    </div>
  );
}

function FilaApi({ fila }: { fila: ApiKeyRow }) {
  const probarApi = usarPanel((s) => s.probarApi);
  const pedirBajaApi = usarPanel((s) => s.pedirBajaApi);
  const distintivo = DISTINTIVO_API[fila.status];
  /* La transición manda sobre el modelo: es lo que impide operar la cuenta. */
  const modo = DISTINTIVO_MODO[fila.inTransition ? 'transicion' : fila.accountMode];

  return (
    <div style={{ display: 'grid', minWidth: ANCHO_MINIMO, gridTemplateColumns: REJILLA, gap: 12, alignItems: 'center', padding: '11px 18px', borderBottom: `1px solid ${T.bordeSuave}` }}>
      <div style={{ ...recorte, fontSize: 13.5, fontWeight: 600, color: T.texto }}>{fila.subAccountLabel}</div>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: T.marcaTexto, fontFamily: FUENTE.mono }}>{fila.accountName}</div>
      <div style={{ ...recorte, fontSize: 12.5, fontFamily: FUENTE.mono, color: T.texto2 }}>{fila.maskedKey || '— sin credenciales —'}</div>
      {/* El UID no se enmascara: no sirve para firmar y es lo que identifica la cuenta. */}
      <div style={{ ...recorte, fontSize: 12.5, fontFamily: FUENTE.mono, color: T.texto2 }} title={fila.parentUid === '' ? undefined : `Cuenta principal ${fila.parentUid}`}>
        {fila.uid === '' ? '—' : fila.uid}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 9px', borderRadius: 20, fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap', background: distintivo.fondo, color: distintivo.texto }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: distintivo.punto, display: 'block' }} />
          {distintivo.etiqueta}
        </span>
        {/*
          * Con qué API habla la cuenta.
          *
          * Va aquí, pegado al estado, y no en una columna propia: es el dato que
          * explica un estado raro. Una subcuenta que el titular actualiza a UTA
          * deja de responder a la API clásica sin previo aviso, y sin este
          * distintivo la fila solo se vería caída.
          */}
        {fila.maskedKey !== '' && (
          <span
            title={modo.pista}
            style={{ display: 'inline-flex', alignItems: 'center', padding: '3px 7px', borderRadius: 20, fontSize: 10.5, fontWeight: 700, letterSpacing: '.04em', whiteSpace: 'nowrap', background: modo.fondo, color: modo.texto }}
          >
            {modo.etiqueta}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, minWidth: 0 }}>
        <button type="button" className="pcb-boton-claro" onClick={() => void probarApi(fila.id)} style={{ ...botonFila, border: `1px solid ${T.bordeFuerte}`, color: T.texto }}>
          Probar
        </button>
        {/*
          * «Eliminar» abre la confirmación; no borra.
          *
          * Borraba en el acto hasta el 31/08/2026. Ahora la baja pide
          * la contraseña de paso —la de abrir y cerrar—, que es lo
          * único que separa un clic de más de perder la credencial de
          * una subcuenta. Ver `DialogoBajaApi`.
          */}
        <button type="button" className="pcb-boton-peligro" onClick={() => void pedirBajaApi(fila.id)} title="Pide la contraseña de paso: la baja borra la credencial y no se puede deshacer" style={{ ...botonFila, border: '1px solid #f0d6d2', color: T.corto }}>
          Eliminar
        </button>
      </div>
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
  const ultimaValidacion = usarPanel((s) => s.ultimaValidacion);
  const carga = usarPanel((s) => s.cargaApis);
  const motivo = usarPanel((s) => s.motivoApis);
  const refrescarApis = usarPanel((s) => s.refrescarApis);
  const respaldarCuentas = usarPanel((s) => s.respaldarCuentas);
  const respaldando = usarPanel((s) => s.respaldando);
  const abrirCarpetaRespaldos = usarPanel((s) => s.abrirCarpetaRespaldos);
  const cuentas = usarPanel((s) => s.cuentas);
  /* Qué bloques están plegados. Vacío = todos abiertos, que es como se entra. */
  const [plegados, fijarPlegados] = useState<ReadonlySet<string>>(new Set());

  if (!abierta) return null;
  const conectadas = apiKeys.filter((a) => a.status === 'ok').length;
  const bloques = agruparPorCuenta(apiKeys, casillasDe(cuentas));

  const alternarBloque = (nombre: string): void =>
    fijarPlegados((antes) => {
      const ahora = new Set(antes);
      if (!ahora.delete(nombre)) ahora.add(nombre);
      return ahora;
    });

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 75, background: T.fondo, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '16px 26px', background: T.marca, color: '#ffffff' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.14em', color: '#8ccdf5', fontFamily: FUENTE.mono }}>API</span>
          <span style={{ fontSize: 18, fontWeight: 600 }}>Gestión de API keys · subcuentas</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12, color: '#95c9ea', fontFamily: FUENTE.mono, whiteSpace: 'nowrap' }}>{conectadas} de {apiKeys.length} conectadas</span>
          {/*
            * Respaldar es una acción sobre *todas* las claves, no sobre una
            * fila: por eso está en la cabecera y no en la tabla ni en el
            * formulario de alta. Y va con el estilo secundario de la barra
            * porque no destruye nada; el botón que sí lo haría —restaurar—
            * vive en la pantalla de desbloqueo.
            */}
          <button
            type="button"
            className="pcb-boton-barra"
            onClick={() => void respaldarCuentas()}
            disabled={respaldando}
            title="Guarda todas sus subcuentas en un archivo dentro de Documentos. El archivo va cifrado: sin su contraseña maestra no sirve de nada."
            style={{ padding: '8px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: respaldando ? 'default' : 'pointer', border: '1px solid #ffffff2e', background: '#ffffff14', color: '#ffffff', whiteSpace: 'nowrap', opacity: respaldando ? 0.6 : 1 }}
          >
            {respaldando ? 'Respaldando…' : 'Respaldar mis cuentas'}
          </button>
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
        {/*
          * Dónde se dice que la contraseña no viaja dentro del respaldo.
          *
          * Va aquí, a todo lo ancho y antes que la tabla, porque es donde el
          * operador está pensando en sus API keys, y porque el respaldo vive en
          * Documentos —una carpeta que suele estar sincronizada a OneDrive—. Lo
          * único que protege ese archivo es la contraseña maestra, así que la
          * frase no es tranquilizadora: es la frontera de seguridad, y tiene que
          * leerse antes de pulsar.
          *
          * «Abrir la carpeta» está siempre, no solo después de respaldar: un
          * botón que aparece y desaparece se lee como un fallo de la pantalla.
          */}
        <div style={{ flex: '1 1 100%', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, padding: '10px 14px', background: T.superficie2, border: `1px solid ${T.borde}`, borderRadius: 10, fontSize: 12, lineHeight: 1.5, color: T.texto2 }}>
          <span style={{ flex: '1 1 320px', minWidth: 0 }}>
            Sus credenciales están cifradas en este equipo. Para llevarlas a otra versión del panel, pulse{' '}
            <strong>Respaldar mis cuentas</strong>: se guarda un archivo en <em>Documentos › Panel de Control Bitget › respaldos</em>.{' '}
            <strong>La contraseña maestra no va dentro del archivo</strong>: sin ella el respaldo no sirve de nada, ni a usted ni a nadie.
          </span>
          <button
            type="button"
            className="pcb-boton-claro"
            onClick={() => void abrirCarpetaRespaldos()}
            style={{ padding: '7px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: `1px solid ${T.bordeFuerte}`, background: T.superficie, color: T.texto, whiteSpace: 'nowrap' }}
          >
            Abrir la carpeta
          </button>
        </div>

        <div style={{ flex: '1 1 620px', minWidth: 0, background: T.superficie, border: `1px solid ${T.bordeFuerte}`, borderRadius: 12, overflow: 'hidden', alignSelf: 'stretch' }}>
          {/*
            * Aquí sí se puede seleccionar texto con el ratón.
            *
            * El panel lleva `user-select: none` en el `body` —es una aplicación
            * de escritorio y arrastrar sobre la matriz no debe pintar de azul
            * media pantalla—, pero esta tabla es la excepción: el UID de Bitget
            * y la clave enmascarada son datos que el operador copia para
            * pegarlos en un correo o en el propio Bitget, y sin selección el
            * «Copiar» del botón derecho no tendría nada que copiar.
            *
            * Lo que se puede copiar de aquí no es secreto: la API Key solo está
            * enmascarada —`bg••••8b3f`— y el UID no sirve para firmar. RNF-001.
            */}
          <div style={{ overflowX: 'auto', userSelect: 'text' }}>
            <div style={{ display: 'grid', minWidth: ANCHO_MINIMO, gridTemplateColumns: REJILLA, gap: 12, padding: '12px 18px', borderBottom: `1px solid ${T.borde}`, fontSize: 11, fontWeight: 600, letterSpacing: '.09em', color: T.texto3 }}>
              <div style={{ whiteSpace: 'nowrap' }}>SUBCUENTA</div>
              <div>CUENTA</div>
              <div style={{ whiteSpace: 'nowrap' }}>API KEY</div>
              <div style={{ whiteSpace: 'nowrap' }}>UID BITGET</div>
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

            {bloques.map((bloque) => (
              <div key={bloque.nombre}>
                <BandaBloque
                  bloque={bloque}
                  plegado={plegados.has(bloque.nombre)}
                  alPlegar={() => alternarBloque(bloque.nombre)}
                />
                {!plegados.has(bloque.nombre) &&
                  bloque.filas.map((fila) => <FilaApi key={fila.id} fila={fila} />)}
              </div>
            ))}
          </div>
        </div>

        <div style={{ flex: '0 1 340px', minWidth: 280, background: T.superficie, border: `1px solid ${T.bordeFuerte}`, borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ fontSize: 14.5, fontWeight: 700, color: T.texto }}>Registrar subcuenta</span>
            <span style={{ fontSize: 12, lineHeight: 1.45, color: T.texto2 }}>Las claves se guardan cifradas en este equipo. Nunca se muestran completas después de guardar.</span>
          </div>

          <SelectorDestino />

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

          {ultimaValidacion !== null && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 5,
                padding: '11px 13px',
                borderRadius: 9,
                border: `1px solid ${T.largo}33`,
                background: `${T.largo}12`
              }}
            >
              <Detectado rotulo="UID detectado" valor={ultimaValidacion.uid} />
              <Detectado
                rotulo="Cuenta principal"
                valor={ultimaValidacion.uidPadre}
                vacio="Bitget no la informa (no es subcuenta)"
              />
              <Detectado rotulo="API validada correctamente" valor="" soloMarca />
              <span style={{ fontSize: 11.5, lineHeight: 1.4, color: T.texto3 }}>
                Los identificadores los devolvió Bitget al validar la clave y quedan guardados con
                la subcuenta. No hay que escribirlos.
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
