/**
 * El bot de Telegram, reducido a lo que el panel necesita: enviar.
 *
 * ==========================================================================
 * La única salida de red que no es Bitget
 * ==========================================================================
 * Hasta las alertas, el panel solo hablaba con api.bitget.com (docs/01 §7).
 * Esto añade api.telegram.org, y solo cuando el operador ha configurado un
 * bot: sin bot guardado en el vault, este módulo no hace ni una petición.
 * Vive en el proceso principal; la pantalla nunca habla con Telegram.
 *
 * Se usan tres métodos de la API de bots, todos por POST con JSON:
 *
 *   getMe        comprueba que el token es de un bot real.
 *   getUpdates   lista los chats que le escribieron hace poco: así el
 *                operador encuentra el id del grupo sin herramientas de fuera.
 *   sendMessage  el aviso. Texto con HTML mínimo (negritas), ya escapado.
 *
 * El bot no recibe órdenes: `getUpdates` solo se usa para encontrar el chat al
 * configurarlo, nunca para leer comandos.
 *
 * El token va en la URL —así lo pide Telegram—, por eso **la URL no se
 * registra nunca** en ningún log, y el token se marca como secreto en el vault
 * para que la redacción lo tache si apareciera en un mensaje de error.
 */
import { request } from 'undici';

export const TELEGRAM_API = 'https://api.telegram.org';
const TIMEOUT_MS = 10_000;
/** `123456789:AA…`: el formato de los tokens de @BotFather. */
const FORMATO_TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/;

export type MotivoTelegram =
  'token-invalido' | 'chat-no-encontrado' | 'sin-acceso' | 'limite' | 'red' | 'otro';

export class ErrorTelegram extends Error {
  readonly motivo: MotivoTelegram;
  /** Solo en `limite`: los segundos que Telegram pide esperar. */
  readonly reintentarEnS: number | null;
  /**
   * Para la bitácora: `error_code` de Telegram (o el HTTP), o el código de
   * transporte (`ENOTFOUND`, `ECONNRESET`…) si no hubo respuesta. Nunca el token.
   */
  readonly codigo: string | null;

  constructor(
    motivo: MotivoTelegram,
    mensaje: string,
    reintentarEnS: number | null = null,
    codigo: string | null = null
  ) {
    super(mensaje);
    this.name = 'ErrorTelegram';
    this.motivo = motivo;
    this.reintentarEnS = reintentarEnS;
    this.codigo = codigo;
  }
}

export interface ChatTelegram {
  id: string;
  titulo: string;
  /** `private`, `group`, `supergroup`, `channel`. */
  tipo: string;
}

export interface BotTelegram {
  usuario: string;
  nombre: string;
}

export interface ClienteTelegram {
  comprobarBot(token: string): Promise<BotTelegram>;
  chatsRecientes(token: string): Promise<ChatTelegram[]>;
  enviar(token: string, chatId: string, texto: string): Promise<void>;
}

interface RespuestaTelegram {
  ok?: boolean;
  result?: unknown;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

/** El error de Telegram, dicho para el operador. */
function errorDe(r: RespuestaTelegram, http: number): ErrorTelegram {
  const codigo = r.error_code ?? http;
  const texto = r.description ?? '';
  const c = String(codigo);
  if (codigo === 401 || codigo === 404) {
    return new ErrorTelegram(
      'token-invalido',
      'Telegram no reconoce el token del bot. Cópielo otra vez de @BotFather.',
      null,
      c
    );
  }
  if (codigo === 429) {
    const s = r.parameters?.retry_after ?? 30;
    return new ErrorTelegram('limite', `Telegram pide esperar ${s} s antes de enviar más.`, s, c);
  }
  if (codigo === 403) {
    return new ErrorTelegram(
      'sin-acceso',
      'El bot no puede escribir en ese chat: lo sacaron del grupo o lo bloquearon. Vuelva a agregarlo.',
      null,
      c
    );
  }
  if (codigo === 400 && /chat not found|chat_id is empty|peer_id_invalid/i.test(texto)) {
    return new ErrorTelegram(
      'chat-no-encontrado',
      'Telegram no encuentra ese chat. Agregue el bot al grupo y escriba /start en él.',
      null,
      c
    );
  }
  return new ErrorTelegram('otro', `Telegram respondió: ${texto || `HTTP ${http}`}`, null, c);
}

/** El código de un fallo de transporte (`ENOTFOUND`…). Solo el código: el mensaje podría llevar la URL. */
function codigoTransporte(e: unknown): string | null {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' && /^[A-Z_]{3,40}$/.test(c) ? c : null;
}

export class TelegramHttp implements ClienteTelegram {
  private readonly base: string;

  constructor(base: string = TELEGRAM_API) {
    this.base = base;
  }

  private async llamar(token: string, metodo: string, cuerpo: unknown = {}): Promise<unknown> {
    /*
     * El token acaba en la ruta de la URL: uno con `/` o `?` cambiaría la
     * petición. Se exige el formato de @BotFather antes de construir nada.
     */
    if (!FORMATO_TOKEN.test(token)) {
      throw new ErrorTelegram(
        'token-invalido',
        'Eso no tiene forma de token de bot. Es la línea larga que da @BotFather, del tipo 123456789:AAF…'
      );
    }

    let http: number;
    let json: RespuestaTelegram;
    try {
      const r = await request(`${this.base}/bot${token}/${metodo}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cuerpo),
        headersTimeout: TIMEOUT_MS,
        bodyTimeout: TIMEOUT_MS
      });
      http = r.statusCode;
      json = (await r.body.json().catch(() => ({}))) as RespuestaTelegram;
    } catch (e) {
      throw new ErrorTelegram(
        'red',
        'No hay conexión con Telegram. Se reintentará en la próxima revisión.',
        null,
        codigoTransporte(e)
      );
    }

    if (json.ok === true) return json.result;
    throw errorDe(json, http);
  }

  async comprobarBot(token: string): Promise<BotTelegram> {
    const r = (await this.llamar(token, 'getMe')) as { username?: string; first_name?: string };
    return { usuario: r.username ?? '', nombre: r.first_name ?? '' };
  }

  async chatsRecientes(token: string): Promise<ChatTelegram[]> {
    const r = (await this.llamar(token, 'getUpdates', { limit: 100 })) as unknown[];
    const chats = new Map<string, ChatTelegram>();
    for (const u of Array.isArray(r) ? r : []) {
      const update = u as Record<string, { chat?: Record<string, unknown> } | undefined>;
      for (const campo of [
        'message',
        'my_chat_member',
        'channel_post',
        'edited_message',
        'chat_member'
      ]) {
        const chat = update[campo]?.chat;
        if (chat === undefined || chat['id'] === undefined) continue;
        const nombre =
          typeof chat['title'] === 'string'
            ? chat['title']
            : [chat['first_name'], chat['last_name']]
                .filter((x) => typeof x === 'string')
                .join(' ') ||
              (typeof chat['username'] === 'string' ? `@${chat['username']}` : 'Chat sin nombre');
        chats.set(String(chat['id']), {
          id: String(chat['id']),
          titulo: nombre,
          tipo: typeof chat['type'] === 'string' ? chat['type'] : 'desconocido'
        });
      }
    }
    return [...chats.values()];
  }

  async enviar(token: string, chatId: string, texto: string): Promise<void> {
    await this.llamar(token, 'sendMessage', {
      chat_id: chatId,
      text: texto,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
  }
}
