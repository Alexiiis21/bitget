import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import {
  NO_FILTER,
  type Account,
  type ClosedTrade,
  type TradeHistory
} from '@shared/domain/panel-view';
import { cifra, cifraConSigno, precio } from '@/lib/formato';
import { BOTON_PRIMARIO, FUENTE, T } from '@/lib/tokens';
import { usarPanel } from '@/store/panel';
import { usarHistorial } from '@/store/historial';
import { identificadorCuenta, ZONA_CDMX } from '@shared/historial-csv';
import { EstadoVacio } from './Esqueleto';

/**
 * Historial por periodo y resultado neto.
 *
 * El operador elige una subcuenta y un periodo, y ve sus operaciones cerradas
 * con las columnas de la plataforma oficial, cuántas ganaron y perdieron, la
 * suma del resultado y el saldo de ahora.
 *
 * --------------------------------------------------------------------------
 * Qué se enseña al instante y qué tarda
 * --------------------------------------------------------------------------
 * La tabla y el resumen salen de lo guardado en el equipo y aparecen en cuanto
 * se elige la subcuenta. A la vez se trae de Bitget lo nuevo; mientras dura, la
 * cabecera lo dice, y al terminar la tabla se actualiza sola. El saldo se lee
 * de Bitget cada vez y lleva su hora.
 *
 * --------------------------------------------------------------------------
 * Solo lectura
 * --------------------------------------------------------------------------
 * No hay un solo botón que opere. Es lo que fija el presupuesto, y es lo que
 * permite abrir esta pantalla sin contraseña de paso.
 */

/*
 * Par y lado · Apal./Modo · Apertura · Entrada · Salida · TP · Cantidad · Resultado · % · Cierre
 *
 * Columnas que se reparten el ancho: la tabla entera cabe en la pantalla sin
 * barra horizontal, para que una captura la muestre completa. La API key no es
 * columna: es la misma en todas las filas y va arriba, junto a la subcuenta.
 */
const REJILLA =
  'minmax(120px,1.2fr) minmax(90px,.8fr) minmax(165px,1.4fr) minmax(90px,1fr) ' +
  'minmax(90px,1fr) minmax(90px,1fr) minmax(80px,.9fr) minmax(90px,1fr) minmax(50px,.5fr) ' +
  'minmax(165px,1.4fr)';
const HUECO = 10;

const celda: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
};
const numero: CSSProperties = {
  ...celda,
  textAlign: 'right',
  fontFamily: FUENTE.mono,
  fontVariantNumeric: 'tabular-nums'
};
const campo: CSSProperties = {
  padding: '7px 9px',
  borderRadius: 7,
  border: `1px solid ${T.campoBorde}`,
  background: T.campoFondo,
  color: T.campoTexto,
  fontSize: 13,
  fontFamily: 'inherit'
};
const etiqueta: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '.04em',
  color: T.texto3
};
const tarjeta: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '14px 16px',
  borderRadius: 10,
  border: `1px solid ${T.borde}`,
  background: T.superficie
};

