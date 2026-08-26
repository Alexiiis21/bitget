# El modo de margen, y las tres cosas que Daniel encontró

**Panel de Control Bitget (PCB)** · 26 de agosto de 2026
Correcciones sobre las observaciones del 25 de agosto por la noche.

---

## 1. Lo que reportó, en sus palabras

> «El TP ya quedó, pero está en modo cruzado.»
> «Tampoco me deja cambiar el puro TP, me dice que a fuerzas abra una posición.»
> «Lo mismo con el margen adicional, no me deja aumentar solo el margen adicional.»
> «¿O la solución es que pongas el selector de Aislado y cruzado?»
> «Si no se puede agregar el margen adicional, pues no abrir la operación.»

Las cinco son la misma raíz, más una de la pantalla. **La solución que propuso es la
correcta**, y es la que está aplicada.

---

## 2. La raíz: el modo de margen es por símbolo, y el panel lo trataba como si fuera de la cuenta

En Bitget el modo de margen se configura **por contrato**, no por cuenta. Por eso
`/api/v2/mix/account/account` lleva `symbol`, y por eso el 25 de agosto hubo que poner las dos
cuentas en aislado *«en los once símbolos»* y no una sola vez.

El panel lo leía **de un solo símbolo** —el primero del mercado, `BTCUSDT`— al verificar la
credencial, lo guardaba en la ficha de la subcuenta y lo aplicaba a **todos** los activos.

Y ese valor no era decorativo. `marginMode` viaja **dentro** de `place-order`, así que Bitget lo
obedece: abrir no solo respeta el modo, **lo deja configurado en ese activo**.

La cadena completa, con BTC en cruzado y SOL en aislado:

```
1. La verificación lee BTCUSDT      -> ficha: «cruzado»
2. El operador abre SOL             -> la orden sale con marginMode: crossed
3. Bitget obedece                   -> SOL queda en CRUZADO
4. El Take Profit entra igual       -> «el TP ya quedó, pero está en modo cruzado»
5. Agregar margen se descarta       -> «no me deja aumentar solo el margen adicional»
```

El paso 5 es correcto por sí mismo —Bitget solo permite agregar margen en aislado— pero llegaba
por un camino que nadie había pedido: el activo estaba en cruzado porque **el panel lo había
puesto ahí**.

Como Daniel explicó, en cruzado no hay margen por posición que agregar: el exchange lo toma del
saldo total de la cuenta según lo va necesitando. No es un fallo del panel, es cómo funciona el
modo. Lo que sí era fallo es acabar en ese modo sin pedirlo.

---

## 3. Lo que cambia

### 3.1 · Selector **Aislado / Cruzado** en la barra lateral

El modo deja de deducirse y pasa a elegirse. Arranca en **Aislado**, que es el modo en el que
funcionan las seis funciones del panel.

Y no se manda a ciegas. Al planificar, el panel lee el modo real **del activo que se va a
operar** en cada subcuenta, y:

| Situación | Qué hace |
|---|---|
| El activo ya está en el modo elegido | No toca nada. Una peticion menos, y permite ampliar una posición ya abierta |
| Está en el otro modo | Lo fija con `set-margin-mode` **antes** de enviar la orden |
| No se puede fijar (Bitget lo rechaza) | **No envía la orden.** La casilla queda como fallo con el motivo |
| No se puede leer el modo | **No abre.** Descarte `modo-margen-ilegible` |

Los dos últimos son deliberados. De los dos errores posibles —no abrir, o abrir reconfigurando un
activo a espaldas del operador— el inofensivo es no abrir.

La confirmación lo enseña: en el resumen (`AISLADO`) y, en la casilla que vaya a cambiar,
`cruzado → aislado`. Un efecto que no se enseña es un efecto que nadie aprobó.

> **Por qué Bitget puede rechazar el cambio:** no permite cambiar el modo con posiciones u órdenes
> abiertas en ese activo. Es correcto —cambiarlo bajo una posición viva movería su liquidación—.
> Por eso el panel solo lo toca cuando de verdad difiere, y si el rechazo llega con el modo **ya
> correcto** (pasa al reintentar las fallidas), sigue adelante y abre.

### 3.2 · El **margen adicional** sale con la apertura

Igual que el Take Profit desde el 25 de agosto, y por el mismo motivo: se escribe en el mismo
formulario y en la misma pulsación, así que salir «aparte» significaba que el operador aprobaba un
diálogo que lo mencionaba y la posición se quedaba sin él.

Una confirmación hace las tres cosas: abre, coloca el Take Profit y agrega el margen. Cada una con
su propia fila en el informe —`Sub-01`, `Sub-01 · TP`, `Sub-01 · MGA`— porque el informe descarta
los mensajes de los trabajos correctos, y un margen fallido escrito dentro de una apertura
correcta sería invisible.

El Take Profit va primero: si algo se tuerce a mitad, la posición queda al menos protegida.

### 3.3 · Si el margen adicional no se puede agregar, **no se abre nada**

Es la petición literal de Daniel, y tiene razón en el razonamiento: indica que hay un parámetro
mal, y abrir sin el margen aprobado deja la posición con menos colchón del que el operador cree
que tiene.

