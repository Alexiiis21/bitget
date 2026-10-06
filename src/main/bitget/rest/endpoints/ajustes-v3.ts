/**
 * Ajustes de cuenta en la API V3 (`/api/v3/account/settings`).
 *
 * Es **el endpoint de verdad de la deteccion de modo**: si responde con exito,
 * la credencial pertenece a una cuenta UTA; si la rechaza por negocio, es
 * clasica. De el salen ademas los dos datos que condicionan como se construye
 * una orden en V3: `holdMode` -si `posSide` es obligatorio- y el apalancamiento
 * por simbolo de `symbolConfigList`.
 *
 * ==========================================================================
 * Estado de verificacion: NO capturado
 * ==========================================================================
 * El esquema sale de la documentacion de Bitget al 7 de septiembre de 2026, no
 * de una respuesta real. Se confirma con `node scripts/sondear-v3.mjs --env UTA`.
 *
 * Por eso todo lo que no es imprescindible se declara opcional, igual que en
 * `posiciones.ts`: si Bitget nombra un campo de otro modo, el panel no inventa
 * un valor ni se rompe en silencio. `accountMode` es el unico obligatorio,
 * porque sin el esta respuesta no responde a la pregunta que se le hizo.
 */
import type { z } from 'zod';
import { z as zod } from 'zod';
import type { ClienteBitget, RespuestaRest } from '../client';
import type { Credencial } from '../signer';

/**
 * Configuracion por simbolo que devuelve UTA.
 *
 * Es el sustituto de `/api/v2/mix/account/account`, que en V2 hay que consultar
 * simbolo a simbolo: aqui viene la lista entera en la misma respuesta.
 */
export const esquemaConfigSimbolo = zod.object({
  category: zod.string().nullish(),
  symbol: zod.string().nullish(),
  marginMode: zod.string().nullish(),
  leverage: zod.union([zod.string(), zod.number()]).nullish()
});

export type ConfigSimbolo = z.infer<typeof esquemaConfigSimbolo>;

/**
 * `uid` como cadena, venga como venga.
 *
 * Mismo tropiezo ya documentado en `subcuentas.ts` y `verificacion.ts`: Bitget
 * devuelve identificadores como numero en unos endpoints y como cadena en
 * otros, y compararlos sin normalizar da falso justo donde se cruzan cuentas.
 */
const esquemaUid = zod.union([zod.string(), zod.number()]).transform((v) => String(v));

export const esquemaAjustesCuenta = zod.object({
  uid: esquemaUid.nullish(),
  /**
   * `unified` | `hybrid` | `upgrading` | `switching`.
   *
   * Los dos ultimos son estados **de transicion**: la cuenta esta cambiando de
   * modelo y no debe operar hasta que termine. Ver `deteccion-modo.ts`.
   */
  accountMode: zod.string(),
  assetMode: zod.string().nullish(),
  accountLevel: zod.string().nullish(),
  /** `one_way_mode` | `hedge_mode`. Decide si `posSide` es obligatorio. */
  holdMode: zod.string().nullish(),
  symbolConfigList: zod.array(esquemaConfigSimbolo).nullish()
});

export type AjustesCuenta = z.infer<typeof esquemaAjustesCuenta>;

/**
 * Lee los ajustes de la cuenta en V3.
 *
 * `idempotente: true`: es una consulta, no mueve nada, y se puede reintentar
 * libremente. La credencial tiene que ir sellada como `v3` -o sin sellar, que
 * da igual aqui- porque la ruta se pasa explicita; el sellado importa en las
 * funciones que eligen ruta segun la superficie.
 */
export function obtenerAjustesCuenta(
  cliente: ClienteBitget,
  credencial: Credencial
): Promise<RespuestaRest<AjustesCuenta>> {
  return cliente.peticionFirmada(
    credencial,
    { metodo: 'GET', ruta: '/api/v3/account/settings', idempotente: true },
    esquemaAjustesCuenta
  );
}

/* ---------- /api/v3/account/assets ---------- */

/**
 * Saldo de una cuenta UTA. Equivalente de `/api/v2/mix/account/accounts`.
 *
 * **Esquema no capturado.** La forma exacta se confirma con la sonda; mientras
 * tanto se aceptan los dos nombres plausibles de cada campo -`coin`/`marginCoin`
 * para la moneda, `available`/`availableBalance` para el disponible- y todo es
 * opcional salvo nada: una respuesta que no encaje debe poder leerse a medias
 * en vez de tumbar la verificacion entera, porque el saldo es informativo y la
 * credencial puede ser perfectamente valida sin el.
 */
