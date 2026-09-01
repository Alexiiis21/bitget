import type { CSSProperties } from 'react';
import { ANCHO_MINIMO_MONITOR, FUENTE, REALCE, REJILLA_MONITOR, T, TIPO_MONITOR } from '@/lib/tokens';
import { cifra, cifraConSigno, restar } from '@/lib/formato';
import { useAncho } from '@/lib/medidas';
import { usarPanel } from '@/store/panel';
import { distintivosDe } from './distintivos';
import type { Account, Position, Side } from '@shared/domain/panel-view';

/**
 * Centro de Monitoreo de Posiciones — acordeón por cuenta.
 *
 * Solo lectura. Solo lista lo que tiene posición abierta, en orden de casilla:
 * si la Sub-13 abre, aparece entre la 12 y la 14; si cierra, desaparece sin
 * desplazar al resto. La entrada resaltada es la primera del activo -la más
 * baja en long, la más alta en short-, la referencia contra la que el operador
 * compara el resto.
 *
 * --------------------------------------------------------------------------
 * Una fila por casilla **y activo**
 * --------------------------------------------------------------------------
 * En Bitget una posición se identifica por cuenta, símbolo y lado, y una
 * casilla puede tener BTC y ETH abiertos a la vez. Hasta la Fase 6 esta lista
 * era una fila por casilla y buscaba la punta con `find(casilla && lado)`: con
 * dos activos abiertos, la segunda posición no se dibujaba en ningún sitio y
 * nada lo delataba. Ahora la fila es la pareja (casilla, activo), que es la
 * unidad que el operador compara —dos entradas de activos distintos no se
 * comparan— y la que hace que la distancia L/S signifique algo.
 *
 * --------------------------------------------------------------------------
 * Dos disposiciones, y por qué no basta con una
 * --------------------------------------------------------------------------
 * Las trece columnas piden `ANCHO_MINIMO_MONITOR` para caber. En un monitor
 * grande sobra sitio; en una laptop no, y hasta el 31/08/2026 lo que pasaba era
 * lo peor de los dos mundos: la tabla se salía del contenedor, que la recorta
 * sin barra de desplazamiento, y **el bloque SHORT entero desaparecía de la
 * pantalla**. No es que se leyera mal: es que no estaba, y nada lo decía.
 *
 * Por debajo de ese ancho la fila se parte en dos: el SHORT se acomoda debajo
 * del LONG, con su rótulo al lado de cada cifra —porque ahí ya no hay cabecera
 * de columna que las nombre— y las dos puntas alineadas entre sí para que la
 * comparación siga siendo vertical. Las filas se separan más marcadamente que
 * las dos puntas de una misma fila, que es lo que impide leer el SHORT de una
 * casilla como si fuera de la siguiente.
 */

interface Fila {
  clave: string;
  sub: Account['subAccounts'][number];
  activoId: string;
  long: Position | undefined;
  short: Position | undefined;
}

/**
 * La entrada de referencia de cada activo, por lado.
 *
 * Se calcula por activo y no por cuenta: la entrada de BTC no es comparable con
 * la de ETH, así que un mínimo común resaltaría siempre la del activo más
 * barato y nunca la primera de cada uno.
 *
 * Se resuelve de una pasada y no dentro del `map` de las filas: buscar el
 * mínimo por fila recorrería la lista entera una vez por fila, y una cuenta con
 * 20 casillas y varios activos abiertos rehace ese recorrido en cada repintado,
 * que con el flujo en vivo son varios por segundo.
 */
function referencias(filas: readonly Fila[], lado: Side): Map<string, number> {
  const porActivo = new Map<string, number>();

  for (const fila of filas) {
    const punta = lado === 'long' ? fila.long : fila.short;
    if (punta === undefined) continue;

    const entrada = Number.parseFloat(punta.entryPrice);
    if (!Number.isFinite(entrada)) continue;

    const actual = porActivo.get(fila.activoId);
    if (actual === undefined) porActivo.set(fila.activoId, entrada);
    else porActivo.set(fila.activoId, lado === 'long' ? Math.min(actual, entrada) : Math.max(actual, entrada));
  }

  return porActivo;
}