const fechaHora = (ms: number): string =>
  new Date(ms).toLocaleString('es-MX', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

/** La misma fecha que `fechaHora`, pero en una zona fija: la del TP se da en UTC y en CDMX. */
const fechaHoraEn = (ms: number, zona: string): string =>
  new Date(ms).toLocaleString('es-MX', {
    timeZone: zona,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

const hora = (ms: number): string =>
  new Date(ms).toLocaleTimeString('es-MX', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

const dia = (ms: number): string =>
  new Date(ms).toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric' });

/** Verde si ganó, rojo si perdió, neutro si quedó en cero. */
const colorResultado = (v: string): string => {
  const n = Number.parseFloat(v);
  return n > 0 ? T.largo : n < 0 ? T.corto : T.texto2;
};

/* ---------------- selector ---------------- */

function Selector({ cuentas }: { cuentas: Account[] }) {
  const subcuenta = usarHistorial((s) => s.subcuenta);
  const periodo = usarHistorial((s) => s.periodo);
  const elegirSubcuenta = usarHistorial((s) => s.elegirSubcuenta);
  const fijarPeriodo = usarHistorial((s) => s.fijarPeriodo);

  const cuenta = cuentas.find((c) => c.subAccounts.some((s) => s.id === subcuenta)) ?? null;

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 14 }}>
      <label style={etiqueta}>
        CUENTA
        <select
          value={cuenta?.id ?? ''}
          onChange={(e) => {
            const primera = cuentas.find((c) => c.id === e.target.value)?.subAccounts[0];
            if (primera) elegirSubcuenta(primera.id);
          }}
          style={{ ...campo, minWidth: 110 }}
        >
          {cuentas.map((c) => (
            <option key={c.id} value={c.id}>
              Cuenta {c.name}
            </option>
          ))}
        </select>
      </label>

      <label style={etiqueta}>
        SUBCUENTA
        <select
          value={subcuenta ?? ''}
          onChange={(e) => elegirSubcuenta(e.target.value)}
          style={{ ...campo, minWidth: 180 }}
        >
          {(cuenta?.subAccounts ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.slot}. {s.label}
            </option>
          ))}
        </select>
      </label>

      <label style={etiqueta}>
        DESDE
        <input
          type="date"
          value={periodo.from}
          max={periodo.to}
          onChange={(e) => fijarPeriodo({ ...periodo, from: e.target.value })}
          style={campo}
        />
      </label>

      <label style={etiqueta}>
        HASTA
        <input
          type="date"
          value={periodo.to}
          min={periodo.from}
          onChange={(e) => fijarPeriodo({ ...periodo, to: e.target.value })}
          style={campo}
        />
      </label>

      <CredencialSubcuenta />

      <EstadoSincronizacion />
    </div>
  );
}

/** La credencial de la subcuenta elegida tal como sale en el registro de API keys. */
function CredencialSubcuenta() {
  const subcuenta = usarHistorial((s) => s.subcuenta);
  const apiKeys = usarPanel((s) => s.apiKeys);
  const cuentas = usarPanel((s) => s.cuentas);

  const fila = apiKeys.find((a) => a.id === subcuenta);
  const sub = cuentas.flatMap((c) => c.subAccounts).find((s) => s.id === subcuenta);
  const nombre = fila?.subAccountLabel || sub?.label;
  if (nombre === undefined) return null;
  const clave = fila?.maskedKey || '—';

  return (
    <div style={etiqueta}>
      API KEY · CUENTA
      <span
        title={`${clave} · ${nombre}`}
        style={{
          ...campo,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          background: T.superficie,
          border: `1px solid ${T.borde}`,
          color: T.texto,
          whiteSpace: 'nowrap',
          letterSpacing: 0
        }}
      >
        <span style={{ fontFamily: FUENTE.mono, fontWeight: 600 }}>{clave}</span>
        <span style={{ color: T.texto2, fontWeight: 500 }}>· {nombre}</span>
      </span>
    </div>
  );
}

function EstadoSincronizacion() {
  const subcuenta = usarHistorial((s) => s.subcuenta);
  const sincronizando = usarHistorial(
    (s) => s.sincronizando !== null && s.sincronizando === s.subcuenta
  );
  const progreso = usarHistorial((s) => s.progreso);
  const datos = usarHistorial((s) => s.datos);
  const actualizar = usarHistorial((s) => s.actualizar);

  const texto = sincronizando
    ? `Consultando Bitget…${progreso ? ` ${progreso.received} operaciones` : ''}`
    : datos?.syncedAt != null
      ? `Actualizado a las ${hora(datos.syncedAt)}`
      : '';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
      <span style={{ fontSize: 11.5, color: T.texto3 }} aria-live="polite">
        {texto}
      </span>
      <button
        type="button"
        onClick={actualizar}
        disabled={subcuenta === null || sincronizando}
        style={{
          padding: '7px 13px',
          borderRadius: 7,
          border: `1px solid ${T.bordeFuerte}`,
          background: T.superficie,
          color: T.texto,
          fontSize: 12.5,
          fontWeight: 600,
          cursor: subcuenta === null || sincronizando ? 'default' : 'pointer',
          opacity: subcuenta === null || sincronizando ? 0.6 : 1
        }}
      >
        Actualizar
      </button>
    </div>
  );
}

