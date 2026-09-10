/**
 * Las listas de V3 vienen envueltas, y no siempre.
 *
 * ==========================================================================
 * Que es realmente «adecuar la paginacion» en este panel
 * ==========================================================================
 * La migracion se describe como `idLessThan` -> `cursor`. Conviene decir lo que
 * se encontro al ir a hacerlo: **`idLessThan` no aparece ni una vez en este
 * repositorio**. El panel nunca ha paginado en V2, y no por descuido:
 *
 *   posiciones      una subcuenta opera ocho activos como mucho -son las ocho
 *                   ranuras del panel-, y `all-position` los devuelve juntos.
 *   planes TP/SL    una peticion trae los de todos los simbolos de la cuenta.
 *   saldos          una fila por moneda de margen.
 *   subcuentas      `limit: 20`, que es el techo de Bitget por cuenta madre.
 *
 * Ninguna de esas listas se acerca a una pagina. Traducir un parametro que nadie
 * envia no es trabajo, es teatro.
 *
 * El cambio real de V3 es otro, y ese si muerde: **la forma del sobre**. Donde
 * V2 devuelve el array pelado en `data`, V3 lo mete dentro de un objeto junto al
 * cursor:
 *
 *   V2   "data": [ {...}, {...} ]
 *   V3   "data": { "list": [ {...}, {...} ], "cursor": "..." }
 *
 * Un esquema que espere lo uno y reciba lo otro **no** se equivoca a medias:
 * falla la validacion entera. En el barrido eso significa una subcuenta UTA sin
 * posiciones en el monitor; en el saldo, un importe congelado.
 *
 * Y no se sabe cual de las dos formas usa cada endpoint: la documentacion de
 * Bitget no es uniforme y **nada de esto esta capturado**. Por eso este modulo
 * acepta las dos y devuelve una sola, en vez de apostar por una.
 *
 * ==========================================================================
 * Por que se lee el cursor si no se pagina
 * ==========================================================================
 * Para poder avisar. Si algun dia una cuenta abre mas posiciones de las que
 * caben en una pagina, el cursor llega con valor y quien lo reciba puede decir
 * «esta lista esta incompleta» en vez de enseñar media cartera como si fuera
 * entera. Que hoy nadie pida la siguiente pagina es una decision; no saber que
 * falta seria un fallo.
 */
import { z as zod } from 'zod';

/** Una lista de V3 ya desenvuelta. `cursor` no nulo significa «hay mas». */
export interface ListaV3<T> {
  lista: T[];
  cursor: string | null;
}

/**
 * Esquema que admite el array pelado de V2 y el sobre con cursor de V3.
 *
 * Se aceptan los dos nombres plausibles del cursor -`cursor` y `nextCursor`-
 * por lo mismo que `posiciones-v3.ts` acepta dos nombres para el margen: no hay
 * respuesta capturada, y equivocarse en el nombre aqui no rompe nada visible
 * -se pagina de todos modos que no-, mientras que equivocarse en `list` deja la
 * lista vacia.
 *
 * La cadena vacia se normaliza a `null`: Bitget devuelve `""` para «no hay mas»
 * en varios endpoints, y tratarla como un cursor valido haria creer que la lista
 * esta incompleta cuando esta entera.
 */
export function esquemaListaV3<T extends zod.ZodTypeAny>(
  elemento: T
): zod.ZodType<ListaV3<zod.infer<T>>> {
  const sobre = zod.object({
    list: zod.array(elemento).nullish(),
    cursor: zod.string().nullish(),
    nextCursor: zod.string().nullish()
  });

  return zod
    .union([zod.array(elemento), sobre])
    .transform((crudo): ListaV3<zod.infer<T>> => {
      if (Array.isArray(crudo)) return { lista: crudo, cursor: null };

      const cursor = crudo.cursor ?? crudo.nextCursor ?? null;
      return {
        lista: crudo.list ?? [],
        cursor: cursor === null || cursor === '' ? null : cursor
      };
    }) as unknown as zod.ZodType<ListaV3<zod.infer<T>>>;
}
