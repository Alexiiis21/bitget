# Fase 4 · Función 3 de 5 — Take Profit por porcentaje

**Panel de Control Bitget (PCB) v1.0** · 13 de agosto de 2026
Presupuesto de referencia: Fase 4, $10,500 MXN · **tercera de las cinco funciones**, en el
proceso principal.

> *«Take Profit por porcentaje — botones rápidos y valor manual.»*

---

## 1. La pregunta que llevaba abierta desde la Fase 1, resuelta

Desde julio quedaba sin responder qué significa «Take Profit al 35%»: 35% de ganancia sobre lo
invertido, o 35% de movimiento del precio. Con apalancamiento la diferencia es enorme, y por eso
bloqueaba esta función.

**Sus propias capturas lo resolvieron.** De una operación real en PEPEUSDT a 75x:

| | |
|---|---|
| Precio de entrada | 0,0000026184 |
| Take Profit al 35% | **0,0000026306** |
| Ganancia estimada según Bitget | 3,0448 USDT **(34,94%)** |

La fórmula que reproduce ese número al decimal:

```
precio = entrada × (1 + porcentaje / apalancamiento)
0,0000026184 × (1 + 0,35 / 75) = 0,0000026306   ← exactamente lo que muestra Bitget
```

Es decir: **35% de ganancia sobre el margen**, no de movimiento del precio. El precio solo se
mueve un 0,47%; el resto lo pone el apalancamiento. La otra lectura habría puesto el objetivo en
0,0000035348, tan lejos que no saltaría nunca — a 75x la liquidación llega mucho antes.

Su operación está escrita como prueba automática. Si alguien cambia la fórmula en el futuro, lo
que falla nombra su caso real y no un número de laboratorio.

### Y una duda que sus capturas resolvieron de paso

Quedaba por saber si el porcentaje se calcula sobre el margen inicial o sobre el margen ya con lo
adicional. La tercera captura lo contesta: esa posición tenía **1.008,71 USDT** de margen tras
añadirle margen adicional, y Bitget seguía mostrando **ROE −8,32%**, que sale de dividir entre
**8,71** — la posición entre el apalancamiento.

Conclusión práctica: **agregar margen no mueve el Take Profit ni obliga a recalcularlo.** Una
cosa menos que coordinar entre las dos funciones.

---

## 2. Qué se construyó y dónde

| Pieza | Archivo |
|---|---|
| El cálculo del precio | [`domain/precio-take-profit.ts`](../src/main/domain/precio-take-profit.ts) |
| El endpoint | [`rest/endpoints/tpsl.ts`](../src/main/bitget/rest/endpoints/tpsl.ts) |
| Motor | `planificarTakeProfit` / `ejecutarTakeProfit` en [`motor-lotes.ts`](../src/main/execution/motor-lotes.ts) |
| Conexión con el panel | Canales `tp:planificar` y `tp:ejecutar` |

**El panel calcula el precio, no Bitget.** Verificado contra la API el 13 de agosto:
`place-tpsl-order` exige `triggerPrice` y rechaza la petición sin él; enviándole un
`triggerPercent` sigue respondiendo *«The trigger price cannot be empty»*. El porcentaje es una
comodidad de la web de Bitget que no viaja en ninguna petición — el mismo caso que la unidad
Costo-USDT.

### Tres decisiones propias de esta función

**Se lee la posición antes de calcular.** El porcentaje no define un precio por sí solo: hacen
falta el precio de entrada de esa posición y su apalancamiento. Por eso el mismo 35% da un precio
distinto en cada cuenta si entraron a precios distintos, y por eso la confirmación enseña el
precio concreto de cada una.

**El apalancamiento se toma de la posición, no de la cuenta.** Es el que de verdad se aplicó al
abrirla. Si la cuenta cambió de apalancamiento después, el de la cuenta daría un precio que no
corresponde a esa posición.

**El redondeo va hacia el precio de entrada**, nunca en contra. Un objetivo un paso más cerca se
ejecuta con una ganancia despreciablemente menor; uno un paso más lejos puede quedarse sin
saltar. De los dos errores posibles, el inofensivo es cobrar un céntimo menos.

