import { useState, type CSSProperties } from 'react';
import { FUENTE, T } from '@/lib/tokens';
import { usarPanel } from '@/store/panel';

/**
 * Cabecera del panel.
 *
 * Lleva el número de instancia -editable por el operador en este diseño- y
 * el interruptor de tema, que solo cambia un atributo en `<body>`: los
 * colores los resuelve la cascada de CSS, ningún componente vuelve a
 * renderizarse por esto. docs/cliente/PCB-standalone.html.
 */

const barra: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '12px 20px',
  background: T.marca,
  color: '#ffffff'
};

const botonBarra: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '5px 9px',
  borderRadius: 7,
  fontSize: 11.5,
  fontWeight: 500,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  border: '1px solid #ffffff2e',
  background: '#ffffff14',
  color: '#ffffff'
};

/**
 * Contra qué mercado opera este panel, a la vista y siempre.
 *
 * El mismo ejecutable sirve para los dos: lo decide `config.json` en la carpeta
 * de datos, no la compilación. Sin este distintivo, la única forma de saber si
 * la próxima orden mueve dinero real sería abrir un archivo de texto — y es
 * también la comprobación de que el `config.json` entregado se copió donde
 * debía. Va en rojo cuando es real porque ahí el error se paga.
 */
function DistintivoMercado() {
  const mercado = usarPanel((s) => s.mercado);
  const real = mercado === 'real';

  return (
    <span
      title={
        real
          ? 'Este panel opera contra el mercado real de Bitget: las órdenes mueven dinero de verdad.'
          : 'Este panel opera contra el mercado simulado de Bitget: las órdenes no mueven dinero real.'
      }
      style={{
        flex: 'none',
        padding: '3px 9px',
        borderRadius: 6,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '.1em',
        whiteSpace: 'nowrap',
        fontFamily: FUENTE.mono,
        border: `1px solid ${real ? '#ff6b6b' : '#ffffff2e'}`,
        background: real ? '#e0313166' : '#ffffff14',
        color: real ? '#ffd7d7' : '#95c9ea'
      }}
    >
      {real ? 'MERCADO REAL' : 'SIMULADO'}
    </span>
  );
}

/**
 * El número de este panel, editable.
 *
 * --------------------------------------------------------------------------
 * Por qué hace falta un borrador y no basta con el valor del store
 * --------------------------------------------------------------------------
 * El campo escribía el número directamente y descartaba todo lo que no fuera un
 * entero ≥ 1. Parecía razonable y hacía el campo **inservible**: borrar el «1»
 * para teclear otro deja la caja vacía un instante, y una caja vacía no es un
 * entero, así que el borrado se descartaba y el dígito volvía a aparecer. No
 * había forma de cambiarlo salvo seleccionarlo entero y sobrescribirlo de una.
 *
 * El borrador es ese estado intermedio: mientras se teclea manda lo escrito, el
 * store recibe el valor solo cuando es válido, y al salir del campo el borrador
 * se suelta —si se dejó vacío, vuelve el número que había—. Ningún estado
 * inválido llega a persistirse.
 */
function NumeroPanel() {
  const numeroPanel = usarPanel((s) => s.numeroPanel);
  const fijarNumeroPanel = usarPanel((s) => s.fijarNumeroPanel);
  /** Lo tecleado mientras dura la edición. `null` = manda el store. */
  const [borrador, fijarBorrador] = useState<string | null>(null);

  const texto = borrador ?? String(numeroPanel);

  return (
    <span
      title="Número de este panel. Se guarda en el equipo y se conserva al reiniciar."
      style={{
        flex: 'none',
        fontSize: 18,
        fontWeight: 700,
        color: '#8ccdf5',
        fontFamily: FUENTE.mono,
        display: 'flex',
        alignItems: 'center',
        gap: 2
      }}
    >
      <span>#</span>
      <input
        className="pcb-campo"
        value={texto}
        onChange={(e) => {
          const limpio = e.target.value.replace(/[^0-9]/g, '').slice(0, 6);
          fijarBorrador(limpio);
          const n = Number.parseInt(limpio, 10);
          if (Number.isFinite(n) && n >= 1 && n !== numeroPanel) void fijarNumeroPanel(n);
        }}
        onBlur={() => fijarBorrador(null)}
        inputMode="numeric"
        style={{
          width: `${Math.max(1, texto.length)}ch`,
          minWidth: 38,
          padding: '2px 5px',
          borderRadius: 6,
          border: '1px solid #ffffff33',
          background: '#ffffff14',
          outline: 'none',
          color: '#8ccdf5',
          fontFamily: FUENTE.mono,
          fontSize: 18,
          fontWeight: 700,
          textAlign: 'center'
        }}
      />
    </span>
  );
}

