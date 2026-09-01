import type { CSSProperties } from 'react';
import { ESTADO_ACCION, FUENTE, T } from '@/lib/tokens';
import { usarPanel } from '@/store/panel';
import type { PlanKind } from '@shared/domain/panel-view';
import type { AlcanceLado, ValoresHerramientas } from './tipos';


/**
 * Barra lateral: selector de activo, ejecución, parámetros, tipo de orden.
 *
 * Cada sub-bloque es su propio componente exportado (`SelectorActivo`,
 * `ControlesEjecucion`, `CamposParametro`, `SelectorTipoOrden`,
 * `InterruptorValoresFijos`) y `BarraLateral` solo los
 * apila en columna — así el layout se puede reordenar sin tocar la lógica de
 * cada pieza. Van en un solo archivo porque comparten el mismo ancho fijo y
 * el mismo ritmo vertical; separarlos en cinco archivos de 40 líneas cada
 * uno no aportaría legibilidad.
 */

const seccion: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5 };
const tituloSeccion: CSSProperties = { fontSize: 9, fontWeight: 700, letterSpacing: '.12em', color: T.texto3 };

/**
 * Las ocho casillas de activo, y el lápiz que abre el buscador.
 *
 * --------------------------------------------------------------------------
 * Ocho casillas editables, no una lista que crece
 * --------------------------------------------------------------------------
 * El cliente pidió el 28/08/2026 poder cambiar qué activo hay en cada casilla
 * sin poder añadir una novena: se quita BTC de la casilla 1 y se pone DOGE, y la
 * casilla 1 pasa a ser DOGE. El número es fijo -ver `RANURAS_ACTIVO`- y por el
 * mismo motivo de siempre: operar sigue siendo elegir entre ocho de un vistazo,
 * y buscar entre los 754 contratos del exchange es un acto aparte que se abre,
 * se usa y se cierra.
 *
 * Una casilla vacía se dibuja igual que una llena, con su número y su borde
 * punteado. No desaparece: es el hueco que se puede llenar, y el operador la
 * edita por ese número.
 */