/* ---------------- tarjetas ---------------- */

function TarjetaSaldo() {
  const saldo = usarHistorial((s) => s.saldo);
  const leyendo = usarHistorial((s) => s.leyendoSaldo);
  const error = usarHistorial((s) => s.errorSaldo);

  return (
    <div style={tarjeta}>
      <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.06em', color: T.texto3 }}>
        SALDO ACTUAL
      </span>
      {error !== null ? (
        <span style={{ fontSize: 12.5, color: T.alertaCriticaTexto }}>{error}</span>
      ) : saldo === null ? (
        <span style={{ fontSize: 13, color: T.texto3 }}>{leyendo ? 'Leyendo…' : '—'}</span>
      ) : (
        <>
          <span
            style={{ ...numero, textAlign: 'left', fontSize: 22, fontWeight: 600, color: T.texto }}
          >
            {cifra(saldo.equity)}{' '}
            <span style={{ fontSize: 13, color: T.texto3 }}>{saldo.currency}</span>
          </span>
          <span style={{ fontSize: 11.5, color: T.texto3 }}>
            Disponible {cifra(saldo.available)} · leído a las {hora(saldo.readAt)}
            {leyendo ? ' · releyendo…' : ''}
          </span>
        </>
      )}
    </div>
  );
}

function TarjetaResultado({ datos }: { datos: TradeHistory | null }) {
  /*
   * Sin nada sincronizado todavía, el resultado no es cero: no se sabe. Un
   * «0,00» mientras llega la primera consulta se leería como «no operó».
   */
  const r = datos === null || datos.coverage === null ? null : datos.summary;

  return (
    <div style={tarjeta}>
      <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.06em', color: T.texto3 }}>
        RESULTADO NETO DEL PERIODO
        {datos?.filtered === true && (
          /* Que no se tome el de una parte por el del periodo entero. */
          <span style={{ marginLeft: 8, color: T.marcaTexto }}>· SOLO LO FILTRADO</span>
        )}
      </span>
      {r === null ? (
        <span style={{ fontSize: 13, color: T.texto3 }}>—</span>
      ) : (
        <>
          <span
            style={{
              ...numero,
              textAlign: 'left',
              fontSize: 22,
              fontWeight: 600,
              color: colorResultado(r.netPnl)
            }}
          >
            {cifraConSigno(r.netPnl)} <span style={{ fontSize: 13, color: T.texto3 }}>USDT</span>
          </span>
          <span style={{ fontSize: 12, color: T.texto2 }}>
            {r.total} {r.total === 1 ? 'operación cerrada' : 'operaciones cerradas'} ·{' '}
            <span style={{ color: T.largo, fontWeight: 600 }}>
              {r.winners} {r.winners === 1 ? 'ganadora' : 'ganadoras'}
            </span>{' '}
            ·{' '}
            <span style={{ color: T.corto, fontWeight: 600 }}>
              {r.losers} {r.losers === 1 ? 'perdedora' : 'perdedoras'}
            </span>
            {r.breakeven > 0 ? ` · ${r.breakeven} en cero` : ''}
          </span>
        </>
      )}
    </div>
  );
}

/* ---------------- avisos ---------------- */

function Aviso({ tono, children }: { tono: 'aviso' | 'error'; children: ReactNode }) {
  const error = tono === 'error';
  return (
    <div
      role={error ? 'alert' : 'status'}
      style={{
        padding: '9px 13px',
        borderRadius: 8,
        fontSize: 12.5,
        lineHeight: 1.5,
        border: `1px solid ${error ? T.alertaCriticaBorde : T.alertaAvisoBorde}`,
        background: error ? T.alertaCriticaFondo : T.alertaAvisoFondo,
        color: error ? T.alertaCriticaTexto : T.alertaAvisoTexto
      }}
    >
      {children}
    </div>
  );
}

