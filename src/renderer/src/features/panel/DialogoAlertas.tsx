import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import type { AlertsCheck, AlertsStatus, TelegramChat } from '@shared/domain/panel-view';
import { BOTON_PRIMARIO, CAJA_ERROR, FUENTE, SOMBRA, T, VELO } from '@/lib/tokens';
import { panelService } from '@/services/panel-service';
import { usarPanel } from '@/store/panel';

/**
 * Alertas por Telegram de lo hecho fuera del panel.
 *
 * Sin bot configurado, la pantalla es una guía de tres pasos: crear el bot,
 * meterlo en el grupo y guardar. El id del grupo no se escribe a mano: el panel
 * le pregunta al bot qué chats le escribieron y el operador elige uno. Con el
 * bot ya guardado, enseña dónde llegan los avisos y la última revisión.
 *
 * Guardar y desactivar piden la contraseña de paso: quien se sienta ante un
 * panel desbloqueado no debe poder desviar los avisos a su propio chat.
 */

const velo: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 78,
  background: VELO.seguridad,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 28
};
const tarjeta: CSSProperties = {
  width: 560,
  maxWidth: '100%',
  maxHeight: '100%',
  overflowY: 'auto',
  background: T.superficie,
  borderRadius: 14,
  boxShadow: SOMBRA.seguridad
};
const cuerpo: CSSProperties = {
  padding: '20px 24px 24px',
  display: 'flex',
  flexDirection: 'column',
  gap: 16
};
const texto: CSSProperties = { fontSize: 12.5, lineHeight: 1.55, color: T.texto2, margin: 0 };
const campo: CSSProperties = {
  padding: '10px 12px',
  borderRadius: 9,
  border: `1px solid ${T.bordeFuerte}`,
  fontSize: 13,
  background: T.campoFondo,
  color: T.campoTexto,
  outline: 'none',
  fontFamily: FUENTE.mono,
  minWidth: 0
};
const etiqueta: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  fontSize: 11.5,
  fontWeight: 600,
  letterSpacing: '.06em',
  color: T.texto2
};
const botonPrimario = (activo: boolean): CSSProperties => ({
  padding: '10px 16px',
  borderRadius: 9,
  fontSize: 13,
  fontWeight: 600,
  cursor: activo ? 'pointer' : 'default',
  border: `1px solid ${BOTON_PRIMARIO.borde}`,
  background: BOTON_PRIMARIO.fondo,
  color: BOTON_PRIMARIO.texto,
  opacity: activo ? 1 : 0.55
});
const botonClaro: CSSProperties = {
  padding: '9px 14px',
  borderRadius: 9,
  fontSize: 12.5,
  fontWeight: 600,
  cursor: 'pointer',
  border: `1px solid ${T.bordeFuerte}`,
  background: T.superficie,
  color: T.texto
};

