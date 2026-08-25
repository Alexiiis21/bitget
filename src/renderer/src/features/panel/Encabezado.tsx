import type { CSSProperties } from 'react';
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
  const numeroPanel = usarPanel((s) => s.numeroPanel);
  const fijarNumeroPanel = usarPanel((s) => s.fijarNumeroPanel);
  const tema = usarPanel((s) => s.tema);
  const fijarTema = usarPanel((s) => s.fijarTema);
  const apiKeys = usarPanel((s) => s.apiKeys);
  const cuentas = usarPanel((s) => s.cuentas);
  const abrirApis = usarPanel((s) => s.abrirApis);
  const abrirSeguridad = usarPanel((s) => s.abrirSeguridad);
  const bloquear = usarPanel((s) => s.bloquear);

  const conectadas = apiKeys.filter((a) => a.status === 'ok').length;
  const conexion = conexionDelPanel(cuentas);

  return (
    <div style={barra}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.14em', color: '#8ccdf5', fontFamily: FUENTE.mono }}>
          PCB
        </span>
        <span style={{ fontSize: 15, fontWeight: 600, whiteSpace: 'nowrap' }}>Panel de Control Bitget</span>
        <span
          title="Número de este panel · editable"
          style={{ fontSize: 18, fontWeight: 700, color: '#8ccdf5', fontFamily: FUENTE.mono, display: 'flex', alignItems: 'center', gap: 2 }}
        >
          <span>#</span>
          <input
            className="pcb-campo"
            value={numeroPanel}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value.replace(/[^0-9]/g, '').slice(0, 6), 10);
              if (Number.isFinite(n) && n >= 1) void fijarNumeroPanel(n);
            }}
            inputMode="numeric"
            style={{
              width: `${Math.max(1, String(numeroPanel).length)}ch`,
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
        <DistintivoMercado />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div
          title="Estado de las credenciales registradas, según la última comprobación contra Bitget"
          style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#95c9ea' }}
        >
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: conexion.color, display: 'block' }} />
          {conexion.texto}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: 2, borderRadius: 20, border: '1px solid #ffffff2e', background: '#ffffff14' }}>
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

        <button type="button" className="pcb-boton-barra" onClick={abrirApis} title="Gestión de API keys de las subcuentas" style={botonBarra}>
          API keys
          <span style={{ fontSize: 10.5, fontFamily: FUENTE.mono, color: '#95c9ea' }}>
            {conectadas} de {apiKeys.length}
          </span>
        </button>

        <button type="button" className="pcb-boton-barra" onClick={abrirSeguridad} title="Configurar la contraseña de paso" style={botonBarra}>
          Seguridad
        </button>

        <button type="button" className="pcb-boton-salir" onClick={bloquear} title="Cerrar sesión y bloquear el panel" style={{ ...botonBarra, fontWeight: 600 }}>
          Cerrar sesión
        </button>
      </div>
    </div>
  );
}
