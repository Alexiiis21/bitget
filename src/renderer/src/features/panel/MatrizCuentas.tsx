import type { CSSProperties } from 'react';
import { ESTADO_ACCION, FUENTE, T } from '@/lib/tokens';
import { cifra } from '@/lib/formato';
import { usarPanel } from '@/store/panel';
import type { Account, Position, Side } from '@shared/domain/panel-view';
import { AccordeonMonitor } from './AccordeonMonitor';
import { AccordeonHistorial } from './AccordeonHistorial';
import { EsqueletoMatriz, EstadoVacio } from './Esqueleto';

/**
 * Cuerpo del panel: una `AccountBlock` por cuenta principal.
 *
 * `AccountAlerts` (el banner crítico y el de aviso) y `SlotGrid` (la rejilla
 * de 20 casillas por lado) viven en este mismo archivo porque los tres
 * comparten el mismo `Account` y no tienen sentido de forma aislada; los dos
 * acordeones sí son piezas independientes lo bastante grandes como para
 * merecer su propio archivo.
 */

function posicionDe(posiciones: Position[], subAccountId: string, side: Side): Position | undefined {
  return posiciones.find((p) => p.subAccountId === subAccountId && p.side === side);
}

/**
 * La posición de esa punta **en el activo seleccionado**.
 *
 * Es más estricta que `posicionDe`, que se conforma con cualquier activo porque
 * a la barra de estado le basta con «hay algo abierto aquí». El apalancamiento
 * no: en Bitget es un ajuste **por símbolo**, así que el de la posición de ETH
 * no dice nada del de SOL, y enseñarlo en la casilla mientras se opera SOL sería
 * un número cierto en el sitio equivocado.
 */
function posicionEnActivo(
  posiciones: Position[],
  subAccountId: string,
  side: Side,
  assetId: string
): Position | undefined {
  return posiciones.find(
    (p) => p.subAccountId === subAccountId && p.side === side && p.assetId === assetId
  );
}