function SelectorActivo() {
  const ranuras = usarPanel((s) => s.ranuras);
  const activoId = usarPanel((s) => s.activoId);
  const fijarActivo = usarPanel((s) => s.fijarActivo);
  const abrirBuscador = usarPanel((s) => s.abrirBuscadorActivos);

  return (
    <div style={seccion}>
      <span style={tituloSeccion}>ACTIVO · FUTUROS USDT-M</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {ranuras.map((a, i) => {
          const activa = a !== null && a.id === activoId;
          return (
            <div key={a?.id ?? `vacia-${i}`} style={{ display: 'flex', alignItems: 'stretch', gap: 3 }}>
              <button
                type="button"
                onClick={() => (a === null ? void abrirBuscador(i) : fijarActivo(a.id))}
                title={
                  a === null
                    ? `Casilla ${i + 1} vacía · pulse para elegir un activo`
                    : `${a.label} · futuros USDT-M${a.tradable ? '' : ' · SUSPENDIDO en Bitget'}`
                }
                style={{
                  flex: '1 1 0',
                  minWidth: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  padding: '6px 8px',
                  borderRadius: 6,
                  fontSize: 11.5,
                  fontWeight: 700,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  fontFamily: FUENTE.mono,
                  border: a === null ? `1.5px dashed ${T.bordeSuave}` : `1.5px solid ${activa ? T.marcaRelleno : T.bordeFuerte}`,
                  background: activa ? T.seleccion : T.superficie,
                  color: activa ? T.marcaTexto : T.texto3
                }}
              >
                <span style={{ flex: 'none', width: 7, height: 7, borderRadius: '50%', background: activa ? T.marcaRelleno : T.bordeFuerte, display: a === null ? 'none' : 'block' }} />
                {a === null ? `${i + 1} · vacía` : a.label}
                {a !== null && !a.tradable && (
                  <span style={{ marginLeft: 'auto', flex: 'none', fontSize: 8.5, fontWeight: 700, color: ESTADO_ACCION.error }}>SUSP</span>
                )}
              </button>
              <button
                type="button"
                className="pcb-boton-claro"
                onClick={() => void abrirBuscador(i)}
                title={`Cambiar el activo de la casilla ${i + 1}`}
                style={{ flex: 'none', width: 24, borderRadius: 6, fontSize: 11, cursor: 'pointer', border: `1px solid ${T.bordeFuerte}`, background: T.superficie, color: T.texto3 }}
              >
                ✎
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ControlesEjecucion() {
  const planear = usarPanel((s) => s.planear);
  const planCargando = usarPanel((s) => s.planCargando);
  const alcance = usarPanel((s) => s.alcance);
  const fijarAlcance = usarPanel((s) => s.fijarAlcance);

  /*
   * El alcance no filtra: manda sobre la selección.
   *
   * En «Ambos» las dos casillas de una columna son una sola —marcar la LONG
   * marca la SHORT—, y en «Long» o «Short» la fila que no se opera se destilda
   * y deja de responder. Así lo marcado es exactamente lo que se envía, que es
   * lo que fallaba: en «Ambos» se podía marcar una sola punta y salía media
   * posición, y al revés, casillas marcadas bajo un alcance que no las contaba
   * se convertían en órdenes al cambiarlo. Ver `reconciliar` en el store.
   */
  const ALCANCES: { id: AlcanceLado; etiqueta: string; pista: string }[] = [
    { id: 'long', etiqueta: 'Long', pista: 'Solo la fila LONG. La fila SHORT se destilda y no se puede marcar.' },
    { id: 'ambos', etiqueta: 'Ambos', pista: 'Las dos filas a la vez: marcar una casilla marca su par, y cada columna sale como dos órdenes —una long y una short—.' },
    { id: 'short', etiqueta: 'Short', pista: 'Solo la fila SHORT. La fila LONG se destilda y no se puede marcar.' }
  ];

  return (
    <div style={seccion}>
      <span style={tituloSeccion}>EJECUCIÓN</span>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
        {/*
          * Los dos botones planifican: ninguno envía. Lo que sale de aquí es la
          * consulta de precios y saldos que arma la confirmación, y hasta que el
          * operador no la apruebe no hay ninguna orden en Bitget.
          */}
        <button
          type="button"
          disabled={planCargando}
          onClick={() => void planear('open')}
          title="Revisar la apertura en las casillas seleccionadas"
          style={{ padding: '9px 6px', borderRadius: 7, fontSize: 12.5, fontWeight: 700, cursor: planCargando ? 'wait' : 'pointer', opacity: planCargando ? 0.6 : 1, border: `1px solid ${T.marcaRelleno}`, background: T.marcaRelleno, color: '#ffffff' }}
        >
          Abrir
        </button>
        <button
          type="button"
          disabled={planCargando}
          onClick={() => void planear('close')}
          title="Cierre rápido en las casillas seleccionadas"
          style={{ padding: '9px 6px', borderRadius: 7, fontSize: 12.5, fontWeight: 700, cursor: planCargando ? 'wait' : 'pointer', opacity: planCargando ? 0.6 : 1, border: `1px solid ${T.bordeFuerte}`, background: T.superficie, color: T.texto }}
        >
          Cerrar
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {ALCANCES.map((a) => {
          const activa = alcance === a.id;
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => fijarAlcance(a.id)}
              title={a.pista}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                padding: '7px 8px',
                borderRadius: 6,
                fontSize: 11.5,
                fontWeight: 600,
                cursor: 'pointer',
                border: `1.5px solid ${activa ? T.marcaRelleno : T.bordeFuerte}`,
                background: activa ? T.seleccion : T.superficie,
                color: activa ? T.marcaTexto : T.texto3
              }}
            >
              <span style={{ flex: 'none', width: 7, height: 7, borderRadius: '50%', background: activa ? T.marcaRelleno : T.bordeFuerte, display: 'block' }} />
              {a.etiqueta}
            </button>
          );
        })}
      </div>
      {alcance === 'ambos' && (
        <span style={{ fontSize: 9.5, lineHeight: 1.35, color: T.texto3 }}>
          Cada casilla marca su par: una columna son dos órdenes, una long y una short.
        </span>
      )}
    </div>
  );
}

interface DefinicionCampo {
  campo: keyof ValoresHerramientas;
  clave: 'tp' | 'mg' | 'ap';
  /** La operación que planifica su botón, o `null` si el campo no es una. */
  plan: PlanKind | null;
  etiqueta: string;
  unidad: string;
  marcador: string;
}

/**
 * `plan: null` significa que el campo **viaja dentro de la apertura**.
 *
 * Son tres de los cuatro: Take Profit, margen inicial y margen adicional. Lo
 * que se teclee aquí sale con la orden al pulsar «Abrir» y no se aplica sobre
 * nada que ya esté abierto; para eso están los campos de la sección «Sobre
 * posiciones abiertas», que son otros. Ver `ValoresHerramientas`.
 *
 * El apalancamiento es el único que sigue siendo su propia operación, y no es
 * una excepción a la regla: no viaja en ninguna orden, es configuración de la
 * cuenta que se deja puesta **antes** de operar.
 */
const CAMPOS: DefinicionCampo[] = [
  { campo: 'tp', clave: 'tp', plan: null, etiqueta: 'Take Profit %', unidad: '%', marcador: '0.00' },
  { campo: 'mgi', clave: 'mg', plan: null, etiqueta: 'Margen inicial', unidad: 'USDT', marcador: '0.000' },
  { campo: 'mga', clave: 'mg', plan: null, etiqueta: 'Margen adicional', unidad: 'USDT', marcador: '0.000' },
  { campo: 'ap', clave: 'ap', plan: 'leverage', etiqueta: 'Apalancamiento', unidad: 'x', marcador: '10' }
];

/**
 * Los cuatro campos de la próxima orden. Tres salen con ella; uno se aplica aparte.
 *
 * --------------------------------------------------------------------------
 * Por qué el Take Profit y el margen adicional no tienen botón aquí
 * --------------------------------------------------------------------------
 * Lo tuvieron, y era el problema. Los dos viajan dentro de la apertura **y
 * además** tenían aquí su botón para aplicarlos sobre una posición ya abierta,
 * leyendo el mismo campo. Hacer las dos cosas enviaba lo mismo dos veces: el
 * 26/08/2026 una posición acabó con 2 USDT de margen adicional donde el
 * operador había escrito 1, y `set-margin` no lleva identificador que impida la
 * repetición.
 *
 * Ajustar una posición abierta se puede volver a hacer desde el 01/09/2026,
 * pero **no desde aquí**: tiene su propia sección y sus propios campos, de modo
 * que el número escrito para abrir no puede reenviarse por inercia. Cada rótulo
 * dice dónde acaba su valor, para que no haya que deducirlo.
 */
function CamposParametro() {
  const valores = usarPanel((s) => s.valores);
  const fijarValor = usarPanel((s) => s.fijarValor);
  const planear = usarPanel((s) => s.planear);
  const planCargando = usarPanel((s) => s.planCargando);

  return (
    <div style={seccion}>
      <span style={tituloSeccion}>PARÁMETROS DE LA PRÓXIMA ORDEN</span>
      <span style={{ fontSize: 9.5, lineHeight: 1.35, color: T.texto3 }}>
        El Take Profit y los dos márgenes salen con la orden al pulsar «Abrir». Para cambiarlos en
        algo ya abierto, use «Sobre posiciones abiertas».
      </span>
      {CAMPOS.map((c) => {
        const valor = valores[c.campo];
        const activo = valor.trim() !== '';
        /* Solo el apalancamiento es una operación por sí mismo; el resto sale al abrir. */
        const plan = c.plan;
        return (
          <div key={c.campo} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {plan !== null ? (
              <button
                type="button"
                disabled={planCargando}
                onClick={() => void planear(plan)}
                title={`Aplicar ${c.etiqueta} a las casillas marcadas. Enseña el plan antes de enviar nada.`}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 6,
                  padding: '6px 8px',
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: planCargando ? 'wait' : 'pointer',
                  opacity: planCargando ? 0.6 : 1,
                  whiteSpace: 'nowrap',
                  border: `1.5px solid ${activo ? T.marcaRelleno : T.bordeFuerte}`,
                  background: activo ? T.marcaRelleno : T.superficie,
                  color: activo ? '#ffffff' : T.texto3
                }}
              >
                {c.etiqueta}
                <span
                  style={{
                    flex: 'none',
                    fontSize: 8.5,
                    fontWeight: 700,
                    letterSpacing: '.1em',
                    padding: '2px 5px',
                    borderRadius: 4,
                    border: `1px solid ${activo ? 'rgba(255,255,255,.55)' : T.bordeFuerte}`,
                    color: activo ? '#ffffff' : T.texto3
                  }}
                >
                  APLICAR
                </span>
              </button>
            ) : (
              <span
                title="Viaja dentro de la orden al pulsar «Abrir». Para aplicarlo sobre una posición que ya está abierta, use los campos de «Sobre posiciones abiertas»."
                style={{ padding: '6px 8px', fontSize: 11, fontWeight: 600, color: T.texto3, whiteSpace: 'nowrap' }}
              >
                {c.etiqueta}
                <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 600, color: T.texto3 }}>
                  sale al abrir
                </span>
              </span>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, border: `1.5px solid ${activo ? T.marcaRelleno : T.bordeSuave}`, borderRadius: 6, background: activo ? T.seleccion : T.fondoCampo, padding: '5px 7px' }}>
              <input
                className="pcb-campo"
                value={valor}
                onChange={(e) => fijarValor(c.campo, e.target.value)}
                inputMode="decimal"
                placeholder={c.marcador}
                style={{ flex: '1 1 0', width: '100%', minWidth: 0, border: 'none', outline: 'none', background: 'transparent', fontFamily: FUENTE.mono, fontSize: 12, fontWeight: 700, color: activo ? T.texto : T.texto3, textAlign: 'right' }}
              />
              <span style={{ flex: 'none', fontSize: 9, fontWeight: 600, color: T.texto3, fontFamily: FUENTE.mono }}>{c.unidad}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Un campo con su unidad, del mismo aspecto que los de PARÁMETROS.
 *
 * Existe para que la sección de ajustes no vuelva a dibujar el mismo `input`
 * con los mismos ocho estilos: dos copias del mismo campo son dos campos que
 * pueden acabar pareciendo distintos sin que nadie lo decida.
 */
function CampoNumerico({
  campo,
  unidad,
  marcador
}: {
  campo: keyof ValoresHerramientas;
  unidad: string;
  marcador: string;
}) {
  const valor = usarPanel((s) => s.valores[campo]);
  const fijarValor = usarPanel((s) => s.fijarValor);
  const activo = valor.trim() !== '';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, border: `1.5px solid ${activo ? T.marcaRelleno : T.bordeSuave}`, borderRadius: 6, background: activo ? T.seleccion : T.fondoCampo, padding: '5px 7px' }}>
      <input
        className="pcb-campo"
        value={valor}
        onChange={(e) => fijarValor(campo, e.target.value)}
        inputMode="decimal"
        placeholder={marcador}
        style={{ flex: '1 1 0', width: '100%', minWidth: 0, border: 'none', outline: 'none', background: 'transparent', fontFamily: FUENTE.mono, fontSize: 12, fontWeight: 700, color: activo ? T.texto : T.texto3, textAlign: 'right' }}
      />
      <span style={{ flex: 'none', fontSize: 9, fontWeight: 600, color: T.texto3, fontFamily: FUENTE.mono }}>{unidad}</span>
    </div>
  );
}

/**
 * Lo que se puede cambiar en una posición que **ya está abierta**.
 *
 * --------------------------------------------------------------------------
 * Por qué esta sección existe y por qué está separada
 * --------------------------------------------------------------------------
 * El cliente necesita corregir lo que ya está en el mercado: una posición que
 * quedó sin Take Profit, otra a la que hay que darle colchón antes de que se
 * acerque la liquidación, y otra a la que hay que quitárselo para recuperar
 * saldo. Eso no se puede resolver cerrando y volviendo a abrir —el precio de
 * reapertura es otro, y sobre cien casillas esa diferencia es el coste—.
 *
 * Está aparte de PARÁMETROS, con sus propios campos, porque la primera vez que
 * existió compartía los de la apertura: el importe se escribía arriba, salía
 * con la orden, se quedaba escrito, y el botón de al lado lo volvía a enviar.
 * El 26/08/2026 una posición acabó con el doble del margen aprobado. Aquí se
 * teclea lo que se aplica a lo abierto, y solo eso.
 *
 * Agregar y quitar margen son **dos botones y un solo campo**. No es un signo:
 * un `-` de más o de menos convierte un aporte en una retirada, y una retirada
 * acerca la liquidación. Lo que decide el sentido es el botón que se pulsa, y
 * la confirmación lo enseña como «margen 5 → 3» antes de enviar nada.
 */
function AjustesPosicionAbierta() {
  const planear = usarPanel((s) => s.planear);
  const planCargando = usarPanel((s) => s.planCargando);
  const tpAjuste = usarPanel((s) => s.valores.tpAjuste);
  const mgAjuste = usarPanel((s) => s.valores.mgAjuste);

  const primario = (activo: boolean): CSSProperties => ({
    flex: '1 1 0',
    padding: '7px 4px',
    borderRadius: 6,
    fontSize: 11,
    fontWeight: 700,
    cursor: planCargando ? 'wait' : 'pointer',
    opacity: planCargando ? 0.6 : 1,
    whiteSpace: 'nowrap',
    border: `1.5px solid ${activo ? T.marcaRelleno : T.bordeFuerte}`,
    background: activo ? T.marcaRelleno : T.superficie,
    color: activo ? '#ffffff' : T.texto3
  });

  const secundario: CSSProperties = {
    flex: '1 1 0',
    padding: '6px 4px',
    borderRadius: 6,
    fontSize: 10.5,
    fontWeight: 600,
    cursor: planCargando ? 'wait' : 'pointer',
    opacity: planCargando ? 0.6 : 1,
    whiteSpace: 'nowrap',
    border: `1px dashed ${T.bordeFuerte}`,
    background: 'transparent',
    color: T.texto3
  };

  return (
    <div style={seccion}>
      <span style={tituloSeccion}>SOBRE POSICIONES ABIERTAS</span>
      <span style={{ fontSize: 9.5, lineHeight: 1.35, color: T.texto3 }}>
        Actúa sobre lo que ya está en el mercado, en las casillas marcadas. Cada botón enseña el
        plan —con lo que hay ahora y cómo quedará— antes de enviar nada.
      </span>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ fontSize: 10, fontWeight: 600, color: T.texto3 }}>Take Profit</span>
        <CampoNumerico campo="tpAjuste" unidad="%" marcador="0.00" />
        <button
          type="button"
          disabled={planCargando}
          onClick={() => void planear('tp')}
          title="Poner ese Take Profit en las casillas marcadas. Si la posición ya tiene uno, lo SUSTITUYE: nunca quedan dos."
          style={primario(tpAjuste.trim() !== '')}
        >
          Poner Take Profit
        </button>
        {/*
          * Quitar no lleva campo: actúa sobre lo que hay puesto, sea el que sea.
          * Va con aspecto secundario porque no es frecuente y ponerlo igual que
          * los demás invitaría a pulsarlo por inercia.
          */}
        <button
          type="button"
          disabled={planCargando}
          onClick={() => void planear('tp-remove')}
          title="Quitar el Take Profit que tengan puesto las casillas marcadas. Esas posiciones quedan sin protección."
          style={secundario}
        >
          Quitar Take Profit
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ fontSize: 10, fontWeight: 600, color: T.texto3 }}>Margen</span>
        <CampoNumerico campo="mgAjuste" unidad="USDT" marcador="0.000" />
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            type="button"
            disabled={planCargando}
            onClick={() => void planear('margin-add')}
            title="Agregar ese margen a las posiciones marcadas. Sale del saldo disponible y aleja la liquidación. Solo en margen AISLADO."
            style={primario(mgAjuste.trim() !== '')}
          >
            Agregar
          </button>
          <button
            type="button"
            disabled={planCargando}
            onClick={() => void planear('margin-remove')}
            title="Retirar ese margen de las posiciones marcadas. Vuelve al saldo disponible y ACERCA la liquidación. Solo en margen AISLADO."
            style={secundario}
          >
            Quitar
          </button>
        </div>
        <span style={{ fontSize: 9, lineHeight: 1.35, color: T.texto3 }}>
          Escriba la cantidad sin signo: el sentido lo decide el botón. Quitar margen acerca la
          liquidación.
        </span>
      </div>
    </div>
  );
}

