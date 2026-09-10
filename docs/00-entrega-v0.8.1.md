# Entrega v0.8.1 — El traspaso, ya probado con dinero real

**Panel de Control Bitget (PCB)** · 5 de septiembre de 2026
Binario: `PCB-0.8.1-REAL-portable.exe` · **Mercado real**

> Continúa la [v0.7.0](00-entrega-v0.7.0.md). Nada de lo que el panel ya hacía cambia de
> sitio: esto corrige dos cosas que fallaban, cierra la prueba que quedaba pendiente y
> añade lo que se pidió durante las pruebas del día 5.

---

## 1. Lo primero: el traspaso ya movió dinero de verdad

La v0.7.0 se entregó con un aviso en la primera página: *«ningún traspaso ha movido dinero
real todavía»*. No se podía, porque la API Key de la cuenta principal no tenía permiso de
traspaso ni la IP de este equipo estaba en su lista blanca.

Concedidos los dos, la prueba se hizo el 5 de septiembre:

| Paso | Resultado |
|---|---|
| La clave responde y reporta sus 20 subcuentas | ✔ |
| Cuenta principal → subcuenta, 0,5 USDT | ✔ `transferId 1480333282735431680` |
| El saldo de la subcuenta pasa a 0,5 | ✔ |
| Vuelta a la cuenta principal | ✔ `transferId 1480333285583388672` |
| La subcuenta queda a 0 y la principal con lo que tenía | ✔ |

La prueba recorre **el plan del panel**, no el endpoint pelado: comprueba que el panel hace
bien el traspaso, no solo que Bitget contesta. Y cubre las dos direcciones, que son las
mismas que usan el reparto y la recogida, así que la Fase 4 queda cubierta por ella.

Queda guardada y se puede repetir cuando haga falta. No se ejecuta sola con el resto de las
pruebas: hay que nombrarla, porque mueve dinero.

## 2. Dos correcciones que afectan al dinero

### El apalancamiento no se aplicaba en cuentas de margen cruzado

**Es el más serio de los dos.** Al ajustar el apalancamiento, el panel indicaba además el
lado (largo o corto). Eso solo tiene sentido en **margen aislado**, donde Bitget guarda un
apalancamiento por lado. En **cruzado** hay uno solo: la petición se aceptaba —sin error, con
código de éxito— y la cuenta se quedaba como estaba. El informe del lote decía «correcto ·
150x» sobre una cuenta que seguía a 10x.

Es lo que se vio con la segunda cuenta principal: la A quedaba a 150x y la B seguía a 10x,
sin ningún error a la vista. Y encaja con lo que se lee de Bitget: una cuenta puede tener
150x en aislado y 10x en cruzado a la vez, y lo que se aplica es el del modo en el que
esté.

Ahora el panel manda el lado **solo en aislado**, y —esto es lo que de verdad lo cierra—
**comprueba cómo quedó la cuenta antes de dar la casilla por buena**. Si Bitget acepta la
petición y el apalancamiento no ha cambiado, la casilla **falla** y lo dice con el número
que tiene de verdad:

> Bitget aceptó la petición pero BTCUSDT sigue a 10x en esta cuenta, no a 150x. No se abrió
> nada.

Un «correcto» que no cambió nada es peor que un fallo: manda a abrir posiciones con un
apalancamiento que no es el aprobado.

### Un punto suelto en un campo tumbaba la apertura entera

Escribir el separador decimal y borrar la cifra deja un `.` en el campo. Eso llegaba hasta
el cálculo y lo reventaba con un error técnico en inglés, sin abrir nada pero también sin
decir qué campo estaba mal. Ahora el panel lo dice antes de salir a Bitget, nombrando el
campo, y cubre los tres de la apertura: **Margen inicial**, **Margen adicional** y **Take
Profit %**.

Con una precisión que importa: un **margen adicional ilegible no se toma por cero**. Abrir
sin el colchón que usted escribió y aprobó sería peor que no abrir.

## 3. Lo que se añadió durante las pruebas del día 5