Con «Margen adicional» escrito y el modo en **Cruzado**, el plan entero se rechaza —no una casilla:
el plan— antes de que salga una sola orden, con el motivo escrito en castellano. La pantalla lo
dice sin gastar siquiera la consulta de precios.

Y se añade una comprobación que faltaba: **el saldo tiene que dar para el margen inicial y el
adicional juntos**. Antes solo se comprobaba el inicial, así que se podían abrir posiciones a las
que después no cabía el margen prometido.

### 3.4 · Los botones de los campos ahora parecen botones

*«Me dice que a fuerzas abra una posición»* tenía una segunda causa, y es de la pantalla.

Aplicar un Take Profit sobre una posición ya abierta siempre se ha podido: el rótulo del campo
**era** el botón. Con aspecto de encabezado de sección. Y uno de los cuatro —*Margen inicial*— no
aplicaba nada al pulsarlo, así que ni siquiera era una regla que se pudiera aprender probando.

Abrir era la única acción que la pantalla presentaba como acción, y eso es lo que Daniel encontró.

Ahora los tres campos que son una operación llevan su distintivo **APLICAR**, *Margen inicial* es
un rótulo con la nota *«sale al abrir»*, y bajo el título de la sección hay una línea que dice qué
hacen: *«actúa sobre las posiciones ya abiertas de las casillas marcadas, sin abrir ninguna»*.

### 3.5 · Se acabó «editar» una posición abierta

Es la consecuencia de todo lo anterior, y la regla que ordena el panel:

> **Todo lo que define una posición se decide antes de abrirla y sale con ella.**
> Después solo se puede quitar el Take Profit o cerrar.

El Take Profit y el margen adicional viajaban con la apertura **y además** tenían su propio botón
para aplicarlos sobre una posición ya abierta. Hacer las dos cosas enviaba lo mismo dos veces —y el
26 de agosto ocurrió: una posición acabó con 2 USDT de margen donde se había escrito 1—.

`set-margin` es la única petición del panel **sin identificador propio**, así que ahí no hay nada
que rechace el repetido: se suma y ya está.

Retirado, y entero. No solo el botón:

| Se va | Qué era |
|---|---|
| Botones *Take Profit %* y *Margen adicional* | Aplicaban sobre posiciones abiertas |
| Botón *Aplicar todo* | Encadenaba los dos anteriores más el apalancamiento |
| Botón *Reintentar margen* del aviso CRÍTICO | Agregaba margen a las posiciones en riesgo |
| Canales `tp:planificar` · `tp:ejecutar` · `margen:planificar` · `margen:ejecutar` | La vía por la que salían |
| `Sesion.planificarTakeProfit` · `planificarMargen` y sus gemelos de ejecución | Lo que había detrás |

Quitar solo el botón no bastaba: mientras el canal exista, un fallo de la pantalla puede llamarlo.

**Lo que no se toca:** *Cerrar*, *Quitar Take Profit* y *Apalancamiento*. Las dos primeras no son
ediciones —una liquida la posición y la otra retira una protección, que es lo que el cliente pidió
el 18 de agosto—. El apalancamiento tampoco: no viaja en ninguna orden, es configuración de la
cuenta que se deja puesta **antes** de operar.

**Lo que esto cuesta**, dicho claro: si una posición queda abierta sin su Take Profit o sin su
margen —porque el envío falló después de abrir—, el panel ya no puede arreglarlo. Hay que
ponérselo en Bitget, o cerrar y volver a abrir. Los mensajes del informe lo dicen así. Es el precio
de que no se pueda enviar dos veces, y es el que se eligió a propósito.

### 3.6 · La contraseña de paso, también al cerrar

Pedida aparte, y el propio panel ya la prometía: al fijar la clave, la pantalla de seguridad decía
que se pediría *«cada vez que se abra **o se cierre** una posición»*. No se cumplía — solo se pedía
al abrir, con el argumento de que es la única acción que compromete dinero nuevo.

El argumento no se sostiene. Cerrar no compromete dinero nuevo, pero **realiza el resultado**:
convierte en definitiva una pérdida que estaba abierta. Y no se deshace pulsando otra vez —un
cierre equivocado no se «reabre», se vuelve a abrir a otro precio, y esa diferencia es el coste del
error—. Sobre cien casillas, un clic de más en *Cerrar* cuesta tanto como uno en *Abrir*.

Las otras cuatro operaciones siguen sin pedirla, a propósito: ajustar el Take Profit, el margen o
el apalancamiento no realiza ningún resultado, y pedir la clave en cada ajuste la convertiría en un
trámite que se teclea sin leer —que es exactamente como se pierde un freno de este tipo—.

### 3.7 · El reintento automático ya no puede duplicar el margen

El otro camino por el que se podía comprometer el doble, y este no lo veía nadie.

`enviarUna` reintenta hasta tres veces los fallos de clase `retryable`. La teoría es que
«transitorio» significa que Bitget **no** lo procesó, así que reenviar es seguro. La práctica es
que esa clase recoge también un **429**, un **`45001`** y un **500**, y ninguno de los tres
garantiza que la petición no llegara a procesarse antes de que la respuesta se perdiera.