/**
 * Aislado o cruzado, para la próxima apertura.
 *
 * Es el selector que pidió el cliente el 25/08/2026, y no es una comodidad: el
 * modo viaja **dentro** de la orden, así que abrir lo deja configurado en ese
 * activo. Antes salía de la ficha de la cuenta —leída de un solo símbolo y
 * aplicada a todos—, de modo que abrir SOL con la ficha de BTC pasaba SOL a
 * cruzado sin que nadie lo pidiera, y en cruzado «Margen adicional» no existe.
 *
 * La pista de cada botón dice qué implica, porque la diferencia no es de
 * preferencia: en cruzado el margen sale del saldo total de la cuenta y lo
 * reparte Bitget, así que agregar margen a una posición concreta no es posible.
 */
function SelectorModoMargen() {
  const modoMargen = usarPanel((s) => s.modoMargen);
  const fijarModoMargen = usarPanel((s) => s.fijarModoMargen);

  const MODOS: { id: 'isolated' | 'crossed'; etiqueta: string; pista: string }[] = [
    {
      id: 'isolated',
      etiqueta: 'Aislado',
      pista: 'El margen queda acotado a cada posición. Es el único modo en el que Bitget permite agregar margen adicional.'
    },
    {
      id: 'crossed',
      etiqueta: 'Cruzado',
      pista: 'El margen sale del saldo total de la cuenta y lo reparte Bitget. En este modo NO se puede agregar margen adicional a una posición.'
    }
  ];

  return (
    <div style={seccion}>
      <span style={tituloSeccion}>MODO DE MARGEN</span>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
        {MODOS.map((m) => {
          const activo = modoMargen === m.id;
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => fijarModoMargen(m.id)}
              title={m.pista}
              style={{ padding: '7px 2px', borderRadius: 6, fontSize: 11.5, fontWeight: 600, cursor: 'pointer', border: `1.5px solid ${activo ? T.marcaRelleno : T.bordeFuerte}`, background: activo ? T.seleccion : T.superficie, color: activo ? T.marcaTexto : T.texto3 }}
            >
              {m.etiqueta}
            </button>
          );
        })}
      </div>
      {modoMargen === 'crossed' && (
        <span style={{ fontSize: 9.5, lineHeight: 1.35, color: T.texto3 }}>
          En cruzado no se puede agregar margen adicional: si el campo tiene valor, no se abre nada.
        </span>
      )}
    </div>
  );
}