**Traspasar desde y hacia la cuenta principal.** Antes los dos desplegables solo ofrecían
subcuentas, así que meter dinero en una concreta solo se podía hacer por el reparto masivo.
Ahora la cuenta principal es una punta más, en los dos sentidos.

**El saldo de la cuenta principal se ve.** Era la única línea sin cifra —la que tiene el
dinero parecía la que no tiene información—, porque Bitget le reporta a la principal el
saldo de sus subcuentas y nunca el suyo. Se lee aparte, con su propia credencial. Aparece
en los desplegables, en la confirmación y debajo de la tabla, separada del TOTAL y
diciéndolo: no es una subcuenta y no entra en esa suma.

**Las cuentas se identifican por su UID.** El nombre lo escribe usted al dar de alta y
puede no parecerse al que esa misma cuenta tiene en otra pantalla. El UID no cambia.

**Aviso de resultado del traspaso, en un diálogo.** Salía en una banda sobre la tabla,
mientras la vista está en el formulario de abajo y la pantalla se recarga; un rechazo se
podía quedar sin leer. Ahora hay que cerrarlo, y distingue **tres** desenlaces:

| | Qué significa | Qué hacer |
|---|---|---|
| **Completado** (verde) | El dinero se movió | Nada. Queda en Movimientos con su referencia |
| **Rechazado** (rojo) | Bitget lo rechazó y dijo por qué | Corregir y repetir |
| **Sin confirmar** (ámbar) | Se envió y Bitget no contestó | **Mirar el saldo antes de repetir** |

**Las API keys ya no se quedan atrás al cambiar de versión.** Es lo que pasó el día 5 y la
conclusión fue la peor posible: *«no se pasaron las API keys»*. No se habían perdido —el
panel es portable y las guarda cifradas en la carpeta `datos-staging` que hay **junto al
`.exe`**—; lo que se perdió fue saber dónde estaban, porque la versión nueva se abrió desde
otra carpeta.

Ahora, cuando el panel arranca **sin credenciales**, la pantalla de desbloqueo lo dice y
ofrece un botón: *«Ya tengo credenciales: importarlas»*. Se señala la carpeta de la
instalación anterior y las copia.

Con tres reglas que conviene conocer:

1. **Nunca sobrescribe un almacén existente.** Si el panel ya tiene credenciales, se
   rechaza sin tocar nada. Por eso el botón solo aparece en el primer arranque.
2. **Copia, no mueve.** La carpeta anterior queda intacta: si algo sale mal, el panel viejo
   sigue funcionando igual.
3. **La contraseña no cambia.** El archivo viaja cifrado tal cual, así que se desbloquea con
   la contraseña maestra que usaba en esa instalación. Sin ella no hay forma de abrirlo, ni
   para usted ni para nadie.

**Las API keys, por bloques.** La lista salía en el orden en que se guardaron, así que una
subcuenta de la B quedaba entre dos de la A. Ahora va una cuenta principal por bloque —A,
B, C…—, ordenada por casilla dentro de cada una, y **cada bloque se pliega**: con las quince
llenas son 300 filas seguidas.

**Reparto y recogida dicen de dónde sale el dinero y a dónde va.** Las dos operaciones
estaban en la misma fila y el botón de recoger parecía usar el importe de al lado —no lo
usa: se lleva todo lo que pueda salir—. Ahora van separadas, cada una con su dirección
delante, y el botón apagado dice por qué lo está.

## 4. Estado honesto de la entrega

**Probado contra la API real de Bitget**, el 5 de septiembre: los permisos de la clave, la
lectura de saldos de la cuenta principal y de sus 20 subcuentas, y el traspaso en las dos
direcciones con el importe mínimo.

**El apalancamiento en margen aislado —el modo que usted opera— está verificado contra la
API real**, el 5 de septiembre, en los dos mercados:

| Dónde | Qué se comprobó |
|---|---|
| Mercado simulado (SBTCSUSDT) | Recorrido completo: leer, rechazar fuera de rango sin gastar peticiones, fijar 20x, releer 20x, repetir, restaurar 10x |
| **Mercado real (BTCUSDT)** | La cuenta está en `isolated` · `hedge_mode` · **150x**, y Bitget confirma el valor en la propia respuesta |