function Paso({ n, titulo, children }: { n: number; titulo: string; children: ReactNode }) {
  return (
    <section style={{ display: 'flex', gap: 12 }}>
      <span
        style={{
          flex: 'none',
          width: 24,
          height: 24,
          borderRadius: '50%',
          background: T.marcaRelleno,
          color: '#ffffff',
          fontSize: 12,
          fontWeight: 700,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        {n}
      </span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={{ fontSize: 13.5, fontWeight: 700, color: T.texto }}>{titulo}</span>
        {children}
      </div>
    </section>
  );
}

function Mensaje({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <div
      role={ok ? 'status' : 'alert'}
      style={{
        padding: '10px 12px',
        borderRadius: 9,
        fontSize: 12,
        lineHeight: 1.5,
        border: `1px solid ${ok ? '#cfe4f5' : CAJA_ERROR.borde}`,
        borderLeft: `4px solid ${ok ? T.marcaRelleno : CAJA_ERROR.acento}`,
        background: ok ? '#eff7fd' : CAJA_ERROR.fondo,
        color: ok ? '#14568f' : CAJA_ERROR.texto
      }}
    >
      {children}
    </div>
  );
}

const fechaHora = (ms: number): string =>
  new Date(ms).toLocaleString('es-MX', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

function resumenRevision(r: AlertsCheck): string {
  const ops = (n: number) => `${n} ${n === 1 ? 'operación' : 'operaciones'}`;
  const base = `${fechaHora(r.finishedAt)} · ${r.reviewed} de ${r.accounts} subcuentas revisadas`;
  switch (r.delivery) {
    case 'ok':
      return `${base} · ${ops(r.sent)} avisadas.`;
    case 'no-news':
      return `${base} · sin operaciones fuera del panel.`;
    case 'failed':
      return `${base} · no se pudo enviar: ${r.deliveryMessage ?? ''} Quedan ${ops(r.pending)} pendientes.`;
    case 'aborted':
      return `${base} · interrumpida al bloquear el panel.`;
    case 'not-configured':
      return 'Sin bot configurado.';
  }
}

/* ---------------- guía de alta ---------------- */

function Alta({ alGuardar }: { alGuardar: (s: AlertsStatus, mensaje: string) => void }) {
  const [token, fijarToken] = useState('');
  const [verToken, fijarVerToken] = useState(false);
  const [buscando, fijarBuscando] = useState(false);
  const [bot, fijarBot] = useState<string | null>(null);
  const [chats, fijarChats] = useState<TelegramChat[] | null>(null);
  const [chat, fijarChat] = useState<TelegramChat | null>(null);
  const [paso, fijarPaso] = useState('');
  const [guardando, fijarGuardando] = useState(false);
  const [aviso, fijarAviso] = useState<{ ok: boolean; texto: string } | null>(null);

  const buscar = async (): Promise<void> => {
    fijarBuscando(true);
    fijarAviso(null);
    try {
      const r = await panelService.findTelegramChats(token.trim());
      fijarBot(r.bot === null ? null : `@${r.bot.username}`);
      fijarChats(r.ok ? r.chats : null);
      fijarChat(r.chats.length === 1 ? (r.chats[0] ?? null) : null);
      if (r.message !== null) fijarAviso({ ok: r.ok, texto: r.message });
    } catch (e) {
      fijarAviso({
        ok: false,
        texto: e instanceof Error ? e.message : 'No se pudo consultar Telegram.'
      });
    } finally {
      fijarBuscando(false);
    }
  };

  const guardar = async (): Promise<void> => {
    if (chat === null) return;
    fijarGuardando(true);
    fijarAviso(null);
    try {
      const r = await panelService.configureAlerts(
        { token: token.trim(), chatId: chat.id, chatTitle: chat.title },
        paso
      );
      if (r.ok) alGuardar(r.status, r.message);
      else fijarAviso({ ok: false, texto: r.message });
    } catch (e) {
      fijarAviso({ ok: false, texto: e instanceof Error ? e.message : 'No se pudo guardar.' });
    } finally {
      fijarGuardando(false);
    }
  };

  return (
    <div style={cuerpo}>
      <p style={texto}>
        El panel revisará qué se hizo <strong>fuera de él</strong> —desde la app, la web de Bitget u
        otro programa— y lo mandará a un grupo de Telegram: al desbloquearlo y, mientras esté
        abierto, cada 15 minutos. Lo que hace el propio panel y lo automático (TP disparado,
        liquidación) no se avisa.
      </p>

      <Paso n={1} titulo="Cree el bot en Telegram">
        <p style={texto}>
          En Telegram abra <strong>@BotFather</strong>, escriba <code>/newbot</code>, póngale un
          nombre y un usuario que termine en «bot». Le dará un <strong>token</strong>: cópielo aquí.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="pcb-campo"
            type={verToken ? 'text' : 'password'}
            placeholder="123456789:AAF…"
            value={token}
            onChange={(e) => {
              fijarToken(e.target.value);
              fijarChats(null);
              fijarChat(null);
              fijarBot(null);
            }}
            autoComplete="off"
            spellCheck={false}
            style={{ ...campo, flex: 1 }}
          />
          <button type="button" style={botonClaro} onClick={() => fijarVerToken((v) => !v)}>
            {verToken ? 'Ocultar' : 'Ver'}
          </button>
        </div>
      </Paso>

      <Paso n={2} titulo="Agregue el bot a su grupo">
        <p style={texto}>
          Cree un grupo (o use uno existente), agregue el bot como miembro y escriba{' '}
          <code>/start</code> en el grupo. Luego pulse «Buscar chats».
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            type="button"
            style={botonClaro}
            disabled={token.trim() === '' || buscando}
            onClick={() => void buscar()}
          >
            {buscando ? 'Buscando…' : 'Buscar chats'}
          </button>
          {bot !== null && <span style={{ fontSize: 12, color: T.texto3 }}>Bot: {bot}</span>}
        </div>
        {chats !== null && chats.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {chats.map((c) => (
              <label
                key={c.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '9px 12px',
                  borderRadius: 9,
                  cursor: 'pointer',
                  border: `1px solid ${chat?.id === c.id ? T.marcaRelleno : T.borde}`,
                  background: chat?.id === c.id ? T.superficie2 : T.superficie
                }}
              >
                <input
                  type="radio"
                  name="chat-telegram"
                  checked={chat?.id === c.id}
                  onChange={() => fijarChat(c)}
                />
                <span style={{ flex: 1, fontSize: 13, color: T.texto, fontWeight: 600 }}>
                  {c.title}
                </span>
                <span style={{ fontSize: 11, color: T.texto3 }}>
                  {c.type === 'private' ? 'chat privado' : 'grupo'}
                </span>
              </label>
            ))}
          </div>
        )}
      </Paso>

      <Paso n={3} titulo="Guarde y compruebe">
        <p style={texto}>
          El panel enviará un mensaje de prueba al chat elegido y, si llega, guardará el bot en el
          almacén cifrado. Lo hecho antes de este momento no se avisa.
        </p>
        <label style={etiqueta}>
          CONTRASEÑA DE PASO
          <input
            className="pcb-campo"
            type="password"
            autoComplete="off"
            placeholder="•••"
            value={paso}
            onChange={(e) => fijarPaso(e.target.value)}
            style={{ ...campo, letterSpacing: '.3em', width: 180 }}
          />
        </label>
        <button
          type="button"
          style={botonPrimario(chat !== null && paso !== '' && !guardando)}
          disabled={chat === null || paso === '' || guardando}
          onClick={() => void guardar()}
        >
          {guardando ? 'Enviando prueba…' : 'Guardar y enviar prueba'}
        </button>
      </Paso>

      {aviso !== null && <Mensaje ok={aviso.ok}>{aviso.texto}</Mensaje>}
    </div>
  );
}

/* ---------------- bot ya configurado ---------------- */

function Activas({
  estado,
  alCambiar,
  mensajeInicial
}: {
  estado: AlertsStatus;
  alCambiar: (s: AlertsStatus) => void;
  mensajeInicial: string | null;
}) {
  const [ocupado, fijarOcupado] = useState<null | 'revisar' | 'probar' | 'desactivar'>(null);
  const [aviso, fijarAviso] = useState<{ ok: boolean; texto: string } | null>(
    mensajeInicial === null ? null : { ok: true, texto: mensajeInicial }
  );
  const [pidiendoPaso, fijarPidiendoPaso] = useState(false);
  const [paso, fijarPaso] = useState('');

  const revisar = async (): Promise<void> => {
    fijarOcupado('revisar');
    fijarAviso(null);
    try {
      const r = await panelService.checkAlertsNow();
      fijarAviso({ ok: r.delivery !== 'failed', texto: resumenRevision(r) });
      alCambiar(await panelService.getAlertsStatus());
    } catch (e) {
      fijarAviso({ ok: false, texto: e instanceof Error ? e.message : 'No se pudo revisar.' });
    } finally {
      fijarOcupado(null);
    }
  };

  const probar = async (): Promise<void> => {
    fijarOcupado('probar');
    fijarAviso(null);
    try {
      const r = await panelService.testAlerts();
      fijarAviso({ ok: r.ok, texto: r.message });
    } finally {
      fijarOcupado(null);
    }
  };

  const desactivar = async (): Promise<void> => {
    fijarOcupado('desactivar');
    fijarAviso(null);
    try {
      const r = await panelService.disableAlerts(paso);
      if (r.ok) alCambiar(r.status);
      else fijarAviso({ ok: false, texto: r.message });
    } finally {
      fijarOcupado(null);
      fijarPaso('');
    }
  };

  return (
    <div style={cuerpo}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          padding: '12px 14px',
          borderRadius: 10,
          border: `1px solid ${T.borde}`,
          background: T.superficie2
        }}
      >
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 13.5,
            fontWeight: 700,
            color: T.texto
          }}
        >
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#2f9e44' }} />
          Alertas activas
        </span>
        <span style={{ fontSize: 12.5, color: T.texto2 }}>
          Llegan a <strong>{estado.chatTitle ?? estado.chatId}</strong>
          {estado.enabledAt !== null
            ? ` · desde el ${fechaHora(Date.parse(estado.enabledAt))}`
            : ''}
        </span>
        <span style={{ fontSize: 12, color: T.texto3 }}>
          Última revisión:{' '}
          {estado.lastCheck === null ? 'todavía ninguna' : resumenRevision(estado.lastCheck)}
        </span>
        {estado.pending > 0 && (
          <span style={{ fontSize: 12, color: T.alertaAvisoTexto }}>
            {estado.pending} {estado.pending === 1 ? 'aviso espera' : 'avisos esperan'} a que
            Telegram responda.
          </span>
        )}
      </div>

      <p style={texto}>
        Revisa al desbloquear el panel y, mientras está abierto, cada 15 minutos. Con el panel
        cerrado no revisa: lo de ese tiempo llega al volver a abrirlo. Cada aviso nombra la
        subcuenta con su identificador (por ejemplo{' '}
        <span style={{ fontFamily: FUENTE.mono }}>PCB-{estado.panelNumber}-A-1</span>).
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button
          type="button"
          style={botonPrimario(ocupado === null)}
          disabled={ocupado !== null}
          onClick={() => void revisar()}
        >
          {ocupado === 'revisar' ? 'Revisando…' : 'Revisar ahora'}
        </button>
        <button
          type="button"
          style={botonClaro}
          disabled={ocupado !== null}
          onClick={() => void probar()}
        >
          {ocupado === 'probar' ? 'Enviando…' : 'Enviar prueba'}
        </button>
        <button
          type="button"
          style={{ ...botonClaro, marginLeft: 'auto', color: CAJA_ERROR.texto }}
          disabled={ocupado !== null}
          onClick={() => fijarPidiendoPaso((v) => !v)}
        >
          Desactivar
        </button>
      </div>

      {pidiendoPaso && (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
          <label style={etiqueta}>
            CONTRASEÑA DE PASO
            <input
              className="pcb-campo"
              type="password"
              autoComplete="off"
              placeholder="•••"
              value={paso}
              onChange={(e) => fijarPaso(e.target.value)}
              style={{ ...campo, letterSpacing: '.3em', width: 180 }}
              autoFocus
            />
          </label>
          <button
            type="button"
            style={{ ...botonClaro, color: CAJA_ERROR.texto }}
            disabled={paso === '' || ocupado !== null}
            onClick={() => void desactivar()}
          >
            {ocupado === 'desactivar' ? 'Desactivando…' : 'Confirmar'}
          </button>
        </div>
      )}

      {aviso !== null && <Mensaje ok={aviso.ok}>{aviso.texto}</Mensaje>}
    </div>
  );
}