/**
 * Precio del activo seleccionado, al lado del distintivo de mercado.
 *
 * --------------------------------------------------------------------------
 * Por qué aquí y no en la barra lateral
 * --------------------------------------------------------------------------
 * Estuvo bajo el selector de activo hasta el 28/08/2026. El cliente lo pidió
 * arriba, y encaja: es el único número de la pantalla que cambia solo y que se
 * mira **mientras** se hace otra cosa —marcar casillas, escribir el margen—, así
 * que tenerlo en la barra obligaba a apartar la vista de la matriz. Junto al
 * distintivo del mercado queda además lo que hay que saber antes de enviar nada:
 * contra qué mercado se opera y a cuánto está.
 *
 * Es el **precio de marca**, el mismo con el que se dimensiona una apertura, no
 * el último negociado: enseñar uno y calcular con otro haría creer al operador
 * que el panel calcula mal. El activo va delante porque sin él el número no
 * dice nada, y el par lleva su propia moneda —`BTC/SUSDT` en el mercado de
 * pruebas—, así que no hace falta rotularla aparte.
 */
function UltimoPrecio() {
  const activos = usarPanel((s) => s.activos);
  const activoId = usarPanel((s) => s.activoId);
  const precios = usarPanel((s) => s.precios);
  const activo = activos.find((a) => a.id === activoId);

  return (
    <span
      title="Precio de marca del activo seleccionado. Es el mismo con el que el panel calcula las cantidades de una apertura."
      style={{
        flex: 'none',
        display: 'flex',
        alignItems: 'baseline',
        gap: 6,
        padding: '3px 9px',
        borderRadius: 6,
        whiteSpace: 'nowrap',
        fontFamily: FUENTE.mono,
        border: '1px solid #ffffff2e',
        background: '#ffffff14'
      }}
    >
      <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.1em', color: '#8ccdf5' }}>
        ÚLTIMO
      </span>
      <span style={{ fontSize: 11, fontWeight: 600, color: '#95c9ea' }}>
        {activo?.label ?? '—'}
      </span>
      <span style={{ fontSize: 13, fontWeight: 700, color: '#ffffff' }}>
        {activo === undefined ? '—' : (precios[activo.id] ?? '—')}
      </span>
    </span>
  );
}

/**
 * Estado de conexión del panel, a partir de las subcuentas registradas.
 *
 * Antes era un punto verde fijo en el código: decía «en línea» siempre, sin
 * consultar nada. Un indicador que no puede decir «no» no informa de nada, y
 * en una herramienta que manda órdenes con dinero de por medio es peor que no
 * tenerlo. RF-002.
 */
function conexionDelPanel(cuentas: { subAccounts: { status: string }[] }[]): {
  texto: string;
  color: string;
} {
  const subs = cuentas.flatMap((c) => c.subAccounts);
  if (subs.length === 0) return { texto: 'sin cuentas', color: '#8794a0' };

  const caidas = subs.filter((s) => s.status === 'error' || s.status === 'sin-api').length;
  if (caidas === 0) return { texto: 'en línea', color: '#35b6f5' };
  if (caidas === subs.length) return { texto: 'sin conexión', color: '#e03131' };
  return { texto: `${caidas} sin conexión`, color: '#f2b705' };
}

