# Alertas de operaciones fuera del panel — Fase 1: verificación contra la API

Fecha: 15/10/2026. Sonda: `test/red/fuera-del-panel.test.ts` (solo lectura).
Fixture: `test/fixtures/alertas/bitget-registros.json`. Cuentas: madre Classic (`BITGET_MADRE_*`) y UTA (`BITGET_UTA_*`).

## 1. Qué deja Bitget de cada acción

| Acción | Classic (v2) | UTA (v3) |
|---|---|---|
| Órdenes | `/api/v2/mix/order/orders-history` → `{entrustedList}`. Trae `clientOid`, `enterPointSource` (`api`/`sys`), `orderSource`, `tradeSide` | `/api/v3/trade/history-orders` → `{list}`. Trae `clientOid`. **Ningún campo de origen** |
| Planes TP/SL | `/api/v2/mix/order/orders-plan-history` (`planType=profit_loss`/`normal_plan`). Conserva `clientOid` y `planStatus` (`executed`/`cancelled`) | `/api/v3/trade/history-strategy-orders`. `status` `cancelled`; `clientOid` numérico |
| Margen | `/api/v2/mix/account/bill`: `append_margin` con símbolo e importe (sin lado) | `/api/v3/account/financial-records`: `INCREASE_MARGIN` con símbolo e importe |
| Traspasos | `bill`: `trans_from_*` / `trans_to_*`. Los del panel llevan `clientOid` `pcbtr…` en `sub-main-trans-record` | El registro de la subcuenta llegó vacío |
| Apalancamiento / modo | **No deja registro.** Se lee el estado actual por símbolo (`/api/v2/mix/account/account`) | Estado actual en `/api/v3/account/settings` |

## 2. Lo que distingue al panel, y lo que no

- **Aperturas del panel:** `clientOid` `pcb…`, 30 de 30.
- **Cierres del panel: sin marca.** El panel cierra con `close-positions`, que no admite `clientOid`; Bitget les pone un número. Llegan como "número + origen `api`", igual que llegaría la orden de otro bot del cliente.
- **Margen, apalancamiento, modo y quitar TP:** no admiten `clientOid` (`cuenta.ts:308`, `cuenta-v3.ts:36`).
- **TP colocado por el panel:** en v2 conserva `pcb…`; en v3 llega con `clientOid` numérico.

**Consecuencia:** la marca `pcb` no basta. El panel anota en una bitácora cada petición de escritura que envía a Bitget (`acciones/propias.jsonl`, desde `ClienteBitget.peticionFirmada`) y una acción se reconoce como suya si coincide con esa bitácora: misma cuenta, mismo símbolo y una escritura unos segundos antes.

## 3. Lo automático, que no se avisa

Verificado en v2:

- **TP disparado:** `orderSource = pos_profit_market` (origen `api`).
- **Liquidación:** `tradeSide = burst_close_long`, origen `sys`.
- **TP que Bitget cancela al cerrarse la posición:** aparece como plan `cancelled` pegado al cierre. No es "quitar el TP" y se descarta.

En v3 el historial no trae origen. Se buscan las mismas marcas en `delegateType` y `execType`, pero **no hay un TP disparado en UTA capturado**: hasta capturarlo, un TP disparado en UTA podría avisarse como cierre.

## 4. Lectores del panel contra los datos reales

Prueba "lectores del panel contra Bitget real", últimos 30 días, con la bitácora vacía (las operaciones son anteriores a ella):

| | Eventos leídos | Automáticos | Con `pcb` | Saldrían como externos sin bitácora |
|---|---|---|---|---|
| Classic | 22 (4 abrir, 4 cerrar, 4 TP puesto, 4 TP quitado, 4 margen, 2 traspasos) | 0 | 8 | 4 cierres, 4 margen, 2 traspasos |
| UTA | 35 (9 abrir, 9 cerrar, 5 TP puesto, 5 TP quitado, 7 margen) | 0 | 7 | 9 cierres, 7 margen, 5 TP puesto, 2 aperturas de un script de pruebas |

Los 4 + 5 "TP quitado" se descartan solos (cancelados por el cierre). Lo demás que saldría como externo son cierres, margen y TP del panel anteriores a la bitácora, más dos órdenes de un script de pruebas, que sí son externas. Desde que existe la bitácora, las acciones del panel se reconocen. Lo prueba `test/integration/alertas.test.ts`: un cierre con `close-positions` no se avisa.

## 5. Pendiente de verificar con una operación manual

Las cuentas de prueba no tienen operaciones hechas a mano. Falta hacer desde la app o la web de Bitget, con el mínimo importe, en la cuenta madre y en la UTA:

1. Abrir y cerrar una posición.
2. Poner y quitar un TP.
3. Agregar margen.
4. Cambiar el apalancamiento.

Después hay que repetir `npm run test:red`. Así se sabrá qué valor de `enterPointSource` deja la app (el aviso mostraría "App"/"Web") y cómo aparece un TP disparado en UTA. **Mientras tanto, ante la duda el panel avisa:** lo que no tiene marca `pcb` ni coincide con su bitácora llega al chat.
