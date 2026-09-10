/**
 * Deteccion del modelo de cuenta: ¿esta subcuenta habla V2 o V3?
 *
 * ==========================================================================
 * La pregunta y por que se responde asi
 * ==========================================================================
 * Bitget no ofrece un endpoint que diga «esta key es de una cuenta clasica». Lo
 * que hay es asimetria: una key de cuenta UTA responde a `/api/v3/*` y una
 * clasica no. De modo que la deteccion es una pregunta cuya **respuesta esta en
 * si la pregunta se puede hacer**.
 *
 *   exito                      -> uta
 *   accountMode en transicion  -> transicion (no operar)
 *   fallo de negocio           -> classic
 *   fallo de red o 429         -> no se concluye nada; se propaga
 *
 * --------------------------------------------------------------------------
 * La distincion que no se puede relajar
 * --------------------------------------------------------------------------
 * **Un fallo reintentable no es un veredicto.** Concluir `classic` porque se
 * cayo la red dejaria a una subcuenta UTA enrutando a V2 -donde no la
 * conocen- hasta la siguiente verificacion buena, y en el panel se veria como
 * una cuenta caida sin motivo aparente. Por eso el error reintentable se
 * propaga y quien llama decide reintentar; no se convierte en un modo.
 *
 * Al reves tambien importa: **no hace falta conocer el codigo de error concreto
 * con que V3 rechaza una key clasica** para que esto sea correcto. Cualquier
 * fallo de negocio se lee como `classic`, y el codigo exacto solo hara falta
 * para el reintento cruzado, que es otro paquete. El dato esta pendiente de
 * sondeo -`docs/00-uta-fase-1-equivalencias.md` seccion 4.1- y este algoritmo
 * no lo necesita.
 */
import type { AccountMode, HoldMode } from '@shared/types';
import { anotarEvento, cuentaDe } from '../diagnostico/bitacora';
import { ErrorBitget, esErrorDeAutenticacion, esPermisoUtaFaltante } from './errors';
import { obtenerAjustesCuenta, type ConfigSimbolo } from './rest/endpoints/ajustes-v3';
import type { ClienteBitget } from './rest/client';
import type { Credencial } from './rest/signer';

/**
 * `transicion` no es un modo de cuenta: es «la cuenta esta cambiando de modelo
 * ahora mismo». Bitget lo declara con `accountMode` en `upgrading` o
 * `switching`. Mientras dure, la subcuenta no debe operar por ninguna de las
 * dos superficies: la que responde hoy puede dejar de hacerlo a media
 * operacion.
 */
export type ModoDetectado = AccountMode | 'transicion' | 'indeterminado';

/** Valores de `accountMode` que significan «esta cambiando, no operes». */
const EN_TRANSICION = new Set(['upgrading', 'switching']);

export interface ResultadoDeteccion {
  modo: ModoDetectado;
  /** Solo lo informa V3. `null` en toda cuenta clasica y en transicion. */
  holdMode: HoldMode | null;
  /** `accountLevel` de UTA, para el diagnostico. `null` si no aplica. */
  nivel: string | null;
  /** El `accountMode` crudo del exchange, sin interpretar. Va al log. */
  accountModeCrudo: string | null;
  /** Codigo con que V3 rechazo la credencial, cuando el modo es `classic`. */
  codigoRechazo: string | null;
  /**
   * `true` cuando el rechazo **prueba** que la cuenta es unificada.
   *
   * Hoy solo lo produce el `40014` de permisos de UTA. Va aparte de `modo`
   * porque el modo sigue siendo `indeterminado` —no se pudo leer `holdMode` ni
   * la configuracion por simbolo, y sin eso no se opera—, pero quien avisa al
   * operador si puede decirle que su cuenta es UTA y que lo que falta es un
   * permiso, en vez de dejarle creyendo que la migracion no se aplico.
   */
  esUta?: boolean;
  /** UID que declara V3. `null` en cuenta clasica. */
  uid: string | null;
  /**
   * Configuracion por simbolo que devuelve UTA.
   *
   * Sustituye a las llamadas simbolo a simbolo de `/api/v2/mix/account/account`:
   * aqui viene la lista entera en la misma respuesta.
   */
  configSimbolos: readonly ConfigSimbolo[];
}

/** Traduce el `holdMode` crudo, sin inventar un valor cuando no se reconoce. */
function holdModeDe(crudo: string | null | undefined): HoldMode | null {
  if (crudo === 'hedge_mode' || crudo === 'one_way_mode') return crudo;
  return null;
}

/**
 * Averigua con que API habla una credencial.
 *
 * **Lanza** ante un fallo reintentable -red, 429, 5xx en consulta-, con el
 * `ErrorBitget` original. No lanza por ningun otro motivo: una credencial
 * invalida o sin permisos es informacion, no una excepcion, igual que en
 * `verificarCredencial`.
 */