/* ---------------- diálogo ---------------- */

export function DialogoAlertas() {
  const abierto = usarPanel((s) => s.alertasAbierto);
  const cerrar = usarPanel((s) => s.cerrarAlertas);
  const [estado, fijarEstado] = useState<AlertsStatus | null>(null);
  const [error, fijarError] = useState<string | null>(null);
  const [recienGuardado, fijarRecienGuardado] = useState<string | null>(null);

  useEffect(() => {
    if (!abierto) return;
    let vivo = true;
    void panelService.getAlertsStatus().then(
      (s) => {
        if (vivo) {
          fijarEstado(s);
          fijarError(null);
        }
      },
      (e: unknown) => {
        if (vivo) fijarError(e instanceof Error ? e.message : 'No se pudo leer la configuración.');
      }
    );
    return () => {
      vivo = false;
    };
  }, [abierto]);

  if (!abierto) return null;

  const salir = (): void => {
    fijarRecienGuardado(null);
    cerrar();
  };

  return (
    <div style={velo}>
      <div style={tarjeta}>
        <div
          style={{
            padding: '20px 24px',
            background: T.marca,
            color: '#ffffff',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 14
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: '.14em',
                color: '#8ccdf5',
                fontFamily: FUENTE.mono
              }}
            >
              ALERTAS
            </span>
            <span style={{ fontSize: 18, fontWeight: 600 }}>Avisos por Telegram</span>
          </div>
          <button
            type="button"
            className="pcb-boton-barra"
            onClick={salir}
            title="Cerrar"
            style={{
              flex: 'none',
              width: 28,
              height: 28,
              borderRadius: 8,
              border: '1px solid #ffffff2e',
              background: '#ffffff14',
              color: '#ffffff',
              fontSize: 14,
              cursor: 'pointer'
            }}
          >
            ×
          </button>
        </div>

        {error !== null ? (
          <div style={cuerpo}>
            <Mensaje ok={false}>{error}</Mensaje>
          </div>
        ) : estado === null ? (
          <div style={cuerpo}>
            <p style={texto}>Leyendo la configuración…</p>
          </div>
        ) : estado.configured ? (
          <Activas
            key={estado.enabledAt ?? 'activas'}
            estado={estado}
            alCambiar={fijarEstado}
            mensajeInicial={recienGuardado}
          />
        ) : (
          <Alta
            alGuardar={(s, mensaje) => {
              fijarRecienGuardado(mensaje);
              fijarEstado(s);
            }}
          />
        )}
      </div>
    </div>
  );
}