function SelectorTipoOrden() {
  const tipoOrden = usarPanel((s) => s.tipoOrden);
  const fijarTipoOrden = usarPanel((s) => s.fijarTipoOrden);
  const limitPrice = usarPanel((s) => s.limitPrice);
  const fijarLimitPrice = usarPanel((s) => s.fijarLimitPrice);

  const TIPOS: { id: 'market' | 'limit'; etiqueta: string; pista: string }[] = [
    { id: 'market', etiqueta: 'Market', pista: 'Ejecuta al mejor precio disponible' },
    { id: 'limit', etiqueta: 'Limit', pista: 'Ejecuta solo al precio límite indicado' }
  ];

  return (
    <div style={seccion}>
      <span style={tituloSeccion}>TIPO DE ORDEN</span>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
        {TIPOS.map((t) => {
          const activo = tipoOrden === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => fijarTipoOrden(t.id)}
              title={t.pista}
              style={{ padding: '7px 2px', borderRadius: 6, fontSize: 11.5, fontWeight: 600, cursor: 'pointer', border: `1.5px solid ${activo ? T.marcaRelleno : T.bordeFuerte}`, background: activo ? T.seleccion : T.superficie, color: activo ? T.marcaTexto : T.texto3 }}
            >
              {t.etiqueta}
            </button>
          );
        })}
      </div>
      {tipoOrden === 'limit' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: T.texto3, whiteSpace: 'nowrap' }}>Precio límite</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, border: `1.5px solid ${limitPrice.trim() ? T.marcaRelleno : T.bordeSuave}`, borderRadius: 6, background: limitPrice.trim() ? T.seleccion : T.fondoCampo, padding: '5px 7px' }}>
            <input
              className="pcb-campo"
              value={limitPrice}
              onChange={(e) => fijarLimitPrice(e.target.value)}
              inputMode="decimal"
              placeholder="0.00"
              style={{ flex: '1 1 0', width: '100%', minWidth: 0, border: 'none', outline: 'none', background: 'transparent', fontFamily: FUENTE.mono, fontSize: 12, fontWeight: 700, color: T.texto, textAlign: 'right' }}
            />
            <span style={{ flex: 'none', fontSize: 9, fontWeight: 600, color: T.texto3, fontFamily: FUENTE.mono }}>USDT</span>
          </div>
        </div>
      )}
    </div>
  );
}