export async function detectarModo(
  cliente: ClienteBitget,
  credencial: Credencial
): Promise<ResultadoDeteccion> {
  const base: ResultadoDeteccion = {
    modo: 'classic',
    holdMode: null,
    nivel: null,
    accountModeCrudo: null,
    codigoRechazo: null,
    uid: null,
    configSimbolos: []
  };

  let ajustes;
  try {
    /*
     * La credencial se sella `v3` aqui aunque el registro la crea clasica: la
     * pregunta es precisamente si V3 le responde, y enviarla con el sello viejo
     * la mandaria a la cola de limite equivocada.
     */
    ajustes = await obtenerAjustesCuenta(cliente, { ...credencial, superficie: 'v3' });
  } catch (e) {
    if (e instanceof ErrorBitget && e.reintentable) throw e;

    /*
     * Cualquier otro fallo se lee como «esta key no vive en V3». Incluye el
     * codigo de superficie equivocada -todavia sin catalogar- y tambien los de
     * credencial invalida: una key que no autentica en V3 tampoco lo hara en
     * V2, y ahi `verificarCredencial` dara el veredicto con su propio mensaje.
     */
    const codigoRechazo = e instanceof ErrorBitget ? e.codigo : null;

    /*
     * ======================================================================
     * Un rechazo del sobre de autenticacion NO es un veredicto sobre el modo
     * ======================================================================
     * Verificado el 09/09/2026: `/api/v3/account/settings` devolvio
     * `40018 · Invalid IP` para una clave cuya cuenta podia perfectamente ser
     * UTA. La firma y las cabeceras son identicas en las dos superficies, asi
     * que ese rechazo se habria producido igual en V2: no dice nada de la
     * superficie, dice que esta IP no puede usar esa clave.
     *
     * Leerlo como `classic` -que es lo que se hacia- mandaba la peticion a V2,
     * cosechaba un segundo rechazo y ensenaba **ese** codigo, dejando al
     * operador buscando un problema de migracion cuando tenia uno de lista
     * blanca. Ver `esErrorDeAutenticacion`.
     */
    /*
     * ======================================================================
     * V3 reconoce la cuenta y le falta un permiso: NO es clasica
     * ======================================================================
     * Verificado el 09/09/2026 sobre una subcuenta que el titular sabe migrada:
     * `/api/v3/account/settings` devolvio `40014 · Incorrect permissions, need
     * UTA manage read or UTA manage write permissions`.
     *
     * Leerlo como `classic` -que es lo que se hacia- enrutaba a V2 una cuenta ya
     * unificada, y ahi V2 la rechazaba con otro codigo. El operador veia ese
     * segundo codigo y ninguna pista de que su cuenta si era UTA.
     *
     * No se concluye `uta` tampoco, y eso es deliberado: sin esta respuesta no
     * hay `holdMode` ni `symbolConfigList`, y operar sin saber el modo de
     * posicion es justo lo que cruza los lados en cobertura. `indeterminado`
     * corta con un motivo accionable —habilitar el permiso— y la siguiente
     * verificacion ya lee la cuenta entera.
     */
    const mensajeCrudo = e instanceof ErrorBitget ? e.mensajeOriginal : null;
    if (esPermisoUtaFaltante(codigoRechazo, mensajeCrudo)) {
      anotarEvento({
        evento: 'deteccion-modo',
        datos: {
          modo: 'indeterminado',
          causa: 'permiso-uta',
          cuenta: cuentaDe(credencial.apiKey),
          codigoRechazo,
          mensaje: mensajeCrudo?.slice(0, 200) ?? null
        }
      });
      return { ...base, modo: 'indeterminado', codigoRechazo, esUta: true };
    }

    if (esErrorDeAutenticacion(codigoRechazo)) {
      anotarEvento({
        evento: 'deteccion-modo',
        datos: {
          modo: 'indeterminado',
          cuenta: cuentaDe(credencial.apiKey),
          codigoRechazo,
          mensaje: e instanceof Error ? e.message.slice(0, 200) : null
        }
      });
      return { ...base, modo: 'indeterminado', codigoRechazo };
    }

    /*
     * ======================================================================
     * Este es el dato que faltaba el 09/09/2026
     * ======================================================================
     * Concluir `classic` es correcto por construccion, pero **por que** V3
     * rechazo la clave es justo lo que hay que saber cuando el operador jura que
     * la cuenta ya es UTA. Sin esta linea, el panel intentaba V2 a continuacion
     * y el unico rastro era el codigo de aquel segundo rechazo, que no dice nada
     * del primero.
     *
     * Un `ESQUEMA` aqui es especialmente revelador: significa que V3 **si**
     * respondio con exito y que el esquema de `account/settings` -escrito desde
     * la documentacion, sin capturar- no encajo. Esa cuenta es UTA y el panel la
     * estaria tratando como clasica por un nombre de campo.
     */
    anotarEvento({
      evento: 'deteccion-modo',
      datos: {
        modo: 'classic',
        cuenta: cuentaDe(credencial.apiKey),
        codigoRechazo,
        mensaje: e instanceof Error ? e.message.slice(0, 200) : null
      }
    });

    return { ...base, codigoRechazo };
  }

  const datos = ajustes.datos;
  const crudo = datos.accountMode;

  if (EN_TRANSICION.has(crudo)) {
    return {
      ...base,
      modo: 'transicion',
      accountModeCrudo: crudo,
      nivel: datos.accountLevel ?? null,
      uid: datos.uid ?? null
    };
  }

  anotarEvento({
    evento: 'deteccion-modo',
    datos: {
      modo: 'uta',
      cuenta: cuentaDe(credencial.apiKey),
      accountMode: crudo,
      holdMode: datos.holdMode ?? null,
      simbolosConfigurados: (datos.symbolConfigList ?? []).length
    }
  });

  return {
    modo: 'uta',
    holdMode: holdModeDe(datos.holdMode),
    nivel: datos.accountLevel ?? null,
    accountModeCrudo: crudo,
    codigoRechazo: null,
    uid: datos.uid ?? null,
    configSimbolos: datos.symbolConfigList ?? []
  };
}
