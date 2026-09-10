# Fase 3 — Traspaso entre subcuentas

**Panel de Control Bitget (PCB)** · Fecha: 3 de septiembre de 2026
Presupuesto de referencia: [`presupuesto-traspaso-subcuentas.md`](presupuesto-traspaso-subcuentas.md), Fase 3, 2 días, $900 MXN

> Cubre lo contratado: *"ejecución del traspaso de USDT de una subcuenta a otra de
> la misma cuenta principal en el monedero de futuros, con confirmación previa que
> muestra origen, destino, importe y saldos resultantes, y registro del movimiento
> con fecha, importe y resultado"*. Continúa [`00-traspasos-fase-2.md`](00-traspasos-fase-2.md).

---

## 1. Aviso, antes de nada

**Esta función mueve dinero, y desde el 05/09/2026 está probada contra Bitget.**
Hasta esa fecha no se había podido ejercitar ni una vez, porque la clave de la
cuenta madre no tenía permiso de traspaso; todo estaba probado solo contra el
exchange simulado.

La prueba física del guion de abajo (§6) se hizo con el importe mínimo entre dos
cuentas propias, ida y vuelta, y está recogida en
[`00-traspasos-fase-4.md` §8](00-traspasos-fase-4.md). Vive en
[`test/fisica/traspaso-real.test.ts`](../test/fisica/traspaso-real.test.ts) y se
puede repetir cuando haga falta; no entra en `npm run test:fisica` por accidente.

## 2. Lo que se construyó

| Pieza | Dónde |
|---|---|
| Endpoint de traspaso | [`endpoints/subcuentas.ts`](../src/main/bitget/rest/endpoints/subcuentas.ts) · `POST /api/v2/spot/wallet/subaccount-transfer` |
| Cálculo y validación previa | [`domain/plan-traspaso.ts`](../src/main/domain/plan-traspaso.ts) |
| Registro en disco | [`storage/registro-traspasos.ts`](../src/main/storage/registro-traspasos.ts) · `traspasos/movimientos.jsonl` |
| Planificar y ejecutar | [`ipc/sesion.ts`](../src/main/ipc/sesion.ts) · `planificarTraspaso`, `ejecutarTraspaso` |
| Canales de IPC | `traspaso:planificar` · `traspaso:ejecutar` · `traspaso:historial` |
| Confirmación | [`DialogoTraspaso.tsx`](../src/renderer/src/features/panel/DialogoTraspaso.tsx) |
| Formulario e historial | [`PantallaSaldos.tsx`](../src/renderer/src/features/panel/PantallaSaldos.tsx) |

## 3. Las cuatro decisiones que protegen el dinero

**En dos pasos, como las seis operaciones.** `planificar` calcula y **no envía
nada**: relee los saldos, comprueba el importe contra el máximo transferible y
devuelve cómo quedan las dos subcuentas. Cancelar no cuesta nada. `ejecutar` envía
lo ya aprobado identificándolo por su `id` — la pantalla no manda importes ni UIDs
al ejecutar, de modo que no puede enviarse algo distinto de lo aprobado.

**El intento se escribe en disco ANTES de salir a la red.** Es lo que convierte
«¿llegó a salir ese dinero?» en una pregunta con respuesta. Si el proceso muere
entre el envío y la respuesta, queda un `intento` sin su `resuelta` y el movimiento
aparece como **SIN CONFIRMAR** en vez de desaparecer. Si esa escritura falla, no se
envía: mover dinero sin dejar rastro es peor que no moverlo.

**Nunca se reenvía solo.** Un traspaso sin respuesta no se reintenta jamás de forma
automática, ni siquiera ante un 5xx. La respuesta correcta a «no sé si salió» es
mirar el saldo, no repetir el movimiento. El `clientOid` —derivado del id del plan,
no aleatorio— protege además del duplicado en el propio exchange si alguien
reenviara a mano.

**Contraseña de paso**, la misma que la apertura de posiciones. Un plan se envía
una sola vez: se retira antes de la petición, así que una segunda pulsación
encuentra el plan ausente en lugar de intentarlo otra vez.

## 4. Validaciones que evitan un rechazo de Bitget

Se comprueban antes de enviar, para que el error más común sea un aviso en
castellano y no una petición gastada: importe mayor que cero y numérico (`NaN` e
`Infinity` incluidos), origen distinto del destino, ambas subcuentas reportadas por
esa cuenta principal, origen con datos, y —la que importa— **importe ≤ máximo
transferible**.

Lo que no se hace es estimar ese máximo: lo da Bitget (`maxTransferOut`) y aquí solo
se compara contra él. Una estimación propia acabaría autorizando lo que el exchange
rechaza, que es justo lo que esta validación evita.

Los saldos se releen **en cada planificación**. El máximo transferible cambia en
cuanto se abre o se cierra una posición, y validar contra una copia de hace un
minuto autorizaría lo que ya no se admite.

## 5. Cómo comprobarlo

```bash
npm run typecheck && npm run lint    # sin errores ni avisos
npm test                             # 673 pruebas, 42 archivos
npm run test:e2e                     # 15 sobre la aplicación compilada
```

