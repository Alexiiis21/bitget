# Aceptación de las Fases 3 y 4 — Guion de pruebas físicas

**Panel de Control Bitget (PCB) v0.4.0**
Fecha de la demostración: 25 de agosto de 2026 · Presupuesto de referencia: Fase 3 ($3,000 MXN)
y Fase 4 ($10,500 MXN)

> Este documento se usa **delante de la pantalla**. Cada casilla se marca en el momento.
> Lo que no se pueda marcar, no está entregado.

---

## 1. Qué se aprueba hoy

| Fase | Concepto contratado | Estado |
|---|---|---|
| 3 | Alta y baja de cuentas, estado de conexión, selección múltiple | Entregado |
| 4 | Apertura de operaciones | Entregado y **enviando órdenes reales** |
| 4 | Cierre de operaciones | Entregado y enviando |
| 4 | Take Profit por porcentaje | Entregado y enviando |
| 4 | Quitar Take Profit *(añadido el 18/08)* | Entregado y enviando |
| 4 | Agregar margen | Entregado y enviando |
| 4 | Ajuste de apalancamiento | Entregado y enviando |

**Lo nuevo respecto a la última demostración:** hasta hoy la Fase 4 estaba construida y probada,
pero Bitget **rechazaba el envío de órdenes** y ninguna de las seis funciones se había podido
demostrar de extremo a extremo. Eso quedó resuelto. Es la primera vez que las seis se ejecutan
contra Bitget de verdad.

---

## 2. Antes de empezar

```bash
npm run dev            # Bitget real, MERCADO REAL: las órdenes mueven dinero
npm run dev:staging    # Bitget real, mercado simulado
npm run dev:demo       # datos de demostración, sin salir a la red
```

Tres avisos que evitan confundir un dato correcto con un fallo:

**Las tres suites de red se pueden encadenar** —comprobado hoy: la batería entera seguida, 369 +
10 + 14 + 14 + 43, en verde—. Hasta esta mañana no: `test:red` lanzaba sus tres archivos **en
paralelo** y se quitaba a sí mismo el cupo de peticiones de la IP, con lo que Bitget respondía
*«está limitando las peticiones»* y la suite fallaba por el cupo y no por el panel. Ahora va en
serie, como ya iba `test:staging`.

> Si aun así una suite de red se pone en rojo con ese mensaje, es el cupo de la IP y no el panel:
> se vuelve a lanzar esa suite sola. El cupo lo impone Bitget y se comparte con cualquier otra
> cosa que esté hablando con la API desde este equipo.

**El saldo de la cuenta con dinero real es de 2,96 USDT.** Alcanza para posiciones del tamaño
mínimo —Bitget exige 5 USDT de nocional, que a 100x son 0,05 USDT de margen— pero no para una
demostración sobre muchas casillas. La cuenta simulada tiene 2 970 SUSDT.

**Las dos cuentas están en margen aislado**, en los once símbolos que opera el panel. Se cambió
hoy: estaban en cruzado, y en cruzado Bitget no admite «agregar margen».

---

## 3. Guion de validación

### A · Alta y baja de cuentas — Fase 3 · `npm run dev:staging`

- [ ] **A1.** El panel arranca **bloqueado**. Sin contraseña maestra no hay credenciales.
- [ ] **A2.** Escribir la contraseña maestra. La primera vez, crea el almacén cifrado.
- [ ] **A3.** *API keys* → rellenar con una credencial **incorrecta** a propósito (cambiar un
      carácter de la Secret Key) → **Guardar y validar**. *Debe verse:* aviso rojo con el motivo
      en español, y **la fila no aparece**.
- [ ] **A4.** Repetir con la credencial buena. *Debe verse:* la clave **enmascarada**
      (`bg••••8b3f`), el distintivo verde *conectada*, y arriba `1 de 1 conectadas`.
- [ ] **A5.** Pulsar **Probar**. Vuelve a preguntar a Bitget y confirma en el momento.
- [ ] **A6.** Registrar **la misma subcuenta otra vez** con otra API Key. *Debe verse:* **no se
      duplica la fila** — es rotar la clave, no una cuenta nueva.
- [ ] **A7.** Pulsar **Eliminar**. *Debe verse:* una confirmación que pide la **contraseña de
      paso** —la misma de abrir y cerrar—. Con una clave equivocada **no se borra nada** y
      quedan dos intentos; al tercero la baja se cancela. Con la correcta, la fila desaparece y
      su credencial se borra del almacén.
- [ ] **A8.** Volver a registrarla y **Volver al panel**: aparece en la matriz con su casilla y
      su saldo.