function AlertasCuenta({ cuenta }: { cuenta: Account }) {
  const posiciones = usarPanel((s) => s.posiciones);

  const subIds = new Set(cuenta.subAccounts.map((s) => s.id));
  const propias = posiciones.filter((p) => subIds.has(p.subAccountId));

  const criticas = propias.filter((p) => p.marginCritical);
  const sinTp = propias.filter((p) => p.actions.oe && !p.actions.tp);

  const nombreSub = (subAccountId: string): string => cuenta.subAccounts.find((s) => s.id === subAccountId)?.label ?? subAccountId;

  return (
    <>
      {/*
        * El aviso no trae botón, y es deliberado.
        *
        * Tuvo uno —«Reintentar margen»— que agregaba margen a las posiciones
        * críticas de la cuenta de una sola pulsación, y ese atajo es justamente
        * el que no vuelve: se retiró el 26/08/2026 junto con el resto de las
        * acciones posteriores a la apertura, después de que una posición acabara
        * con el doble del margen aprobado.
        *
        * Agregar margen a lo ya abierto sí volvió el 01/09/2026, pero por el
        * camino que pasa por la confirmación: se marcan las casillas y se pulsa
        * «Agregar margen» en la barra lateral, y el plan enseña `actual →
        * resultante` de cada una antes de enviar nada. Aplicar el mismo importe
        * dos veces se ve en esa pantalla; desde un botón del aviso, no se veía.
        */}
      {criticas.length > 0 && (
        <div
          title="Posición abierta sin margen adicional: riesgo de liquidación. Para dárselo, marque sus casillas y use «Agregar margen», en «Sobre posiciones abiertas»."
          style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 12px', background: T.alertaCriticaFondo, borderBottom: `1px solid ${T.alertaCriticaBorde}`, borderLeft: '5px solid #e03131' }}
        >
          <span style={{ flex: 'none', width: 18, height: 18, borderRadius: 5, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800, color: '#ffffff', background: '#e03131' }}>!</span>
          <span style={{ flex: 'none', fontSize: 11, fontWeight: 800, letterSpacing: '.06em', color: T.alertaCriticaTexto, whiteSpace: 'nowrap' }}>CRÍTICO · SIN MARGEN ADICIONAL</span>
          <span style={{ minWidth: 0, fontSize: 10.5, color: T.alertaCriticaTexto2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {criticas.length} {criticas.length === 1 ? 'posición abierta' : 'posiciones abiertas'} sin margen adicional · riesgo de liquidación:{' '}
            {criticas.map((p) => `${nombreSub(p.subAccountId)} (${p.side})`).join(' · ')}
          </span>
        </div>
      )}

      {sinTp.length > 0 && (
        <div
          title="Posiciones abiertas sin Take Profit colocado. Requiere atención, pero no pone el capital en riesgo."
          style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 12px', background: T.alertaAvisoFondo, borderBottom: `1px solid ${T.alertaAvisoBorde}` }}
        >
          <span style={{ flex: 'none', width: 15, height: 15, borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, color: '#4a3200', background: '#f2b705' }}>!</span>
          <span style={{ flex: 'none', fontSize: 10.5, fontWeight: 700, color: T.alertaAvisoTexto, whiteSpace: 'nowrap' }}>Aviso · SIN TAKE PROFIT</span>
          <span style={{ minWidth: 0, fontSize: 10.5, color: T.alertaAvisoTexto, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {sinTp.length} {sinTp.length === 1 ? 'posición abierta sin Take Profit' : 'posiciones abiertas sin Take Profit'}:{' '}
            {sinTp.map((p) => `${nombreSub(p.subAccountId)} (${p.side})`).join(' · ')}
          </span>
        </div>
      )}
    </>
  );
}

const acortarSaldo = (saldo: string): string => {
  const n = Number.parseFloat(saldo);
  return n >= 1000 ? `${cifra(n / 1000, 1)}k` : cifra(n, 1);
};

/**
 * Una fila de veinte casillas: la de LONG o la de SHORT.
 *
 * La fila que el alcance no opera no se puede marcar: va con la casilla de
 * marcar punteada y el rótulo apagado. Antes se marcaba igual —la marca no se
 * enviaba, pero se quedaba puesta— y bastaba cambiar el alcance para que
 * aquellas casillas olvidadas se convirtieran en órdenes. Con el alcance en
 * «Ambos» las dos filas van juntas: marcar una casilla marca su par, que es lo
 * que «Ambos» significa.
 */
function RejillaCasillas({ cuenta, lado }: { cuenta: Account; lado: Side }) {
  const posiciones = usarPanel((s) => s.posiciones);
  const seleccion = usarPanel((s) => s.seleccion[cuenta.id]);
  const alternarCasilla = usarPanel((s) => s.alternarCasilla);
  const alcance = usarPanel((s) => s.alcance);
  const activoId = usarPanel((s) => s.activoId);
  const campo = lado === 'long' ? 'selLong' : 'selShort';
  const sel = seleccion?.[campo] ?? cuenta.subAccounts.map(() => false);
  const nombreLado = lado === 'long' ? 'Long' : 'Short';
  const enAlcance = alcance === 'ambos' || alcance === lado;
  /*
   * Una línea por fila, y cada una dice algo distinto de la misma columna.
   *
   * LONG lleva el **saldo** de la subcuenta y SHORT, el **apalancamiento**. El
   * saldo salía antes en las dos —es de la subcuenta, no de un lado— y dos
   * cifras iguales una encima de otra se leen como dos saldos que casualmente
   * coinciden. Con el hueco libre, la fila SHORT pasa a enseñar el dato que no
   * estaba en ninguna parte de la matriz.
   */
  const muestraSaldo = lado === 'long';
  const nota = !enAlcance
    ? `fuera del alcance · ahora mismo solo se opera en ${alcance === 'long' ? 'Long' : 'Short'}`
    : alcance === 'ambos'
      ? `marca también la casilla ${lado === 'long' ? 'SHORT' : 'LONG'} de esta columna`
      : null;

  /*
   * La fila apagada no se apaga entera: la barra de estado de cada casilla
   * -verde, roja o amarilla- conserva su color. Es riesgo de una posición
   * abierta, y sigue siendo verdad aunque ahora mismo no se opere ese lado;
   * bajarle el contraste por no poder seleccionarla sería esconderlo.
   */
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 4 }}>
      <div style={{ flex: 'none', width: 62, display: 'flex', alignItems: 'center', fontSize: 9.5, fontWeight: 700, letterSpacing: '.04em', color: enAlcance ? (lado === 'long' ? T.largo : T.corto) : T.texto3, whiteSpace: 'nowrap' }}>
        {lado === 'long' ? 'LONG · OE' : 'SHORT · OE'}
      </div>
      {cuenta.subAccounts.map((sub, i) => {
        const posicion = posicionDe(posiciones, sub.id, lado);
        const marcada = sel[i] === true;

        /*
         * El apalancamiento que de verdad está aplicado en esta punta.
         *
         * Sale de la posición abierta, que es lo único que el panel sabe con
         * certeza: en Bitget el apalancamiento es por símbolo, y el que trae la
         * verificación de la credencial es el del **primer símbolo del
         * mercado** —BTC—, así que usarlo aquí diría «150x» mientras se opera
         * PEPE a 75x. Sin posición abierta en el activo elegido no hay nada
         * vigente que enseñar, y se pone un guion en vez del valor del
         * formulario: ese es el que se aplicaría, no el que hay.
         */
        const enActivo = posicionEnActivo(posiciones, sub.id, lado, activoId);

        /*
         * ------------------------------------------------------------------
         * Sin posición SHORT, se enseña el apalancamiento del LONG, marcado
         * ------------------------------------------------------------------
         * Lo pidió el cliente el 31/08/2026: operando solo en largo, esta línea
         * -la única de la matriz que enseña apalancamiento- salía siempre en
         * guion, así que el dato no estaba en ninguna parte de la pantalla.
         *
         * El número prestado va con `↑` y en el color del LONG, y la pista lo
         * dice con todas las letras. La marca no es decoración: en cobertura
         * Bitget configura los dos lados **por separado** —`isolatedLongLever` e
         * `isolatedShortLever`—, así que el 150x del largo no demuestra que el
         * corto esté a 150x. El panel no puede saber a cuánto está el lado
         * corto sin una posición abierta o una consulta por símbolo que hoy no
         * hace; lo que sí puede es no dar a entender que lo sabe.
         */
        const prestado =
          !muestraSaldo && enActivo === undefined
            ? posicionEnActivo(posiciones, sub.id, 'long', activoId)
            : undefined;
        const vigente = enActivo ?? prestado;
        const apalancamiento =
          vigente === undefined ? '—' : `${vigente.leverage}x${prestado === undefined ? '' : '↑'}`;

        /* La cifra de esta fila, dicha con todas las letras al pasar el cursor. */
        const detalleLinea = muestraSaldo
          ? ` · saldo ${sub.balance}`
          : enActivo !== undefined
            ? ` · apalancamiento ${enActivo.leverage}x en ${activoId}`
            : prestado !== undefined
              ? ` · sin posición SHORT en ${activoId} · ${prestado.leverage}x es el apalancamiento del LONG, y en cobertura Bitget configura cada lado por separado`
              : ` · sin posición en ${activoId}: no hay apalancamiento aplicado que enseñar`;

        /*
         * La conexión manda sobre la posición. Si no se puede hablar con la
         * subcuenta, lo que el panel sabe de su posición es de hace un rato, y
         * pintarlo como si fuera de ahora es peor que reconocer el corte.
         */
        const sinConexion = sub.status === 'error' || sub.status === 'sin-api';
        const color = sinConexion || posicion?.hasError
          ? ESTADO_ACCION.error
          : posicion?.actions.oe
            ? ESTADO_ACCION.realizada
            : ESTADO_ACCION.pendiente;
        const estadoTexto = sinConexion
          ? `sin conexión · ${sub.statusReason ?? 'la credencial no responde'}`
          : posicion?.hasError
            ? `error · ${posicion.errorReason ?? ''}`
            : posicion?.actions.oe
              ? 'posición abierta'
              : posicion
                ? 'posición cerrada'
                : 'sin posición';

        return (
          <button
            key={sub.id}
            type="button"
            className="pcb-casilla"
            /*
             * `aria-disabled` y no `disabled`: un botón deshabilitado no recibe
             * el cursor, y con él se perdería la pista que dice el estado de esa
             * subcuenta y ese lado —la que pide el punto B3 de la aceptación—.
             * El clic lo ignora el store, que es donde está la regla.
             */
            aria-disabled={!enAlcance}
            onClick={() => alternarCasilla(cuenta.id, campo, i)}
            title={`${sub.label} · ${nombreLado} · ${estadoTexto}${detalleLinea}${nota === null ? '' : ` · ${nota}`}`}
            style={{
              flex: '1 1 0',
              minWidth: 0,
              height: 46,
              borderRadius: 7,
              padding: '3px 2px 0',
              cursor: enAlcance ? 'pointer' : 'default',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 2,
              overflow: 'hidden',
              border: `1.5px solid ${marcada ? T.marcaRelleno : T.borde}`,
              background: marcada ? T.seleccion : enAlcance ? T.superficie : T.superficie2
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              {/* Fuera del alcance la casilla de marcar va punteada y vacía: no se puede tildar. */}
              <span style={{ width: 12, height: 12, flex: 'none', borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8.5, lineHeight: 1, color: '#ffffff', border: `1.5px ${enAlcance ? 'solid' : 'dashed'} ${marcada ? T.marcaRelleno : enAlcance ? T.bordeFuerte : T.bordeSuave}`, background: marcada ? T.marcaRelleno : 'transparent' }}>
                {marcada ? '✓' : ''}
              </span>
              <span style={{ fontSize: 11.5, fontWeight: 700, fontFamily: FUENTE.mono, color: marcada ? T.marcaTexto : enAlcance ? T.texto2 : T.texto3 }}>{sub.slot}</span>
              {sinConexion && (
                <span
                  aria-hidden
                  style={{ fontSize: 9, fontWeight: 800, lineHeight: 1, color: ESTADO_ACCION.error }}
                >
                  ⚠
                </span>
              )}
            </span>
            {/*
              * LONG: el saldo de la subcuenta. SHORT: el apalancamiento de esa
              * punta, o el del LONG con `↑` y en verde cuando el corto no tiene
              * posición abierta que lo diga.
              */}
            <span style={{ width: '100%', textAlign: 'center', fontSize: 9, fontWeight: 600, fontFamily: FUENTE.mono, letterSpacing: '-.02em', color: marcada ? T.marcaTexto : prestado !== undefined ? T.largo : T.texto3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {muestraSaldo ? acortarSaldo(sub.balance) : apalancamiento}
            </span>
            <span style={{ width: '100%', height: 4, borderRadius: 2, background: color, marginTop: 1 }} />
          </button>
        );
      })}
    </div>
  );
}

function BloqueCuenta({ cuenta }: { cuenta: Account }) {
  const alternarCuenta = usarPanel((s) => s.alternarCuenta);
  const seleccion = usarPanel((s) => s.seleccion[cuenta.id]);
  const cmpAbierto = usarPanel((s) => s.cmpAbierto[cuenta.id] ?? false);
  const histAbierto = usarPanel((s) => s.histAbierto[cuenta.id] ?? false);
  const alternarCmp = usarPanel((s) => s.alternarCmp);
  const alternarHist = usarPanel((s) => s.alternarHist);
  const posiciones = usarPanel((s) => s.posiciones);
  const sinPosiciones = usarPanel((s) => s.cargaPosiciones === 'error');
  const alcance = usarPanel((s) => s.alcance);

  /* «Todas» se da por cumplido mirando solo los lados que el alcance opera. */
  const enLong = alcance !== 'short' ? (seleccion?.selLong.every(Boolean) ?? false) : true;
  const enShort = alcance !== 'long' ? (seleccion?.selShort.every(Boolean) ?? false) : true;
  const todas = seleccion !== undefined && enLong && enShort;
  const saldoTotal = cuenta.subAccounts.reduce((t, s) => t + Number.parseFloat(s.balance), 0);
  const subIds = new Set(cuenta.subAccounts.map((s) => s.id));
  const abiertas = new Set(posiciones.filter((p) => p.actions.oe && subIds.has(p.subAccountId)).map((p) => p.subAccountId)).size;

  return (
    <div style={{ borderBottom: `6px solid ${T.bordeSuave}` }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', gap: 10, padding: '9px 12px', background: T.marca, color: '#ffffff' }}>
        <div style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: '.1em', color: '#8ccdf5', fontFamily: FUENTE.mono, whiteSpace: 'nowrap' }}>
          SALDO TOTAL {cifra(saldoTotal, 2)} USDT
        </div>
        <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase', textAlign: 'center', whiteSpace: 'nowrap' }}>{cuenta.name}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={() => alternarCuenta(cuenta.id)}
            title={`Seleccionar o quitar las ${cuenta.subAccounts.length} casillas de esta cuenta`}
            style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '4px 9px', borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', border: '1px solid #ffffff2e', background: '#ffffff14', color: '#ffffff' }}
          >
            <span style={{ width: 14, height: 14, borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, lineHeight: 1, border: `1.5px solid ${todas ? '#35b6f5' : '#ffffff66'}`, background: todas ? '#35b6f5' : 'transparent', color: '#08243c' }}>
              {todas ? '✓' : ''}
            </span>
            Todas
          </button>
        </div>
      </div>

      <AlertasCuenta cuenta={cuenta} />

      <div style={{ padding: '7px 12px 8px', display: 'flex', flexDirection: 'column', gap: 5, background: T.superficie, borderBottom: `1px solid ${T.borde}` }}>
        <RejillaCasillas cuenta={cuenta} lado="long" />
        <RejillaCasillas cuenta={cuenta} lado="short" />
      </div>

      <div
        onClick={() => alternarCmp(cuenta.id)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', background: T.banda, borderBottom: `1px solid ${T.borde}`, cursor: 'pointer', userSelect: 'none' }}
      >
        <span style={{ fontSize: 10, lineHeight: 1, color: T.marcaTexto, width: 10, display: 'flex', justifyContent: 'center' }}>{cmpAbierto ? '▼' : '▶'}</span>
        <span style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: '.12em', color: T.marcaTexto, textTransform: 'uppercase', whiteSpace: 'nowrap' }}>Centro de monitoreo de posiciones</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: T.texto3, fontFamily: FUENTE.mono, whiteSpace: 'nowrap' }}>
          {sinPosiciones ? 'sin datos de posiciones' : `${abiertas} de ${cuenta.subAccounts.length} con posición abierta`}
        </span>
      </div>
      {cmpAbierto && <AccordeonMonitor cuenta={cuenta} />}

      <div
        onClick={() => void alternarHist(cuenta.id)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', background: T.superficie2, borderTop: `1px solid ${T.bordeSuave}`, borderBottom: `1px solid ${T.borde}`, cursor: 'pointer', userSelect: 'none' }}
      >
        <span style={{ fontSize: 10, lineHeight: 1, color: T.marcaTexto, width: 10, display: 'flex', justifyContent: 'center' }}>{histAbierto ? '▼' : '▶'}</span>
        <span style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: '.12em', color: T.marcaTexto, textTransform: 'uppercase', whiteSpace: 'nowrap' }}>Historial de posiciones</span>
      </div>
      {histAbierto && <AccordeonHistorial cuenta={cuenta} />}
    </div>
  );
}