function InterruptorValoresFijos() {
  const valoresFijos = usarPanel((s) => s.valoresFijos);
  const alternarValoresFijos = usarPanel((s) => s.alternarValoresFijos);

  return (
    <button
      type="button"
      onClick={alternarValoresFijos}
      title="Con valores fijos activados los campos NO se limpian al aplicar"
      style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 8px', borderRadius: 7, fontSize: 11, fontWeight: 700, cursor: 'pointer', border: `1.5px solid ${valoresFijos ? T.marcaRelleno : T.bordeFuerte}`, background: valoresFijos ? T.seleccion : T.superficie, color: valoresFijos ? T.marcaTexto : T.texto3 }}
    >
      <span style={{ flex: 'none', width: 24, height: 13, borderRadius: 8, padding: 1.5, display: 'flex', background: valoresFijos ? T.marcaRelleno : T.bordeFuerte, justifyContent: valoresFijos ? 'flex-end' : 'flex-start' }}>
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#ffffff', display: 'block' }} />
      </span>
      Valores fijos · {valoresFijos ? 'ACTIVADO' : 'desactivado'}
    </button>
  );
}

/**
 * Selección de todas las casillas y su contrario.
 *
 * El contrato pide poder operar «sobre una cuenta, varias o todas». Sin estos
 * dos botones, «todas» era pulsar una vez por cada cuenta principal, y deshacer
 * la selección era destildar a mano — con el riesgo de que una casilla olvidada
 * reciba la siguiente acción.
 */
