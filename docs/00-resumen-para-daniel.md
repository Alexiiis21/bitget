# Resumen de lo construido — para su confirmación

**Panel de Control Bitget (PCB)** · 18 de agosto de 2026 · segunda versión, con sus correcciones

## 1. Lo que usted nos dijo, y cómo quedó

| Lo que usted dijo | Cómo quedó en el panel | ¿Correcto? |
|---|---|---|
| «El apalancamiento se fija una sola vez y ya queda fijo» | La apertura **no lo cambia**. Se fija aparte, cuando usted quiera | ☐ |
| «Uso el más alto: en Bitcoin 150x, en PEPE 75x» | El panel lee el máximo de cada activo del propio Bitget. Propuesta: que el campo venga ya con ese máximo | ☐ |
| «En la demo Bitcoin solo deja 125x» | Cierto, y no es solo Bitcoin: en la demo ETH baja a 100x. El panel usa el tope que corresponda a cada mercado, sin que usted haga nada | ☐ |
| «El margen inicial es por casilla» | Cada casilla long y cada casilla short son objetivos independientes. Marcar las dos de una subcuenta con 100 USDT compromete 200 | ☐ |
| «El margen adicional también es por casilla» | Igual, y además el panel comprueba que el saldo dé para todas las casillas marcadas de esa subcuenta, no solo para una | ☐ |
| «La unidad debe quedar fija en Costo-USDT» | Fija y no configurable. Usted escribe el margen; el panel calcula la cantidad y la envía | ☐ |
| **«El Take Profit debo poder usarlo en el % que yo quiera»** | **Corregido.** El porcentaje es un campo que usted escribe en cada operación; no hay ningún valor grabado ni obligatorio. El panel calcula el precio exacto de cada posición, y su ejemplo de PEPE lo reproduce **al decimal** | ☐ |
| **«Debo poder quitarlo: hay escenarios donde voy sin Take Profit»** | **Construido el 18 de agosto.** Quitar el Take Profit es ahora una acción más del panel, sobre las cuentas que se marquen | ☐ |
| **«El cierre rápido es el que yo uso, ¿está programado?»** | **Sí, y es justo ese.** El cierre del panel *es* el cierre rápido de Bitget | ☐ |
| «Siempre opero en modo aislado, jamás en cruzado» | El panel respeta el modo de cada subcuenta y avisa si alguna está en cruzado | ☐ |
| «Si falla algo, el margen es lo más crítico» | En cada operación, lo primero que se comprueba y lo primero que se informa es el margen | ☐ |
| **«Yo no opero XRP, solo los 5 activos del panel»** | Correcto: los cinco son BTC, ETH, SOL, PEPE y PAXG. XRP no está y no se va a operar | ☐ |

---

## 2. Las tres cosas que no quedaron claras

### «El panel le enseña qué va a pasar» — qué significa

Es un paso intermedio, antes de que salga ninguna orden:

1. Usted marca las cuentas, elige el activo y escribe cuánto quiere poner.
2. Pulsa el botón. **Todavía no se envía nada.**
3. El panel sale a Bitget, mira el precio de ese momento y el saldo de cada subcuenta, y devuelve
   una lista concreta: qué cantidad exacta se va a comprar en cada cuenta, y qué cuentas se quedan
   fuera y por qué.
4. Usted lo lee. Si está bien, confirma y **ahí** salen las órdenes. Si no, cancela y no ha pasado
   nada.

Es la diferencia entre pulsar a ciegas y ver la factura antes de pagar. Y las cuentas que se
quedan fuera aparecen con su nombre, así que nunca hay una subcuenta cuyo estado haya que
adivinar.

### «Reintentar solo las que fallaron» — la pregunta y la respuesta

La pregunta era si, cuando una operación falla en unas cuentas y sale bien en otras, se puede
volver a intentar **solo en las fallidas** sin duplicar las que ya se hicieron.

**Sí.** Ejemplo: se abre en 34 cuentas, salen 31 y fallan 3 porque en ese momento se cortó
internet. El panel muestra las 3 con su nombre. Se pulsa «reintentar» y se envían **solo esas 3**.
Las 31 que ya entraron ni se tocan.

Y aunque se tocaran, no pasaría nada: cada orden lleva una etiqueta única que Bitget reconoce, así
que la segunda vez la rechaza. **No se puede abrir dos veces la misma posición**, ni pulsando dos
veces, ni reintentando, ni por un fallo del programa.