- [ ] **A9.** **Cuenta principal** es un desplegable **fijo de la A a la O** —quince— y ya no un
      campo donde se escribe. *Esto es lo que quedamos el 28 de agosto.*
- [ ] **A10.** **Casilla** es un desplegable **de la 1 a la 20**: la subcuenta aparece en la matriz
      **exactamente en la casilla elegida**, no en la primera libre.
- [ ] **A11.** Las casillas ya ocupadas salen en el desplegable **con el nombre de quien las ocupa
      y no se pueden elegir**. Al cambiar de cuenta principal, la casilla propuesta cambia a la
      primera libre **de esa** cuenta.
- [ ] **A12.** Tras un alta correcta se conservan la cuenta principal y **avanza la casilla** a la
      siguiente libre: dar de alta veinte seguidas no obliga a reelegir las dos cosas cada vez. Las
      tres claves sí se borran.

### B · Estado de conexión — Fase 3

- [ ] **B1.** El indicador de la cabecera dice **en línea**, **N sin conexión** o **sin
      conexión** según lo que haya.
- [ ] **B2.** **Cerrar sesión** y volver a entrar. *Debe verse:* la cuenta aparece como no
      comprobada y, **sin tocar nada**, pasa sola a conectada en unos segundos.
- [ ] **B3.** Pasar el cursor por una casilla: aparece el estado de esa subcuenta y ese lado.
- [ ] **B4.** El **número de panel** de la cabecera —`#1`— se puede **borrar y reescribir**, y al
      **cerrar y volver a abrir el panel sigue puesto**. *Antes se dejaba teclear pero volvía al
      anterior en cada arranque: nada lo guardaba.*
- [ ] **B5.** Junto al distintivo del mercado, el **último precio** del activo seleccionado, con su
      par. Es el precio de marca, el mismo con el que se calculan las cantidades.

### C · La matriz y la selección múltiple — Fase 3 · `npm run dev:demo`

- [ ] **C1.** Dos cuentas principales, cada una con sus subcuentas numeradas. Cada columna enseña
      el **saldo en la fila LONG** y el **apalancamiento aplicado en la fila SHORT** —el de la
      posición abierta en el activo elegido, o un guion si no hay ninguna—. El saldo salía antes en
      las dos filas: es de la subcuenta, no de un lado.
- [ ] **C2.** Una casilla con **⚠** es una subcuenta **sin conexión**, y se distingue a simple
      vista de una que no tiene posición abierta.
- [ ] **C3.** Con el alcance en **Ambos** (el de partida), marcar **una** casilla: se marca
      también **la otra punta de esa columna** y el contador dice *2 casillas seleccionadas* —una
      columna en «Ambos» son dos órdenes, una long y una short—. No hay forma de dejar media
      columna marcada.
- [ ] **C4.** **Todas** en la barra de una cuenta principal: sus cuarenta casillas.
- [ ] **C5.** **Todas** en la barra lateral: *80 casillas seleccionadas*.
- [ ] **C6.** **Ninguna**: la selección se vacía.
- [ ] **C7.** Cambiar el alcance a **Long**: la fila SHORT **se destilda y se apaga** —no admite
      clics— y el contador baja a la mitad. Igual con **Short** y la fila LONG.
- [ ] **C8.** Pulsar **Todas** con el alcance en **Long** y volver a **Ambos**: la fila SHORT
      **se enciende a la vista** y el contador se duplica, porque «Ambos» son las dos puntas.
      *Antes el contador se duplicaba igual, pero la matriz no cambiaba: las short venían
      marcadas por debajo desde el principio y no había manera de saberlo.*

### D · Estructura y límites — Fase 3 (pruebas automáticas)

- [ ] **D1.** Hasta **15 cuentas principales** —de la A a la O—; una más se rechaza **sin gastar
      una petición**. *Eran cinco hasta el 28 de agosto.*
- [ ] **D2.** Hasta **20 subcuentas** por cuenta principal; la 21 se rechaza igual. Son **300
      subcuentas** en total.
- [ ] **D3.** Una casilla ya ocupada se rechaza **antes de preguntar a Bitget**, diciendo qué
      subcuenta la ocupa.
- [ ] **D4.** Comprobable con `npm test`.

### E · Las seis funciones, en pantalla — Fase 4 · `npm run dev:staging`

- [ ] **E1.** El selector de activo trae los del **catálogo de Bitget**, con su tope de
      apalancamiento. En el mercado de pruebas son tres (BTC, ETH, XRP); en el real, ocho.
- [ ] **E1a.** El **✎** de una casilla abre el **buscador**: escribir `DOGE` (o `DOGEUSDT`) la deja
      en un puñado de resultados. Elegir uno **sustituye** el activo de esa casilla; las demás no se
      mueven. *Esto es lo que pediste el 28 de agosto.*
