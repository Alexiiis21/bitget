import type { CSSProperties } from 'react';
import { FUENTE, T } from '@/lib/tokens';
import { usarPanel } from '@/store/panel';
import type { PlanKind } from '@shared/domain/panel-view';
import type { AlcanceLado, ValoresHerramientas } from './tipos';

/**
 * Barra lateral: selector de activo, ejecución, parámetros, tipo de orden.
 *
 * Cada sub-bloque es su propio componente exportado (`SelectorActivo`,
 * `ControlesEjecucion`, `CamposParametro`, `SelectorTipoOrden`,
 * `InterruptorValoresFijos`, `BotonAplicarTodo`) y `BarraLateral` solo los
 * apila en columna — así el layout se puede reordenar sin tocar la lógica de
 * cada pieza. Van en un solo archivo porque comparten el mismo ancho fijo y
 * el mismo ritmo vertical; separarlos en cinco archivos de 40 líneas cada
 * uno no aportaría legibilidad.
 */

const seccion: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5 };
const tituloSeccion: CSSProperties = { fontSize: 9, fontWeight: 700, letterSpacing: '.12em', color: T.texto3 };

function SelectorActivo() {
  const activos = usarPanel((s) => s.activos);
  const activoId = usarPanel((s) => s.activoId);
  const fijarActivo = usarPanel((s) => s.fijarActivo);
  const precios = usarPanel((s) => s.precios);
  const activo = activos.find((a) => a.id === activoId);

  return (
    <div style={seccion}>
      <span style={tituloSeccion}>ACTIVO · FUTUROS USDT-M</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {activos.map((a) => {
          const activa = a.id === activoId;
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => fijarActivo(a.id)}
              title={`${a.label} · futuros USDT-M`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                padding: '6px 8px',
                borderRadius: 6,
                fontSize: 11.5,
                fontWeight: 700,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                fontFamily: FUENTE.mono,
                border: `1.5px solid ${activa ? T.marcaRelleno : T.bordeFuerte}`,
                background: activa ? T.seleccion : T.superficie,
                color: activa ? T.marcaTexto : T.texto3
              }}
            >
              <span style={{ flex: 'none', width: 7, height: 7, borderRadius: '50%', background: activa ? T.marcaRelleno : T.bordeFuerte, display: 'block' }} />
              {a.label}
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 6, padding: '4px 7px', borderRadius: 6, background: T.superficie2, border: `1px solid ${T.borde}` }}>
        <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: '.08em', color: T.texto3 }}>ÚLTIMO</span>
        <span style={{ fontSize: 12, fontWeight: 700, fontFamily: FUENTE.mono, color: T.texto }}>
          {activo ? (precios[activo.id] ?? '—') : '—'} USDT
        </span>
      </div>
    </div>
  );
}