function Avisos({ datos }: { datos: TradeHistory | null }) {
  const errorConsulta = usarHistorial((s) => s.errorConsulta);
  const errorSync = usarHistorial((s) => s.errorSync);
  const ultimaSync = usarHistorial((s) => s.ultimaSync);
  const sincronizando = usarHistorial(
    (s) => s.sincronizando !== null && s.sincronizando === s.subcuenta
  );

  return (
    <>
      {errorConsulta !== null && <Aviso tono="error">{errorConsulta}</Aviso>}
      {errorSync !== null && (
        <Aviso tono="error">
          No se pudo traer lo nuevo de Bitget: {errorSync} Lo que se ve es lo guardado en este
          equipo
          {datos?.syncedAt != null ? ` hasta el ${fechaHora(datos.syncedAt)}` : ''}.
        </Aviso>
      )}
      {ultimaSync?.gap === true && (
        <Aviso tono="aviso">
          Esta subcuenta pasó más de 90 días sin consultarse. Bitget ya no entrega las operaciones
          de ese intervalo, así que pueden faltar operaciones anteriores al{' '}
          {dia(ultimaSync.coverage.fromMs)}.
        </Aviso>
      )}
      {/*
       * «Falta después» no se avisa: es lo normal cuando el periodo incluye
       * hoy, y se arregla solo con la sincronización que ya está en marcha.
       * «Falta antes» sí, porque puede no tener arreglo.
       */}
      {datos !== null &&
        datos.period !== null &&
        datos.completeness.missingBefore &&
        !sincronizando &&
        datos.coverage !== null && (
          <Aviso tono="aviso">
            El periodo empieza antes de lo disponible: esta subcuenta tiene operaciones guardadas
            desde el {dia(datos.coverage.fromMs)}. Bitget solo entrega los últimos 90 días, así que
            lo anterior solo aparece si el panel ya lo había guardado.
          </Aviso>
        )}
    </>
  );
}

/* ---------------- filtros y exportación ---------------- */

function BarraFiltros({ datos }: { datos: TradeHistory | null }) {
  const filtro = usarHistorial((s) => s.filtro);
  const fijarFiltro = usarHistorial((s) => s.fijarFiltro);
  const exportar = usarHistorial((s) => s.exportar);
  const exportando = usarHistorial((s) => s.exportando);
  const problemaPeriodo = usarHistorial((s) => s.problemaPeriodo);

  const activo = filtro.symbol !== null || filtro.side !== null || filtro.outcome !== 'all';
  /* El par elegido sigue en la lista aunque el periodo nuevo no lo tenga. */
  const pares = [
    ...new Set([...(datos?.symbols ?? []), ...(filtro.symbol ? [filtro.symbol] : [])])
  ].sort();
  const sinFilas = datos === null || datos.trades.length === 0;
  const puedeExportar = !exportando && problemaPeriodo === null && !sinFilas;

  const select: CSSProperties = { ...campo, padding: '6px 8px', fontSize: 12.5 };

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 12 }}>
      <label style={etiqueta}>
        PAR
        <select
          value={filtro.symbol ?? ''}
          onChange={(e) =>
            fijarFiltro({ ...filtro, symbol: e.target.value === '' ? null : e.target.value })
          }
          style={{ ...select, minWidth: 130 }}
        >
          <option value="">Todos</option>
          {pares.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>

      <label style={etiqueta}>
        LADO
        <select
          value={filtro.side ?? ''}
          onChange={(e) =>
            fijarFiltro({
              ...filtro,
              side: e.target.value === 'long' || e.target.value === 'short' ? e.target.value : null
            })
          }
          style={select}
        >
          <option value="">Todos</option>
          <option value="long">Long</option>
          <option value="short">Short</option>
        </select>
      </label>

      <label style={etiqueta}>
        RESULTADO
        <select
          value={filtro.outcome}
          onChange={(e) =>
            fijarFiltro({
              ...filtro,
              outcome:
                e.target.value === 'winners' || e.target.value === 'losers' ? e.target.value : 'all'
            })
          }
          style={select}
        >
          <option value="all">Todas</option>
          <option value="winners">Ganadoras</option>
          <option value="losers">Perdedoras</option>
        </select>
      </label>

      {activo && (
        <button
          type="button"
          onClick={() => fijarFiltro(NO_FILTER)}
          style={{
            padding: '6px 10px',
            borderRadius: 7,
            border: 'none',
            background: 'transparent',
            color: T.marcaTexto,
            fontSize: 12.5,
            fontWeight: 600,
            cursor: 'pointer'
          }}
        >
          Quitar filtros
        </button>
      )}

      <button
        type="button"
        onClick={() => void exportar()}
        disabled={!puedeExportar}
        title={
          sinFilas
            ? 'No hay operaciones que exportar con este periodo y filtros'
            : 'Guarda en un archivo CSV, que abre Excel, las operaciones que se ven en la tabla'
        }
        style={{
          marginLeft: 'auto',
          padding: '7px 13px',
          borderRadius: 7,
          border: `1px solid ${BOTON_PRIMARIO.borde}`,
          background: BOTON_PRIMARIO.fondo,
          color: BOTON_PRIMARIO.texto,
          fontSize: 12.5,
          fontWeight: 600,
          cursor: puedeExportar ? 'pointer' : 'default',
          opacity: puedeExportar ? 1 : 0.55
        }}
      >
        {exportando ? 'Exportando…' : 'Exportar CSV'}
      </button>
    </div>
  );
}