function ControlesSeleccion() {
  const seleccionarTodo = usarPanel((s) => s.seleccionarTodo);
  const limpiarSeleccion = usarPanel((s) => s.limpiarSeleccion);
  const seleccionadas = usarPanel((s) => s.contarSeleccion());
  const hayCuentas = usarPanel((s) => s.cuentas.length > 0);

  const boton: CSSProperties = {
    flex: '1 1 0',
    padding: '6px 2px',
    borderRadius: 6,
    fontSize: 10.5,
    fontWeight: 700,
    cursor: 'pointer',
    border: `1.5px solid ${T.bordeFuerte}`,
    background: T.superficie,
    color: T.texto2
  };

  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <button
        type="button"
        className="pcb-boton-claro"
        onClick={seleccionarTodo}
        disabled={!hayCuentas}
        title="Marcar todas las casillas de todas las cuentas principales"
        style={{ ...boton, opacity: hayCuentas ? 1 : 0.45, cursor: hayCuentas ? 'pointer' : 'default' }}
      >
        Todas
      </button>
      <button
        type="button"
        className="pcb-boton-claro"
        onClick={limpiarSeleccion}
        disabled={seleccionadas === 0}
        title="Quitar la selección de todas las casillas"
        style={{
          ...boton,
          opacity: seleccionadas === 0 ? 0.45 : 1,
          cursor: seleccionadas === 0 ? 'default' : 'pointer'
        }}
      >
        Ninguna
      </button>
    </div>
  );
}

