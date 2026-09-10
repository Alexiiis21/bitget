import { useEffect, useState, type CSSProperties } from 'react';
import type {
  BalanceSheet,
  SpreadMode,
  SpreadPlan,
  SpreadResult,
  SubAccountBalance,
  TransferPlan,
  TransferRecord,
  TransferResult,
  Warning
} from '@shared/domain/panel-view';
import { cifra } from '@/lib/formato';
import { BOTON_PRIMARIO, FUENTE, T } from '@/lib/tokens';
import { panelService } from '@/services/panel-service';
import { usarPanel } from '@/store/panel';
import { EsqueletoFilas, EstadoVacio } from './Esqueleto';
import { DialogoResultadoTraspaso } from './DialogoResultadoTraspaso';
import { DialogoTraspaso } from './DialogoTraspaso';
import { DialogoReparto } from './DialogoReparto';

/**
 * Pantalla de saldos por subcuenta. Fase 2 de los traspasos.
 *
 * Enseña, con una sola petición a Bitget, cuánto tiene cada subcuenta de la
 * cuenta principal y —lo que de verdad importa— cuánto puede salir de ella.
 *
 * --------------------------------------------------------------------------
 * Por qué hay dos columnas de dinero y no una
 * --------------------------------------------------------------------------
 * El saldo disponible de una subcuenta no es lo que se puede transferir: el
 * margen comprometido en posiciones abiertas no viaja. Bitget publica los dos
 * números por separado (`available` y `maxTransferOut`) y el panel los enseña
 * por separado. Fundirlos —o enseñar solo el saldo— llevaría a preparar repartos
 * que el exchange rechaza, y el rechazo llegaría al final, con todo montado.
 *
 * --------------------------------------------------------------------------
 * Esto no es el monitor: no se refresca solo
 * --------------------------------------------------------------------------
 * El endpoint admite una petición cada diez segundos por cuenta. Un intervalo
 * automático agotaría ese cupo y dejaría la pantalla en error justo cuando se la
 * necesita. Se lee al abrir y cuando el operador pulsa Actualizar, y la hora de
 * la lectura queda a la vista: un saldo sin hora es un saldo que miente.
 */

/* La primera columna es la casilla de selección para las acciones masivas. */
const REJILLA = '28px minmax(140px,1fr) 150px 130px 130px 120px';
const ANCHO_MINIMO = 730;

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
const cabecera: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: REJILLA,
  gap: 12,
  padding: '9px 14px',
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '.06em',
  color: T.texto3,
  borderBottom: `1px solid ${T.borde}`
};
const boton: CSSProperties = {
  padding: '7px 13px',
  borderRadius: 7,
  border: `1px solid ${T.bordeFuerte}`,
  background: T.superficie,
  color: T.texto,
  fontSize: 12.5,
  fontWeight: 600,
  cursor: 'pointer'
};
const etiquetaCampo: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
  fontSize: 11.5,
  fontWeight: 600,
  letterSpacing: '.06em',
  color: T.texto2
};
const campo: CSSProperties = {
  padding: '9px 11px',
  borderRadius: 8,
  border: `1px solid ${T.bordeFuerte}`,
  fontSize: 13.5,
  fontWeight: 500,
  background: T.campoFondo,
  color: T.campoTexto,
  fontFamily: FUENTE.mono,
  outline: 'none'
};

/**
 * Un dato que no se sabe se dibuja como raya, nunca como cero.
 *
 * Cero significa «esta cuenta no tiene nada», que es una afirmación sobre el
 * dinero de alguien. Cuando la madre no reporta una subcuenta lo cierto es que
 * no se sabe, y decir cero invitaría a darla por vacía.
 */
function Cantidad({ valor, atenuado = false }: { valor: string | null; atenuado?: boolean }) {
  if (valor === null) {
    return (
      <span style={{ ...numero, color: T.texto3 }} title="Bitget no informó de esta subcuenta">
        —
      </span>
    );
  }
  return <span style={{ ...numero, color: atenuado ? T.texto2 : T.texto }}>{cifra(valor)}</span>;
}

/**
 * Marca las dos anomalías que la pantalla no debe esconder.
 *
 * Cuando no hay nada que marcar devuelve un `<span>` vacío y **no `null`**: esta
 * es una celda de una rejilla, y una celda que no se renderiza no deja su hueco
 * —corre a las siguientes—. Con `null`, las filas sin distintivo pintaban sus
 * tres importes una columna a la izquierda, bajo el encabezado equivocado: el
 * disponible aparecía como transferible. Se vio en la captura de la pantalla, no
 * en el typecheck ni en las pruebas.
 */
function Distintivo({ fila }: { fila: SubAccountBalance }) {
  if (fila.onlyInBitget) {
    return (
      <span
        title="Bitget la reporta como subcuenta de esta cuenta principal, pero no está dada de alta en el panel. Puede recibir y enviar saldo igualmente: un traspaso se firma con la clave de la cuenta principal, no con la suya."
        style={{ fontSize: 10.5, fontWeight: 600, color: T.alertaAvisoTexto }}
      >
        NO ESTÁ EN EL PANEL
      </span>
    );
  }
  if (fila.noData) {
    return (
      <span
        title="Está dada de alta en el panel, pero la cuenta principal no la reporta. Puede colgar de otra cuenta principal."
        style={{ fontSize: 10.5, fontWeight: 600, color: T.texto3 }}
      >
        SIN DATOS
      </span>
    );
  }
  return <span />;
}

