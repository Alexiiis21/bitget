/**
 * Endpoints de subcuentas vistas desde la cuenta madre.
 *
 * Sostienen la funcion de traspaso de saldo entre subcuentas:
 * docs/presupuesto-traspaso-subcuentas.md y docs/00-traspasos-fase-1.md.
 *
 * ==========================================================================
 * Verificado contra la API real
 * ==========================================================================
 * **04/09/2026, con 20 subcuentas reales colgando de la cuenta madre 7514542716**
 * (clave con `[coow, wtow, cpow, chow]` y su IP ligada). La respuesta se capturo
 * entera y de ella sale el esquema de abajo, campo por campo. No esta deducido
 * de la documentacion.
 *
 * Dos cosas que solo se ven con datos delante:
 *
 *   - **`userId` llega como numero**, no como cadena: `"userId": 8071480530`.
 *     Por eso `esquemaUid` normaliza. Sin esa normalizacion el cruce contra las
 *     cuentas del panel -que guardan el UID como cadena- fallaria en silencio.
 *   - **Todos los campos vienen presentes**, incluido `maxTransferOut`. Los que
 *     estaban `nullish` por prudencia pasaron a obligatorios el 04/09/2026: un
 *     campo opcional de mas obliga a defenderse de un `null` que no ocurre, y esa
 *     defensa esconde un cambio de la API en vez de hacerlo saltar.
 *
 * Antes de eso se comprobo, el 03/09/2026, que **leer no necesita permiso de
 * traspaso**: la clave de entonces no lo tenia y la lectura pasaba igual.
 */
import type { z } from 'zod';
import { z as zod } from 'zod';
import type { ClienteBitget, RespuestaRest } from '../client';
import type { Credencial } from '../signer';

/* ---------- /api/v2/mix/account/sub-account-assets ---------- */

/**
 * Saldo de futuros de una subcuenta, tal como lo reporta la madre.
 *
 * `maxTransferOut` es el dato que justifica la pantalla entera: el saldo de una
 * subcuenta **no** es lo que se puede sacar de ella, porque el margen
 * comprometido en posiciones abiertas no viaja. Bitget ya hace esa resta, de
 * modo que el panel no tiene que estimarla -y no debe: una estimacion propia
 * acabaria proponiendo traspasos que el exchange rechaza-.
 */
const esquemaActivoSubcuenta = zod.object({
  marginCoin: zod.string(),
  available: zod.string(),
  /* Obligatorios: los manda siempre. Captura real del 04/09/2026. */
  maxTransferOut: zod.string(),
  accountEquity: zod.string(),
  usdtEquity: zod.string(),
  locked: zod.string(),
  unrealizedPL: zod.string(),
  /*
   * Estos si llegan a `null` de verdad -se vio en la captura, con las veinte
   * subcuentas a cero-, asi que se declaran opcionales por lo que son y no por
   * prudencia. El panel no usa ninguno hoy; se listan para que el dia que
   * hagan falta no haya que volver a capturar la respuesta.
   */
  crossedMaxAvailable: zod.string().nullish(),
  isolatedMaxAvailable: zod.string().nullish(),
  btcEquity: zod.string().nullish(),
  coupon: zod.string().nullish(),
  crossedUnrealizedPL: zod.string().nullish(),
  isolatedUnrealizedPL: zod.string().nullish()
});

/**
 * `userId` llega como numero o como cadena segun el endpoint.
 *
 * Es el mismo tropiezo ya documentado en `verificacion.ts`: `/spot/account/info`
 * devuelve `userId` cadena y `parentId` numero, y compararlos entre si sin
 * normalizar da falso justo donde se cruzan cuentas. Aqui se acepta cualquiera
 * de los dos y se guarda **siempre como cadena**, porque es un identificador y
 * no una cantidad.
 */
const esquemaUid = zod.union([zod.string(), zod.number()]).transform((v) => String(v));

export const esquemaSaldosSubcuentas = zod.array(
  zod.object({
    userId: esquemaUid,
    assetList: zod.array(esquemaActivoSubcuenta).nullish()
  })
);

export type SaldosSubcuentas = z.infer<typeof esquemaSaldosSubcuentas>;

