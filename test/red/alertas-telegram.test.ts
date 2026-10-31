/**
 * Alertas contra Telegram y Bitget de verdad. Envía mensajes reales al chat.
 *
 * Necesita en `.env` (ignorado por git):
 *
 *   TELEGRAM_BOT_TOKEN   el token que da @BotFather.
 *   TELEGRAM_CHAT_ID     opcional. Si falta, se usa el grupo que le escribió
 *                        al bot (agréguelo al grupo y escriba /start).
 *
 * ==========================================================================
 * Dos bloques
 * ==========================================================================
 *   «bot de Telegram real»   comprueba el token, encuentra el grupo y envía
 *                            el mensaje de prueba y un aviso de ejemplo, este
 *                            marcado como PRUEBA: no son operaciones reales.
 *
 *   «de punta a punta»       un panel de verdad —`Sesion`, cuenta madre y UTA
 *                            de `.env`, mercado real— con el bot. Va en dos
 *                            tiempos, con el estado en ALERTAS_PRUEBA_DIR:
 *                              1ª ejecución: configura y toma la foto de partida.
 *                              entre medias: alguien opera a mano en la app.
 *                              2ª ejecución: revisa; lo hecho a mano llega al chat.
 *                            Sin ALERTAS_PRUEBA_DIR no corre: guarda las API
 *                            Keys en un vault y la carpeta la elige quien prueba.
 *
 * Solo lee de Bitget. El token no se imprime nunca.
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClienteBitget } from '@main/bitget/rest/client';
import type { Credencial } from '@main/bitget/rest/signer';
import { Sesion } from '@main/ipc/sesion';
import { TelegramHttp } from '@main/alertas/telegram';
import { mensajePrueba, mensajesTelegram } from '@main/alertas/mensajes';
import type { EventoPendiente } from '@main/alertas/tipos';
import './credenciales-reales';
import { credencialUta, hayCredencialUta } from '../fisica/credenciales-uta';

const token = (process.env['TELEGRAM_BOT_TOKEN'] ?? '').trim();
const chatDeEnv = (process.env['TELEGRAM_CHAT_ID'] ?? '').trim();
const dirPrueba = (process.env['ALERTAS_PRUEBA_DIR'] ?? '').trim();
const hayToken = token !== '';

const credencialMadre: Credencial = {
  apiKey: process.env['BITGET_MADRE_API_KEY'] ?? '',
  secretKey: process.env['BITGET_MADRE_SECRET_KEY'] ?? '',
  passphrase: process.env['BITGET_MADRE_PASSPHRASE'] ?? ''
};
const hayMadre = credencialMadre.apiKey !== '';

const tg = new TelegramHttp();

/** El chat de `.env`, o el grupo que le escribió al bot. */
async function chatDestino(): Promise<{ id: string; titulo: string }> {
  if (chatDeEnv !== '') return { id: chatDeEnv, titulo: '(TELEGRAM_CHAT_ID)' };
  const chats = await tg.chatsRecientes(token);
  const elegido = chats.find((c) => c.tipo !== 'private') ?? chats[0];
  if (elegido === undefined) {
    throw new Error(
      'El bot no ve ningún chat. Agréguelo al grupo, escriba /start en el grupo y vuelva a correr la prueba ' +
        '(o ponga TELEGRAM_CHAT_ID en .env).'
    );
  }
  return { id: elegido.id, titulo: elegido.titulo };
}