Y como en las dos funciones anteriores: el `clientOid` impide que un reenvío deje dos Take Profit
sobre la misma posición, y lo indeterminado se resuelve **mirando los planes que Bitget tiene
puestos**, que es la verdad de fondo.

---

## 3. Cómo se prueba

```bash
npm test              # 289 pruebas, sin salir a la red
npm run test:fisica   # abre, pone Take Profit y cierra, de verdad
```

Las 24 pruebas nuevas cubren, entre otras cosas: su operación real de PEPE al decimal; que el
mismo porcentaje da precios distintos según el apalancamiento; que en short el objetivo va hacia
abajo; que un porcentaje demasiado pequeño para el paso del activo se rechaza en vez de colocar
un Take Profit que saltaría al instante; 300 posiciones a la vez; y el corte de red con el plan
puesto y sin poner.

---

## 4. Guía de la prueba física

`npm run test:fisica` recorre ahora el ciclo entero del Take Profit, que es lo que hace el
operador cuando cambia de idea a mitad de una operacion:

| Paso | Qué hace |
|---|---|
| 1 | Lee el saldo simulado |
| 2 | Abre una posición |
| 3 | Planifica el Take Profit al 35% y **enseña el precio y cuánto debe moverse el mercado** |
| 4 | Lo coloca |
| 5 | Pregunta a Bitget qué plan quedó puesto y a qué precio |
| 6 | **Lo quita**, enseñando antes cuál va a quitar |
| 7 | Comprueba con Bitget que ya no hay ninguno |
| 8 | Vuelve a pulsar «quitar»: sale como *ya no estaba*, no como fallo |
| 9 | **Lo vuelve a poner con otro porcentaje** (20% en vez de 35%) |
| 10 | Cierra la posición |
| 11 | Comprueba si el Take Profit quedó vivo tras cerrar |

**El paso 11 responde su pregunta pendiente** —si al cerrar hay que cancelar el Take Profit a
mano— con datos en lugar de con suposiciones. Si quedara vivo, el panel tendría que cancelarlo y
eso son peticiones adicionales por cuenta.

**El paso 5 es el único punto que no se pudo verificar de antemano.** El disparador va por último
precio (`fill_price`), como en su pantalla, pero Bitget comprueba que exista la posición antes de
validar ese parámetro, así que no se pudo confirmar sin poder abrir. Queda como comprobación de
la prueba física.

**Estado hoy.** Los pasos 1 y 11 pasan; los intermedios se detienen en el mismo muro de siempre:
`40126 · The current account type is not allowed`. Sigue haciendo falta **una API Key creada
desde Trading Demo de la cuenta principal**. No requiere KYC ni fondos, y desbloquea de golpe la
demostración de las cinco funciones.

---

## 5. Lo que necesito de tu lado

1. **La API Key de Trading Demo.** Es lo único que separa la prueba física de estar completa.
2. **KYC de la cuenta principal**, para operar en producción.
3. La cuenta de pruebas está en **margen cruzado** y usted opera en **aislado**. Para la prueba
   de «agregar margen» habrá que cambiarla: Bitget solo permite añadir margen en aislado.

---

## 6. Qué sigue

Quedan dos funciones: **agregar margen** y **ajuste de apalancamiento**. Las dos reutilizan el
mismo motor y ya no dependen de ninguna respuesta pendiente.

Del apalancamiento hay además una propuesta sobre la mesa: que el campo venga por defecto con el
**máximo del activo**, leído del catálogo de Bitget, ya que usted siempre opera al máximo. Eso
acierta solo en cada activo (BTC 150x, PEPE 75x) y en el mercado simulado usa el tope que
corresponda, sin que usted tenga que acordarse de nada.

---

## 7. Añadido el 18 de agosto: poder quitarlo, y el porcentaje que se quiera

Dos correcciones del cliente, una de ellas sobre un supuesto que estaba mal recogido.

### El 35% no era una regla

En el mensaje del 12 de agosto quedó anotado que «siempre usa el TP en 35%». El cliente lo
corrigió el 18:

> *«Aquí está mal eso de que siempre opero al 35%; si lo dije así, me equivoqué, porque de acuerdo
> al activo o la circunstancia del mercado debo poder usar el TP en el % que yo quiera.»*

**El código ya lo permitía**: el porcentaje siempre fue un parámetro que viaja con cada petición,
no una constante. No había nada que cambiar, y precisamente por eso conviene decirlo: el supuesto
equivocado estaba en la documentación, no en el programa. Lo que sí se ha hecho es quitar el «35%»
de donde figuraba como si fuera una regla, y que la prueba física coloque **dos porcentajes
distintos** en el mismo recorrido, para que se vea.

### Quitar el Take Profit

> *«Debo poder modificarlo, pero incluso debo poderlo quitar si quiero. Ese no va por defecto,
> porque hay escenarios del mercado donde de hecho voy sin Take Profit y hago el cierre manual.»*

Esto sí era una función que no existía. Se construyó el 18 de agosto con la misma arquitectura de
las demás: planificar primero, enseñar, y quitar solo lo aprobado.

| Pieza | Archivo |
|---|---|
| Endpoint | `cancelarPlan` y `buscarTakeProfit` en [`rest/endpoints/tpsl.ts`](../src/main/bitget/rest/endpoints/tpsl.ts) |
| Motor | `planificarQuitarTakeProfit` / `ejecutarQuitarTakeProfit` |
| Conexión con el panel | Canales `tp:planificar-quitar` y `tp:ejecutar-quitar` |
| Pruebas | [`test/integration/motor-quitar-tp.test.ts`](../test/integration/motor-quitar-tp.test.ts), 16 casos |

**Tres decisiones que merecen explicación:**

**Se lee lo que hay puesto, no lo que el panel recuerda haber puesto.** Sería más barato guardar
el identificador de cada Take Profit colocado y cancelar por ahí. Estaría mal: el operador también
los pone y los quita desde la app de Bitget, y esos el panel no los conocería. Quitar «el que yo
puse» dejaría puesto justo el que el operador está viendo en pantalla cuando pide quitarlo. Así
que la verdad es la lista de planes de Bitget, y de paso la confirmación puede enseñar el precio
al que estaba puesto cada uno.

**Un Stop Loss no se puede confundir con un Take Profit.** Bitget los devuelve mezclados en la
misma lista. Quitar el Stop Loss creyendo que se quita el Take Profit dejaría la posición sin su
única protección, así que el filtro es explícito y hay una prueba dedicada a ello.

**`00000 success` aquí no significa nada.** Verificado contra la API el 18 de agosto: cancelar un
plan que ya no existe responde éxito con las dos listas vacías. Darlo por bueno diría «quitado»
sin haber quitado nada, que es la peor respuesta posible cuando lo que está en juego es si esa
posición tiene o no protección. El panel distingue los tres casos: quitado, rechazado por Bitget
—con su motivo—, y *ya no estaba*.

### Un hallazgo que obligó a poner un freno

Probando el endpoint apareció esto: si la petición se envía **sin la lista de identificadores**,
Bitget la acepta igual y **cancela todos los Take Profit del símbolo**, devolviendo éxito. Un
descuido que dejara esa lista vacía habría quitado la protección de posiciones que el operador no
había seleccionado, sin ningún error visible.

Por eso el identificador es obligatorio en la firma de la función, siempre viaja exactamente uno,
y hay una prueba que revisa **cada petición enviada** para comprobarlo. El modo «cancelar todo» de
Bitget no se puede alcanzar desde el panel ni por accidente.

### El cierre rápido, que también preguntó

> *«El cierre manual me refiero a cierre rápido, ese no sé si ya lo programaste.»*

Está programado desde la función 2, y es exactamente ese. El panel no calcula una cantidad ni manda
un precio: usa el endpoint de cierre relámpago de Bitget, que cierra la posición entera a mercado.
Se eligió así porque enviar una cantidad calculada instantes antes puede dejar un resto abierto si
la posición cambió; decirle a Bitget «cierra lo que haya» no puede.