- [ ] **E1b.** Siguen siendo **ocho casillas**: no hay forma de añadir una novena. Una casilla se
      puede dejar **vacía** —«Vaciar la casilla N»— y se sigue viendo, con su número.
- [ ] **E1c.** Un activo que ya está en otra casilla aparece en el buscador **marcado y sin poder
      elegirse**, con el número de la casilla que ocupa. Dos casillas con el mismo activo serían dos
      botones llamados igual.
- [ ] **E1d.** Cerrar el panel y volver a abrirlo: **las casillas siguen como se dejaron**. Se
      guardan por mercado, así que las del real y las del simulado son independientes.
- [ ] **E1e.** Vaciar la casilla del activo **que estaba seleccionado**: la selección salta al
      primero que quede, y el pie de la matriz enseña ese activo. Ninguna orden sale de aquí.
- [ ] **E2.** Elegir un activo pone el campo de apalancamiento en **el máximo de ese activo**.
- [ ] **E3.** Marcar casillas, escribir margen, y pulsar **Abrir**. *Debe verse:* el **diálogo de
      confirmación** con el precio de referencia, lo que recibe cada casilla —cantidad, margen
      real, nocional— y **qué se queda fuera y por qué**. Hasta aquí **no ha salido ninguna
      orden**.
- [ ] **E4.** **Cancelar**. No se envía nada.
- [ ] **E5.** Repetir y confirmar con la **contraseña de paso**. Tres intentos fallidos cancelan
      la operación sin enviar. *Debe verse:* el informe por casilla.
- [ ] **E6.** El **Take Profit %** y el **margen adicional** salen con la orden de E5, no aparte:
      la confirmación los enseña —precio de disparo calculado, no porcentaje— y el informe trae
      una fila por cada uno (`Sub-01`, `Sub-01 · TP`, `Sub-01 · MGA`). *No hay botón para
      aplicarlos sobre una posición ya abierta: enviarlos dos veces era posible y pasó.*
- [ ] **E7.** Pulsar **Quitar Take Profit**. El diálogo enseña **cuál va a quitar**, con su
      precio. *Esta es la función que pediste el 18 de agosto.*
- [ ] **E8.** Escribir un **margen adicional** con el modo en **Cruzado** y pulsar *Abrir*: **no
      se abre nada** y se dice por qué. En cruzado el margen sale del saldo total de la cuenta.
- [ ] **E8b.** Marcar varias casillas, entre ellas una de una subcuenta **sin saldo para el margen
      inicial más el adicional**, y pulsar *Abrir*. La confirmación se abre con el aviso **NO SE VA
      A ENVIAR NADA** arriba, **no pide la contraseña de paso**, y el botón de confirmar queda
      apagado diciendo *Corrija los valores para continuar*. Abajo, en *SE QUEDAN FUERA*, está
      nombrada la casilla que va corta con su motivo. *Añadido el 29/08/2026 a petición tuya: se
      pidió abrir con ese margen adicional, y abrir solo las que caben dejaría medio lote con menos
      colchón del aprobado. Se sale bajando los importes, añadiendo saldo o desmarcando esa
      casilla.*
- [ ] **E9.** Cambiar el **apalancamiento** y aplicarlo.
- [ ] **E10.** Pulsar **Cerrar**. El diálogo enseña qué cantidad se cierra en cada casilla, y
      pide la **contraseña de paso** igual que la apertura: cerrar realiza el resultado y no se
      deshace pulsando otra vez.
- [ ] **E11.** Dejar el diálogo abierto **más de dos minutos** y confirmar: el plan **ha
      caducado** y hay que volver a revisarlo. El precio con el que se calculó ya no es el de
      ahora.
- [ ] **E12.** En el ejecutable de dinero real, la barra superior dice **`MERCADO REAL`** en
      rojo, y cada confirmación empieza por `REVISAR ANTES DE ENVIAR · MERCADO REAL`.

### F · Verificación automática — ejecutada hoy

- [ ] **F1.** `npm run typecheck` → sin errores de tipos.
- [ ] **F2.** `npm run lint` → **cero avisos** tolerados.
- [ ] **F3.** `npm test` → **369 pruebas**, sin salir a la red.
- [ ] **F4.** `npm run test:e2e` → **10 pruebas** sobre la aplicación ya compilada.
- [ ] **F5.** `npm run test:staging` → **14 pruebas** contra `api.bitget.com` con el código
      compilado como el binario del cliente.