function ResultadoExportacion() {
  const r = usarHistorial((s) => s.ultimaExportacion);
  const error = usarHistorial((s) => s.errorExportacion);
  const descartar = usarHistorial((s) => s.descartarExportacion);

  if (r === null && error === null) return null;
  const ok = error === null && r?.ok === true;

  return (
    <div
      role={ok ? 'status' : 'alert'}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '9px 13px',
        borderRadius: 8,
        fontSize: 12.5,
        lineHeight: 1.5,
        border: `1px solid ${ok ? T.borde : T.alertaCriticaBorde}`,
        background: ok ? T.superficie2 : T.alertaCriticaFondo,
        color: ok ? T.texto2 : T.alertaCriticaTexto
      }}
    >
      <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
        {error ?? r?.message}
        {ok && r?.path ? (
          <>
            {' '}
            Guardado en <span style={{ fontFamily: FUENTE.mono }}>{r.path}</span>
          </>
        ) : null}
      </span>
      <button
        type="button"
        onClick={descartar}
        aria-label="Cerrar aviso"
        style={{
          border: 'none',
          background: 'transparent',
          color: 'inherit',
          cursor: 'pointer',
          fontSize: 15
        }}
      >
        ×
      </button>
    </div>
  );
}

/* ---------------- tabla ---------------- */

/*
 * Lo que no cabe en la rejilla sin barra horizontal —las fechas del TP en UTC y
 * en CDMX, el desglose del resultado— se ve al seleccionar la fila, como la API
 * key se ve al elegir la subcuenta.
 */