const pie: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 14,
  padding: '4px 12px',
  borderTop: `1px solid ${T.bordeSuave}`,
  background: T.superficie2,
  fontSize: 9.5,
  color: T.texto3,
  overflow: 'hidden',
  whiteSpace: 'nowrap'
};

function PieMatriz() {
  const activos = usarPanel((s) => s.activos);
  const activoId = usarPanel((s) => s.activoId);
  const tipoOrden = usarPanel((s) => s.tipoOrden);
  const limitPrice = usarPanel((s) => s.limitPrice);
  const activo = activos.find((a) => a.id === activoId);

  return (
    <div style={pie}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 13, minWidth: 0, overflow: 'hidden' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 'none' }}>
          <span style={{ width: 16, height: 12, borderRadius: 3, background: '#2f9e44', display: 'block' }} />
          acción realizada
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 'none' }}>
          <span style={{ width: 16, height: 12, borderRadius: 3, background: '#e03131', display: 'block' }} />
          pendiente
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 'none' }}>
          <span style={{ width: 16, height: 12, borderRadius: 3, background: '#f2b705', display: 'block' }} />
          error · pase el cursor por la casilla
        </span>
        <span style={{ color: T.texto3, flex: 'none' }}>|</span>
        <span style={{ flex: 'none' }}>TP · MGA · AP · OE</span>
        <span style={{ color: T.texto3, flex: 'none' }}>|</span>
        {/*
          * La marca del apalancamiento prestado, explicada donde se puede leer
          * sin pasar el cursor por una casilla concreta.
          */}
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, flex: 'none' }}>
          <span style={{ fontFamily: FUENTE.mono, fontWeight: 700, color: T.largo }}>↑</span>
          apalancamiento del LONG
        </span>
      </div>
      <div style={{ flex: 'none', fontFamily: FUENTE.mono, whiteSpace: 'nowrap' }}>
        {activo?.label ?? '—'} · {tipoOrden === 'limit' ? `LIMIT ${limitPrice || '—'}` : 'MARKET'}
      </div>
    </div>
  );
}