/**
 * Saldo de futuros de **todas** las subcuentas de la madre, en una peticion.
 *
 * Esta es la propiedad que hace barata la pantalla de saldos: no es una llamada
 * por subcuenta -que sobre cien cuentas seria una tormenta de peticiones y un
 * problema de rate limit-, sino una sola respuesta con todas dentro.
 *
 * Limite publicado: 1 peticion / 10 s por UID. Es holgado para lo que hace la
 * pantalla -se pide al abrirla y al pulsar refrescar- pero **no admite un
 * refresco automatico agresivo**: quien anada un intervalo aqui tiene que
 * respetar esos 10 segundos.
 *
 * La credencial tiene que ser la de la **cuenta madre**. Con la clave de una
 * subcuenta la respuesta viene vacia: una subcuenta no tiene subcuentas.
 */
export function obtenerSaldosSubcuentas(
  cliente: ClienteBitget,
  credencial: Credencial,
  productType = 'USDT-FUTURES'
): Promise<RespuestaRest<SaldosSubcuentas>> {
  return cliente.peticionFirmada(
    credencial,
    {
      metodo: 'GET',
      ruta: '/api/v2/mix/account/sub-account-assets',
      consulta: { productType },
      idempotente: true
    },
    esquemaSaldosSubcuentas
  );
}

/* ---------- /api/v2/spot/wallet/subaccount-transfer ---------- */

/**
 * Lo que Bitget devuelve al aceptar un traspaso.
 *
 * `transferId` es el identificador del movimiento en el exchange y es lo que
 * queda anotado en el registro: es la unica forma de senalar un traspaso
 * concreto si algun dia hay que reclamarlo.
 */
export const esquemaTraspaso = zod.object({
  transferId: zod.string().nullish(),
  clientOid: zod.string().nullish()
});

export type Traspaso = z.infer<typeof esquemaTraspaso>;

/** Monederos entre los que Bitget admite mover saldo. El panel solo usa futuros. */
export type TipoMonedero = 'usdt_futures' | 'spot' | 'coin_futures' | 'usdc_futures';

/**
 * Mueve saldo de una subcuenta a otra de la misma cuenta madre.
 *
 * ==========================================================================
 * Esto mueve dinero. Verificado contra la API real el 05/09/2026
 * ==========================================================================
 * Estuvo sin verificar hasta esa fecha: la clave de la madre no tenia permiso
 * de traspaso -`40014 · need transfer write permissions`- ni este equipo estaba
 * en su lista blanca de IP (`40018`). Concedidos los dos, se hizo la prueba
 * fisica con el importe minimo: cuenta madre 7514542716 -> subcuenta
 * 4995399641, 0,5 USDT, y de vuelta. Bitget acepto las dos y devolvio
 * `transferId`; los saldos se movieron y quedaron como estaban.
 *
 * La prueba vive en `test/fisica/traspaso-real.test.ts` y se repite cuando haga
 * falta. No entra en `npm run test:fisica` por accidente: hay que nombrarla.
 *
 * --------------------------------------------------------------------------
 * Por que va bajo el prefijo `/spot/`
 * --------------------------------------------------------------------------
 * Igual que `/api/v2/spot/account/info`, que es de donde se leen los permisos de
 * una key de solo futuros. Bitget agrupa varias operaciones de cuenta bajo ese
 * prefijo sin que el nombre describa el producto que mueven. No significa que
 * haga falta permiso de spot ni que el saldo pase por el monedero spot: origen y
 * destino son los dos `usdt_futures`, y el movimiento es directo.
 *
 * --------------------------------------------------------------------------
 * `clientOid` no es opcional aqui
 * --------------------------------------------------------------------------
 * Bitget lo admite vacio; el panel no lo manda nunca vacio. Es lo que hace que
 * un reenvio no se convierta en un segundo traspaso, igual que en las ordenes
 * -docs/01 seccion 9, «la pieza de seguridad mas importante de todo el
 * sistema»-. Quien llame a esta funcion tiene que traer uno.
 */