function Fila({
  o,
  abierta,
  alternar
}: {
  o: ClosedTrade;
  abierta: boolean;
  alternar: () => void;
}) {
  const desglose =
    `Precio ${cifraConSigno(o.pricePnl, 4)} · Comisiones ${cifraConSigno(o.fees, 4)} · ` +
    `Financiamiento ${cifraConSigno(o.funding, 4)}`;

  return (
    <div style={{ borderBottom: `1px solid ${T.bordeSuave}` }}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={abierta}
        title={abierta ? 'Ocultar el detalle' : 'Ver el detalle del TP y del resultado'}
        onClick={alternar}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            alternar();
          }
        }}
        style={{
          display: 'grid',
          gridTemplateColumns: REJILLA,
          gap: HUECO,
          alignItems: 'center',
          padding: '8px 14px',
          fontSize: 12.5,
          cursor: 'pointer',
          background: abierta ? T.superficie2 : 'transparent'
        }}
      >
        <span style={celda}>
          <span style={{ fontWeight: 600, color: T.texto }}>{o.symbol}</span>{' '}
          <span style={{ fontWeight: 600, color: o.side === 'long' ? T.largo : T.corto }}>
            {o.side === 'long' ? 'Long' : 'Short'}
          </span>
        </span>
        <span style={{ ...celda, color: T.texto2 }}>
          {o.leverage === null ? '—' : `${o.leverage}x`} ·{' '}
          {o.marginMode === 'isolated' ? 'Aislado' : o.marginMode === 'crossed' ? 'Cruzado' : '—'}
        </span>
        <span style={{ ...celda, color: T.texto2, fontFamily: FUENTE.mono, fontSize: 11 }}>
          {fechaHora(o.openedAt)}
        </span>
        <span style={numero}>{precio(o.entryPrice)}</span>
        <span style={numero}>{precio(o.exitPrice)}</span>
        <span
          style={{ ...numero, color: o.takeProfit === null ? T.texto3 : T.texto2 }}
          title={
            o.takeProfit === null
              ? 'Sin TP puesto al cerrar, o Bitget ya no lo conserva'
              : undefined
          }
        >
          {o.takeProfit === null ? '—' : precio(o.takeProfit.price)}
        </span>
        <span style={numero}>{precio(o.closedSize)}</span>
        <span style={{ ...numero, fontWeight: 600, color: colorResultado(o.pnl) }} title={desglose}>
          {cifraConSigno(o.pnl, 4)}
        </span>
        <span style={{ ...numero, color: T.texto3 }}>
          {o.pnlPercent === null ? '—' : `${cifraConSigno(o.pnlPercent)} %`}
        </span>
        <span style={{ ...celda, color: T.texto2, fontFamily: FUENTE.mono, fontSize: 11 }}>
          {fechaHora(o.closedAt)}
        </span>
      </div>
      {abierta && <DetalleOperacion o={o} desglose={desglose} />}
    </div>
  );
}

function Dato({ rotulo, children }: { rotulo: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
      <span style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.06em', color: T.texto3 }}>
        {rotulo}
      </span>
      <span style={{ fontSize: 12.5, color: T.texto, overflowWrap: 'anywhere' }}>{children}</span>
    </div>
  );
}

/** Una fecha en UTC y en CDMX, una debajo de otra. */
function DobleHora({ ms }: { ms: number }) {
  return (
    <span
      style={{ display: 'flex', flexDirection: 'column', fontFamily: FUENTE.mono, fontSize: 11.5 }}
    >
      <span>
        <span style={{ color: T.texto3 }}>UTC </span>
        {fechaHoraEn(ms, 'UTC')}
      </span>
      <span>
        <span style={{ color: T.texto3 }}>CDMX </span>
        {fechaHoraEn(ms, ZONA_CDMX)}
      </span>
    </span>
  );
}

function DetalleOperacion({ o, desglose }: { o: ClosedTrade; desglose: string }) {
  const tp = o.takeProfit;
  return (
    <div
      style={{
        display: 'grid',
        /* Columnas que bajan de línea antes que desbordar: nunca barra horizontal. */
        gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
        gap: '12px 20px',
        padding: '10px 14px 14px',
        background: T.superficie2,
        borderTop: `1px dashed ${T.bordeSuave}`
      }}
    >
      <Dato rotulo="TAKE PROFIT">
        {tp === null ? (
          <span style={{ color: T.texto3 }}>
            Sin TP puesto al cerrar, o Bitget ya no lo conserva
          </span>
        ) : (
          <span style={{ fontFamily: FUENTE.mono, fontWeight: 600 }}>{precio(tp.price)}</span>
        )}
      </Dato>
      {tp !== null && (
        <Dato rotulo="TP COLOCADO">
          <DobleHora ms={tp.placedAt} />
        </Dato>
      )}
      {tp !== null && (
        <Dato rotulo="TP DISPARADO">
          {tp.triggeredAt === null ? (
            <span style={{ color: T.texto3 }}>
              No se disparó: Bitget lo canceló al cerrarse la posición
            </span>
          ) : (
            <DobleHora ms={tp.triggeredAt} />
          )}
        </Dato>
      )}
      <Dato rotulo="DESGLOSE DEL RESULTADO">
        <span style={{ fontFamily: FUENTE.mono, fontSize: 11.5 }}>{desglose}</span>
      </Dato>
      <Dato rotulo="ID DE POSICIÓN">
        <span style={{ fontFamily: FUENTE.mono, fontSize: 11.5 }}>{o.id}</span>
      </Dato>
    </div>
  );
}