Para cuatro de las cinco operaciones da igual: `place-order`, `place-tpsl-order`,
`close-positions` y `cancel-plan` llevan `clientOid` y Bitget rechaza el repetido.
`set-leverage` y `set-margin-mode` son idempotentes por naturaleza —fijar 150x dos veces deja
150x—.

**`set-margin` no es ninguna de las dos cosas.** No acepta `clientOid` y cada llamada suma.

Ahora, antes de **reenviar** —nunca antes del primer envío—, se relee el margen de la posición y
se compara con el que debería haber quedado:

| Lo que se lee | Qué hace |
|---|---|
| El margen ya está aplicado | Da el envío por bueno y **no reenvía** |
| Sigue sin aplicarse | Reenvía, que es lo que el reintento existe para hacer |
| No se puede comprobar | **No reenvía.** Queda `indeterminada`, fuera de «reintentar las fallidas» |

Cuesta una consulta, y solo en el camino del reintento. El comentario del motor decía que nunca
reintentaba a ciegas; era cierto para `indeterminada` y falso para `retryable`. Ahora lo es para
las dos.

### 3.8 · El aviso de apalancamiento, del símbolo correcto

Efecto lateral de la misma raíz: el aviso *«la cuenta está a 20x y la operación se calculó a 10x»*
salía del apalancamiento guardado en la ficha —el del primer símbolo del mercado, otra vez—. Avisaba
de diferencias que no existían en el activo elegido y se callaba las que sí.

Ahora sale de la misma lectura fresca del símbolo que se va a operar, y para el modo con el que se
va a abrir: en cruzado hay un solo apalancamiento para los dos lados, y es ese el que se compara.

---

## 4. Lo que cuesta

Una consulta más por subcuenta y por planificación (`/mix/account/account`). Van por bloques, como
los envíos, así que un lote de cien no encola cien lecturas de golpe.

Es el precio de no volver a abrir a ciegas, y compra además el apalancamiento correcto del símbolo
sin ninguna petición adicional: llega en la misma respuesta.

---

## 5. Cómo se comprueba

```bash
npm run typecheck   # sin errores
npm run lint        # cero avisos
npm test            # 396 pruebas, sin salir a la red
npm run test:e2e    # 10 pruebas sobre la aplicación compilada
```

**Pruebas nuevas** (19 más que el 25 de agosto), todas con el defecto reproducido primero:

`test/integration/motor-apertura.test.ts`
- lee el modo real del símbolo y lo enseña en el plan; planificar no lo cambia
- fija el modo **antes** de la orden, y se comprueba el orden de las dos peticiones
- **no** lo toca cuando ya coincide —lo que permite ampliar una posición abierta—
- si no puede fijarlo, **no envía la orden**
- si el rechazo llega con el modo ya correcto, sigue y abre
- si no puede leer el modo, descarta sin abrir
- margen adicional en cruzado: el plan entero se rechaza y no sale ninguna orden
- el saldo se comprueba contra los dos importes juntos

`test/integration/motor-margen.test.ts`
- si Bitget lo procesó y aun así respondió transitorio, **no se reenvía**: una sola
  petición, no cuatro
- si de verdad no llegó a aplicarse, el reintento sigue haciendo su trabajo
- si no se puede comprobar, queda `indeterminada` y no sale una segunda petición

Las tres se comprobaron **fallando primero**: con la comprobación desactivada, dos de ellas
caen —«expected 'fallo' to be 'indeterminada'»— y con ella pasan.

`test/integration/apertura-con-take-profit.test.ts`
- el margen adicional se agrega tras abrir, con su propia fila en el informe
- si falla con la posición ya abierta, se cuenta como fallo y se dice qué hacer
- Take Profit y margen adicional salen juntos, en una confirmación

`test/renderer/store-plan.test.ts`
- el modo y el margen adicional viajan tal como están en la pantalla
- en cruzado con margen adicional escrito **no se planifica siquiera**
- sin la contraseña de paso, cerrar no envía nada; al tercer intento se cancela
- el apalancamiento sigue sin pedirla
- tras abrir, los tres valores que salieron con la orden se vacían

`test/e2e/arranque.spec.ts`
- **no existe** canal para aplicar Take Profit ni margen por separado, comprobado
  contra el binario ya compilado

Además, `test/fisica/**` entra por fin en `npm run typecheck`. Estaba fuera, y por eso sus
llamadas se quedaron atrás en silencio cuando el contrato del motor cambió.

---

## 6. Lo que sigue necesitando comprobación con Bitget delante

Todo lo anterior está probado contra el exchange simulado del proyecto, que responde como Bitget
pero no **es** Bitget. Falta pasar `npm run test:fisica` contra la cuenta demo, y en particular:

- que `set-margin-mode` responda como se espera cuando el activo tiene posición abierta;
- que abrir en aislado sobre un activo que estaba en cruzado lo deje efectivamente en aislado.

Son los dos puntos donde la documentación de Bitget y su comportamiento real no siempre coinciden
—ya pasó con `posSide` y con `planType`—.