/**
 * Decide qué ocupa el cuerpo de la matriz.
 *
 * El orden de las ramas no es casual: primero «todavía no se sabe», luego «se
 * sabe que falló» y solo al final «se sabe que no hay nada». Invertirlo haría
 * que un fallo de conexión se anunciara como «no tiene cuentas registradas»,
 * que es una frase que invita a dar de alta credenciales que ya existen.
 */
function CuerpoMatriz() {
  const cuentas = usarPanel((s) => s.cuentas);
  const carga = usarPanel((s) => s.cargaCuentas);
  const motivo = usarPanel((s) => s.motivoCuentas);
  const abrirApis = usarPanel((s) => s.abrirApis);

  if (carga === 'inicial' || carga === 'cargando') return <EsqueletoMatriz />;

  if (carga === 'error') {
    return (
      <EstadoVacio
        tono="error"
        titulo="No se pudieron cargar las cuentas"
        cuerpo="El panel está abierto, pero no ha podido leer las cuentas ni sus posiciones. Las credenciales guardadas no se han tocado."
        detalle={motivo}
      />
    );
  }

  if (cuentas.length === 0) {
    return (
      <EstadoVacio
        titulo="No hay cuentas registradas"
        cuerpo="Este panel todavía no tiene ninguna subcuenta dada de alta. Registre la API key de una subcuenta de Bitget y aparecerá aquí con sus casillas."
        accion={{ rotulo: 'Registrar una API key', alClic: abrirApis }}
      />
    );
  }

  return (
    <>
      {cuentas.map((cuenta) => (
        <BloqueCuenta key={cuenta.id} cuenta={cuenta} />
      ))}
    </>
  );
}

export function MatrizCuentas() {
  return (
    <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overflowX: 'hidden', background: T.superficie }}>
        <CuerpoMatriz />
      </div>
      <PieMatriz />
    </div>
  );
}