function Tabla({ datos }: { datos: TradeHistory | null }) {
  const [abierta, fijarAbierta] = useState<string | null>(null);
  const consultando = usarHistorial((s) => s.consultando);
  const problemaPeriodo = usarHistorial((s) => s.problemaPeriodo);
  const sincronizando = usarHistorial(
    (s) => s.sincronizando !== null && s.sincronizando === s.subcuenta
  );

  const cabecera = (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: REJILLA,
        gap: HUECO,
        padding: '9px 14px',
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '.06em',
        color: T.texto3,
        borderBottom: `1px solid ${T.borde}`
      }}
    >
      <span>PAR Y LADO</span>
      <span>APAL. · MODO</span>
      <span>APERTURA</span>
      <span style={{ textAlign: 'right' }}>ENTRADA PROM.</span>
      <span style={{ textAlign: 'right' }}>SALIDA PROM.</span>
      <span style={{ textAlign: 'right' }}>TP</span>
      <span style={{ textAlign: 'right' }}>CANTIDAD</span>
      <span style={{ textAlign: 'right' }}>RESULTADO USDT</span>
      <span style={{ textAlign: 'right' }}>%</span>
      <span>CIERRE</span>
    </div>
  );

  let cuerpo: ReactNode;
  if (problemaPeriodo !== null) {
    cuerpo = <EstadoVacio compacto titulo="Periodo no válido" cuerpo={problemaPeriodo} />;
  } else if (datos === null) {
    cuerpo = (
      <EstadoVacio
        compacto
        titulo={consultando || sincronizando ? 'Cargando historial…' : 'Sin datos'}
        cuerpo="Elija una subcuenta para ver sus operaciones cerradas."
      />
    );
  } else if (datos.trades.length === 0) {
    cuerpo = (
      <EstadoVacio
        compacto
        titulo={
          datos.coverage === null && sincronizando
            ? 'Consultando Bitget…'
            : 'Sin operaciones cerradas'
        }
        cuerpo={
          datos.coverage === null && sincronizando
            ? 'Es la primera consulta de esta subcuenta: se están trayendo sus últimos 90 días.'
            : datos.filtered
              ? 'Ninguna operación del periodo cumple los filtros.'
              : 'No hay operaciones cerradas en este periodo.'
        }
      />
    );
  } else {
    cuerpo = datos.trades.map((o) => (
      <Fila
        key={o.id}
        o={o}
        abierta={abierta === o.id}
        alternar={() => fijarAbierta(abierta === o.id ? null : o.id)}
      />
    ));
  }

  return (
    <div
      style={{
        border: `1px solid ${T.borde}`,
        borderRadius: 10,
        background: T.superficie,
        overflowX: 'auto'
      }}
    >
      <div style={{ opacity: consultando && datos !== null ? 0.6 : 1 }}>
        {cabecera}
        {cuerpo}
      </div>
    </div>
  );
}

/* ---------------- pantalla ---------------- */

