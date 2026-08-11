/**
 * El sobre comun de todas las respuestas de Bitget v2.
 *
 *   { "code": "00000", "msg": "success", "requestTime": 1700000000000, "data": ... }
 *
 * Bitget devuelve **HTTP 200 tambien cuando la operacion fallo**: el resultado
 * real esta en `code`. Un cliente que solo mire el estado HTTP da por buena una
 * orden rechazada. Por eso el sobre se valida siempre, antes que nada.
 *
 * Los numeros llegan como cadena y se conservan como cadena: convertirlos a
 * `number` aqui perderia precision en un precio de liquidacion.
 * docs/03 seccion 14.
 */
import { z } from 'zod';

export const esquemaSobre = z.object({
  code: z.string(),
  msg: z.string(),
  /* Algunos endpoints publicos lo omiten. */
  requestTime: z.number().optional(),
  data: z.unknown().optional()
});

export type Sobre = z.infer<typeof esquemaSobre>;

/** Hora del servidor: `/api/v2/public/time`. Base de la correccion de reloj. */
export const esquemaHoraServidor = z.object({
  serverTime: z.string()
});