function ControlesEjecucion() {
  const planear = usarPanel((s) => s.planear);
  const planCargando = usarPanel((s) => s.planCargando);
  const alcance = usarPanel((s) => s.alcance);
  const fijarAlcance = usarPanel((s) => s.fijarAlcance);

  const ALCANCES: { id: AlcanceLado; etiqueta: string }[] = [
    { id: 'long', etiqueta: 'Long' },
    { id: 'ambos', etiqueta: 'Ambos' },
    { id: 'short', etiqueta: 'Short' }
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

      {/*
        * Quitar el Take Profit va aparte de los otros dos y con aspecto de
        * acción secundaria: no es una operación frecuente, y ponerla junto a
        * «Cerrar» invitaría a pulsarla por inercia. El cliente la pidió porque
        * a veces opera sin Take Profit y cierra a mano.
        */}
      <button
        type="button"
        disabled={planCargando}
        onClick={() => void planear('tp-remove')}
        title="Quitar el Take Profit de las casillas seleccionadas"
        style={{ padding: '6px', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: planCargando ? 'wait' : 'pointer', opacity: planCargando ? 0.6 : 1, border: `1px dashed ${T.bordeFuerte}`, background: 'transparent', color: T.texto3 }}
      >
        Quitar Take Profit
      </button>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {ALCANCES.map((a) => {
          const activa = alcance === a.id;
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => fijarAlcance(a.id)}
              title="Lado al que se aplican las acciones"
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
 * `plan: null` significa que el campo no es una operación por sí mismo.
 *
 * Es el caso del margen inicial: no se aplica suelto, viaja dentro de la
 * apertura. Por eso su rótulo es un rótulo y no un botón — antes lo era, con el
 * mismo aspecto que los demás y sin hacer nada al pulsarlo.
 */
const CAMPOS: DefinicionCampo[] = [
  { campo: 'tp', clave: 'tp', plan: 'tp', etiqueta: 'Take Profit %', unidad: '%', marcador: '0.00' },
  { campo: 'mgi', clave: 'mg', plan: null, etiqueta: 'Margen inicial', unidad: 'USDT', marcador: '0.000' },
  { campo: 'mga', clave: 'mg', plan: 'margin', etiqueta: 'Margen adicional', unidad: 'USDT', marcador: '0.000' },
  { campo: 'ap', clave: 'ap', plan: 'leverage', etiqueta: 'Apalancamiento', unidad: 'x', marcador: '10' }
];

/**
 * Los cuatro campos, y el botón que aplica cada uno **por separado**.
 *
 * --------------------------------------------------------------------------
 * Por qué el botón dice «Aplicar» y lleva su distintivo
 * --------------------------------------------------------------------------
 * Hasta el 26/08/2026 el rótulo de cada campo **era** el botón que aplicaba esa
 * operación, con aspecto de encabezado de sección. Y uno de los cuatro —el
 * margen inicial— no aplicaba nada, así que ni siquiera era una regla que se
 * pudiera aprender pulsando.
 *
 * El resultado lo reportó el cliente el 25/08/2026: creía que la única forma de
 * poner un Take Profit era abriendo una posición, porque abrir era la única
 * acción que la pantalla presentaba como acción. Estas tres operaciones actúan
 * sobre posiciones **ya abiertas**, y es lo que más falta le hace: ajustar el
 * Take Profit o el margen de lo que ya tiene, sin tocar la posición.
 */
function CamposParametro() {
  const valores = usarPanel((s) => s.valores);
  const fijarValor = usarPanel((s) => s.fijarValor);
  const planear = usarPanel((s) => s.planear);
  const planCargando = usarPanel((s) => s.planCargando);

  return (
    <div style={seccion}>
      <span style={tituloSeccion}>PARÁMETROS</span>
      <span style={{ fontSize: 9.5, lineHeight: 1.35, color: T.texto3 }}>
        «Aplicar» actúa sobre las posiciones ya abiertas de las casillas marcadas, sin abrir ninguna.
      </span>
      {CAMPOS.map((c) => {
        const valor = valores[c.campo];
        const activo = valor.trim() !== '';
        /* El margen inicial no es una operación: no lleva botón, lleva rótulo. */
        const suelta = c.plan !== null;
        return (
          <div key={c.campo} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {suelta ? (
              <button
                type="button"
                disabled={planCargando}
                onClick={() => void planear(c.plan as PlanKind)}
                title={`Aplicar ${c.etiqueta} a las posiciones abiertas de las casillas marcadas. Enseña el plan antes de enviar nada.`}
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
                title="El margen inicial no se aplica suelto: sale con la apertura."
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

function BotonAplicarTodo() {
  const planearVarios = usarPanel((s) => s.planearVarios);
  const valores = usarPanel((s) => s.valores);
  const activo = ['tp', 'mgi', 'mga', 'ap'].some((k) => valores[k as keyof ValoresHerramientas].trim() !== '');

  return (
    <button
      type="button"
      onClick={() => void planearVarios(['tp', 'margin', 'leverage'])}
      title="Take Profit, margen adicional y apalancamiento, uno detrás de otro y aprobando cada uno"
      style={{ marginTop: 2, padding: '10px 8px', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', border: `1.5px solid ${activo ? T.marcaRelleno : T.bordeFuerte}`, background: activo ? T.marcaRelleno : T.superficie, color: activo ? '#ffffff' : T.texto3, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7 }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 2, background: activo ? '#8ccdf5' : T.bordeFuerte, display: 'block' }} />
      Aplicar todo
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

export function BarraLateral() {
  return (
    <div style={{ height: '100%', flex: 'none', width: 228, display: 'flex', flexDirection: 'column', gap: 10, padding: 10, background: T.superficie, borderLeft: `1px solid ${T.bordeFuerte}`, overflowY: 'auto', overflowX: 'hidden' }}>
      <SelectorActivo />
      <div style={{ height: 1, background: T.borde }} />
      <ControlesEjecucion />
      <div style={{ height: 1, background: T.borde }} />
      <CamposParametro />
      <div style={{ height: 1, background: T.borde }} />
      <SelectorModoMargen />
      <SelectorTipoOrden />
      <InterruptorValoresFijos />
      <BotonAplicarTodo />
      <div style={{ height: 1, background: T.borde }} />
      <ControlesSeleccion />
      <EtiquetaSeleccion />
    </div>
  );
}