/**
 * Alta de la API Key de la cuenta principal.
 *
 * Vive aquí, dentro de la pantalla que la necesita, y no en la gestión de API
 * keys: aquella registra subcuentas —con su cuenta principal y su casilla— y
 * una cuenta madre no tiene ni lo uno ni lo otro. Mezclarlas obligaría a
 * inventarle una casilla a una credencial que no opera nada.
 */
function AltaMadre({ alDarDeAlta }: { alDarDeAlta: () => void }) {
  const [nombre, fijarNombre] = useState('');
  const [apiKey, fijarApiKey] = useState('');
  const [secretKey, fijarSecretKey] = useState('');
  const [passphrase, fijarPassphrase] = useState('');
  const [ocupado, fijarOcupado] = useState(false);
  const [error, fijarError] = useState<string | null>(null);
  const [avisos, fijarAvisos] = useState<Warning[]>([]);

  const guardar = async (): Promise<void> => {
    fijarOcupado(true);
    fijarError(null);
    fijarAvisos([]);
    try {
      const r = await panelService.registerParentAccount({
        name: nombre,
        apiKey,
        secretKey,
        passphrase
      });
      if (!r.ok) {
        fijarError(r.reason ?? 'Bitget no aceptó la credencial.');
        return;
      }
      /*
       * Se avisa pero no se bloquea: una clave sin subcuentas es válida, solo
       * que no es la que hace falta. El operador tiene que poder verlo escrito
       * antes de preguntarse por qué la tabla sale vacía.
       */
      fijarAvisos(r.warnings);
      fijarSecretKey('');
      fijarPassphrase('');
      if (r.warnings.length === 0) alDarDeAlta();
    } catch (e) {
      fijarError(e instanceof Error ? e.message : 'No se pudo guardar la credencial.');
    } finally {
      fijarOcupado(false);
    }
  };

  const completo =
    nombre.trim() !== '' &&
    apiKey.trim() !== '' &&
    secretKey.trim() !== '' &&
    passphrase.trim() !== '';

  return (
    <div style={{ maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <h3 style={{ margin: '0 0 6px', fontSize: 14, fontWeight: 600, color: T.texto }}>
          API Key de la cuenta principal
        </h3>
        <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: T.texto2 }}>
          Es la clave de la cuenta <strong>de la que cuelgan</strong> tus subcuentas, no la de
          ninguna de ellas. Con permiso de lectura de subcuentas basta para esta pantalla; el
          permiso de traspaso solo hará falta para mover saldo.
        </p>
      </div>

      {error !== null && (
        <div
          role="alert"
          style={{
            padding: '10px 13px',
            borderRadius: 8,
            border: `1px solid ${T.alertaCriticaBorde}`,
            background: T.alertaCriticaFondo,
            color: T.alertaCriticaTexto,
            fontSize: 12.5
          }}
        >
          {error}
        </div>
      )}

      {avisos.map((a) => (
        <div
          key={a.code}
          role="alert"
          style={{
            padding: '10px 13px',
            borderRadius: 8,
            border: `1px solid ${T.alertaAvisoBorde}`,
            background: T.alertaAvisoFondo,
            color: T.alertaAvisoTexto,
            fontSize: 12.5,
            lineHeight: 1.5
          }}
        >
          {a.message}
        </div>
      ))}

      <label style={etiquetaCampo}>
        NOMBRE
        <input
          style={campo}
          value={nombre}
          placeholder="Cuenta principal"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => fijarNombre(e.target.value)}
        />
      </label>
      <label style={etiquetaCampo}>
        API KEY
        <input
          style={campo}
          value={apiKey}
          placeholder="bg_xxxxxxxxxxxx"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => fijarApiKey(e.target.value)}
        />
      </label>
      <label style={etiquetaCampo}>
        SECRET KEY
        <input
          style={campo}
          type="password"
          value={secretKey}
          placeholder="••••••••••••"
          autoComplete="off"
          onChange={(e) => fijarSecretKey(e.target.value)}
        />
      </label>
      <label style={etiquetaCampo}>
        PASSPHRASE
        <input
          style={campo}
          type="password"
          value={passphrase}
          placeholder="••••••••"
          autoComplete="off"
          onChange={(e) => fijarPassphrase(e.target.value)}
        />
      </label>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button
          type="button"
          style={{
            ...BOTON_PRIMARIO,
            opacity: completo && !ocupado ? 1 : 0.55,
            cursor: completo && !ocupado ? 'pointer' : 'default'
          }}
          disabled={!completo || ocupado}
          onClick={() => void guardar()}
        >
          {ocupado ? 'Comprobando con Bitget…' : 'Guardar y leer saldos'}
        </button>
        {avisos.length > 0 && (
          <button type="button" style={boton} onClick={alDarDeAlta}>
            Continuar de todos modos
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Formulario de traspaso.
 *
 * Planificar no envía nada: calcula y abre la confirmación. Quien valida de
 * verdad es el proceso principal, contra el máximo transferible que Bitget
 * reporta en ese instante; aquí solo se recogen los tres datos y se enseña el
 * motivo cuando el plan se rechaza.
 */
function FormularioTraspaso({
  filas,
  moneda,
  madreUid,
  madreNombre,
  madreSaldo,
  alPlanificar
}: {
  filas: readonly SubAccountBalance[];
  moneda: string;
  /** UID de la cuenta principal: es una punta más, en los dos sentidos. */
  madreUid: string;
  madreNombre: string;
  /** Su saldo de futuros, o `null` si no se pudo leer. */
  madreSaldo: string | null;
  alPlanificar: (p: TransferPlan) => void;
}) {
  const [origen, fijarOrigen] = useState('');
  const [destino, fijarDestino] = useState('');
  const [importe, fijarImporte] = useState('');
  const [error, fijarError] = useState<string | null>(null);
  const [ocupado, fijarOcupado] = useState(false);

  const planificar = async (): Promise<void> => {
    fijarOcupado(true);
    fijarError(null);
    try {
      alPlanificar(
        await panelService.planTransfer({ fromUid: origen, toUid: destino, amount: importe })
      );
    } catch (e) {
      fijarError(e instanceof Error ? e.message : 'No se pudo preparar el traspaso.');
    } finally {
      fijarOcupado(false);
    }
  };

  /*
   * Del origen solo se ofrece lo que puede salir: sin datos no se saca nada.
   *
   * Y la madre se quita de las dos listas de subcuentas porque ya va aparte.
   * Cuando su propia clave está dada de alta en el panel —que es lo normal: es
   * la que lee los saldos— aparece también como fila, y ahí sale «sin datos»
   * porque Bitget no se reporta a sí misma. Sin esta línea, la cuenta principal
   * salía dos veces en «HACIA»: una utilizable y otra que solo daba error.
   */
  const subcuentas = filas.filter((f) => f.uid !== madreUid);
  const posiblesOrigen = subcuentas.filter((f) => !f.noData && f.maxTransferable !== null);
  const listo = origen !== '' && destino !== '' && importe.trim() !== '' && origen !== destino;
  const elegido = filas.find((f) => f.uid === origen);
  /*
   * La cuenta principal es una punta más, en los dos sentidos.
   *
   * Estaba fuera de los dos desplegables, así que meter dinero en una subcuenta
   * concreta solo se podía hacer por el reparto masivo —marcando esa única
   * subcuenta y repartiendo entre ella—, que no es donde nadie lo busca. El
   * traspaso ya la admitía por debajo: `subaccount-transfer` mueve entre dos
   * UID cualesquiera de la misma madre, y es lo que el reparto usa. Pedido por
   * el operador el 05/09/2026.
   *
   * De su saldo no se sabe nada —la madre no se reporta a sí misma—, así que
   * cuando es el origen no hay máximo que comprobar y lo dice la nota de abajo.
   */
  /*
   * El rótulo lleva el saldo, como las subcuentas.
   *
   * Sin él, la única línea del desplegable **con** dinero era la única sin
   * cifra, y se leía como la que no tiene información. Es lo que preguntó el
   * operador el 05/09/2026: «¿por qué no aparece la cuenta main, que es la que
   * tiene el dinero?». Aparecía; no lo parecía.
   */
  /*
   * Y lleva el UID, aunque tenga nombre.
   *
   * El nombre lo escribe el operador al dar de alta la cuenta principal, así que
   * puede no parecerse al que esa misma cuenta tiene en Bitget o en la matriz:
   * una principal dada de alta como «A» y registrada además como subcuenta
   * «Main» es la misma cuenta con dos rótulos, y sin el UID no hay forma de
   * verlo desde aquí. El UID es la identidad —mismo criterio que el registro de
   * cuentas— y no es secreto: no sirve para firmar nada.
   */
  const rotuloMadre =
    `Cuenta principal · ${madreNombre === '' ? madreUid : `${madreNombre} · ${madreUid}`}` +
    (madreSaldo === null ? '' : ` · ${cifra(madreSaldo)} ${moneda}`);
  const desdeMadre = origen !== '' && origen === madreUid;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '14px 16px',
        border: `1px solid ${T.borde}`,
        borderRadius: 10,
        background: T.superficie
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 12
        }}
      >
        <h3 style={{ margin: 0, fontSize: 13.5, fontWeight: 600, color: T.texto }}>
          Traspasar saldo
        </h3>
        {elegido?.maxTransferable != null && (
          <span style={{ fontSize: 11.5, color: T.texto2 }}>
            De {elegido.label} pueden salir{' '}
            <strong style={{ fontFamily: FUENTE.mono, color: T.texto }}>
              {cifra(elegido.maxTransferable)}
            </strong>{' '}
            {moneda}
          </span>
        )}
      </div>

      {error !== null && (
        <div
          role="alert"
          style={{
            padding: '9px 12px',
            borderRadius: 8,
            border: `1px solid ${T.alertaAvisoBorde}`,
            background: T.alertaAvisoFondo,
            color: T.alertaAvisoTexto,
            fontSize: 12,
            lineHeight: 1.45
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ ...etiquetaCampo, flex: '1 1 190px' }}>
          DESDE
          <select style={campo} value={origen} onChange={(e) => fijarOrigen(e.target.value)}>
            <option value="">Elegir cuenta…</option>
            {madreUid !== destino && <option value={madreUid}>{rotuloMadre}</option>}
            {posiblesOrigen.map((f) => (
              <option key={f.uid} value={f.uid}>
                {f.label} · {cifra(f.maxTransferable)} {moneda}
              </option>
            ))}
          </select>
        </label>

        <label style={{ ...etiquetaCampo, flex: '1 1 190px' }}>
          HACIA
          <select style={campo} value={destino} onChange={(e) => fijarDestino(e.target.value)}>
            <option value="">Elegir cuenta…</option>
            {madreUid !== origen && <option value={madreUid}>{rotuloMadre}</option>}
            {subcuentas
              .filter((f) => f.uid !== origen)
              .map((f) => (
                <option key={f.uid} value={f.uid}>
                  {f.label}
                </option>
              ))}
          </select>
        </label>

        <label style={{ ...etiquetaCampo, flex: '0 1 140px' }}>
          IMPORTE
          <input
            className="pcb-campo"
            style={campo}
            inputMode="decimal"
            placeholder="0.00"
            value={importe}
            /* Solo dígitos y punto: es dinero, y lo demás no es un importe. */
            onChange={(e) => fijarImporte(e.target.value.replace(/[^0-9.]/g, ''))}
          />
        </label>

        <button
          type="button"
          onClick={() => void planificar()}
          disabled={!listo || ocupado}
          style={{
            ...BOTON_PRIMARIO,
            flex: 'none',
            opacity: listo && !ocupado ? 1 : 0.55,
            cursor: listo && !ocupado ? 'pointer' : 'default'
          }}
        >
          {ocupado ? 'Calculando…' : 'Revisar traspaso'}
        </button>
      </div>

      {/*
        * Lo que el panel no puede comprobar, dicho antes de aprobar.
        *
        * De las subcuentas se conoce el máximo transferible y un importe de más
        * se rechaza aquí, en castellano y sin gastar una petición. De la cuenta
        * principal no: no se reporta a sí misma, así que ese freno no existe y
        * quien dice que no hay saldo es Bitget. Callarlo sería dejar creer que
        * la comprobación previa cubre también este caso.
        */}
      {desdeMadre && (
        <p style={{ margin: 0, fontSize: 11, lineHeight: 1.5, color: T.texto3 }}>
          {madreSaldo === null
            ? 'No se ha podido leer el saldo de la cuenta principal, así que aquí no se comprueba nada antes de enviar: si no alcanza, lo rechaza Bitget y el movimiento no se hace.'
            : `La cuenta principal tiene ${cifra(madreSaldo)} ${moneda} disponibles. De ella Bitget no informa del máximo transferible —solo lo hace de las subcuentas—, así que si parte está comprometida en posiciones el rechazo llega del exchange, no de aquí.`}
        </p>
      )}

      <p style={{ margin: 0, fontSize: 11, color: T.texto3 }}>
        Nada sale hasta que lo apruebes en la confirmación, con la contraseña de paso.
      </p>
    </div>
  );
}

/** Historial de lo que se ha movido. */
function Historial({ movimientos }: { movimientos: readonly TransferRecord[] }) {
  if (movimientos.length === 0) return null;

  const COLOR: Record<TransferRecord['outcome'], string> = {
    exito: T.texto2,
    fallo: T.alertaCriticaTexto,
    /* Ni bien ni mal: se envió y no se supo. Se mira; no se reintenta solo. */
    pendiente: T.alertaAvisoTexto
  };

  const ROTULO: Record<TransferRecord['outcome'], string> = {
    exito: 'ENVIADO',
    fallo: 'FALLÓ',
    pendiente: 'SIN CONFIRMAR'
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: T.texto2 }}>Movimientos</h3>
      <div
        style={{
          border: `1px solid ${T.borde}`,
          borderRadius: 10,
          overflow: 'hidden',
          background: T.superficie
        }}
      >
        {movimientos.map((m) => (
          <div
            key={m.id}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 10,
              padding: '8px 14px',
              borderTop: `1px solid ${T.bordeSuave}`,
              fontSize: 12.5
            }}
          >
            <span style={{ fontFamily: FUENTE.mono, fontSize: 11, color: T.texto3, flex: 'none' }}>
              {new Date(m.at).toLocaleString('es-MX', {
                day: '2-digit',
                month: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
              })}
            </span>
            <span
              style={{
                flex: '1 1 auto',
                minWidth: 0,
                color: T.texto,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
            >
              {m.fromLabel} → {m.toLabel}
            </span>
            <span style={{ ...numero, flex: 'none', color: T.texto }}>
              {cifra(m.amount)} {m.currency}
            </span>
            <span
              title={m.message ?? undefined}
              style={{
                flex: 'none',
                width: 96,
                textAlign: 'right',
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: '.06em',
                color: COLOR[m.outcome]
              }}
            >
              {ROTULO[m.outcome]}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Rótulo de cada mitad del bloque: dice la dirección en la que va el dinero. */
const rotuloMitad: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '.08em',
  color: T.texto2,
  textTransform: 'uppercase'
};

/**
 * Acciones masivas sobre las subcuentas marcadas: R5 y R6 del requerimiento.
 *
 * El reparto necesita un importe; la recogida no —se lleva lo que haya—. Las dos
 * pasan por la misma confirmación, que enseña la lista entera antes de enviar
 * nada.
 *
 * --------------------------------------------------------------------------
 * Las dos van separadas y con la dirección escrita
 * --------------------------------------------------------------------------
 * Estaban en una sola fila: importe, modo, «Revisar reparto» y «Recoger saldo»
 * uno detrás de otro. Así, el botón de recoger parecía usar el importe que hay
 * a su izquierda —no lo usa: se lleva todo lo que pueda salir— y en ningún
 * sitio decía **de dónde sale el dinero y a dónde va**, que es lo primero que
 * hay que saber antes de pulsar nada. El operador lo dijo con esas palabras el
 * 05/09/2026: «no se entiende».
 *
 * De ahí las tres cosas que hace ahora: nombrar la cuenta principal, separar
 * las dos operaciones con su dirección delante, y decir junto al botón por qué
 * no se puede pulsar todavía, en vez de dejarlo apagado sin explicación.
 */
function BarraMasiva({
  seleccion,
  moneda,
  madre,
  alPlanificar
}: {
  seleccion: readonly string[];
  moneda: string;
  /** Nombre de la cuenta principal: es el origen del reparto y el destino de la recogida. */
  madre: string;
  alPlanificar: (p: SpreadPlan) => void;
}) {
  const [total, fijarTotal] = useState('');
  const [modo, fijarModo] = useState<SpreadMode>('iguales');
  const [error, fijarError] = useState<string | null>(null);
  const [ocupado, fijarOcupado] = useState(false);

  const conPlan = async (hacer: () => Promise<SpreadPlan>): Promise<void> => {
    fijarOcupado(true);
    fijarError(null);
    try {
      alPlanificar(await hacer());
    } catch (e) {
      fijarError(e instanceof Error ? e.message : 'No se pudo preparar la operación.');
    } finally {
      fijarOcupado(false);
    }
  };

  const hay = seleccion.length > 0;
  const puedeRepartir = hay && total.trim() !== '' && !ocupado;

  /* Por qué no se puede repartir todavía. `null` = se puede. */
  const falta = !hay
    ? 'Marque subcuentas en la tabla de arriba'
    : total.trim() === ''
      ? 'Escriba el importe a repartir'
      : null;

  /* Cómo nombrar a las marcadas en las dos frases de dirección. */
  const marcadas = hay
    ? `${seleccion.length} ${seleccion.length === 1 ? 'subcuenta marcada' : 'subcuentas marcadas'}`
    : 'las subcuentas que marque';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '14px 16px',
        border: `1px solid ${T.borde}`,
        borderRadius: 10,
        background: T.superficie
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 12
        }}
      >
        <h3 style={{ margin: 0, fontSize: 13.5, fontWeight: 600, color: T.texto }}>
          Reparto y recogida
        </h3>
        <span style={{ fontSize: 11.5, color: hay ? T.texto2 : T.texto3 }}>
          {hay
            ? `${seleccion.length} ${seleccion.length === 1 ? 'subcuenta marcada' : 'subcuentas marcadas'}`
            : 'Ninguna subcuenta marcada'}
        </span>
      </div>

      {/*
        * La frase que faltaba: qué mueve esto y entre quiénes.
        *
        * «Sin salir de Bitget» no es un adorno: es la primera pregunta que se
        * hace quien ve un botón que mueve dinero, y la respuesta está en el
        * contrato —retirar a un destino externo no entra, y no entrará—.
        */}
      <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.5, color: T.texto2 }}>
        Mueve {moneda} entre la cuenta principal <strong>{madre}</strong> y sus subcuentas, en el
        monedero de futuros y sin salir de Bitget.
      </p>

      {error !== null && (
        <div
          role="alert"
          style={{
            padding: '9px 12px',
            borderRadius: 8,
            border: `1px solid ${T.alertaAvisoBorde}`,
            background: T.alertaAvisoFondo,
            color: T.alertaAvisoTexto,
            fontSize: 12,
            lineHeight: 1.45
          }}
        >
          {error}
        </div>
      )}

      <div style={{ ...rotuloMitad, display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' }}>
        Repartir
        <span style={{ fontSize: 11, fontWeight: 500, letterSpacing: 0, textTransform: 'none', color: T.texto3 }}>
          de la cuenta principal {madre} → a {marcadas}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ ...etiquetaCampo, flex: '0 1 150px' }}>
          IMPORTE A REPARTIR
          <input
            className="pcb-campo"
            style={campo}
            inputMode="decimal"
            placeholder="0.00"
            value={total}
            onChange={(e) => fijarTotal(e.target.value.replace(/[^0-9.]/g, ''))}
          />
        </label>

        <label style={{ ...etiquetaCampo, flex: '1 1 220px' }}>
          CÓMO
          <select
            style={campo}
            value={modo}
            onChange={(e) => fijarModo(e.target.value as SpreadMode)}
          >
            <option value="iguales">A partes iguales</option>
            <option value="igualar">Igualando los saldos</option>
          </select>
        </label>

        <button
          type="button"
          onClick={() =>
            void conPlan(() =>
              panelService.planSpread({ toUids: [...seleccion], total, mode: modo })
            )
          }
          disabled={!puedeRepartir}
          style={{
            ...BOTON_PRIMARIO,
            flex: 'none',
            opacity: puedeRepartir ? 1 : 0.55,
            cursor: puedeRepartir ? 'pointer' : 'default'
          }}
        >
          Revisar reparto
        </button>

        {/* Un botón apagado sin motivo se lee como un botón roto. */}
        {falta !== null && (
          <span style={{ flex: '1 1 160px', fontSize: 11, color: T.texto3, alignSelf: 'center' }}>
            {falta}
          </span>
        )}
      </div>

      <p style={{ margin: 0, fontSize: 11, lineHeight: 1.5, color: T.texto3 }}>
        <strong>A partes iguales</strong> da lo mismo a cada una;{' '}
        <strong>igualando los saldos</strong> las deja al mismo nivel, sin quitarle nada a la que ya
        esté por encima. Importes en {moneda}.
      </p>

      <div style={{ height: 1, background: T.bordeSuave, margin: '2px 0' }} />

      <div style={{ ...rotuloMitad, display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' }}>
        Recoger
        <span style={{ fontSize: 11, fontWeight: 500, letterSpacing: 0, textTransform: 'none', color: T.texto3 }}>
          de {marcadas} → a la cuenta principal {madre}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          type="button"
          onClick={() => void conPlan(() => panelService.planCollect({ fromUids: [...seleccion] }))}
          disabled={!hay || ocupado}
          style={{
            ...boton,
            flex: 'none',
            opacity: hay && !ocupado ? 1 : 0.55,
            cursor: hay && !ocupado ? 'pointer' : 'default'
          }}
        >
          Recoger saldo
        </button>

        <span style={{ flex: '1 1 200px', fontSize: 11, lineHeight: 1.5, color: T.texto3 }}>
          {hay
            ? 'Devuelve todo lo que pueda salir de esas subcuentas. No usa el importe de arriba.'
            : 'Marque subcuentas en la tabla de arriba.'}
        </span>
      </div>
    </div>
  );
}