/**
 * Las filas de la cuenta, en orden de casilla y, dentro de cada una, de activo.
 *
 * El orden de casilla es el de `subAccounts`, que ya viene por `slot`: es el
 * número que el operador aprende de memoria. Los activos de una misma casilla
 * van alfabéticos para que no bailen entre un refresco y el siguiente.
 */
function filasDe(cuenta: Account, posiciones: readonly Position[]): Fila[] {
  const filas: Fila[] = [];

  for (const sub of cuenta.subAccounts) {
    const suyas = posiciones.filter((p) => p.subAccountId === sub.id && p.actions.oe);
    const activos = [...new Set(suyas.map((p) => p.assetId))].sort();

    for (const activoId of activos) {
      filas.push({
        clave: `${sub.id}|${activoId}`,
        sub,
        activoId,
        long: suyas.find((p) => p.assetId === activoId && p.side === 'long'),
        short: suyas.find((p) => p.assetId === activoId && p.side === 'short')
      });
    }
  }

  return filas;
}

/** Lo que las dos disposiciones necesitan saber de una fila, calculado una vez. */
interface Pintada extends Fila {
  punto: string;
  motivo: string | null;
  /** Entrada del short menos la del long. `null` si falta una de las dos puntas. */
  distancia: number | null;
  destacadaLong: boolean;
  destacadaShort: boolean;
}

export function AccordeonMonitor({ cuenta }: { cuenta: Account }) {
  const posiciones = usarPanel((s) => s.posiciones);
  const abrirDetalle = usarPanel((s) => s.abrirDetalle);
  const cargaPosiciones = usarPanel((s) => s.cargaPosiciones);
  const motivoPosiciones = usarPanel((s) => s.motivoPosiciones);
  const [medir, ancho] = useAncho();

  const filas = filasDe(cuenta, posiciones);

  /*
   * «No hay posiciones abiertas» y «no se sabe si las hay» son cosas distintas
   * y piden reacciones opuestas del operador. La lista vacía solo puede
   * afirmarse cuando el flujo de posiciones está vivo.
   */
  if (cargaPosiciones === 'error') {
    return (
      <div style={{ padding: '10px 12px', fontSize: TIPO_MONITOR.rotulo, color: T.texto3 }}>
        No hay datos de posiciones: {motivoPosiciones ?? 'el flujo en vivo no está disponible.'}
      </div>
    );
  }

  if (filas.length === 0) {
    return <div style={{ padding: '10px 12px', fontSize: TIPO_MONITOR.rotulo, color: T.texto3 }}>Ninguna subcuenta de esta cuenta tiene posición abierta en este momento.</div>;
  }

  const primerasLong = referencias(filas, 'long');
  const primerasShort = referencias(filas, 'short');

  /*
   * Mientras no se ha medido -el primer render, antes de que la ref se
   * enganche- se supone ancha. La medida llega en el mismo commit, antes de que
   * el navegador pinte, así que no se ve el cambio.
   */
  const estrecho = ancho > 0 && ancho < ANCHO_MINIMO_MONITOR;

  const pintadas: Pintada[] = filas.map((fila) => ({
    ...fila,
    punto: fila.long?.hasError || fila.short?.hasError ? '#f2b705' : '#2f9e44',
    motivo: fila.long?.errorReason ?? fila.short?.errorReason ?? null,
    distancia: fila.long && fila.short ? restar(fila.short.entryPrice, fila.long.entryPrice) : null,
    destacadaLong: fila.long !== undefined && Number.parseFloat(fila.long.entryPrice) === primerasLong.get(fila.activoId),
    destacadaShort: fila.short !== undefined && Number.parseFloat(fila.short.entryPrice) === primerasShort.get(fila.activoId)
  }));

  return (
    <div ref={medir}>
      {!estrecho && <CabeceraAncha />}
      {pintadas.map((fila) =>
        estrecho ? (
          <FilaPartida key={fila.clave} fila={fila} alAbrir={() => abrirDetalle(cuenta.id, fila.sub.id, fila.activoId)} />
        ) : (
          <FilaAncha key={fila.clave} fila={fila} alAbrir={() => abrirDetalle(cuenta.id, fila.sub.id, fila.activoId)} />
        )
      )}
    </div>
  );
}

