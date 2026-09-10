# Paquete A — Diagnóstico y mapa de equivalencias V2↔V3 (UTA)

**Panel de Control Bitget (PCB)** · Fecha: 7 de septiembre de 2026
Cotización de referencia: `Cotizacion_PCB_Migracion_V3_UTA.pdf`, Paquete A, 2–4 h, prioridad Alta
Documento de contexto: [`../INTEGRACION_V3_UTA.md`](../INTEGRACION_V3_UTA.md)

> Cubre lo que pide el Paquete A: *"inventario de los endpoints usados hoy, equivalencia uno a
> uno con V3, tabla de traducción de parámetros y de códigos de error"*. No incluye código de
> producto — eso empieza en el Paquete B, igual que en
> [`00-traspasos-fase-1.md`](00-traspasos-fase-1.md).

---

## 0. Cómo leer este documento

Todo lo que sigue está etiquetado por origen. La distinción no es una formalidad: el proyecto
ya se ha llevado dos sustos por dar por buena la documentación de Bitget frente a la respuesta
real —`posSide` en lugar de `holdSide` al listar planes
([`tpsl.ts:84-97`](../src/main/bitget/rest/endpoints/tpsl.ts#L84-L97)) y `planType` en la
cancelación ([`tpsl.ts:198-214`](../src/main/bitget/rest/endpoints/tpsl.ts#L198-L214))—, y los
dos habrían pasado desapercibidos en una tabla sin esta columna.

| Etiqueta | Significado |
|---|---|
| **VERIFICADO** | Capturado contra `api.bitget.com` en la fecha indicada, o leído del código que ya lo capturó. |
| **CÓDIGO** | Leído del código fuente del panel. No admite duda sobre lo que el panel hace hoy. |
| **DOC** | Deducido de la documentación de Bitget vía `INTEGRACION_V3_UTA.md`. **No capturado.** |
| **HUECO** | No hay equivalente conocido. Es trabajo a estimar, no un detalle a resolver sobre la marcha. |

**Estado de la columna V3 al cierre de este documento: todo es DOC.** No se ha ejecutado ni una
petición contra `/api/v3/*`. La sonda que las hace está escrita y sin correr —
[`../scripts/sondear-v3.mjs`](../scripts/sondear-v3.mjs), §8. Hasta que su salida se pegue en
este documento, ninguna fila V3 debe tratarse como verificada.

---

## 1. Inventario de la superficie V2 — 21 rutas · CÓDIGO

La cotización mapea 9 funciones. El panel usa **21 rutas** (19 REST + 2 canales WebSocket). La
diferencia no es un descuido de la cotización: siete de las rutas de más son endpoints de
soporte que ninguna función de usuario nombra —resolución de órdenes indeterminadas, catálogo,
reloj— y cuatro pertenecen al módulo de traspasos, entregado en v0.8.1, **después** del
presupuesto base de julio sobre el que se redactó la cotización.

### 1.1 Órdenes y posiciones

| Ruta | Función · archivo | Parámetros enviados | Campos leídos | `idempotente` |
|---|---|---|---|---|
| `POST /api/v2/mix/order/place-order` | `abrirPosicion` · [`ordenes.ts:71`](../src/main/bitget/rest/endpoints/ordenes.ts#L71) | `symbol`, `productType`, `marginCoin`, `marginMode`, `size`, `side` (`buy`/`sell`), `tradeSide:"open"`, `orderType` (`market`/`limit`), `clientOid`, +`price`+`force:"gtc"` si límite | `orderId`, `clientOid` | `false` |
| `POST /api/v2/mix/order/close-positions` | `cerrarPosicion` · [`ordenes.ts:154`](../src/main/bitget/rest/endpoints/ordenes.ts#L154) | `symbol`, `productType`, `holdSide`, `clientOid` | `successList[]`, `failureList[]` (`orderId`, `clientOid`, `errorCode`, `errorMsg`) | `false` |
| `GET /api/v2/mix/order/detail` | `consultarOrden` · [`ordenes.ts:199`](../src/main/bitget/rest/endpoints/ordenes.ts#L199) | `symbol`, `productType`, `clientOid` | `orderId`, `clientOid`, `symbol`, `size`, `state`, `baseVolume`, `priceAvg` | `true` |
| `GET /api/v2/mix/position/all-position` | `obtenerPosiciones` · [`posiciones.ts:57`](../src/main/bitget/rest/endpoints/posiciones.ts#L57) | `productType`, `marginCoin` | `symbol`, `holdSide`, `total`, `available`, `marginCoin`, `marginMode`, `openPriceAvg`, `liquidationPrice`, `leverage`, `marginSize`, `unrealizedPL` | `true` |

`close-positions` cierra «lo que haya» en vez de una cantidad fija a propósito
([`ordenes.ts:137-149`](../src/main/bitget/rest/endpoints/ordenes.ts#L137-L149)): entre que el
panel lee la posición y la orden sale, el tamaño puede haber cambiado, y una cantidad fija
dejaría un resto abierto sin que nadie lo note. Cualquier equivalente V3 tiene que conservar
esa propiedad.

### 1.2 Take Profit

| Ruta | Función · archivo | Parámetros enviados | Campos leídos | `idempotente` |
|---|---|---|---|---|
| `POST /api/v2/mix/order/place-tpsl-order` | `colocarTakeProfit` · [`tpsl.ts:46`](../src/main/bitget/rest/endpoints/tpsl.ts#L46) | `symbol`, `productType`, `marginCoin`, `planType:"pos_profit"`, `triggerPrice`, `triggerType:"fill_price"`, `holdSide`, `clientOid` | `orderId`, `clientOid` | `false` |
| `GET /api/v2/mix/order/orders-plan-pending` | `planesPendientes` · [`tpsl.ts:118`](../src/main/bitget/rest/endpoints/tpsl.ts#L118) | `productType`, `planType:"profit_loss"` | `entrustedList[]`: `orderId`, `clientOid`, `symbol`, `planType`, `triggerPrice`, **`posSide`**, `status` | `true` |
| `POST /api/v2/mix/order/cancel-plan-order` | `cancelarPlan` · [`tpsl.ts:216`](../src/main/bitget/rest/endpoints/tpsl.ts#L216) | `symbol`, `productType`, `marginCoin`, `planType` (el del plan: `pos_profit`), `orderIdList:[{orderId}]` | `successList[]`, `failureList[]` | `false` |

Dos trampas ya pagadas que la migración no debe volver a pagar, las dos **VERIFICADAS** contra
la API real:

- **25/08/2026** — al **listar**, el lado viene en `posSide`; al **enviar** se llama `holdSide`.
  Filtrar por `holdSide` en el listado no encuentra nunca nada y el panel concluye «esta
  posición no tiene Take Profit» teniéndolo.
- **25/08/2026** — cancelar con `planType:"profit_loss"` (la familia) responde `00000 success`
  con las dos listas vacías **y no cancela nada**. Hay que mandar el tipo concreto que devolvió
  el listado. El éxito no significa que se haya quitado algo: hay que mirar el contenido.

### 1.3 Cuenta y configuración

| Ruta | Función · archivo | Parámetros enviados | Campos leídos | `idempotente` |
|---|---|---|---|---|
| `GET /api/v2/spot/account/info` | `obtenerInfoCuenta` · [`cuenta.ts:38`](../src/main/bitget/rest/endpoints/cuenta.ts#L38) | — | `userId`, `authorities[]`, `ips`, `parentId` | `true` |
| `GET /api/v2/mix/account/accounts` | `obtenerCuentasFuturos` · [`cuenta.ts:64`](../src/main/bitget/rest/endpoints/cuenta.ts#L64) | `productType` | `marginCoin`, `available`, `accountEquity`, `usdtEquity`, `locked` | `true` |
| `GET /api/v2/mix/account/account` | `obtenerCuentaSimbolo` · [`cuenta.ts:291`](../src/main/bitget/rest/endpoints/cuenta.ts#L291) | `symbol`, `productType`, `marginCoin` | `marginMode`, **`posMode`**, `isolatedLongLever`, `isolatedShortLever`, `crossedMarginLeverage`, `available`, `accountEquity` | `true` |
| `POST /api/v2/mix/account/set-leverage` | `fijarApalancamiento` · [`cuenta.ts:157`](../src/main/bitget/rest/endpoints/cuenta.ts#L157) | `symbol`, `productType`, `marginCoin`, `leverage`, `holdSide` **solo en aislado** | `longLeverage`, `shortLeverage`, `crossMarginLeverage`, `marginMode` | `false` |
| `POST /api/v2/mix/account/set-margin-mode` | `fijarModoMargen` · [`cuenta.ts:214`](../src/main/bitget/rest/endpoints/cuenta.ts#L214) | `symbol`, `productType`, `marginCoin`, `marginMode` | (misma forma que `set-leverage`) | `false` |
| `POST /api/v2/mix/account/set-margin` | `ajustarMargen` · [`cuenta.ts:262`](../src/main/bitget/rest/endpoints/cuenta.ts#L262) | `symbol`, `productType`, `marginCoin`, `amount`, `holdSide` | — (`zod.unknown()`) | `false` |

`posMode` de este endpoint es **el `holdMode` de V3 con otro nombre**: mismos dos valores,
`hedge_mode` / `one_way_mode`, y misma consecuencia. Hoy se traduce a `ModoPosicion` en
[`verificacion.ts:424`](../src/main/bitget/verificacion.ts#L424). Es el único concepto del
documento de contexto que **ya existe** en el panel.

Tres restricciones VERIFICADAS que condicionan el mapeo:

- **13/08/2026** — `set-margin` solo funciona en margen aislado; en cruzado responde `40808`.
- **13/08/2026** — `set-leverage` con `holdSide` en una cuenta **cruzada** responde `00000` y
  **no cambia nada** (incidencia del 05/09/2026). De ahí que `holdSide` sea `null` en cruzado.
- **25/08/2026** — el modo de margen es **por símbolo**, no por cuenta. Leer el de un símbolo y
  aplicarlo a otro reconfigura en silencio el que se está operando.

### 1.4 Soporte

| Ruta | Función · archivo | Firma | Uso |
|---|---|---|---|
| `GET /api/v2/public/time` | `sincronizarReloj` · [`client.ts:174`](../src/main/bitget/rest/client.ts#L174) | pública | Corrección de reloj al arrancar y tras un rechazo por marca de tiempo |
| `GET /api/v2/mix/market/contracts` | [`simbolos.ts:71`](../src/main/bitget/rest/endpoints/simbolos.ts#L71) | pública | Catálogo de activos: paso de cantidad, `maxLever` |
| `GET /api/v2/mix/market/ticker` | [`simbolos.ts:107`](../src/main/bitget/rest/endpoints/simbolos.ts#L107) | pública | Precio de referencia para dimensionar la orden y calcular el TP |

### 1.5 Traspasos entre subcuentas — v0.8.1, fuera del mapa de la cotización

| Ruta | Función · archivo | Parámetros enviados | Campos leídos | `idempotente` |
|---|---|---|---|---|
| `GET /api/v2/mix/account/sub-account-assets` | `obtenerSaldosSubcuentas` · [`subcuentas.ts:102`](../src/main/bitget/rest/endpoints/subcuentas.ts#L102) | `productType` · **credencial de la madre** | `userId`, `assetList[]`: `marginCoin`, `available`, **`maxTransferOut`**, `accountEquity`, `usdtEquity`, `locked`, `unrealizedPL` | `true` |
| `POST /api/v2/spot/wallet/subaccount-transfer` | `traspasarEntreSubcuentas` · [`subcuentas.ts:171`](../src/main/bitget/rest/endpoints/subcuentas.ts#L171) | `fromType`/`toType` (`usdt_futures`), `amount`, `coin`, `fromUserId`, `toUserId`, `clientOid` | `transferId`, `clientOid` | `false` |
| `GET /api/v2/spot/account/sub-main-trans-record` | `buscarTraspaso` · [`subcuentas.ts:263`](../src/main/bitget/rest/endpoints/subcuentas.ts#L263) | `clientOid`, `coin`, `limit` | `clientOid`, `transferId`, `status`, `size`, `coin`, `cTime` | `true` |

VERIFICADO **04/09/2026** (lectura, con 20 subcuentas reales) y **05/09/2026** (traspaso real de
0,5 USDT, ida y vuelta). `maxTransferOut` es lo que justifica la pantalla entera: el saldo de
una subcuenta no es lo que se puede sacar de ella, y Bitget ya hace esa resta.

### 1.6 WebSocket privado

| Canal | Suscripción literal | Campos leídos | Archivo |
|---|---|---|---|
| `positions` | `{instType:"USDT-FUTURES", channel:"positions", coin:"default"}` | `instId`/`symbol`, `holdSide`, `total`, `marginMode`, `marginSize`, `openPriceAvg`, `liquidationPrice`, `leverage`, `unrealizedPL` | [`empujones.ts:34`](../src/main/bitget/ws/empujones.ts#L34) |
| `orders-algo` | `{instType:"USDT-FUTURES", channel:"orders-algo", instId:"default"}` | `instId`/`symbol`, `orderId`, `clientOid`, `planType`, `triggerPrice`, `posSide`, `status` | [`empujones.ts:105`](../src/main/bitget/ws/empujones.ts#L105) |

Login WS: prefirma `timestamp + "GET" + "/user/verify"` con **timestamp en segundos**, no en
milisegundos ([`conexion.ts:262-285`](../src/main/bitget/ws/conexion.ts#L262-L285)). Es la única
diferencia de firmado del proyecto y hay que conservarla en el equivalente V3.

---

## 2. Mapa de equivalencias uno a uno

Columna V3 **DOC** en todas las filas. Veredicto en tres valores: `directo` (renombrar
parámetros y ya), `semántica` (el equivalente existe pero cambia lo que significa o lo que
devuelve, y hay que revisar la lógica que lo consume), `HUECO`.

| # | V2 (hoy) | V3 (UTA) | Veredicto | Nota |
|---|---|---|---|---|
| 1 | `mix/order/place-order` | `trade/place-order` | **semántica** | Cambian 4 parámetros y aparece `posSide` condicional al `holdMode` |
| 2 | `mix/order/close-positions` | `trade/close-positions` | **semántica** | Límite 5/s/UID. Conservar «cierra lo que haya» |
| 3 | `mix/order/detail` | **?** | **HUECO — crítico** | §2.1 |
| 4 | `mix/position/all-position` | `position/current-position` | **semántica** | `openPriceAvg`→`avgPrice`; límite 20/s/UID |
| 5 | `mix/order/place-tpsl-order` | `trade/place-order` + `takeProfit`, `tpTriggerBy`, `tpOrderType` | **semántica** | Deja de ser un plan aparte y pasa a ser campos de la orden. §2.2 |
| 6 | `mix/order/orders-plan-pending` | **?** | **HUECO** | §2.2 |
| 7 | `mix/order/cancel-plan-order` | **?** | **HUECO** | §2.2 |
| 8 | `mix/account/set-leverage` | `account/set-leverage` | **semántica** | `longLeverage`/`shortLeverage` en hedge en vez de `leverage`+`holdSide` |
| 9 | `mix/account/set-margin` | `account/set-margin` | **semántica** | `operation:"add"` + `amount` en vez de `amount` con signo |
| 10 | `mix/account/set-margin-mode` | **?** | **HUECO** | §2.3 |
| 11 | `mix/account/account` | `account/settings` (parcial) | **semántica** | `posMode`→`holdMode`. El apalancamiento por símbolo vive en `symbolConfigList` |
| 12 | `mix/account/accounts` | `account/assets` | **semántica** | Forma del balance sin capturar |
| 13 | `spot/account/info` | `account/settings` | **semántica** | ¿Dónde quedan `authorities` e `ips`? §2.4 |
| 14 | `public/time` | (misma) | **directo** | Endpoint público, sin superficie propia |
| 15 | `mix/market/contracts` | `market/instruments` | **semántica** | `category` en vez de `productType` |
| 16 | `mix/market/ticker` | `market/tickers` | **semántica** | idem |
| 17 | `mix/account/sub-account-assets` | **?** | **HUECO — traspasos** | §7 |
| 18 | `spot/wallet/subaccount-transfer` | **?** | **HUECO — traspasos** | §7 |
| 19 | `spot/account/sub-main-trans-record` | **?** | **HUECO — traspasos** | §7 |
| 20 | WS `positions` | WS `position` · `instType:"UTA"` | **semántica** | §5 |
| 21 | WS `orders-algo` | **?** | **HUECO** | §5 |

**Ocho huecos sobre 21 rutas.** Ninguno es opcional: cada uno corresponde a una función que el
operador usa hoy.

### 2.0 Cómo quedan tratados tras la Fase C — actualizado el 8/09/2026

Las cinco funciones principales ya enrutan solas por superficie. Ante los huecos **no se
adivina un endpoint**: en Bitget un parámetro mal supuesto responde `00000` y hace otra cosa —lo
demuestran las incidencias del 25/08 y del 05/09—, así que un endpoint mal supuesto haría lo
mismo y el operador leería «Take Profit puesto» sobre una posición sin proteger.

| Función | En cuentas UTA | Qué ve el operador |
|---|---|---|
| Apertura | **Migrada** · `trade/place-order` | Igual que en Classic |
| Cierre | **Migrada** · `trade/close-positions` | Igual que en Classic |
| Agregar margen | **Migrada** · `account/set-margin` | Igual que en Classic |
| Apalancamiento | **Migrada** · `account/set-leverage` | Igual que en Classic |
| Take Profit por % | **Bloqueada** | La casilla UTA falla con un motivo accionable; las Classic del mismo lote siguen |
| Quitar Take Profit | **Bloqueada** | Ídem |
| Cambio de modo de margen | **Bloqueada** | Solo falla si el modo real difiere del aprobado |

Dos decisiones de detalle que no son evidentes y conviene tener escritas:

- **`orders-plan-pending` devuelve lista vacía en vez de fallar.** Es la única de las tres del
  Take Profit que no puede lanzar: el barrido la llama cada 45 s por cuenta y su fallo no se
  traga —descartaría la foto de posiciones y marcaría la cuenta desconectada a los tres ciclos—.
  Lanzar ahí dejaría toda subcuenta UTA sin posiciones en el monitor y pintada como caída, que
  es mucho peor que quedarse sin la columna de Take Profit.
- **`mix/order/detail` lanza en lugar de devolver `null`.** En el contrato de `consultarOrden`,
  `null` significa *«la orden no entró»* y quien lo recibe ofrece reintentar. Devolver `null`
  por no saber convertiría una apertura que sí entró en una segunda apertura: es exactamente la
  regla dura nº 2. Lanzando, la casilla queda `indeterminada`, que es la verdad.

### 2.1 Hueco crítico — la resolución por `clientOid`

`mix/order/detail` es la **única** forma de responder «¿esta orden entró?» tras un corte de red.
Sobre él se apoya la clase `indeterminada`, que es la pieza que impide duplicar una posición
([`errors.ts:23-25`](../src/main/bitget/errors.ts#L23-L25),
[`ordenes.ts:199-229`](../src/main/bitget/rest/endpoints/ordenes.ts#L199-L229)). El
comportamiento exacto que hay que reproducir:

```
consultarOrden(clientOid) -> DetalleOrden   la orden entró
                          -> null           Bitget respondió 40109: NO entró
                          -> throw          no se sabe; sigue indeterminada
```

Esa asimetría es deliberada y no se puede relajar. **Sin equivalente V3, una cuenta UTA no puede
tener tri-estado**: toda orden cortada quedaría permanentemente `indeterminada` y el operador
tendría que comprobar en Bitget a mano. El Paquete E depende de cerrar este hueco, no el B.

Candidatos a verificar con la sonda, por orden de probabilidad: `GET /api/v3/trade/order-info`,
`GET /api/v3/trade/orders-history` filtrando por `clientOid`, `GET /api/v3/trade/unfilled-orders`.
Hay que confirmar además **qué código sustituye al `40109`**: tratar «no existe» como error en
vez de como respuesta convertiría un «no entró» en un «no se sabe», y el reintento seguro en
una parálisis.

#### Cómo quedó tras la Fase E — actualizado el 8/09/2026

**El endpoint sigue sin conocerse. La pregunta ya tiene otra fuente: el socket.**

El tema `order` de UTA trae `clientOid` y estado. Si el socket anunció esa orden, Bitget la
conoce — entró. [`registro-ordenes-uta.ts`](../src/main/bitget/registro-ordenes-uta.ts) anota lo
que llega y `consultarOrdenV3` lo consulta, de modo que el cuadro de arriba queda así en V3:

```
consultarOrdenV3(clientOid) -> DetalleOrden   el socket la anunció: entró
                            -> throw          no consta; sigue indeterminada
                            -> null           NUNCA
```

**La asimetría se conserva invirtiéndola.** En V2 la fuente sabe decir que no (`40109`); aquí no
puede, porque «no consta» tiene cuatro explicaciones inocentes —socket caído, cuenta fría por
cupo del pool, empujón que llega un instante después, o que de verdad no entró— y ninguna forma
de distinguirlas. Devolver `null` ahí reintentaría una apertura que sí entró.

El resultado es que la Fase E convierte **algunas** casillas `indeterminada` en `exito` y
**ninguna** en `fallo`. No puede empeorar ningún desenlace, y por eso se pudo hacer sin cerrar el
hueco. Cuando la sonda confirme el endpoint, el registro pasa a ser el atajo y REST la fuente de
la respuesta negativa.

Limitación honesta: una cuenta **fría** —sin socket porque no tenía posiciones y el pool da el
cupo a quien las tiene— no anota nada, y su primera apertura interrumpida seguirá quedando
`indeterminada`. Es justo el caso de una apertura sobre cuenta vacía.

### 2.2 Hueco — el ciclo de vida del Take Profit

En V2 el TP es un **plan independiente** con su propio `orderId`, que se lista y se cancela por
separado. En V3, según el documento de contexto, pasa a ser **campos de la propia orden**
(`takeProfit`, `tpTriggerBy`, `tpOrderType`). Ese cambio rompe tres cosas de golpe:

1. **Poner un TP sobre una posición ya abierta.** Si en V3 el TP solo se puede adjuntar al
   colocar la orden, la función «Take Profit por %» del panel —que se aplica sobre posiciones
   que ya existen— no tiene equivalente directo. Hay que confirmar si existe un
   `POST /api/v3/position/tpsl-order` o similar.
2. **Listar el TP puesto.** `orders-plan-pending` alimenta la columna Take Profit del monitor y
   la resolución de indeterminados del TP. Sin equivalente, la columna queda vacía en UTA.
3. **Quitar el TP.** La función «Quitar Take Profit» cancela por `orderId` del plan
   —precisamente porque el plan puede haberlo puesto el operador desde la app de Bitget y no
   tener `clientOid` nuestro—. Si en V3 el TP es un campo de la orden, «quitarlo» es
   probablemente una modificación, no una cancelación.

Es el hueco de mayor superficie: toca 3 de las 21 rutas y 2 de las 5 funciones principales.

### 2.3 Hueco — el modo de margen por símbolo

`set-margin-mode` no aparece en el mapa de la cotización, pero el motor lo llama **antes de cada
apertura** cuando el modo real difiere del aprobado, y esa llamada existe por una incidencia
concreta (25/08/2026). En UTA el modo de margen se declara a nivel de cuenta/posición y
`marginMode` deja de ser obligatorio en la orden, así que la pregunta no es solo «qué endpoint»
sino **si el concepto sigue existiendo por símbolo**. Si no existe, la comprobación previa del
motor sobra en UTA y la confirmación previa que ve el operador cambia de contenido — un cambio
de comportamiento observable que hay que decidir a propósito, no descubrir en pruebas.

### 2.4 Semántica a confirmar — permisos de la API Key

`spot/account/info` es hoy la única fuente de `authorities` e `ips`, y de ella depende
`verificarCredencial` entera ([`verificacion.ts:319`](../src/main/bitget/verificacion.ts#L319)),
incluida la política de avisos por permiso de traspaso o retiro. `account/settings` de V3
devuelve `uid`, `accountMode`, `assetMode`, `accountLevel`, `holdMode` y `symbolConfigList` —
**ninguno de los dos que el panel necesita**. O bien `spot/account/info` sigue respondiendo a una
key UTA, o bien hace falta otro endpoint. La sonda `--env UTA --v2` responde exactamente esto.

---

## 3. Tabla de traducción de parámetros · DOC

Cada fila anclada al punto del código donde hoy se construye el parámetro, para que el Paquete B
sea mecánico.

| V2 | V3 | Cambio | Dónde se construye hoy |
|---|---|---|---|
| `productType: "USDT-FUTURES"` | `category: "USDT-FUTURES"` | Renombre. El valor ya va en mayúsculas en el panel | [`mercado.ts:60`](../src/main/bitget/mercado.ts#L60) — un solo sitio |
| `productType: "SUSDT-FUTURES"` | **sin equivalente listado** | §6.1 | [`mercado.ts:81`](../src/main/bitget/mercado.ts#L81) |
| `size` | `qty` | Renombre, misma semántica | [`ordenes.ts:81`](../src/main/bitget/rest/endpoints/ordenes.ts#L81) |
| `marginCoin` | — | **Eliminado**; UTA lo resuelve solo | 8 llamadas; siempre `mercado.marginCoin` |
| `marginMode` (obligatorio en la orden) | `marginMode` opcional | Default `crossed`; el modo real vive en la cuenta/posición | [`ordenes.ts:80`](../src/main/bitget/rest/endpoints/ordenes.ts#L80) |
| — | `posSide: "long"\|"short"` | **Nuevo.** Obligatorio en hedge, se omite en one-way | Derivable de `Lado`, que ya viaja en cada entrada |
| — | `timeInForce` | Nuevo. `gtc` por defecto | Hoy `force: "gtc"` en órdenes límite ([`ordenes.ts:90`](../src/main/bitget/rest/endpoints/ordenes.ts#L90)) |
| `holdSide` (enviar) | `posSide` | Renombre | `close-positions`, `set-margin`, `set-leverage`, `place-tpsl-order` |
| `posSide` (listar) | `posSide` | **Ya coincide** | [`tpsl.ts:106`](../src/main/bitget/rest/endpoints/tpsl.ts#L106) |
| `openPriceAvg` | `avgPrice` | Renombre en la respuesta | [`empujones.ts:93`](../src/main/bitget/ws/empujones.ts#L93), [`barrido-posiciones.ts`](../src/main/execution/barrido-posiciones.ts) |
| `liquidationPrice` | `liquidationPrice` | **Sin cambio** | idem |
| `idLessThan` | `cursor` | Paginación. **El panel no pagina hoy** — sin impacto | — |
| `instId` (WS) | `symbol` (WS) | Renombre | [`empujones.ts:36-37`](../src/main/bitget/ws/empujones.ts#L36-L37) ya lee `instId ?? symbol` |
| `channel` (WS) | `topic` (WS) | Renombre | [`conexion.ts:290-297`](../src/main/bitget/ws/conexion.ts#L290-L297) |
| `instType: "USDT-FUTURES"` (WS) | `instType: "UTA"` | Un solo valor cubre todos los topics | [`conexion.ts:293`](../src/main/bitget/ws/conexion.ts#L293) |

Valores de `category`: `SPOT`, `MARGIN`, `USDT-FUTURES`, `COIN-FUTURES`, `USDC-FUTURES`.

### 3.1 `clientOid` — VERIFICADO por lectura de código, sin sondeo

V3 exige 1–32 caracteres de entre letras, dígitos y `. : / _ -`. Los dos generadores del panel
cumplen con margen:

| Generador | Forma | Longitud | Alfabeto |
|---|---|---|---|
| Órdenes · [`motor-lotes.ts:639`](../src/main/execution/motor-lotes.ts#L639) | `pcb` + 12 hex + índice + `l`/`s` | 17–19 | `[a-z0-9]` |
| Traspasos · [`sesion.ts:2658`](../src/main/ipc/sesion.ts#L2658) | `pcbtr` + 12 hex | 17 | `[a-z0-9]` |

El `planId` sale de `randomUUID().replace(/-/g,'').slice(0,12)`, que solo produce hexadecimal.
**No hay riesgo de rechazo por caracteres.** El punto del checklist de la cotización
«`clientOid` generado pasa la validación de caracteres de V3» queda cerrado aquí, sin gastar
una petición.

Lo que sí hay que preservar: el `clientOid` es **derivado del plan, no aleatorio**, de modo que
reenviar el mismo plan produce el mismo identificador y Bitget lo rechaza en vez de duplicar. El
fallback cruzado del Paquete E tiene que reusarlo, nunca regenerarlo.

### 3.2 El firmado no cambia — CÓDIGO

[`signer.ts`](../src/main/bitget/rest/signer.ts) construye
`timestamp + MÉTODO + rutaCompleta + cuerpo` sin nada específico de V2, y las cuatro cabeceras
(`ACCESS-KEY`, `ACCESS-SIGN`, `ACCESS-TIMESTAMP`, `ACCESS-PASSPHRASE`) son idénticas en las dos
superficies. **El Paquete B no toca criptografía**, y `firmarPeticion` se reutiliza tal cual.
La regla que lo sostiene —firmar exactamente los mismos bytes que viajan— se mantiene sin
cambios.

---

## 4. Tabla de códigos de error

22 códigos catalogados en [`errors.ts:82-160`](../src/main/bitget/errors.ts#L82-L160), más
`40109` tratado fuera del catálogo. La columna «V3» es **DOC** en su totalidad: ningún código de
V3 se ha observado.

| Código | Clase actual | Significado | ¿Vigente en V3? |
|---|---|---|---|
| `40001` | `fatal-cuenta` | Falta la API Key | Probable · autenticación compartida |
| `40002` | `fatal-cuenta` | Falta la firma | Probable |
| `40003` | `fatal-cuenta` | Falta la marca de tiempo | Probable |
| `40005` | `fatal-cuenta` | Passphrase no coincide | Probable |
| `40006` / `40009` | `fatal-cuenta` | Firma inválida | Probable |
| `40012` | `fatal-cuenta` | Key inexistente **o** passphrase equivocada (VERIFICADO 28/07/2026) | Probable |
| `40014` | `fatal-cuenta` | Sin permiso de trading / traspaso | Probable |
| `40018` | `fatal-cuenta` | IP no autorizada | Probable |
| `40037` | `fatal-cuenta` | La API Key no existe | Probable |
| `40008` | `retryable` | Marca de tiempo expirada | Probable |
| `429` | `retryable` | Rate limit | Sí · límites distintos, §6.3 |
| `40725` | `retryable` | Servicio ocupado | Probable |
| `45001` | `retryable` | Fallo temporal | Probable |
| `43012` | `fatal-cuenta` | Saldo insuficiente | **Revisar** · margen unificado cambia el cálculo |
| `22002` | `omitida` | No hay posición que cerrar (VERIFICADO 12/08/2026) | **Revisar** · `close-positions` V3 devuelve lista |
| `40754` | `fatal-cuenta` | Futuros no habilitados | **Revisar** · en UTA no aplica igual |
| `40808` | `fatal-cuenta` | `set-margin` solo en aislado (VERIFICADO 13/08/2026) | **Revisar** · §4.2 |
| `40034` | `fatal-lote` | Activo inexistente | Probable |
| `40019` | `fatal-lote` | Falta parámetro obligatorio | Sí · será el más frecuente durante el Paquete B |
| `45110` | `fatal-lote` | Monto bajo el mínimo | Probable |
| `400172` | `fatal-lote` | Parámetro rechazado / apalancamiento fuera de rango | Probable |
| `40109` | *(fuera del catálogo)* | Orden inexistente → `null`, **no error** | **HUECO** · §2.1 |

Fuera del catálogo, por HTTP ([`errors.ts:284-322`](../src/main/bitget/errors.ts#L284-L322)):
`429`→`retryable`; `5xx`→`retryable` si idempotente, `indeterminada` si no; `401`/`403`→
`fatal-cuenta`. Esta capa es agnóstica de superficie y **no necesita cambios**.

### 4.1 El código que falta y que decide el Paquete E

Ninguno de los 22 significa «superficie equivocada», porque hasta hoy no existían dos
superficies. Ese código es la pieza que autoriza el fallback cruzado, y es lo único que separa
un mecanismo seguro de uno peligroso:

- Ante **ese** código concreto: invalidar el modo cacheado, re-detectar, reintentar **una vez**
  con el mismo `clientOid`.
- Ante timeout, error de red o 5xx en una escritura: **nunca** cruzar de superficie. El
  resultado es desconocido, la clase es `indeterminada`, y se resuelve consultando.

Confundir los dos casos es el escenario que la regla dura nº2 prohíbe. Hasta que la sonda
devuelva el código real, **el fallback cruzado no se puede implementar**, y así debe entrar en
el Paquete E.

#### Cómo quedó tras la Fase E — actualizado el 8/09/2026

**El código sigue sin capturar, y resultó que no hacía falta.** La conclusión de arriba daba por
supuesto que la superficie equivocada había que *deducirla* de un código. Se puede *comprobar*:
`GET /api/v3/account/settings` es un oráculo que responde de qué tipo es la cuenta —si contesta,
es UTA; si la rechaza por negocio, es Classic—. Eso prueba en qué superficie está, en vez de
adivinarlo.

Lo que sí hace falta del código es saber **cuándo vale la pena preguntar**, y ahí el catálogo
sirve por descarte: un código catalogado ya significa otra cosa —saldo, permisos, parámetro— y no
dispara nada; uno ausente es el candidato, porque ningún código de los 22 significa «esta clave no
habla esta API». `MotorLotes.pareceSuperficieEquivocada` exige las tres condiciones:

| Condición | Por qué |
|---|---|
| `clase === 'fatal-cuenta'` | `retryable` ya se reintenta; `indeterminada` **no se puede** reenviar; `fatal-lote` es de parámetros, iguales en las dos superficies |
| rechazo de negocio (código numérico) | prueba que Bitget recibió la petición y **no la ejecutó** — excluye `ESQUEMA`, donde la orden pudo entrar, y los cortes de transporte |
| ausente del catálogo | ver arriba |

Confirmado el desajuste, se corrige el modo, se **persiste** —`FuenteCuentas.alCorregirModo`, para
que las otras 99 casillas del lote no tropiecen igual— y se reenvía **una vez**, con el mismo
`clientOid`. Esa reutilización es la red: si algo hubiera entrado, Bitget rechaza el identificador
repetido en lugar de abrir una segunda posición.

El caso `ESQUEMA` merece nombrarse aparte porque es el más peligroso del mecanismo: Bitget
respondió `00000` y el cuerpo no encajó, así que la operación **pudo ejecutarse**. Reenviarla
—aunque fuera a la otra superficie— es exactamente cómo se abren dos posiciones. De ahí la
exigencia de código numérico.

### 4.2 La regla por defecto ya protege la migración

[`errors.ts:19-22`](../src/main/bitget/errors.ts#L19-L22): un código desconocido cae en
`fatal-cuenta`, jamás en `retryable`. Aplicado a la migración significa que **un código nuevo de
V3 que nadie haya catalogado falla esa cuenta y se ve en el informe, sin reintentarse**. Es
exactamente el comportamiento que se quiere mientras el catálogo se completa: el panel no puede
duplicar una orden por un código que no entiende. No hay que cambiar nada de esta política para
la migración.

---

## 5. WebSocket — traducción y hueco · DOC

| V2 | V3 |
|---|---|
| `wss://ws.bitget.com/v2/ws/private` | `wss://ws.bitget.com/v3/ws/private` |
| `{instType:"USDT-FUTURES", channel:"positions", coin:"default"}` | `{instType:"UTA", topic:"position"}` |
| `{instType:"USDT-FUTURES", channel:"orders-algo", instId:"default"}` | **HUECO** |
| login: `timestamp + "GET" + "/user/verify"`, segundos | DOC: idéntico, sin confirmar |

Mapeo de campos del topic `position` contra lo que consume
[`posicionesDeEmpujon`](../src/main/bitget/ws/empujones.ts#L51):

| Campo interno | V2 (`positions`) | V3 (`position`) · DOC |
|---|---|---|
| `simbolo` | `instId` ?? `symbol` | `symbol` |
| `lado` | `holdSide` | `posSide` |
| `tamano` | `total` | `total` |
| `precioEntrada` | `openPriceAvg` | `avgPrice` |
| `precioLiquidacion` | `liquidationPrice` | `liquidationPrice` |
| `apalancamiento` | `leverage` | `leverage` |
| `modoMargen` | `marginMode` | `marginMode` |
| `margen` | `marginSize` | **sin equivalente confirmado** |
| `pnl` | `unrealizedPL` | **sin equivalente confirmado** |

`marginSize` y `unrealizedPL` no aparecen en la lista de campos de `current-position` del
documento de contexto. Si no existen, se pierden la columna de margen y el ROE del Centro de
Monitoreo, que se calcula como `pnl / margenActual`
([`sesion.ts:223-228`](../src/main/ipc/sesion.ts#L223-L228)). A confirmar con la sonda: el
volcado de `current-position` responde esto directamente.

**El hueco de `orders-algo`** es el mismo de §2.2 visto desde el otro lado. El documento de
contexto lista tres topics V3 —`order`, `account`, `position`— y ninguno es de planes TP/SL. Si
el TP en V3 es un campo de la orden, probablemente llegue por el topic `order`, pero eso hay que
verlo, no suponerlo: la columna Take Profit del monitor depende de ello.

**Regla de implementación que no se negocia**: el normalizador emite siempre `Posicion`, y la
tabla del monitor no debe contener ni un `if (mode === 'uta')`. El almacén
([`almacen-posiciones.ts`](../src/main/domain/almacen-posiciones.ts)) ya es agnóstico de
superficie —solo distingue `origen: 'ws' | 'rest'`— y es el punto de encuentro natural de las
dos.

### 5.1 Cómo quedó tras la Fase D — actualizado el 8/09/2026

El socket V3 está construido en
[`conexion.ts`](../src/main/bitget/ws/conexion.ts): la superficie sale de la credencial, igual
que en REST, y toda la diferencia entre las dos cabe en la tabla `SUSCRIPCIONES` —URL, si el
canal se llama `channel` o `topic`, si el `instType` es el producto o el literal `UTA`, y qué
canales se piden—. El login no se tocó: es idéntico en las dos.

| Tema V3 | Qué se hace con él |
|---|---|
| `position` | **Consumido.** Normaliza a `Posicion` y entra en el mismo almacén que V2 |
| `account` | **Consumido.** Refresca el saldo por el mismo `registrarSaldo` que usa el barrido |
| `order` | **Consumido desde la Fase E.** Alimenta el registro que devuelve el tri-estado a UTA — §2.1 |

Tres detalles que condicionan lo que viene:

1. **`order` no sustituye a `orders-algo`.** Se parecen en el nombre y no en el contenido: uno
   trae órdenes normales y el otro órdenes de plan. V3 no publica tema de planes, lo que es
   coherente con el hueco §2.2 y con que el Take Profit quedara bloqueado en UTA en la Fase C.
   Donde `order` sí vale es en el §2.1: trae `clientOid` y estado, que es la única pista conocida
   para resolver una apertura indeterminada en UTA. La Fase D lo dejó sin esquema —inventar
   nombres para datos que nadie lee es el error del 25/08/2026— y la Fase E se lo escribió, ya con
   un consumidor. El coste de equivocarse ahí es benigno y conviene saber por qué: si un nombre no
   acierta, el `clientOid` sale vacío, la orden no se anota y la casilla se queda `indeterminada`,
   que es donde estaba. Un campo mal supuesto aquí no puede producir una respuesta falsa; solo
   puede no producir ninguna.
2. **La conexión no queda viva sin los tres temas confirmados.** Con dos de tres, la cuenta
   enseñaría posiciones al segundo y un saldo de hace 45 s sin que nada lo indicara. Si Bitget
   rechaza alguno de los tres nombres, la cuenta cae a REST y se marca; no se pierde información,
   se pierde inmediatez.
3. **Los renombres de V3 no se repiten en el socket.** `posicionesDeEmpujonV3` delega en
   `posicionV3AFormatoV2`, el mismo traductor que usa la lectura REST. El día que la sonda diga
   cómo se llama de verdad el margen de una posición UTA, se corrige en un sitio y queda
   corregido en los dos caminos —si no, el monitor se contradiría consigo mismo cada 45 s—.

### 5.2 La paginación: `idLessThan` no existe en este repositorio

El alcance describe este trabajo como `idLessThan` → `cursor`. Al ir a hacerlo se encontró que
**`idLessThan` no aparece ni una vez en el código**: el panel nunca ha paginado en V2, y no por
descuido —posiciones (ocho ranuras), planes TP/SL (una petición por cuenta), saldos (una fila por
moneda) y subcuentas (`limit: 20`, el techo de Bitget) no se acercan a una página—. Traducir un
parámetro que nadie envía no habría sido trabajo.

El cambio real de V3 es otro y sí muerde: **la forma del sobre**. Donde V2 devuelve el array
pelado en `data`, V3 lo mete en `{list, cursor}`. Un esquema que espere lo uno y reciba lo otro no
se equivoca a medias: falla la validación entera, y eso son posiciones que no llegan al monitor o
un saldo congelado. Como no hay respuesta capturada y la documentación no es uniforme,
[`lista-v3.ts`](../src/main/bitget/rest/lista-v3.ts) acepta las dos formas y devuelve una. El
cursor se lee aunque no se pagine, para poder decir «esta lista está incompleta» en vez de enseñar
media cartera como si fuera entera.

### 5.3 El fallo que apareció al leer el camino entero

`obtenerCuentasFuturos` —el saldo del barrido, cada 45 s— **no tenía despachador de superficie**.
En una cuenta UTA iba a `/api/v2/mix/account/accounts`, Bitget la rechazaba, y el fallo no se veía:
[`leerSaldo`](../src/main/execution/barrido-posiciones.ts#L411) se traga su propio error a
propósito, para que un saldo caído no descarte la foto de posiciones ni pinte en rojo una cuenta
que responde. El resultado era una columna de saldo congelada en el valor que dejó la
verificación, indefinidamente y sin ningún aviso.

Cada pieza por separado se comportaba como debía. Ahora despacha a `/api/v3/account/assets` y
devuelve la forma de V2, como las cinco funciones de la Fase C.

---

## 6. Decisiones que constriñen el Paquete B

Las tres se toman aquí porque el Paquete B no puede empezar sin ellas.

### 6.1 Dónde va la costura — **no** en `ClienteBitget`

`INTEGRACION_V3_UTA.md` §3 propone una fachada `BitgetClient` que la lógica de negocio ya
usaría. **No es así hoy.** `ClienteBitget` es transporte —firma, reloj, envelope, rate limit— y
los consumidores llaman funciones libres con la forma `f(cliente, credencial, mercado, …)` desde
~17 puntos de [`motor-lotes.ts`](../src/main/execution/motor-lotes.ts) y
[`barrido-posiciones.ts`](../src/main/execution/barrido-posiciones.ts). La costura pasa por las
funciones de `rest/endpoints/*`, no por el cliente.

**Decisión: la superficie viaja en `Credencial`.**

> **Corregido el 8/09/2026, durante el Paquete B.** La primera redacción de esta sección
> proponía colgar la superficie de `Mercado`. Es incorrecto, y conviene dejar escrito por qué:
> `Mercado` es un **singleton por mercado** —uno real y uno simulado, `MERCADOS[clave]`—
> mientras que la superficie es **por subcuenta**. En el mismo mercado y al mismo tiempo habrá
> cuentas Classic y cuentas UTA, así que un campo en `Mercado` no puede representarlas.

El objeto correcto es [`Credencial`](../src/main/bitget/rest/signer.ts), y por una razón que ya
estaba escrita en este código: *"el límite de Bitget es por UID y **cada key pertenece a
exactamente un UID**"* ([`client.ts:224-228`](../src/main/bitget/rest/client.ts#L224-L228)). Una
API Key emitida sobre cuenta UTA solo puede hablar V3 — la superficie **es** una propiedad de la
clave. Y `Credencial` ya viaja a todas las funciones de `rest/endpoints/*` junto al mercado, así
que no hay que tocar ni una firma:

```ts
export type Superficie = 'v2' | 'v3';

export interface Credencial {
  apiKey: string;
  secretKey: string;
  passphrase: string;
  /** Ausente = 'v2'. Una cuenta sin modo detectado habla V2, el defecto seguro. */
  superficie?: Superficie;
}
```

El sellado ocurre en **un solo sitio**, `Sesion.credencialSellada()`, por el que pasan los cuatro
caminos que sacan credenciales del vault (barrido, sockets, motor y verificación). Una
credencial sin sellar habla V2, de modo que un camino que se saltara ese método degradaría a una
cuenta UTA en vez de mandarla a ciegas a una superficie desconocida.

`Maniobra<E>`/`correrLote` ([`motor-lotes.ts:176-221`](../src/main/execution/motor-lotes.ts#L176-L221))
**admite un adaptador V3 sin tocarse**: no sabe qué endpoints toca ninguna maniobra.

La alternativa —una fachada `BitgetClient` como pide el documento de contexto— obliga a
reescribir los ~17 puntos de llamada, que es justo el código que la regla dura nº1 dice no
tocar. Se descarta por eso, no por coste.

### 6.2 Dónde se persiste el modo de cuenta

**Recomendación: `esquemaCuenta` de
[`registro-cuentas.ts:46`](../src/main/domain/registro-cuentas.ts#L46)**, subiendo
`VERSION_ACTUAL` de 3 a 4:

```ts
accountMode: z.enum(['classic', 'uta']).default('classic'),
holdMode: z.enum(['one_way_mode', 'hedge_mode']).nullable().default(null),
```

Es exactamente el patrón con que se añadió `uidPadre` en v2→v3: `.default()` hace que los
archivos viejos carguen sin migración explícita y se reescriban en formato nuevo la próxima vez
que se guarden. El `.default('classic')` implementa literalmente el *"valor por defecto
`classic` para las existentes"* del documento de contexto.

Ahí viven ya los dos campos hermanos —`modoPosicion` y `modoMargen`— que se refrescan en cada
verificación, y existe el hueco exacto para el refresco: `actualizarModos()`
([`registro-cuentas.ts:445-470`](../src/main/domain/registro-cuentas.ts#L445-L470)), que ya
ignora `null` («la verificación no llegó a leerlo») y solo escribe si algo cambió.

**Descartado: el vault.** Obligaría a descifrar para conocer el modo —y el panel dibuja la
rejilla estando bloqueado— y el vault rechaza duramente las versiones futuras, rompiendo la
compatibilidad hacia atrás que `cuentas.json` sí ofrece.

`holdMode` merece un aviso: decide si `posSide` es obligatorio. Una cuenta en `hedge_mode` cuya
detección haya fallado y quede en `one_way_mode` enviaría órdenes sin `posSide`, y en cobertura
eso **cruza los lados**. El valor por defecto seguro es `null` («no se sabe»), no un modo
concreto, y sin él la cuenta no debe operar.

### 6.3 Rate limiter — la clave necesita una dimensión más

[`client.ts:239`](../src/main/bitget/rest/client.ts#L239) usa `credencial.apiKey` como clave del
bucket, porque el límite de V2 es por UID. V3 publica límites **por endpoint y por UID**
(`place-order` 10/s, `close-positions` 5/s, `current-position` 20/s). El
[`LimitadorPeticiones`](../src/main/execution/rate-limiter.ts) acepta cualquier `string` como
clave, así que soporta `` `${apiKey}|v3|place-order` `` **sin cambio estructural** — solo hay
que decidir la clave y dimensionar los buckets. Trabajo del Paquete B, sin rediseño.

---

## 7. Anexo — la superficie de traspasos

Las tres rutas REST de §1.5 más la pantalla de saldos entera quedan **fuera del mapa de la
cotización**, porque el módulo se entregó en v0.8.1, después del presupuesto base de julio sobre
el que se redactó. Están dentro del alcance de este diagnóstico por decisión expresa.

Consecuencia operativa, que conviene decir sin rodeos: **una subcuenta que pase a UTA
desaparecería también de la pantalla de saldos y no se le podría traspasar dinero**, y eso
ocurriría con el mismo silencio que en el resto del panel. `sub-account-assets` se consulta con
la credencial de la **madre**, así que hay una pregunta adicional que ninguna otra ruta plantea:
qué devuelve esa llamada cuando la madre es Classic y algunas de sus subcuentas ya son UTA —
¿las omite, las devuelve con saldo cero, o falla entera? Si las omite en silencio, el panel
mostraría menos subcuentas sin señalar por qué. La sonda no puede responderlo con las
credenciales de una subcuenta; hace falta una pasada con la clave de la madre una vez exista la
subcuenta UTA colgando de ella.

Las tres rutas viven bajo prefijos `mix/` y `spot/` que V3 unifica, así que ninguna sobrevive
tal cual. No hay estimación de horas aquí: sale del mapeo, y el mapeo depende de la sonda.

---

## 8. La sonda — [`../scripts/sondear-v3.mjs`](../scripts/sondear-v3.mjs)

Modelada sobre [`ver-permisos.mjs`](../scripts/ver-permisos.mjs): Node puro, sin dependencias
del `src/`, sin tocar el vault. **Solo GET firmados: no escribe nada en ninguna superficie.**

```
node scripts/sondear-v3.mjs                 # BITGET_DEMO_*, superficie V3
node scripts/sondear-v3.mjs --env UTA       # BITGET_UTA_*,  superficie V3
node scripts/sondear-v3.mjs --env UTA --v2  # BITGET_UTA_*,  superficie V2
node scripts/sondear-v3.mjs --env DEMO --v2 # control
```

Las cuatro combinaciones importan: las dos cruzadas dan los códigos de desajuste, y las dos
rectas son el control que demuestra que un fallo de la cruzada es del desajuste y no de la
clave. Credenciales nuevas en [`../.env.example`](../.env.example), bloque `BITGET_UTA_*`.

### 8.1 Lo que cada sondeo resuelve

| Petición | Hueco que cierra |
|---|---|
| `GET /api/v3/account/settings` con key **Classic** | El código de «superficie equivocada» de §4.1 — sin él no hay fallback cruzado |
| `GET /api/v3/account/settings` con key **UTA** | `accountMode`, `holdMode`, `accountLevel`, `symbolConfigList` reales |
| `GET /api/v3/position/current-position` | ¿Existen `marginSize` y `unrealizedPL`? (§5) — de ello dependen la columna de margen y el ROE |
| `GET /api/v3/account/assets` | Forma real del balance frente a `mix/account/accounts` |
| `GET /api/v3/market/instruments?category=SUSDT-FUTURES` | **Si hay o no mercado de práctica en UTA** (§9.1) |
| `GET /api/v2/spot/account/info` con key **UTA** | Si los permisos siguen siendo legibles (§2.4) y el código de rechazo simétrico |
| `GET /api/v2/mix/position/all-position` con key **UTA** | El rechazo sobre el endpoint que alimenta el monitoreo |

La salida imprime HTTP status, `code`, `msg` y el JSON crudo indentado, más un veredicto en
texto. Está pensada para pegarse en §10 de este documento.

---

## 9. Riesgos abiertos

### 9.1 El mercado de práctica — el de mayor consecuencia

[`mercado.ts:1-22`](../src/main/bitget/mercado.ts#L1-L22) es explícito y está VERIFICADO
(12/08/2026): Bitget **no ofrece un modo demo por cabecera**, ofrece **otro mercado**, con otro
`productType` (`SUSDT-FUTURES`), otros símbolos (`SBTCSUSDT`) y otra moneda de margen (`SUSDT`).
El proyecto trata eso como una ventaja de seguridad y se apoya en ella: *"una orden dirigida al
mercado simulado no puede ejecutarse por error contra dinero real, porque el símbolo ni siquiera
existe allí. No hay bandera que se pueda quedar mal puesta"*. Toda la suite `test/fisica/` vive
de esa separación.

`INTEGRACION_V3_UTA.md:301` asume en cambio una cabecera `paptrading: 1`, y la lista de
`category` de su §5 **no incluye `SUSDT-FUTURES`**. Las dos cosas no pueden ser ciertas a la vez.

| Rama | Consecuencia |
|---|---|
| **Existe demo en UTA** | El Paquete F procede como está cotizado. Hay que averiguar si se alcanza por `category` o por cabecera, y si es por cabecera, `esStaging()` deja de ser la red de seguridad que es hoy |
| **No existe demo en UTA** | Todas las pruebas destructivas sobre UTA pasan a hacerse **con dinero real** en una subcuenta desechable, con importes mínimos. Cambia el riesgo del Paquete F, su duración y el checklist de la cotización |

**Hay que resolverlo antes de comprometer el Paquete F.** Es una petición de la sonda, no una
estimación.

### 9.2 Riesgos heredados, sin novedad

- Una subcuenta que pasa a UTA **no puede volver** a Classic. Las pruebas de modo van en
  subcuentas desechables, nunca en producción.
- La cuenta madre está en el límite de 20 subcuentas de Bitget. Hay que liberar un espacio o
  pedir ampliación antes del Paquete F.
- Medida provisional recomendada, independiente de esta migración: pedir a soporte de Bitget la
  conservación del modo clásico para las cuentas hoy conectadas al panel, e instruir a los
  titulares a no actualizar por su cuenta mientras la adecuación se desarrolla.

---

## 9.3 Sondeo del 09/09/2026 — dos respuestas y una conclusión falsa

Primera ejecución real de `scripts/sondear-v3.mjs --env UTA`. Cerró un riesgo, dejó otro abierto y
**produjo una conclusión equivocada que conviene dejar escrita**.

### RESUELTO · §9.1 — UTA no tiene mercado de práctica

```
GET /api/v3/market/instruments?category=SUSDT-FUTURES
HTTP 400 · code 40034 · "Parameter SUSDT-FUTURES does not exist"
```

Confirmado contra la API real: **`SUSDT-FUTURES` no existe en V3**. El mercado simulado de Bitget
es exclusivo de la superficie clásica.

Consecuencia, y es cara: toda prueba destructiva sobre una cuenta UTA —abrir, cerrar, agregar
margen— va **con dinero real**, en una subcuenta desechable y con importes mínimos. La suite
`test/fisica/` de V2 sigue en simulado; su equivalente UTA no puede existir. Es la razón de que
`test/fisica/uta-escrituras.test.ts` automatice solo el apalancamiento y deje las otras cuatro al
procedimiento manual de la nota de entrega.

### NO resuelto · §4.1 — el código de superficie equivocada sigue sin capturar

```
GET /api/v3/account/settings
code 40018 · "Invalid IP,Current request IP 187.243.210.174"
```

La sonda imprimió: *«Este es el valor que buscaba el Paquete A: el que detectMode() debe tratar
como classic»*. **Es falso, y el error era del script.**

`40018` significa que la IP no está en la lista blanca de esa API Key. La firma y las cuatro
cabeceras de autenticación son **idénticas en V2 y V3** (§2), así que ese rechazo se habría
producido igual en la otra superficie: no distingue nada. La cuenta puede ser UTA perfectamente y
no hay forma de saberlo hasta que la clave se pueda usar.

**Qué se cambió a raíz de esto:**

| Pieza | Antes | Ahora |
|---|---|---|
| `detectarModo` | cualquier fallo de negocio → `classic` | los del sobre de autenticación → `indeterminado` |
| `verificarCredencial` | seguía a V2 y mostraba el segundo código | corta y muestra el problema real |
| `sondear-v3.mjs` | llamaba a cualquier código «el de superficie» | distingue y lo dice |

La lista de códigos afectados está en `SOBRE_DE_AUTENTICACION`
([`errors.ts`](../src/main/bitget/errors.ts)) y es corta a propósito: `40001`, `40002`, `40003`,
`40005`, `40006`, `40009`, `40018`. **No** incluye `40012`, `40014` ni `40037` —«la key no existe»
o «sin permiso» sí podrían ser la forma en que V3 rechaza a una clave clásica, y meterlos daría
por inválida una cuenta Classic que funciona. Ante la duda, un diagnóstico pobre antes que un
rechazo falso.

### La lección, que vale más que el hallazgo

El algoritmo de detección se defendió en la Fase B como «correcto por construcción: cualquier
fallo de negocio se lee como `classic`, y por eso no hace falta conocer el código exacto». Sigue
siendo cierto **para decidir la superficie**, y sigue siendo la razón de que B se pudiera construir
sin la sonda.

Lo que no era cierto es lo que se dedujo de ahí: que por tanto la causa del rechazo daba igual. Da
igual para *elegir ruta* y no da igual para *diagnosticar*. Un algoritmo que acierta la decisión y
tira la explicación produce exactamente lo que se vio: un panel que dice «código 40085» sobre un
problema de lista blanca.

---

## 10. Salida de la sonda — **pendiente**

> Esta sección se rellena pegando la salida de los cuatro comandos de §8. Mientras esté vacía,
> **todas las filas V3 de este documento son DOC**, y las ocho filas HUECO de §2 siguen sin
> estimación. El Paquete A no está cerrado hasta que esta sección tenga contenido.

**Desde la Fase F hay una segunda fuente, y es mejor que la sonda:**

```
npx vitest run --config vitest.fisica.config.ts test/fisica/uta-lecturas.test.ts
```

La sonda manda peticiones firmadas a mano y enseña lo que contesta Bitget — sirve para
descubrir. La prueba física recorre **el código del panel**: el mismo `ClienteBitget`, los mismos
esquemas Zod, la misma detección de modo, el mismo normalizador. Es la diferencia entre «Bitget
responde algo» y «el panel entiende lo que responde», y su volcado final está pensado para
pegarse aquí. No mueve dinero.

Responde de paso el §9.1 (si UTA admite `SUSDT-FUTURES`) y el §4.1 (con qué código rechaza V3 a
una clave Classic).

```
(pendiente — node scripts/sondear-v3.mjs --env DEMO)
```

```
(pendiente — node scripts/sondear-v3.mjs --env UTA)
```

```
(pendiente — node scripts/sondear-v3.mjs --env UTA --v2)
```

```
(pendiente — node scripts/sondear-v3.mjs --env DEMO --v2)
```

---

## 11. Resumen para decidir

1. **La superficie real es de 21 rutas, no de 9.** Siete son de soporte y cuatro son de
   traspasos, un módulo posterior al presupuesto base.
2. **Ocho huecos sin equivalente V3 conocido.** El más caro es `mix/order/detail`: sin él, una
   cuenta UTA no puede tener tri-estado y toda orden cortada queda indeterminada a mano.
3. **El ciclo de vida del Take Profit es el hueco de mayor superficie**: 3 rutas y 2 de las 5
   funciones principales, porque en V3 el TP deja de ser un plan independiente.
4. **La costura no va en `ClienteBitget`** sino en `Mercado`. Ahorra reescribir los ~17 puntos
   de llamada, que es el código que no se debe tocar.
5. **`clientOid` y el firmado ya cumplen V3** — verificado por lectura de código, sin gastar
   una petición. Dos puntos del checklist cerrados.
6. **El fallback cruzado no se puede implementar todavía**: falta el código de «superficie
   equivocada», y hasta tenerlo cualquier implementación sería una suposición sobre dinero real.
7. **La pregunta abierta más cara es si UTA tiene mercado de práctica.** Si no lo tiene, el
   Paquete F cambia de naturaleza.

Los siete puntos se resuelven con la sonda salvo el 3 y el 4, que son diseño. **Siguiente paso
concreto: rellenar `BITGET_UTA_*` en `.env` y correr los cuatro comandos de §8.**