/** Lo que la pantalla puede estar enseñando en cada momento. */
type Estado =
  | { fase: 'cargando' }
  | { fase: 'sin-madre' }
  | { fase: 'listo'; hoja: BalanceSheet; movimientos: TransferRecord[] }
  | { fase: 'error'; motivo: string };

/**
 * Decide qué toca enseñar, sin tocar estado de React.
 *
 * Devuelve el estado en vez de fijarlo para que el efecto de montaje no llame a
 * `setState` de forma sincrona —lo prohíbe `react-hooks/set-state-in-effect`, y
 * con razón: encadena renders—. Además evita salir a la red cuando todavía no
 * hay credencial que usar.
 */
async function cargar(): Promise<Estado> {
  try {
    const madres = await panelService.listParentAccounts();
    if (madres.length === 0) return { fase: 'sin-madre' };

    const hoja = await panelService.getBalanceSheet();
    /*
     * El historial se lee de disco y no cuesta una petición a Bitget, pero si
     * fallara no puede llevarse por delante los saldos: son lo que la pantalla
     * viene a enseñar. Mismo criterio que en `iniciar` del store.
     */
    const movimientos = await panelService.listTransfers(20).catch(() => []);
    return { fase: 'listo', hoja, movimientos };
  } catch (e) {
    return {
      fase: 'error',
      motivo: e instanceof Error ? e.message : 'No se pudieron leer los saldos.'
    };
  }
}