describe.skipIf(!hayToken)('bot de Telegram real', () => {
  it('el token es de un bot y encuentra el chat', async () => {
    const bot = await tg.comprobarBot(token);
    console.log(`  bot: @${bot.usuario} (${bot.nombre})`);
    expect(bot.usuario.toLowerCase().endsWith('bot')).toBe(true);

    const chats = await tg.chatsRecientes(token);
    console.log(
      '  chats que le escribieron:',
      chats.map((c) => `${c.titulo} [${c.tipo}] ${c.id}`)
    );
    const destino = await chatDestino();
    console.log(`  destino: ${destino.titulo} ${destino.id}`);
  });

  it('envía el mensaje de prueba y un aviso de ejemplo', async () => {
    const destino = await chatDestino();
    await tg.enviar(token, destino.id, mensajePrueba(1));

    const ahora = Date.now();
    const ejemplo = (p: Partial<EventoPendiente>): EventoPendiente => ({
      clave: `ejemplo-${Math.random()}`,
      tipo: 'abrir',
      cuandoMs: ahora - 3_600_000,
      simbolo: 'BTCUSDT',
      lado: 'long',
      cantidad: '0.001',
      precio: '115230.5',
      importe: null,
      origen: 'app',
      clientOid: null,
      orderId: null,
      automatico: false,
      detalle: null,
      cuentaId: 'ejemplo',
      identificador: 'PCB-1-A-1',
      etiqueta: 'Sub-01',
      grupo: 'A',
      ...p
    });
    const mensajes = mensajesTelegram(
      [
        ejemplo({}),
        ejemplo({ tipo: 'cerrar', cuandoMs: ahora - 1_800_000, precio: '116010' }),
        ejemplo({
          tipo: 'tp-sl-quitado',
          detalle: 'TP',
          cuandoMs: ahora - 900_000,
          cantidad: null,
          precio: null
        }),
        ejemplo({
          tipo: 'apalancamiento',
          detalle: '10x → 20x',
          simbolo: 'ETHUSDT',
          lado: null,
          origen: null,
          desdeMs: ahora - 7_200_000,
          cuandoMs: ahora,
          identificador: 'PCB-1-A-3',
          etiqueta: 'Sub-03'
        })
      ],
      {
        numeroPanel: 1,
        zona: Intl.DateTimeFormat().resolvedOptions().timeZone,
        moneda: 'USDT',
        ahoraMs: ahora
      }
    );
    for (const m of mensajes) {
      await tg.enviar(
        token,
        destino.id,
        `🧪 <b>PRUEBA — ejemplo de formato, no son operaciones reales</b>\n\n${m.texto}`
      );
    }
    console.log(`  enviados: 1 de prueba + ${mensajes.length} de ejemplo a ${destino.titulo}`);
  });
});

describe.skipIf(!hayToken || dirPrueba === '' || !hayMadre)(
  'alertas de punta a punta con Bitget y Telegram reales',
  () => {
    const MAESTRA = process.env['ALERTAS_PRUEBA_MAESTRA'] ?? 'maestra-prueba-alertas';
    const PASO = 'bg1';
    let cliente: ClienteBitget;

    beforeAll(() => {
      cliente = new ClienteBitget();
    });
    afterAll(async () => {
      await cliente.cerrar();
    });

    it('configura, revisa y envía lo hecho fuera del panel', async () => {
      const sesion = new Sesion(
        {
          vault: join(dirPrueba, 'vault.enc'),
          cuentas: join(dirPrueba, 'cuentas.json'),
          activos: join(dirPrueba, 'activos.json'),
          historial: join(dirPrueba, 'historial'),
          acciones: join(dirPrueba, 'acciones', 'propias.jsonl'),
          alertas: join(dirPrueba, 'alertas', 'estado.json')
        },
        cliente,
        {
          mercado: 'real',
          parametrosKdf: { N: 16, r: 1, p: 1 },
          numeroPanel: () => 1,
          esperaVigiaMs: 3_600_000
        }
      );

      try {
        if ((await sesion.estadoVault()) === 'sin-inicializar') {
          await sesion.crear(MAESTRA);
          await sesion.fijarPaso(PASO);
          const altas: [string, Credencial][] = [['Madre', credencialMadre]];
          if (hayCredencialUta) altas.push(['UTA', credencialUta]);
          for (const [etiqueta, c] of altas) {
            const alta = await sesion.agregar({
              etiqueta,
              grupoNombre: 'A',
              apiKey: c.apiKey,
              secretKey: c.secretKey,
              passphrase: c.passphrase
            });
            console.log(`  alta ${etiqueta}: ${alta.ok ? 'ok' : alta.motivo}`);
            expect(alta.ok).toBe(true);
          }
        } else {
          expect((await sesion.abrir(MAESTRA)).ok).toBe(true);
        }

        const estado = await sesion.estadoAlertas();
        if (!estado.configurado) {
          const destino = await chatDestino();
          const r = await sesion.configurarAlertas(
            { token, chatId: destino.id, chatTitulo: destino.titulo },
            PASO
          );
          console.log(`  configurar: ${r.ok ? 'ok' : `${r.motivo} — ${r.mensaje}`}`);
          expect(r.ok).toBe(true);
        }

        const revision = await sesion.revisarAlertas();
        console.log('  revisión:', {
          cuentas: revision.cuentas,
          revisadas: revision.revisadas,
          nuevas: revision.nuevas,
          detectadas: revision.detectadas,
          enviadas: revision.enviadas,
          pendientes: revision.pendientes,
          envio: revision.envio,
          mensajeEnvio: revision.mensajeEnvio,
          errores: revision.errores
        });
        expect(revision.errores).toEqual([]);
        expect(revision.envio).not.toBe('fallo');
      } finally {
        sesion.cerrar();
      }
    }, 120_000);
  }
);