export function traspasarEntreSubcuentas(
  cliente: ClienteBitget,
  credencial: Credencial,
  datos: {
    uidOrigen: string;
    uidDestino: string;
    importe: string;
    clientOid: string;
    moneda?: string;
    monedero?: TipoMonedero;
  }
): Promise<RespuestaRest<Traspaso>> {
  const monedero = datos.monedero ?? 'usdt_futures';

  return cliente.peticionFirmada(
    credencial,
    {
      metodo: 'POST',
      ruta: '/api/v2/spot/wallet/subaccount-transfer',
      cuerpo: {
        fromType: monedero,
        toType: monedero,
        amount: datos.importe,
        coin: datos.moneda ?? 'USDT',
        fromUserId: datos.uidOrigen,
        toUserId: datos.uidDestino,
        clientOid: datos.clientOid
      },
      /*
       * `idempotente: false`: el cliente REST no reintenta por su cuenta.
       *
       * Aunque `clientOid` protege del duplicado, un reintento a ciegas sobre un
       * movimiento de dinero es justo lo que el proyecto no hace en ninguna de
       * las seis operaciones. Un envio sin respuesta se resuelve **consultando**
       * -`buscarTraspaso`, aqui abajo-, no repitiendo.
       */
      idempotente: false
    },
    esquemaTraspaso
  );
}

/* ---------- /api/v2/spot/account/sub-main-trans-record ---------- */

/**
 * Un traspaso tal como lo tiene registrado Bitget.
 *
 * Solo se leen los campos que hacen falta para responder a una pregunta: «este
 * `clientOid`, ¿entro o no?». El resto de la respuesta se ignora.
 */
export const esquemaRegistroTraspaso = zod.array(
  zod.object({
    clientOid: zod.string().nullish(),
    transferId: zod.string().nullish(),
    /** `Successful`, `Failed`, `Processing`… Bitget no publica la lista cerrada. */
    status: zod.string().nullish(),
    size: zod.string().nullish(),
    coin: zod.string().nullish(),
    cTime: zod.string().nullish()
  })
);

export type RegistrosTraspaso = z.infer<typeof esquemaRegistroTraspaso>;

/**
 * Busca en Bitget si un traspaso llego a entrar, por su `clientOid`.
 *
 * ==========================================================================
 * Para que existe: el envio del que no se sabe nada
 * ==========================================================================
 * Un traspaso que se envia y no responde -un corte de red, un tiempo agotado-
 * deja la clase `indeterminada` de `errors.ts`: *«se envio y no hubo respuesta.
 * NUNCA se reintenta: se consulta»*. Esta es la consulta.
 *
 * Sin ella, la unica salida era anotar «fallo» y dejar que el operador decidiera.
 * Y esa salida es peligrosa: al replanificar se genera un `clientOid` **nuevo**,
 * de modo que la proteccion contra duplicados del envio original deja de aplicar
 * y el dinero puede moverse dos veces.
 *
 * --------------------------------------------------------------------------
 * La asimetria que hay que respetar al leer el resultado
 * --------------------------------------------------------------------------
 * **Encontrar el registro demuestra que entro. No encontrarlo no demuestra
 * nada**: Bitget puede tardar en registrarlo, y la consulta puede fallar por su
 * cuenta. Por eso esta funcion devuelve la lista cruda y quien la llama trata el
 * vacio como «sigue sin saberse», nunca como «no entro».
 *
 * `verified: false` en el sentido de la API: no verificado contra Bitget real,
 * porque la clave madre todavia no tiene permiso de traspaso. La ruta y los
 * parametros salen del SDK `bitget-api@3.2.1` que hay en `node_modules`
 * -`getSpotMainSubTransferRecord`-, que es el oraculo que ya usa la firma HMAC.
 */
export function buscarTraspaso(
  cliente: ClienteBitget,
  credencial: Credencial,
  datos: { clientOid: string; moneda?: string; limite?: number }
): Promise<RespuestaRest<RegistrosTraspaso>> {
  return cliente.peticionFirmada(
    credencial,
    {
      metodo: 'GET',
      ruta: '/api/v2/spot/account/sub-main-trans-record',
      consulta: {
        clientOid: datos.clientOid,
        coin: datos.moneda ?? 'USDT',
        limit: String(datos.limite ?? 20)
      },
      /* Una consulta si es segura de repetir: no mueve nada. */
      idempotente: true
    },
    esquemaRegistroTraspaso
  );
}