function CuerpoHistorial() {
  const cuentas = usarPanel((s) => s.cuentas);
  const subcuenta = usarHistorial((s) => s.subcuenta);
  const elegirSubcuenta = usarHistorial((s) => s.elegirSubcuenta);
  const escucharProgreso = usarHistorial((s) => s.escucharProgreso);
  const datos = usarHistorial((s) => s.datos);

  /*
   * Sin subcuenta elegida —o si la elegida se dio de baja con la pantalla
   * abierta—, la primera del panel.
   */
  const primera = cuentas[0]?.subAccounts[0]?.id ?? null;
  const sigue = cuentas.some((c) => c.subAccounts.some((s) => s.id === subcuenta));
  useEffect(() => {
    if (!sigue && primera !== null) elegirSubcuenta(primera);
  }, [sigue, primera, elegirSubcuenta]);

  useEffect(() => escucharProgreso(), [escucharProgreso]);

  if (cuentas.every((c) => c.subAccounts.length === 0)) {
    return (
      <EstadoVacio
        titulo="No hay subcuentas en el panel"
        cuerpo="Dé de alta una API key en la pantalla de API keys para consultar su historial."
      />
    );
  }

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 760 }}>
      <Selector cuentas={cuentas} />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
          gap: 14
        }}
      >
        <TarjetaResultado datos={datos} />
        <TarjetaSaldo />
      </div>

      <Avisos datos={datos} />

      <BarraFiltros datos={datos} />
      <ResultadoExportacion />

      <Tabla datos={datos} />

      <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.55, color: T.texto3 }}>
        <strong style={{ color: T.texto2 }}>Resultado</strong> es el neto que reporta Bitget por
        cada operación: el movimiento de precio más comisiones y financiamiento. El del periodo es
        su suma, y no tiene por qué coincidir con la variación del saldo: los traspasos, depósitos y
        retiros no intervienen. Bitget no informa el apalancamiento ni el porcentaje en su
        historial; por eso esas columnas muestran «—».{' '}
        <strong style={{ color: T.texto2 }}>TP</strong> es el Take Profit que estaba puesto al
        cerrarse la posición; seleccione una operación para ver cuándo se colocó y cuándo se
        disparó, en hora UTC y de CDMX. Las demás fechas son de este equipo, y el periodo cuenta los
        dos días completos.
      </p>
    </section>
  );
}

/**
 * `PCB-1-A-1`: panel, cuenta madre y casilla de la subcuenta que se enseña.
 *
 * Va en la barra superior, a la vista, para que una captura de esta pantalla
 * diga de qué subcuenta es aunque se reenvíe suelta. Es el mismo que lleva la
 * primera columna del CSV exportado.
 */
function IdentificadorSubcuenta() {
  const numeroPanel = usarPanel((s) => s.numeroPanel);
  const cuentas = usarPanel((s) => s.cuentas);
  const subcuenta = usarHistorial((s) => s.subcuenta);

  const cuenta = cuentas.find((c) => c.subAccounts.some((s) => s.id === subcuenta));
  const sub = cuenta?.subAccounts.find((s) => s.id === subcuenta);
  if (cuenta === undefined || sub === undefined) return null;

  const id = identificadorCuenta(numeroPanel, cuenta.name, sub.slot);
  return (
    <span
      title={`Panel ${numeroPanel} · cuenta ${cuenta.name} · casilla ${sub.slot} (${sub.label})`}
      style={{
        padding: '4px 11px',
        borderRadius: 7,
        background: '#ffffff',
        color: '#0a1a2b',
        fontFamily: FUENTE.mono,
        fontSize: 15,
        fontWeight: 700,
        letterSpacing: '.02em',
        whiteSpace: 'nowrap'
      }}
    >
      {id}
    </span>
  );
}

export function PantallaHistorial() {
  const abierta = usarPanel((s) => s.historialAbierto);
  const cerrar = usarPanel((s) => s.cerrarHistorial);

  if (!abierta) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 75,
        background: T.fondo,
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          padding: '16px 26px',
          background: T.marca,
          color: '#ffffff'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '.14em',
              color: '#8ccdf5',
              fontFamily: FUENTE.mono
            }}
          >
            HISTORIAL
          </span>
          <IdentificadorSubcuenta />
          <span style={{ fontSize: 18, fontWeight: 600 }}>Historial de posiciones y resultado</span>
        </div>
        <button
          type="button"
          className="pcb-boton-barra"
          onClick={cerrar}
          title="Volver al panel"
          style={{
            padding: '8px 14px',
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
            border: '1px solid #ffffff2e',
            background: '#ffffff14',
            color: '#ffffff',
            whiteSpace: 'nowrap'
          }}
        >
          Volver al panel
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '20px 26px' }}>
        <CuerpoHistorial />
      </div>
    </div>
  );
}