/* ---------------- disposición ancha: las dos puntas en la misma línea ---------------- */

const rejillaAncha: CSSProperties = {
  display: 'grid',
  minWidth: ANCHO_MINIMO_MONITOR,
  gridTemplateColumns: REJILLA_MONITOR,
  padding: '3px 12px'
};

function CabeceraAncha() {
  return (
    <>
      <div style={{ ...rejillaAncha, alignItems: 'end', padding: '6px 12px 0', fontSize: TIPO_MONITOR.rotulo, fontWeight: 700, letterSpacing: '.09em', color: T.texto3 }}>
        <div />
        <div />
        <div />
        <div style={{ textAlign: 'right', color: T.largo }}>LONG</div>
        <div />
        <div />
        <div style={{ textAlign: 'center', color: T.largo, padding: '0 6px' }}>ESTADO LONG</div>
        <div style={{ textAlign: 'center', fontWeight: 800, color: T.texto, padding: '0 2px', whiteSpace: 'nowrap' }}>DIST. L/S</div>
        <div />
        <div style={{ textAlign: 'right', color: T.corto }}>SHORT</div>
        <div />
        <div />
        <div style={{ textAlign: 'center', color: T.corto, padding: '0 6px' }}>ESTADO SHORT</div>
      </div>
      <div style={{ ...rejillaAncha, alignItems: 'end', padding: '2px 12px 5px', borderBottom: `1px solid ${T.borde}`, fontSize: TIPO_MONITOR.rotulo, color: T.texto3, letterSpacing: '.03em' }}>
        <div style={{ fontWeight: 700, letterSpacing: '.09em' }}>SUBCUENTA</div>
        <div style={{ fontWeight: 700, letterSpacing: '.09em' }}>ACTIVO</div>
        <div style={{ textAlign: 'right' }}>Liquidación</div>
        <div style={{ textAlign: 'right' }}>Entrada</div>
        <div style={{ textAlign: 'right', fontWeight: 600 }}>M. inicial</div>
        <div style={{ textAlign: 'right' }}>Take Profit</div>
        <div />
        <div />
        <div style={{ textAlign: 'right' }}>Liquidación</div>
        <div style={{ textAlign: 'right' }}>Entrada</div>
        <div style={{ textAlign: 'right', fontWeight: 600 }}>M. inicial</div>
        <div style={{ textAlign: 'right' }}>Take Profit</div>
        <div />
      </div>
    </>
  );
}

function FilaAncha({ fila, alAbrir }: { fila: Pintada; alAbrir: () => void }) {
  const { sub, activoId, long, short, punto, motivo, distancia, destacadaLong, destacadaShort } = fila;

  return (
    <div
      className="pcb-fila-monitor"
      onClick={alAbrir}
      title={motivo ?? 'Ver detalle de la subcuenta'}
      style={{ ...rejillaAncha, alignItems: 'center', borderBottom: `1px solid ${T.bordeSuave}`, cursor: 'pointer' }}
    >
      <Identidad etiqueta={sub.label} punto={punto} />
      <div style={{ fontSize: TIPO_MONITOR.rotulo, fontWeight: 700, letterSpacing: '.04em', color: T.texto2, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activoId}</div>
      <Cifra valor={cifra(long?.liquidationPrice)} />
      <Cifra valor={cifra(long?.entryPrice)} destacada={destacadaLong} lado="long" />
      <Cifra valor={cifra(long?.initialMarginAccum)} peso={600} titulo={TITULO_MARGEN} />
      <Cifra valor={cifra(long?.takeProfitPrice)} color={T.largo} peso={500} />
      <Distintivos posicion={long} etiquetaLado="Long" />
      <div style={{ textAlign: 'center', fontFamily: FUENTE.mono, fontSize: TIPO_MONITOR.destacado, fontWeight: 700, color: T.texto }}>{cifraConSigno(distancia)}</div>
      <Cifra valor={cifra(short?.liquidationPrice)} />
      <Cifra valor={cifra(short?.entryPrice)} destacada={destacadaShort} lado="short" />
      <Cifra valor={cifra(short?.initialMarginAccum)} peso={600} titulo={TITULO_MARGEN} />
      <Cifra valor={cifra(short?.takeProfitPrice)} color={T.corto} peso={500} />
      <Distintivos posicion={short} etiquetaLado="Short" />
    </div>
  );
}

/* ---------------- disposición partida: el SHORT debajo del LONG ---------------- */

/**
 * Las dos puntas comparten la misma rejilla, y por eso se pueden comparar.
 *
 * Cada dato lleva su rótulo al lado porque aquí no hay cabecera de columna que
 * los nombre: una cifra sola en una pantalla estrecha es un número sin decir de
 * qué, y en esta lista conviven cuatro que se parecen mucho.
 *
 * Las columnas tienen tope y la fila se empaqueta a la izquierda en vez de
 * repartirse el ancho: con cuatro datos y mil píxeles, el reparto los separaba
 * tanto que había que barrer la pantalla con la vista para leer una sola punta.
 * Los distintivos van justo detrás, no pegados al borde derecho, por lo mismo.
 */
const rejillaPartida: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0,64px) repeat(4,minmax(0,152px)) minmax(0,auto)',
  justifyContent: 'start',
  gap: 12,
  alignItems: 'center',
  padding: '3px 0'
};

