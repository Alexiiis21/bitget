# Historial por periodo — Fase 1: verificación contra la API

Fecha: 12/10/2026. Sonda: `test/red/historial.test.ts` (solo lectura).
Fixture: `test/fixtures/historial/v3-history-position.json`.

## 1. Estado de la verificación

| Superficie | Endpoint | Verificado |
|---|---|---|
| UTA (v3) | `GET /api/v3/position/history-position` | **Sí**: 9 posiciones reales capturadas |
| Classic (v2) | `GET /api/v2/mix/position/history-position` | **Sí** (13/10/2026), con la clave de la cuenta madre (`BITGET_MADRE_*`): 29 posiciones reales. La clave `BITGET_DEMO_*` responde `40018 Invalid IP` desde este equipo. |

## 2. Lo que devuelve cada superficie (verificado)

Classic (v2) usa los mismos conceptos con otros nombres: `holdSide`, `openAvgPrice`/`closeAvgPrice`, `pnl`, `openFee`/`closeFee`, `ctime`/`utime`, y el sobre `{ list, endId }`. En las 29 posiciones se cumple también `netProfit = pnl + openFee + closeFee + totalFunding`. La tabla siguiente usa los nombres de V3.

Sobre: `{ list: [...], cursor: "..." }`. Cada posición trae:

| Campo Bitget | Columna del panel |
|---|---|
| `symbol`, `posSide` (`long`/`short`) | Par y lado |
| `marginMode` (`isolated`/`crossed`) | Modo de margen |
| `createdTime` (ms) | Fecha de apertura |
| `openPriceAvg` / `closePriceAvg` | Precio de entrada / salida promedio |
| `closeTotalPos` | Cantidad de cierre |
| `netProfit` | Resultado (ver §3) |
| `updatedTime` (ms) | Fecha de cierre |
| `cumRealisedPnl`, `openFeeTotal`, `closeFeeTotal`, `totalFunding`, `cashDividend` | Desglose, se conserva para auditoría |

**No vienen:** el **apalancamiento** ni ningún **porcentaje** de la operación (ver §5).

## 3. Qué incluye el resultado

En las 9 posiciones capturadas se cumple, con diferencias de redondeo de 1e-8:

```
netProfit = cumRealisedPnl + openFeeTotal + closeFeeTotal + totalFunding
```

Las comisiones y el financiamiento llegan con signo (negativo = coste). Por tanto:

- `cumRealisedPnl` es solo el movimiento de precio.
- `netProfit` es lo que de verdad entró o salió de la cuenta.

**Decisión:** el resultado de cada operación y la suma del periodo usan **`netProfit`**. Ejemplo real: una operación con `cumRealisedPnl = +0.00336` tiene `netProfit = −0.01692`. Esa operación **es perdedora** aunque el precio fuera a favor.

Pendiente de confirmar a ojo: que la columna "PnL realizado" de la web de Bitget coincide con `netProfit` en estas mismas operaciones.

## 4. Paginación y ventana

- **Orden:** de la más reciente a la más antigua por fecha de cierre, en las dos superficies.
- **Filtro:** `startTime`/`endTime` filtran por **fecha de cierre** y los dos extremos son **inclusivos**. Verificado en v2 y v3 con una posición abierta el 03/09 y cerrada el 06/09: un `endTime` entre las dos fechas la excluye, y un `endTime` igual a su cierre la incluye.
- **El cursor de Bitget pierde posiciones.** Paginando de 2 en 2 con `idLessThan = endId` (v2), de 29 posiciones llegaron 28. La que faltaba cerró **1 ms** antes que la última de la página anterior. `endId` es un id interno que no coincide con el `positionId` y no sigue el orden de la lista. **Decisión:** no se usa el cursor en ninguna superficie. Se pagina por fecha de cierre: se pide la página siguiente con `endTime` igual a la fecha de cierre más antigua de la anterior, y las posiciones del borde que se repiten se descartan por `positionId`. Con este método llegan 29 de 29 en v2 y 9 de 9 en v3, iguales a la página única.
- **Límite del método:** si más de 100 posiciones de una misma cuenta cierran en el mismo milisegundo, la consulta se detiene con aviso (`paginacion-estancada`) en vez de saltarse ninguna. En una subcuenta no ocurre en la práctica.
- **Rango máximo por petición:** 90 días. Con 120 días responde `00001 startTime and endTime interval cannot be greater than 90 days`.
- **Antigüedad máxima:** también 90 días. Pedir el tramo de hace 180 a 90 días responde `25200 HistoryPositionQueryParam time range illegal`. **Bitget solo entrega por API los últimos 90 días.**

Consecuencia para la Fase 3: lo anterior a 90 días **solo existe si el panel ya lo guardó localmente**. Una cuenta que no se sincronice en más de 90 días pierde de forma irrecuperable las operaciones de ese hueco. Es la "Consideración importante" del presupuesto, ahora con cifra concreta.

## 5. Decisión que corresponde al cliente: apalancamiento y porcentaje

El presupuesto promete mostrar el apalancamiento y el porcentaje de cada operación **"tal como aparecen en la plataforma"**. La API de historial no los entrega. Hay tres opciones:

1. **Mostrar "—"** en esas dos columnas. Cumple "Valores mostrados: el sistema no estima ni ajusta valores propios".
2. **Calcular el porcentaje** como `netProfit / margen inicial`. Requiere el apalancamiento, que tampoco viene en el historial, así que haría falta guardarlo al abrir desde el panel. No serviría para operaciones abiertas fuera del panel.
3. **Calcular el porcentaje sobre el nocional** (`netProfit / (precioEntrada × cantidad)`). Se puede obtener siempre, pero **no es** el porcentaje que muestra Bitget.

Recomendación: la opción 1. Si el cliente quiere porcentaje, la 2 solo cubre lo operado desde el panel, y hay que decírselo así.

## 6. Límite de peticiones

No se ha medido. El valor publicado por Bitget es de 20 peticiones/s por UID, **sin confirmar contra la documentación vigente**. Ese límite queda por encima del bucket de 8/s por cuenta que ya aplica el limitador del cliente, así que **no se añade a `LIMITES_POR_ENDPOINT`**: según el criterio de `constants.ts`, solo llevan bucket propio los endpoints que caen por debajo de 8/s. Una sincronización completa son pocas páginas, así que el límite no aprieta.