export const esquemaActivo = zod.object({
  coin: zod.string().nullish(),
  marginCoin: zod.string().nullish(),
  available: zod.string().nullish(),
  availableBalance: zod.string().nullish(),
  equity: zod.string().nullish(),
  accountEquity: zod.string().nullish(),
  usdtEquity: zod.string().nullish(),
  locked: zod.string().nullish(),
  frozen: zod.string().nullish()
});

/**
 * Lleva a una lista plana de monedas cualquiera de las formas en que Bitget
 * documenta el saldo UTA:
 *
 *   REST documentado   { accountEquity, ..., assets: [ {coin, available} ] }
 *   WS tema account    [ { totalEquity, ..., coin: [ {coin, available} ] } ]
 *   supuestas antes    [ {coin, available} ]  y  { list: [...] }
 *
 * Solo se aceptaban las dos ultimas, y con la documentada el sobre `{list}` de
 * zod validaba el objeto con `list` ausente: lista vacia, sin error, y el saldo
 * de toda subcuenta UTA sin escribirse nunca -ni por REST ni por WS-.
 */
function aplanarActivos(crudo: unknown): unknown {
  if (Array.isArray(crudo)) {
    return crudo.flatMap((fila: unknown) => {
      if (fila !== null && typeof fila === 'object') {
        const anidada = (fila as { coin?: unknown; assets?: unknown }).coin;
        if (Array.isArray(anidada)) return anidada;
        const activos = (fila as { assets?: unknown }).assets;
        if (Array.isArray(activos)) return activos;
      }
      return [fila];
    });
  }
  if (crudo !== null && typeof crudo === 'object') {
    const sobre = crudo as { assets?: unknown; list?: unknown };
    if (Array.isArray(sobre.assets)) return aplanarActivos(sobre.assets);
    if (Array.isArray(sobre.list)) return aplanarActivos(sobre.list);
    /*
     * La cabecera de la cuenta sin `assets`: una cuenta sin ninguna moneda. Se
     * lee como lista vacia -que `saldoDeFotoCompleta` traduce a 0- y no como
     * error de esquema, que dejaria el saldo viejo en pantalla.
     */
    const cabecera = crudo as { accountEquity?: unknown; usdtEquity?: unknown };
    if (sobre.assets == null && sobre.list == null && (cabecera.accountEquity != null || cabecera.usdtEquity != null)) {
      return [];
    }
  }
  return crudo;
}

export const esquemaActivosCuenta = zod.preprocess(aplanarActivos, zod.array(esquemaActivo));

export type ActivosCuenta = z.infer<typeof esquemaActivosCuenta>;

/** Lee el saldo de una cuenta UTA como lista plana de monedas. */
export async function obtenerActivosCuenta(
  cliente: ClienteBitget,
  credencial: Credencial
): Promise<RespuestaRest<ActivosCuenta>> {
  return cliente.peticionFirmada(
    credencial,
    { metodo: 'GET', ruta: '/api/v3/account/assets', idempotente: true },
    esquemaActivosCuenta
  );
}

/**
 * El disponible en la moneda indicada, o `null` si la respuesta no lo trae.
 *
 * Solo la fila de esa moneda. Hasta el 04/10/2026, si no la encontraba y habia
 * una unica fila, devolvia esa: una cuenta con todo el USDT retirado y algo de
 * polvo en otra moneda enseñaba ese polvo como si fueran USDT.
 */
export function disponibleDe(activos: ActivosCuenta, moneda: string): string | null {
  const fila = activos.find((a) => (a.coin ?? a.marginCoin) === moneda);
  if (fila === undefined) return null;
  return fila.available ?? fila.availableBalance ?? null;
}

/**
 * El disponible leido de `GET /api/v3/account/assets`, donde **no venir es 0**.
 *
 * ==========================================================================
 * Por que existe, distinto de `disponibleDe`
 * ==========================================================================
 * Bitget no devuelve en `assets` las monedas con saldo cero. Incidencia del
 * 04/10/2026: el cliente retiro todo de una subcuenta UTA y la matriz siguio
 * enseñando sus 10 USDT, porque la fila de USDT dejo de llegar y la regla
 * «sin fila no se escribe nada» conservaba el saldo viejo para siempre. En
 * Classic no pasa: `mix/account/accounts` trae la fila aunque este a cero.
 *
 * Solo vale para esta respuesta REST, que es la foto completa de la cuenta. Un
 * empujon del tema `account` puede traer solo lo que cambio, y ahi la ausencia
 * no dice nada: sigue usando `disponibleDe`. Si la peticion falla no se llega
 * aqui, asi que un fallo de red sigue sin poner nada a cero.
 */
export function saldoDeFotoCompleta(activos: ActivosCuenta, moneda: string): string | null {
  const fila = activos.find((a) => (a.coin ?? a.marginCoin) === moneda);
  if (fila === undefined) return '0';
  return fila.available ?? fila.availableBalance ?? null;
}