- [ ] **F6.** `npm run test:fisica` → **43 pruebas** que **envían órdenes de verdad** al mercado
      simulado de Bitget. Las seis funciones, cada una `1 correctas · 0 con error`.

Resultado de hoy: **todo en verde**, y `test:fisica` repetido dos veces seguidas con el mismo
resultado.

---

## 4. Tres defectos que encontró esta verificación, y que ya están corregidos

Se listan porque **ninguno se veía leyendo el código ni ejecutando las pruebas sin red**: los
tres aparecieron al operar de verdad contra Bitget.

**El panel no encontraba nunca un Take Profit puesto.** Al colocarlo, Bitget llama al lado
`holdSide`; al listarlo, lo devuelve como `posSide` y no incluye el primero. El panel filtraba
por `holdSide`, así que concluía *«esta posición no tiene ningún Take Profit puesto»*
teniéndolo. *Quitar Take Profit* era, en la práctica, inoperante.

**Y al quitarlo, Bitget decía que sí sin quitar nada.** Los planes se consultan con
`planType: profit_loss` —la familia entera— y cancelar con ese mismo valor responde
`00000 success` con las dos listas vacías **sin cancelar**. Ni error, ni aviso. El tipo que
cancela es el del plan concreto, `pos_profit`. Se comprobaron las cuatro variantes contra la
API para saber cuál funciona.

**La prueba física dejaba la cuenta en margen cruzado.** El modo de margen viaja dentro de cada
orden, así que abrir en cruzado **reconfigura el símbolo en Bitget**. Cuatro pruebas lo llevaban
escrito a mano, de modo que cada ejecución devolvía la cuenta a cruzado y la siguiente ya no
podía demostrar *agregar margen*.

Los tres tienen ahora prueba propia que falla si vuelven.

Y dos más, de los que se ven al ejecutar la batería entera:

- **`npm run lint` estaba en rojo** por unas trazas de depuración que imprimían el cuerpo de
  cada orden al enviarla. Retiradas.
- **`npm run test:red` fallaba una de cada tres veces**, siempre en pruebas distintas, porque
  lanzaba sus tres archivos en paralelo contra la misma IP. Ahora va en serie.

---

## 5. Lo que estas fases **no** incluyen

- **Las posiciones abiertas siguen siendo de la Fase 6.**

  > **Corregido el 29/08/2026.** Esto decía que el Centro de Monitoreo dice *sin datos de
  > posiciones*, y ya no es verdad: el barrido REST y el pool de sockets están construidos y
  > probados, así que las posiciones **se ven**. Lo que no ha ocurrido es la fase: no se ha
  > revisado contra el uso real ni entra en la validación de la Fase 5. Se deja escrito porque lo
  > contrario —callar que se ve— haría que se reportaran fallos contra una fase sin abrir.
- **No se puede editar una subcuenta registrada** —renombrarla o moverla—. Hoy se da de baja y
  se vuelve a dar de alta.
- **El alta en tanda desde la interfaz** no existe: la carga masiva funciona por herramienta
  aparte, con el panel cerrado.
- **El Take Profit parcial** no está en el alcance: el que se pone cierra la posición entera.

Nada de esto es una limitación técnica: es el reparto por fases del presupuesto.

---

## 6. Lo que necesito de tu lado

| # | Asunto | Por qué importa |
|---|---|---|
| 1 | **Fondear la cuenta de dinero real** | Hoy tiene 2,96 USDT: alcanza para el tamaño mínimo, no para una ejecución sobre muchas casillas |
| 2 | **Confirmar los ocho activos** del mercado real: BTC, ETH, SOL, PEPE, PAXG, SUI, DOGE, XRP | El presupuesto hablaba de cinco. Si alguno sobra, se quita del selector |
| 3 | ¿Hace falta **editar** una subcuenta registrada? | Hoy es dar de baja y volver a dar de alta |
| 4 | ¿Hace falta **dar de alta varias a la vez desde la pantalla**? | La herramienta existe por fuera y exige cerrar el panel |

---

## 7. Aprobación

Conforme a la cláusula 4(c) del presupuesto, estas fases se entienden aprobadas si no se
manifiestan observaciones dentro de los **7 días naturales** posteriores a esta demostración.

Casillas marcadas en la sección 3: ______ de 39.

Observaciones:

_______________________________________________________________________________

_______________________________________________________________________________

_______________________________________________________________________________

<br>

| | |
|---|---|
| ____________________________ | ____________________________ |
| **Alexis Cárdenas Camacho** · Desarrollador | **Daniel Montero Ramírez** · Cliente |
| Fecha: ____ / ____ / 2026 | Fecha: ____ / ____ / 2026 |