Pruebas nuevas de esta fase: 18 unitarias del plan
([`plan-traspaso.test.ts`](../test/unit/plan-traspaso.test.ts)), 9 del registro
([`registro-traspasos.test.ts`](../test/unit/registro-traspasos.test.ts)), 13 de
integración contra el exchange simulado
([`traspaso.test.ts`](../test/integration/traspaso.test.ts)) y 1 e2e de que el
canal respeta el bloqueo del panel.

**A mano, en la demostración:** `npm run dev:demo` → desbloquear → **Saldos** →
alta de la cuenta principal → formulario al pie de la tabla → *Revisar traspaso* →
confirmación con contraseña de paso `bg1`. Un importe acabado en `.77` se rechaza a
propósito, para poder ver el camino del fallo.

## 6. Prueba física pendiente, y qué hace falta para hacerla

En cuanto exista la credencial, la prueba es corta y hay que hacerla **en este
orden**:

1. `node scripts/ver-permisos.mjs --env MADRE` — confirmar que aparece el código de traspaso, y catalogarlo en `CATALOGO_PERMISOS` de `verificacion.ts`.
2. Leer saldos en el panel con esa credencial: tienen que salir las subcuentas reales.
3. Traspasar **el mínimo** entre dos subcuentas propias, y comprobarlo en Bitget.
4. Capturar la respuesta real y **apretar el esquema** de `subcuentas.ts`: los campos hoy `nullish` salen de la documentación, no de una respuesta observada.

## 7. Para Daniel

Los dos primeros puntos **quedaron resueltos el 05/09/2026** y con ellos se hizo
la prueba física:

1. ~~API Key de la cuenta principal con permiso de traspaso.~~ Concedido.
2. ~~IP del equipo en la lista blanca de esa clave.~~ Concedida: los endpoints de subcuentas, que el 03/09/2026 devolvían `40018 · Invalid IP`, responden desde este equipo.
3. Sigue abierta desde la Fase 1: confirmación por escrito de la ampliación de política del 29/08 ([§4](presupuesto-traspaso-subcuentas.md)).

**Y una que se abre ahora.** Al conceder el traspaso, la clave pasó de declarar
`[coow, cpow, chow]` a declarar `[coow, wtow, cpow, chow, stow]`. Los dos códigos
nuevos —`wtow` y `stow`— no están catalogados, y **Bitget no publica qué
significa cada uno**. Uno de los dos es el traspaso, porque el traspaso ya
funciona; del otro no se sabe nada. Conviene abrir la pantalla de la API Key en
Bitget y confirmar qué casillas quedaron marcadas, en particular que **«Retirar»
esté apagada**: el presupuesto dice que el sistema no usará permisos de retiro, y
esa promesa se sostiene mejor si la clave tampoco los tiene.

Queda la **Fase 4** —reparto y recogida masiva—, que no necesita mecanismo nuevo:
cada reparto es una lista de estos mismos traspasos, con su propio `clientOid`,
pasando por la cola de ejecución que ya reparte lotes de órdenes.

## 8. Corrección posterior: el envío del que no se sabe nada

**Añadido el 4 de septiembre de 2026**, a raíz de una revisión externa del diseño.

La entrega original tenía un defecto en la clasificación de errores: el `catch`
del envío anotaba `fallo` ante **cualquier** excepción, incluida la clase
`indeterminada` que [`errors.ts`](../src/main/bitget/errors.ts) define como
*«se envió y no hubo respuesta. NUNCA se reintenta: se consulta»*.

**Por qué era grave, y no cosmético.** Si al operador se le dice «fallo», lo
natural es repetir. Y repetir aquí significa planificar de nuevo, lo que genera un
`clientOid` **nuevo**: la protección contra duplicados del envío original deja de
aplicar y el mismo dinero se mueve dos veces. El estado `pendiente` del registro
existía desde el primer día para este caso, pero el camino de ejecución no lo
producía nunca.

**Cómo queda.** Ante un indeterminado se consulta a Bitget por el `clientOid`
(`GET /api/v2/spot/account/sub-main-trans-record`, que lo acepta como filtro), y
se respeta una asimetría que conviene tener escrita:

> **Encontrar el registro demuestra que entró. No encontrarlo no demuestra nada.**

Bitget puede tardar en registrarlo, y la consulta puede fallar por su cuenta. Por
eso el caso sin respuesta clara **no se cierra**: se queda como `pendiente`, sin
línea de resuelta, y la pantalla lo dice con esas palabras —«sin confirmar»,
en color de aviso y no de error, desaconsejando repetirlo—.

En el reparto masivo los sin confirmar **se cuentan aparte de los fallidos**: un
lote «18 enviados · 2 sin confirmar» pide comprobar dos saldos; llamarlos fallidos
invitaría a reenviarlos.

Cubierto por [`traspaso-indeterminado.test.ts`](../test/integration/traspaso-indeterminado.test.ts),
que fuerza el timeout contra el exchange simulado y comprueba los cuatro caminos:
la consulta lo encuentra, no lo encuentra, la consulta también falla, y un rechazo
de verdad sigue siendo un fallo.

*La ruta del endpoint se verificó contra el SDK `bitget-api@3.2.1` de
`node_modules`, el mismo oráculo que usa la firma HMAC. La revisión que originó
esta corrección la nombraba como `/api/v2/spot/account/subAccount-transferRecords`,
que no existe.*