function FilaPartida({ fila, alAbrir }: { fila: Pintada; alAbrir: () => void }) {
  const { sub, activoId, long, short, punto, motivo, distancia, destacadaLong, destacadaShort } = fila;

  return (
    <div
      className="pcb-fila-monitor"
      onClick={alAbrir}
      title={motivo ?? 'Ver detalle de la subcuenta'}
      /* El borde grueso separa casillas; el fino de dentro, las dos puntas de una. */
      style={{ padding: '6px 12px 7px', borderBottom: `2px solid ${T.borde}`, cursor: 'pointer' }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, minWidth: 0 }}>
        <Identidad etiqueta={sub.label} punto={punto} />
        <span style={{ flex: 'none', fontSize: TIPO_MONITOR.rotulo, fontWeight: 700, letterSpacing: '.04em', color: T.texto2 }}>{activoId}</span>
        <span style={{ marginLeft: 'auto', flex: 'none', display: 'flex', alignItems: 'baseline', gap: 6, whiteSpace: 'nowrap' }}>
          <span style={{ fontSize: TIPO_MONITOR.rotulo, fontWeight: 700, letterSpacing: '.09em', color: T.texto3 }}>DIST. L/S</span>
          <span style={{ fontFamily: FUENTE.mono, fontSize: TIPO_MONITOR.destacado, fontWeight: 700, color: T.texto }}>{cifraConSigno(distancia)}</span>
        </span>
      </div>

      <PuntaPartida lado="long" posicion={long} destacada={destacadaLong} />
      <PuntaPartida lado="short" posicion={short} destacada={destacadaShort} />
    </div>
  );
}

function PuntaPartida({ lado, posicion, destacada }: { lado: Side; posicion: Position | undefined; destacada: boolean }) {
  const color = lado === 'long' ? T.largo : T.corto;

  return (
    <div style={{ ...rejillaPartida, borderTop: `1px solid ${T.bordeSuave}` }}>
      <span style={{ justifySelf: 'start', padding: '1px 7px', borderRadius: 4, fontSize: TIPO_MONITOR.distintivo, fontWeight: 700, letterSpacing: '.06em', color: '#ffffff', background: color }}>
        {lado === 'long' ? 'LONG' : 'SHORT'}
      </span>
      <Dato rotulo="Liquidación" valor={cifra(posicion?.liquidationPrice)} />
      <Dato rotulo="Entrada" valor={cifra(posicion?.entryPrice)} destacada={destacada} lado={lado} />
      <Dato rotulo="M. inicial" valor={cifra(posicion?.initialMarginAccum)} peso={600} titulo={TITULO_MARGEN} />
      <Dato rotulo="Take Profit" valor={cifra(posicion?.takeProfitPrice)} color={color} peso={500} />
      <Distintivos posicion={posicion} etiquetaLado={lado === 'long' ? 'Long' : 'Short'} />
    </div>
  );
}