function EtiquetaSeleccion() {
  const mensaje = usarPanel((s) => s.mensaje);
  const seleccionadas = usarPanel((s) => s.contarSeleccion());
  const rotulo = mensaje || (seleccionadas === 0 ? 'Ninguna casilla seleccionada' : `${seleccionadas} ${seleccionadas === 1 ? 'casilla seleccionada' : 'casillas seleccionadas'}`);

  return (
    <div style={{ marginTop: 'auto', paddingTop: 8, fontSize: 10, lineHeight: 1.35, color: T.texto3, fontVariantNumeric: 'tabular-nums' }}>
      {rotulo}
    </div>
  );
}

/**
 * El orden de la barra, de arriba abajo.
 *
 * --------------------------------------------------------------------------
 * Por qué la ejecución arriba y el activo abajo
 * --------------------------------------------------------------------------
 * Era al revés hasta el 28/08/2026: se elegía activo, se bajaba a los botones y
 * se seguía bajando a los parámetros. El cliente pidió invertirlo, y el orden
 * que queda es el de la frecuencia de uso: **Abrir**, **Cerrar** y los
 * parámetros se tocan en cada operación; el activo se elige una vez y se deja
 * puesto, así que ocupar con él la parte alta era gastar el sitio más accesible
 * en lo que menos se pulsa.
 *
 * El activo queda debajo de «Todas / Ninguna», que es la otra cosa que se ajusta
 * poco, y el precio de ese activo se fue a la cabecera —junto al distintivo del
 * mercado—, donde se lee sin tener que mirar la barra.
 */
export function BarraLateral() {
  return (
    <div style={{ height: '100%', flex: 'none', width: 228, display: 'flex', flexDirection: 'column', gap: 10, padding: 10, background: T.superficie, borderLeft: `1px solid ${T.bordeFuerte}`, overflowY: 'auto', overflowX: 'hidden' }}>
      <ControlesEjecucion />
      <div style={{ height: 1, background: T.borde }} />
      <CamposParametro />
      <div style={{ height: 1, background: T.borde }} />
      {/*
        * Debajo de los parámetros de la orden y antes del modo de margen: el
        * orden de la barra es el del recorrido de una operación —se abre, y
        * después se corrige lo abierto—, y la separación visual es parte de lo
        * que impide confundir un campo con el otro. Ver `AjustesPosicionAbierta`.
        */}
      <AjustesPosicionAbierta />
      <div style={{ height: 1, background: T.borde }} />
      <SelectorModoMargen />
      <SelectorTipoOrden />
      <InterruptorValoresFijos />
      <div style={{ height: 1, background: T.borde }} />
      <ControlesSeleccion />
      <div style={{ height: 1, background: T.borde }} />
      <SelectorActivo />
      <EtiquetaSeleccion />
    </div>
  );
}