export function Encabezado() {
  const tema = usarPanel((s) => s.tema);
  const fijarTema = usarPanel((s) => s.fijarTema);
  const apiKeys = usarPanel((s) => s.apiKeys);
  const cuentas = usarPanel((s) => s.cuentas);
  const abrirApis = usarPanel((s) => s.abrirApis);
  const abrirSaldos = usarPanel((s) => s.abrirSaldos);
  const abrirSeguridad = usarPanel((s) => s.abrirSeguridad);
  const abrirColores = usarPanel((s) => s.abrirColores);
  const bloquear = usarPanel((s) => s.bloquear);

  const conectadas = apiKeys.filter((a) => a.status === 'ok').length;
  const conexion = conexionDelPanel(cuentas);

  return (
    <div style={barra}>
      {/*
       * El nombre del panel es lo único que puede encogerse.
       *
       * Con el precio al lado del distintivo de mercado, el grupo izquierdo
       * pasa a competir por el ancho con los botones de la derecha en las
       * ventanas más estrechas que admite el diseño. Los datos —número,
       * mercado, precio— no se recortan: se recorta el rótulo, que es el único
       * que el operador ya se sabe.
       */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
        <span
          style={{
            flex: 'none',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '.14em',
            color: '#8ccdf5',
            fontFamily: FUENTE.mono
          }}
        >
          PCB
        </span>
        <span
          style={{
            minWidth: 0,
            fontSize: 15,
            fontWeight: 600,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
        >
          Panel de Control Bitget
        </span>
        <NumeroPanel />
        <DistintivoMercado />
        <UltimoPrecio />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div
          title="Estado de las credenciales registradas, según la última comprobación contra Bitget"
          style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#95c9ea' }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: conexion.color,
              display: 'block'
            }}
          />
          {conexion.texto}
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            padding: 2,
            borderRadius: 20,
            border: '1px solid #ffffff2e',
            background: '#ffffff14'
          }}
        >
          <button
            type="button"
            onClick={() => fijarTema('light')}
            title="Modo claro"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              padding: '3px 9px',
              borderRadius: 16,
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              border: 'none',
              background: tema === 'light' ? '#ffffff' : 'transparent',
              color: tema === 'light' ? '#08243c' : '#95c9ea'
            }}
          >
            ☀ Claro
          </button>
          <button
            type="button"
            onClick={() => fijarTema('dark')}
            title="Modo oscuro"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              padding: '3px 9px',
              borderRadius: 16,
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              border: 'none',
              background: tema === 'dark' ? '#35b6f5' : 'transparent',
              color: tema === 'dark' ? '#08243c' : '#95c9ea'
            }}
          >
            ☾ Oscuro
          </button>
        </div>

        <div style={{ width: 1, height: 22, background: '#ffffff26' }} />

        <button
          type="button"
          className="pcb-boton-barra"
          onClick={abrirApis}
          title="Gestión de API keys de las subcuentas"
          style={botonBarra}
        >
          API keys
          <span style={{ fontSize: 10.5, fontFamily: FUENTE.mono, color: '#95c9ea' }}>
            {conectadas} de {apiKeys.length}
          </span>
        </button>

        <button
          type="button"
          className="pcb-boton-barra"
          onClick={abrirSaldos}
          title="Saldo de futuros de cada subcuenta, y cuánto puede salir de cada una"
          style={botonBarra}
        >
          Saldos
        </button>

        <button
          type="button"
          className="pcb-boton-barra"
          onClick={abrirSeguridad}
          title="Configurar la contraseña de paso"
          style={botonBarra}
        >
          Seguridad
        </button>

        {/* Junto al interruptor de tema y a Seguridad, que es donde ya viven los ajustes. */}
        <button
          type="button"
          className="pcb-boton-barra"
          onClick={abrirColores}
          title="Cambiar los colores de estado de la matriz"
          style={botonBarra}
        >
          Colores
        </button>

        <button
          type="button"
          className="pcb-boton-salir"
          onClick={bloquear}
          title="Cerrar sesión y bloquear el panel"
          style={{ ...botonBarra, fontWeight: 600 }}
        >
          Cerrar sesión
        </button>
      </div>
    </div>
  );
}