Eso último es lo que hace que el arreglo no cueste nada: `set-leverage` devuelve el modo y
el apalancamiento que dejó puesto, así que el panel confirma con esa misma respuesta.
**Una petición por casilla, igual que antes.** Un lote de trescientas casillas sigue siendo
trescientas peticiones.

**Lo que no se ha probado con dinero real:**

1. **El reparto y la recogida masivos.** El mecanismo es el mismo traspaso que sí se probó,
   repetido; pero el lote entero no se ha ejercitado contra Bitget.
2. **El apalancamiento en cuentas de margen cruzado.** Queda cubierto solo por pruebas
   automáticas. No es una carencia de esta entrega: usted opera en aislado, y el soporte de
   cruzado se conserva por si alguna cuenta apareciera configurada así —en ese caso el panel
   ya no daría por bueno un cambio que no se aplicó, que era el fallo—.

**Para traspasar en sus cuentas de operación.** La prueba se hizo con la cuenta principal
de desarrollo. Sus cuentas **A · ALEJANDRA T. LUNA** y **B · MONICA MONTERO** necesitan lo
mismo en sus propias claves: **permiso de traspaso** y **la IP de este equipo en su lista
blanca**. Sin las dos, Bitget rechaza el movimiento y no es un fallo del panel.

**Sobre los permisos de la clave.** Al conceder el traspaso, la clave pasó a declarar cinco
permisos: Futuros (órdenes y posiciones), Spot, Administrar subcuentas y **Monedero ·
Traspaso**. **No tiene permiso de retiro**, que es lo que el presupuesto promete. Conviene
revisarlo también en las claves de las otras dos cuentas principales cuando las amplíe: el
panel no necesita ni usa el retiro.

**Tres bordes sin terminar**, los mismos de la v0.7.0 y ninguno bloqueante:

1. No hay pantalla para **dar de baja** una cuenta principal. Rotar su clave sí funciona:
   volver a darla de alta la reemplaza.
2. Con **dos o más cuentas principales** registradas en Saldos, la pantalla pide que se
   indique cuál y todavía no hay selector. Con una, no se nota.
3. La lista de traspasos pendientes existe por dentro pero no tiene pantalla propia; se ven
   en el historial, marcados «SIN CONFIRMAR».

## 5. Cómo probar esta versión

0. **Si viene de una versión anterior y el panel arranca vacío:** pulse *«Ya tengo
   credenciales: importarlas»* en la pantalla de desbloqueo y señale la carpeta
   `datos-staging` que está junto al panel antiguo. Luego desbloquee con la contraseña
   maestra de siempre.
1. Abrir el binario y desbloquear con la contraseña maestra.
2. **API keys** → comprobar que las cuentas salen agrupadas por bloque y que los bloques se
   pliegan.
3. **Apalancamiento**, que es la corrección importante: marcar casillas de las dos cuentas
   principales, fijar el valor, y comprobar **en Bitget** que las dos quedaron en él. Si
   alguna no puede, ahora sale en rojo con el número que tiene de verdad.
4. **Saldos** → comprobar que la cuenta principal aparece con su saldo, debajo de la tabla y
   en los dos desplegables.
5. **Un traspaso de la cuenta principal a una subcuenta**, con el importe mínimo. Revisar la
   confirmación, aprobarla y leer el diálogo de resultado.
6. Comprobar el movimiento en Bitget y en **Movimientos** del panel.
7. Solo entonces, un reparto pequeño.

---

**Verificación de esta versión:** 745 pruebas automáticas (46 archivos), 15 de extremo a
extremo sobre la aplicación compilada, más dos pruebas físicas contra Bitget: el traspaso
de saldo y el ajuste de apalancamiento en margen aislado. `typecheck` y `lint` sin un solo
aviso. El binario se comprobó tras empaquetar: se compila como **mercado real** y se
identifica como versión 0.8.1.