/** Rótulo a la izquierda y cifra a la derecha. Solo en la disposición partida. */
function Dato({
  rotulo,
  valor,
  color,
  peso,
  titulo,
  destacada = false,
  lado
}: {
  rotulo: string;
  valor: string;
  color?: string | undefined;
  peso?: number | undefined;
  titulo?: string | undefined;
  destacada?: boolean | undefined;
  lado?: Side | undefined;
}) {
  return (
    <div title={titulo} style={{ minWidth: 0, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
      <span style={{ flex: '0 1 auto', fontSize: TIPO_MONITOR.rotulo, color: T.texto3, letterSpacing: '.03em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{rotulo}</span>
      <span style={{ flex: 'none' }}>
        <Cifra valor={valor} color={color} peso={peso} destacada={destacada} lado={lado} />
      </span>
    </div>
  );
}

/* ---------------- piezas compartidas ---------------- */

function Identidad({ etiqueta, punto }: { etiqueta: string; punto: string }) {
  return (
    <div style={{ fontSize: TIPO_MONITOR.destacado, fontWeight: 600, paddingLeft: 2, display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      <span style={{ width: 8, height: 8, flex: 'none', borderRadius: '50%', background: punto, display: 'block' }} />
      <span style={{ flex: 'none' }}>{etiqueta}</span>
    </div>
  );
}

/**
 * Una cifra de la lista.
 *
 * `destacada` es la entrada de referencia del activo —la más baja en long, la
 * más alta en short—, y va con fondo de color: es contra ella contra la que el
 * operador lee todas las demás.
 */
function Cifra({
  valor,
  color,
  peso,
  titulo,
  destacada = false,
  lado
}: {
  valor: string;
  color?: string | undefined;
  peso?: number | undefined;
  titulo?: string | undefined;
  destacada?: boolean | undefined;
  lado?: Side | undefined;
}) {
  const base: CSSProperties ={ textAlign: 'right', fontFamily: FUENTE.mono, fontSize: TIPO_MONITOR.valor, fontWeight: peso ?? 400, color: color ?? T.texto2, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

  if (!destacada) {
    return (
      <div title={titulo} style={base}>
        {valor}
      </div>
    );
  }

  const corto = lado === 'short';
  return (
    <div title={titulo} style={base}>
      <span style={{ borderRadius: 4, padding: '1px 4px', marginRight: -4, fontWeight: 700, color: corto ? REALCE.cortoTexto : REALCE.largoTexto, background: corto ? REALCE.cortoFondo : REALCE.largoFondo }}>
        {valor}
      </span>
    </div>
  );
}

/**
 * El guion de esta columna no significa cero.
 *
 * Sale en las posiciones que ya estaban abiertas cuando arrancó el panel: ese
 * número lo lleva el panel, no Bitget, y no se puede deducir de una lectura.
 */
const TITULO_MARGEN =
  'Margen inicial acumulado: apertura + reposicionamientos. ' +
  'Un guion significa que la posición ya estaba abierta cuando arrancó el panel.';

function Distintivos({ posicion, etiquetaLado }: { posicion: Position | undefined; etiquetaLado: string }) {
  const lista = distintivosDe(posicion, etiquetaLado);
  return (
    <div style={{ display: 'flex', justifyContent: 'center', gap: 5, padding: '0 3px', minWidth: 0, overflow: 'hidden' }}>
      {lista.map((d) => (
        <span key={d.clave} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 0, flex: '0 1 auto' }}>
          <span title={d.pista} style={{ minWidth: 27, height: 17, borderRadius: 4, padding: '0 4px', fontSize: TIPO_MONITOR.distintivo, fontWeight: 700, letterSpacing: '.04em', color: '#ffffff', display: 'flex', alignItems: 'center', justifyContent: 'center', background: d.color }}>
            {d.etiqueta}
          </span>
          {/*
            * El valor va del tamaño de las cifras de la fila, no de pie de foto:
            * es el porcentaje del Take Profit y el apalancamiento de la
            * posición. Ver `TIPO_MONITOR.distintivoValor`.
            */}
          <span style={{ fontSize: TIPO_MONITOR.distintivoValor, fontWeight: 600, color: T.texto2, fontFamily: FUENTE.mono, lineHeight: 1.15 }}>{d.valor}</span>
        </span>
      ))}
    </div>
  );
}