### «El cierre rápido, ¿está programado?»

Sí, y es exactamente ese. Cuando el panel cierra no calcula una cantidad ni manda un precio: le
dice a Bitget «cierra lo que haya en esta posición, a mercado, ahora». Es la misma función del
botón de cierre rápido de la app.

Se hizo así a propósito. Si el panel mandara una cantidad calculada un minuto antes y la posición
hubiera cambiado, el cierre saldría incompleto y dejaría un resto abierto sin que nadie lo supiera.
Diciéndole a Bitget «cierra lo que haya», eso no puede ocurrir.

---

## 3. Las cuentas que salen de su propia pantalla

Para que vea que no son suposiciones. De la captura que nos envió, PEPE a 75x:

```
su precio de entrada        0,0000026184
su Take Profit al 35%       0,0000026306
ganancia que muestra Bitget 3,0448 USDT (34,94%)
```

El panel calcula ese mismo 0,0000026306. La cuenta es: el precio solo se mueve un 0,47%, y el
apalancamiento de 75 multiplica esa ganancia hasta el 35%. Con cualquier otro porcentaje que se
escriba, la cuenta es la misma.

Y de la misma captura salió otra cosa útil: esa posición tenía **1.008 USDT de margen** después
de que se le agregara margen, y Bitget seguía calculando el porcentaje sobre **8,71**. Es
decir: **agregar margen no le mueve el Take Profit**. No hay que rehacerlo.

---

## 4. Qué hace el panel hoy

**Seis funciones construidas**: abrir, cerrar (rápido), poner Take Profit, **quitar Take Profit**,
agregar margen y ajustar apalancamiento. Todas funcionan igual y sobre las cuentas que se marquen
—una, varias o todas.

Lo que las seis tienen en común, y que conviene que sepa porque es donde está el trabajo:

**Antes de enviar nada, el panel enseña qué va a pasar.** No se aprueba «abrir 100 USDT a 150x»,
se aprueba «0,0157 BTC en estas 34 cuentas, y estas 3 no pueden porque les falta saldo». Los
precios y las cantidades que se ven son los de verdad.

**Si el problema es de la operación, no sale ni una orden.** Un activo mal escrito o un
apalancamiento fuera de rango detienen todo antes de empezar. Si el problema es de una cuenta
concreta —sin saldo, sin posición— esa se queda fuera y las demás siguen.

**Lo que sale bien nunca se deshace.** Si entra en 31 cuentas y falla en 3, las 31 quedan hechas
y se ve exactamente cuáles fallaron y por qué, con el nombre de cada subcuenta.

**No puede duplicar una posición.** Cada orden lleva un identificador propio; si se pulsan dos
veces o reintenta las fallidas, Bitget reconoce el repetido y no abre una segunda. Y si se corta
internet justo al enviar, el panel **no reintenta a ciegas**: le pregunta a Bitget qué pasó de
verdad.

**No satura la API.** Las órdenes salen por tandas y a un ritmo que Bitget acepta, así que operar
sobre cien cuentas no provoca bloqueos.

---

## 5. Lo único pendiente de su parte

1. La **API Key de Trading Demo** de la cuenta principal, para poder demostrar físicamente las
   operaciones. No pide KYC ni fondos.
2. Que la cuenta de pruebas quede en **modo aislado**; hoy está en cruzado, y Bitget no permite
   agregar margen en cruzado.
3. Confirmar la propuesta del **apalancamiento por defecto al máximo del activo**: se elige BTC y
   el campo sale 150x; se elige PEPE y sale 75x. Es un valor de partida, siempre modificable.

Un aviso sobre la demo de Bitget: su mercado de pruebas solo tiene tres activos —Bitcoin, Ethereum
y XRP—, así que la demostración física se hará sobre Bitcoin. No afecta al panel, que lee el
catálogo de cada mercado; es solo lo que Bitget ofrece para practicar.

---

## 6. ¿Está todo conforme?

Si algo de la tabla de la sección 1 no es como usted opera, dígalo ahora: cambiarlo hoy cuesta una
tarde, y cuando esté la pantalla montada encima cuesta bastante más.

Observaciones:

_______________________________________________________________________________

_______________________________________________________________________________

_______________________________________________________________________________
