# Historial por periodo — Fase 7: validación contra datos reales

Fecha: 13/10/2026. Prueba: `test/red/historial-fase7.test.ts` (solo lectura).
Se reproduce con `npm run test:red`.

## 1. Qué se probó

Se probó el camino completo del panel con dos cuentas reales de Bitget:

- **Classic (v2):** la cuenta madre (`BITGET_MADRE_*`).
- **UTA (v3):** la cuenta unificada (`BITGET_UTA_*`).

En las dos el recorrido fue el mismo:

1. Alta de la cuenta en una `Sesion` real, con almacén temporal.
2. Sincronización contra api.bitget.com.
3. Guardado en disco.
4. Consulta de ocho periodos con la zona horaria de México.
5. Lectura del saldo vigente.
6. Reapertura del panel, comprobando que lo guardado se lee sin volver a Bitget.

Ninguna llamada modifica nada en Bitget: el alta verifica la credencial con GETs, y el historial y el saldo también son GETs.

## 2. Contra qué se comparó

Comparar el panel consigo mismo no demuestra nada, así que el resultado esperado de cada periodo se calculó **sin compartir código con el panel**:

- Las operaciones se pidieron a Bitget en ventanas de 7 días con una sola página cada una, sin el paginador del panel.
- Los bordes de día se calcularon a mano con el desfase fijo de México (UTC−6), sin `rangoDePeriodo`.
- La suma se hizo con `Decimal` sobre el `netProfit` crudo de la respuesta.

En cada periodo se exigió que coincidieran las operaciones una por una (por `positionId`), las ganadoras, las perdedoras y la suma exacta.

## 3. Resultados

| Cuenta | Periodo | Desde | Hasta | Operaciones | Ganadoras | Perdedoras | Resultado neto (USDT) | Activos | Coincide |
|---|---|---|---|---|---|---|---|---|---|
| Classic | Hoy | 2026-10-13 | 2026-10-13 | 0 | 0 | 0 | 0 | — | Sí |
| Classic | Últimos 7 días | 2026-10-07 | 2026-10-13 | 0 | 0 | 0 | 0 | — | Sí |
| Classic | Últimos 30 días | 2026-09-14 | 2026-10-13 | 4 | 0 | 4 | -0.3203656 | BTCUSDT, DOGEUSDT | Sí |
| Classic | Últimos 90 días | 2026-07-17 | 2026-10-13 | 29 | 2 | 27 | -1.12517378 | BTCUSDT, DOGEUSDT, ETHUSDT | Sí |
| Classic | Día con más operaciones | 2026-08-25 | 2026-08-25 | 7 | 2 | 5 | -0.36095346 | BTCUSDT, ETHUSDT | Sí |
| Classic | Mes natural | 2026-08-01 | 2026-08-31 | 22 | 2 | 20 | -0.64003821 | BTCUSDT, ETHUSDT | Sí |
| Classic | Cruce de fin de mes | 2026-08-27 | 2026-09-05 | 8 | 0 | 8 | -0.2139156 | BTCUSDT | Sí |
| Classic | Cruce de inicio de mes | 2026-07-27 | 2026-08-05 | 0 | 0 | 0 | 0 | — | Sí |
| UTA | Hoy | 2026-10-13 | 2026-10-13 | 0 | 0 | 0 | 0 | — | Sí |
| UTA | Últimos 7 días | 2026-10-07 | 2026-10-13 | 0 | 0 | 0 | 0 | — | Sí |
| UTA | Últimos 30 días | 2026-09-14 | 2026-10-13 | 9 | 1 | 8 | -0.367036 | BTCUSDT | Sí |
| UTA | Últimos 90 días | 2026-07-17 | 2026-10-13 | 9 | 1 | 8 | -0.367036 | BTCUSDT | Sí |
| UTA | Día con más operaciones | 2026-10-01 | 2026-10-01 | 6 | 1 | 5 | -0.23946485 | BTCUSDT | Sí |
| UTA | Mes natural | 2026-10-01 | 2026-10-31 | 9 | 1 | 8 | -0.367036 | BTCUSDT | Sí |
| UTA | Cruce de fin de mes | 2026-10-27 | 2026-11-05 | 0 | 0 | 0 | 0 | — | Sí |
| UTA | Cruce de inicio de mes | 2026-09-26 | 2026-10-05 | 9 | 1 | 8 | -0.367036 | BTCUSDT | Sí |

**Los 16 casos coinciden.** También se leyó el saldo vigente de las dos cuentas, y al reabrir el panel lo guardado se leyó sin volver a Bitget.

Los resultados son negativos porque son cuentas de pruebas que operan importes mínimos: las comisiones pesan más que el movimiento de precio. Es justo el caso que muestra que el panel suma el **neto** (`netProfit`) y no solo el PnL de precio.

## 4. Lo que esta prueba no cubre

- **Comparación visual con la web de Bitget.** La prueba demuestra que el panel suma exactamente lo que devuelve la API. Falta confirmar a ojo que la columna "PnL realizado" de la web coincide con `netProfit` en estas mismas operaciones. Basta abrir en la web el historial de posiciones de la cuenta madre del 25/08/2026: deben verse 7 posiciones cerradas que suman −0.36 USDT.
- **Volumen.** Ninguna semana pasó de 100 operaciones, así que la paginación de varias páginas con datos reales solo se probó partiendo en páginas de 5 (`test/red/historial.test.ts`). Con páginas de 100 está cubierta por los tests sobre el Bitget simulado.
- **Activos.** Las cuentas de prueba solo operaron BTC, ETH y DOGE. El panel no distingue activos al sumar, así que no hay un caso por activo que pueda fallar aparte.