function CuerpoSaldos() {
  const [estado, fijarEstado] = useState<Estado>({ fase: 'cargando' });
  const [vuelta, fijarVuelta] = useState(0);
  const [releyendo, fijarReleyendo] = useState(false);
  /** El traspaso pendiente de aprobar. `null` = no hay confirmación abierta. */
  const [plan, fijarPlan] = useState<TransferPlan | null>(null);
  /** El reparto o recogida pendiente de aprobar. */
  const [planMasivo, fijarPlanMasivo] = useState<SpreadPlan | null>(null);
  /** Desenlace del último envío, para decirlo sin un diálogo más. */
  const [ultimo, fijarUltimo] = useState<TransferResult | null>(null);
  /** Desenlace del último reparto: cuántos entraron y cuántos no. */
  const [ultimoMasivo, fijarUltimoMasivo] = useState<SpreadResult | null>(null);
  /** UIDs marcados para las acciones masivas. */
  const [marcadas, fijarMarcadas] = useState<string[]>([]);

  useEffect(() => {
    let vivo = true;
    void (async () => {
      const siguiente = await cargar();
      if (!vivo) return;
      fijarEstado(siguiente);
      fijarReleyendo(false);
    })();
    return () => {
      vivo = false;
    };
  }, [vuelta]);

  const releer = (): void => {
    fijarReleyendo(true);
    fijarVuelta((v) => v + 1);
  };

  /*
   * Salga bien o mal, después de un envío se releen los saldos: si salió, ya no
   * son los de antes, y dejarlos en pantalla invitaría a preparar el siguiente
   * traspaso sobre cifras que ya no existen.
   */
  const alTerminar = (r: TransferResult): void => {
    fijarPlan(null);
    fijarUltimo(r);
    releer();
  };

  const alTerminarMasivo = (r: SpreadResult): void => {
    fijarPlanMasivo(null);
    fijarUltimoMasivo(r);
    /* La selección se suelta: se acaba de operar sobre ella. */
    fijarMarcadas([]);
    releer();
  };

  if (estado.fase === 'sin-madre') return <AltaMadre alDarDeAlta={releer} />;

  /* Solo las que tienen datos entran en reparto o recogida. */
  const marcables =
    estado.fase === 'listo' ? estado.hoja.rows.filter((f) => !f.noData).map((f) => f.uid) : [];

  const hoja = estado.fase === 'listo' ? estado.hoja : null;
  const hora =
    hoja === null
      ? ''
      : new Date(hoja.fetchedAt).toLocaleTimeString('es-MX', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        });

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: ANCHO_MINIMO }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 16
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 12, color: T.texto2 }}>
            {hoja === null
              ? 'Cuenta principal'
              : `${hoja.parentName || 'Cuenta principal'} · UID ${hoja.parentUid}`}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {hoja !== null && (
            <span style={{ fontSize: 11.5, color: T.texto3 }}>Leído a las {hora}</span>
          )}
          <button
            type="button"
            style={boton}
            onClick={releer}
            disabled={releyendo || estado.fase === 'cargando'}
          >
            {releyendo || estado.fase === 'cargando' ? 'Leyendo…' : 'Actualizar'}
          </button>
        </div>
      </header>

      {/*
        * El desenlace del traspaso ya no sale aquí, en una banda sobre la tabla:
        * sale en un diálogo, al final de esta misma pantalla. La banda aparecía
        * arriba mientras el operador miraba el formulario de abajo, y la lista
        * se recargaba en ese momento porque los saldos ya no eran los de antes;
        * un rechazo —o peor, un envío sin confirmar— se podía quedar sin leer.
        * Ver `DialogoResultadoTraspaso`.
        */}
      {ultimoMasivo !== null && (
        <div
          role="status"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
            padding: '10px 14px',
            borderRadius: 8,
            fontSize: 12.5,
            lineHeight: 1.5,
            /* Un lote con un solo fallo no es un éxito, y no se pinta como tal. */
            border: `1px solid ${ultimoMasivo.ok ? T.borde : T.alertaAvisoBorde}`,
            background: ultimoMasivo.ok ? T.superficie2 : T.alertaAvisoFondo,
            color: ultimoMasivo.ok ? T.texto2 : T.alertaAvisoTexto
          }}
        >
          <div style={{ flex: '1 1 auto', minWidth: 0 }}>
            <strong>
              {ultimoMasivo.sent}{' '}
              {ultimoMasivo.sent === 1 ? 'traspaso enviado' : 'traspasos enviados'}
              {ultimoMasivo.failed > 0 && ` · ${ultimoMasivo.failed} sin enviar`}
              {ultimoMasivo.unconfirmed > 0 && ` · ${ultimoMasivo.unconfirmed} sin confirmar`}
            </strong>

            {/*
             * Los sin confirmar se explican aparte y primero. Es el único caso en
             * el que repetir la operación puede mover el dinero dos veces, así que
             * no puede quedar mezclado en la misma lista que los rechazos.
             */}
            {ultimoMasivo.unconfirmed > 0 && (
              <p style={{ margin: '6px 0 0' }}>
                Los que salen «sin confirmar» se enviaron y Bitget no dijo si entraron.
                <strong> Comprueba sus saldos antes de repetirlos:</strong> un envío nuevo lleva
                otro identificador y movería el dinero otra vez. Quedan registrados como
                pendientes.
              </p>
            )}

            {ultimoMasivo.results.some((x) => !x.ok) && (
              <ul style={{ margin: '5px 0 0', paddingLeft: 18 }}>
                {ultimoMasivo.results
                  .filter((x) => !x.ok)
                  .map((x) => (
                    <li key={x.id}>
                      {x.fromLabel} → {x.toLabel}: {x.message ?? 'sin detalle'}
                    </li>
                  ))}
              </ul>
            )}
          </div>
          <button
            type="button"
            onClick={() => fijarUltimoMasivo(null)}
            style={{
              flex: 'none',
              border: 'none',
              background: 'transparent',
              color: 'inherit',
              fontSize: 14,
              cursor: 'pointer'
            }}
            title="Cerrar el aviso"
          >
            ×
          </button>
        </div>
      )}

      {estado.fase === 'error' && (
        <div
          role="alert"
          style={{
            padding: '11px 14px',
            borderRadius: 8,
            border: `1px solid ${T.alertaAvisoBorde}`,
            background: T.alertaAvisoFondo,
            color: T.alertaAvisoTexto,
            fontSize: 12.5,
            lineHeight: 1.5
          }}
        >
          {estado.motivo}
        </div>
      )}

      <div
        style={{
          border: `1px solid ${T.borde}`,
          borderRadius: 10,
          overflow: 'hidden',
          background: T.superficie
        }}
      >
        <div style={cabecera}>
          <input
            type="checkbox"
            title="Marcar o desmarcar todas las que tienen datos"
            checked={marcadas.length > 0 && marcadas.length === marcables.length}
            /* Ni todas ni ninguna: el estado intermedio se ve, no se adivina. */
            ref={(el) => {
              if (el !== null)
                el.indeterminate = marcadas.length > 0 && marcadas.length < marcables.length;
            }}
            onChange={(e) => fijarMarcadas(e.target.checked ? marcables : [])}
            style={{ cursor: 'pointer' }}
          />
          <span>SUBCUENTA</span>
          <span />
          <span style={{ textAlign: 'right' }}>DISPONIBLE</span>
          <span style={{ textAlign: 'right' }}>TRANSFERIBLE</span>
          <span style={{ textAlign: 'right' }}>EQUITY</span>
        </div>

        {estado.fase === 'cargando' ? (
          <EsqueletoFilas rejilla={REJILLA} anchoMinimo={ANCHO_MINIMO} filas={8} />
        ) : hoja === null || hoja.rows.length === 0 ? (
          <EstadoVacio
            titulo="Sin saldos que mostrar"
            cuerpo={
              estado.fase === 'error'
                ? 'No se pudo leer. Comprueba que la credencial sea la de la cuenta principal de la que cuelgan tus subcuentas.'
                : 'Bitget no reporta ninguna subcuenta para esta cuenta principal.'
            }
          />
        ) : (
          hoja.rows.map((f) => (
            <div
              key={f.uid}
              style={{
                display: 'grid',
                gridTemplateColumns: REJILLA,
                gap: 12,
                alignItems: 'center',
                padding: '9px 14px',
                borderTop: `1px solid ${T.bordeSuave}`,
                background: f.noData ? T.superficie2 : 'transparent',
                fontSize: 13
              }}
            >
              <input
                type="checkbox"
                /* Sin datos no se puede repartir ni recoger: no se deja marcar. */
                disabled={f.noData}
                checked={marcadas.includes(f.uid)}
                onChange={(e) =>
                  fijarMarcadas((m) =>
                    e.target.checked ? [...m, f.uid] : m.filter((x) => x !== f.uid)
                  )
                }
                title={
                  f.noData ? 'Sin datos: no entra en reparto ni recogida' : `Marcar ${f.label}`
                }
                style={{ cursor: f.noData ? 'default' : 'pointer' }}
              />
              <span style={{ ...celda, color: T.texto, fontWeight: 500 }} title={`UID ${f.uid}`}>
                {f.label}
              </span>
              <Distintivo fila={f} />
              <Cantidad valor={f.available} />
              <Cantidad valor={f.maxTransferable} />
              <Cantidad valor={f.equity} atenuado />
            </div>
          ))
        )}

        {hoja !== null && hoja.rows.length > 0 && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: REJILLA,
              gap: 12,
              alignItems: 'center',
              padding: '10px 14px',
              borderTop: `1px solid ${T.borde}`,
              background: T.superficie2,
              fontSize: 13,
              fontWeight: 600
            }}
          >
            <span />
            <span style={{ ...celda, color: T.texto2 }}>
              TOTAL · {hoja.withData} de {hoja.rows.length} con datos
            </span>
            <span />
            <span style={{ ...numero, color: T.texto }}>{cifra(hoja.totalAvailable)}</span>
            <span style={{ ...numero, color: T.texto }}>{cifra(hoja.totalTransferable)}</span>
            <span />
          </div>
        )}

        {/*
          * La cuenta principal, fuera de la tabla y a propósito.
          *
          * No es una subcuenta: no ocupa casilla, no se opera y su saldo sale de
          * otra petición. Meterla como una fila más la sumaría al TOTAL, que es
          * el total de las subcuentas, y ese número dejaría de significar lo que
          * dice. Va debajo, con su nombre y su cifra, que es lo que faltaba: es
          * la cuenta desde la que se reparte.
          */}
        {hoja !== null && (
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 12,
              padding: '10px 14px',
              borderTop: `1px solid ${T.borde}`,
              background: T.superficie,
              fontSize: 12.5
            }}
          >
            <span style={{ color: T.texto2, fontWeight: 600 }}>
              Cuenta principal {hoja.parentName === '' ? '' : `${hoja.parentName} · `}
              <span style={{ fontFamily: FUENTE.mono }}>{hoja.parentUid}</span>
              <span style={{ marginLeft: 8, fontWeight: 400, color: T.texto3 }}>
                no es una subcuenta: no entra en el total
              </span>
            </span>
            <span style={{ ...numero, color: T.texto, fontWeight: 600 }}>
              {hoja.parentAvailable === null
                ? '— no se pudo leer'
                : `${cifra(hoja.parentAvailable)} ${hoja.currency}`}
            </span>
          </div>
        )}
      </div>

      <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.55, color: T.texto3 }}>
        <strong style={{ color: T.texto2 }}>Transferible</strong> es lo que Bitget permite sacar de
        cada subcuenta: el saldo menos el margen comprometido en posiciones abiertas. Es el número
        contra el que se valida cada traspaso. Importes en {hoja?.currency ?? 'USDT'}.
      </p>

      {estado.fase === 'listo' && estado.hoja.rows.length > 0 && (
        <FormularioTraspaso
          filas={estado.hoja.rows}
          moneda={estado.hoja.currency}
          madreUid={estado.hoja.parentUid}
          madreNombre={estado.hoja.parentName}
          madreSaldo={estado.hoja.parentAvailable}
          alPlanificar={fijarPlan}
        />
      )}

      {estado.fase === 'listo' && estado.hoja.rows.length > 0 && (
        <BarraMasiva
          seleccion={marcadas}
          moneda={estado.hoja.currency}
          madre={estado.hoja.parentName}
          alPlanificar={fijarPlanMasivo}
        />
      )}

      {estado.fase === 'listo' && <Historial movimientos={estado.movimientos} />}

      {plan !== null && (
        <DialogoTraspaso plan={plan} alCerrar={() => fijarPlan(null)} alTerminar={alTerminar} />
      )}

      {/*
        * Va después de la confirmación a propósito: la sustituye. `alTerminar`
        * cierra una y abre este, así que nunca están los dos a la vez.
        */}
      {ultimo !== null && (
        <DialogoResultadoTraspaso resultado={ultimo} alCerrar={() => fijarUltimo(null)} />
      )}

      {planMasivo !== null && (
        <DialogoReparto
          plan={planMasivo}
          alCerrar={() => fijarPlanMasivo(null)}
          alTerminar={alTerminarMasivo}
        />
      )}
    </section>
  );
}

export function PantallaSaldos() {
  const abierta = usarPanel((s) => s.saldosAbierto);
  const cerrar = usarPanel((s) => s.cerrarSaldos);

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
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '.14em',
              color: '#8ccdf5',
              fontFamily: FUENTE.mono
            }}
          >
            SALDOS
          </span>
          <span style={{ fontSize: 18, fontWeight: 600 }}>Saldos por subcuenta</span>
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
        <CuerpoSaldos />
      </div>
    </div>
  );
}
