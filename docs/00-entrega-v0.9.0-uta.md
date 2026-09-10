# Entrega v0.9.0 — Convivencia Bitget V2 (Classic) y V3 (UTA)

**Panel de Control Bitget (PCB)** · 8 de septiembre de 2026
Binario: `PCB-0.9.0-REAL-portable.exe` · **Mercado real**

> Continúa la [v0.8.1](00-entrega-v0.8.1.md). **Ninguna cuenta Classic cambia de
> comportamiento**: si todas sus subcuentas siguen siendo Classic, este binario hace
> exactamente lo mismo que el anterior. Lo nuevo solo se activa en las cuentas que Bitget
> haya migrado a UTA.

---

## 1. Qué problema resuelve

Bitget está migrando las cuentas a un modelo unificado —**UTA**— con una API distinta, la V3.
Una API Key emitida sobre una cuenta ya migrada **no puede** hablar con los endpoints de
siempre: Bitget la rechaza.

El riesgo real no es una fecha de apagado, que Bitget no ha anunciado. Es que un titular
actualice su cuenta por su cuenta y esa subcuenta **desaparezca del panel sin aviso**: dejaría
de leerse, dejaría de aparecer en el monitor y sus casillas fallarían sin que nada explicara por
qué.

Desde esta versión el panel habla las dos. Cada subcuenta va por donde le toca, y el operador no
tiene que saber cuál es cuál.

## 2. Lo que ve el operador

**Un distintivo por fila en la pantalla de APIs**: `V2`, `UTA` o `CAMBIANDO`. Es lo único nuevo
en pantalla, y existe para que una cuenta migrada no pase inadvertida.

El modo se detecta solo, al validar las credenciales, y se recuerda. No hay nada que configurar
y no hay ninguna casilla que marcar.

**`CAMBIANDO`** significa que Bitget está migrando esa cuenta en ese momento. Mientras dure, la
subcuenta **no opera**: no entra en los lotes, igual que hoy no entra una sin credencial. Es lo
correcto —una cuenta a medio migrar puede aceptar una orden y aplicarla en el modelo que no
es— y se resuelve solo cuando Bitget termina.

Todo lo demás está igual: la misma confirmación previa, el mismo informe por cuenta, la misma
matriz. Un lote sobre una selección mixta de Classic y UTA se envía junto y devuelve un
resultado por cuenta, como siempre.

## 3. Qué funciona en UTA, y qué no

| Función | En cuentas UTA | Qué ve el operador |
|---|---|---|
| Apertura | **Migrada** | Igual que en Classic |
| Cierre | **Migrada** | Igual que en Classic |
| Agregar margen | **Migrada** | Igual que en Classic |
| Ajuste de apalancamiento | **Migrada** | Igual que en Classic |
| Centro de Monitoreo | **Migrado** | Misma tabla, mismas columnas |
| Saldos | **Migrado** | Misma columna |
| **Take Profit por %** | **Bloqueado** | La casilla UTA falla con su motivo; las Classic del mismo lote siguen |
| **Quitar Take Profit** | **Bloqueado** | Ídem |
| **Cambio de modo de margen** | **Bloqueado** | Solo falla si el modo real difiere del aprobado |

### Por qué el Take Profit está bloqueado y no «aproximado»

Los tres endpoints del Take Profit —ponerlo, listarlo, quitarlo— **no tienen equivalente
conocido** en V3. Se podría haber mandado el endpoint más parecido a ver qué pasa. No se hizo, y
la razón está escrita dos veces en el historial de este mismo panel:

- **25/08/2026** · cancelar un plan con el `planType` de la familia respondió `00000 success`
  con las listas vacías **y no canceló nada**.
- **05/09/2026** · `set-leverage` con el lado en una cuenta cruzada respondió `00000` **y no
  cambió el apalancamiento**. El informe decía «correcto · 150x» sobre una cuenta a 10x.

En Bitget, un parámetro mal supuesto no falla de forma ruidosa: responde éxito. Un endpoint mal
supuesto haría lo mismo, y el operador leería «Take Profit puesto» sobre una posición **sin
protección**. Una casilla que falla diciendo por qué es estrictamente mejor.

**Mientras tanto**, el Take Profit de una posición en cuenta UTA se pone desde la app de Bitget.
El panel no lo enseñará en su columna —tampoco puede listarlo— pero la posición sí queda
protegida.

## 4. Qué está probado y qué no

Esta es la sección que conviene leer entera.

### Probado, y de forma reproducible

- **819 pruebas automáticas** (52 archivos), verdes en tres ejecuciones seguidas.
- **15 pruebas de extremo a extremo** sobre la aplicación compilada.
- `typecheck` y `lint` sin un solo aviso.
- La regresión sobre Classic: las pruebas que existían antes de esta migración **no se
  modificaron** para hacerlas pasar. Es el criterio de que V2 no se rompió, y no una revisión a
  ojo.

### **No probado contra la API real de Bitget**

**Ninguna de las peticiones de V3 se ha enviado nunca a Bitget.** Los nombres de los parámetros,
las rutas, los nombres de los campos de respuesta y los tres temas del WebSocket salen de la
documentación publicada por Bitget al 7 de septiembre de 2026, no de respuestas capturadas.

Las pruebas automáticas usan un exchange simulado, que contesta lo que se le dice. Lo que
demuestran es que **la traducción y el enrutamiento son correctos**: que una cuenta UTA manda sus
peticiones a V3 con los parámetros traducidos, que una Classic sigue yendo a V2, y que un lote
mixto trata a cada una como debe. Lo que **no** pueden demostrar es que Bitget acepte esos
cuerpos.

Esto no es una omisión: es que hasta ahora no ha habido una subcuenta UTA contra la que
ejecutarlo. La validación es el paso 5 de abajo, y **debe hacerse antes de operar con dinero
real sobre una cuenta UTA**.

### Las dos situaciones difíciles, y cómo quedan resueltas

**Si una cuenta migra a UTA entre dos usos del panel**, la primera casilla falla —lo guardado dice
Classic y Bitget ya solo habla V3—. El panel lo detecta, lo corrige y reenvía **una vez**, con el
mismo identificador de orden. El modo corregido se guarda, así que las demás cuentas del mismo
lote no tropiezan igual y el monitor y los saldos pasan a leerse por donde toca.

No se adivina por el mensaje de error: se comprueba preguntándole a Bitget de qué tipo es esa
cuenta. Y el reenvío solo ocurre cuando el fallo **prueba que la orden no se ejecutó**. Ante una
respuesta ilegible o un corte de conexión —donde la orden pudo haber entrado— no se reenvía nada,
ni corregido.

**Si una apertura se queda sin respuesta en una cuenta UTA**, el panel comprueba si el canal en
vivo anunció esa orden. Si la anunció, entró, y la casilla sale correcta. Si no consta, la casilla
queda **indeterminada** —«se envió y no se sabe»— y hay que comprobarla en Bitget antes de
reintentar.

Esa segunda mitad no es un fallo pendiente, es la respuesta correcta: que el canal no la anunciara
puede significar que la orden no entró, pero también que el canal estaba caído o que esa
subcuenta no tenía conexión en vivo en ese momento. Dar por fallida una orden que sí entró
abriría la posición dos veces, y eso es lo único que este panel no puede hacer.

> El caso que sigue quedando indeterminado con más frecuencia es la **primera apertura sobre una
> subcuenta vacía**: sin posiciones no tiene conexión en vivo —el cupo se lo lleva quien sí las
> tiene—, así que no hay canal que pueda anunciar nada.

## 5. Cómo validar contra la subcuenta UTA — procedimiento

Ordenado de menor a mayor consecuencia. **No salte pasos**: cada uno confirma lo que el
siguiente da por supuesto.

### Paso 1 · Configurar la credencial (una vez)

En el archivo `.env`, junto a las que ya hay:

```
BITGET_UTA_API_KEY=
BITGET_UTA_SECRET_KEY=
BITGET_UTA_PASSPHRASE=
BITGET_UTA_UID=
```

### Paso 2 · Las lecturas — **no mueve dinero**

```
npx vitest run --config vitest.fisica.config.ts test/fisica/uta-lecturas.test.ts
```

Seis lecturas contra la cuenta real, recorriendo el código del panel. Al terminar imprime un
volcado con los nombres de campo que Bitget devolvió de verdad. **Guarde esa salida**: es lo que
confirma o corrige los esquemas de las tres fases anteriores, y responde de paso las dos
preguntas abiertas más caras —si UTA admite el mercado de práctica, y con qué código rechaza V3
a una clave Classic—.

Se puede ejecutar contra la cuenta de producción sin consecuencia. Lo peor que puede pasar es que
falle nombrando el campo que no encaja.

### Paso 3 · El apalancamiento — escribe, pero es reversible

```
PCB_UTA_ESCRITURAS=1 npx vitest run --config vitest.fisica.config.ts test/fisica/uta-escrituras.test.ts
```

Es la única de las cinco funciones que se puede validar sola con responsabilidad: no necesita
posición abierta, ponerla dos veces deja el mismo resultado, y la prueba **restaura el valor
original al terminar**. Si no pudiera restaurarlo, lo dice con el número que había.

No se ejecuta sin esa variable delante. Es la única prueba del repositorio que puede tocar una
cuenta con dinero real, y una variable que hay que escribir es la diferencia entre decidirlo y
que ocurra.

### Paso 4 · Las cuatro restantes, desde el panel

Margen, cierre y apertura necesitan una posición abierta, y el Take Profit está bloqueado. **Eso
no se automatiza**, por una razón concreta: la suite física de V2 opera en el mercado simulado de
Bitget (`SUSDT-FUTURES`), y **V3 no lista esa categoría**. Si UTA no tiene mercado de práctica
—lo dice el paso 2—, una apertura automática aquí sería una apertura con dinero real sin nadie
mirando.

Se validan desde el panel, con usted delante, y es además mejor prueba: ejercita la confirmación
previa y el informe por cuenta, que es lo que se usa a diario.

En una subcuenta UTA **desechable**, con el importe mínimo:

1. **Apalancamiento** sobre una selección de una Classic y la UTA a la vez. Comprobar que el
   informe da resultado por cada una y que el número quedó puesto **en Bitget**.
2. **Apertura** de una posición mínima solo en la UTA. Leer la confirmación antes de aprobar.
3. Comprobar que la posición aparece en el **Centro de Monitoreo** con entrada y liquidación
   correctas, y en la misma tabla que las Classic.
4. **Agregar margen** a esa posición. Comprobar en Bitget que el margen subió.
5. **Cerrar** la posición. Comprobar que la fila desaparece del monitor.
6. Repetir la apertura sobre una selección mixta Classic + UTA y comprobar que el informe
   distingue las dos.

### Paso 5 · Antes de operar en producción

Ninguna subcuenta UTA de producción debe operarse desde el panel hasta que los pasos 2 a 4 estén
hechos y su salida revisada.

## 6. Riesgos que siguen abiertos

- **Una subcuenta que pasa a UTA no puede volver a Classic.** Las pruebas destructivas de modo
  van en subcuentas desechables, nunca en las de producción.
- **El mercado de práctica.** Si UTA no admite `SUSDT-FUTURES`, toda prueba destructiva sobre
  cuentas UTA es con dinero real. Lo resuelve el paso 2.
- **El Take Profit**, mientras siga bloqueado, se pone desde Bitget en las cuentas UTA.
- **La corrección de superficie y el tri-estado de UTA** —sección 4— están construidos y probados
  contra el exchange simulado, pero se apoyan en dos cosas sin capturar: el código con que Bitget
  rechaza a una clave en la API que no le toca, y la forma del canal `order`. El paso 2 del
  procedimiento responde la primera; la segunda se comprueba en el paso 4, viendo si una apertura
  interrumpida se resuelve sola.

---

**Verificación de esta versión:** 819 pruebas automáticas (52 archivos) verdes en tres
ejecuciones seguidas, 15 de extremo a extremo sobre la aplicación compilada, `typecheck` y `lint`
sin un solo aviso. El binario se comprobó tras empaquetar: se compila como **mercado real** y se
identifica como versión 0.9.0. **Las pruebas físicas contra una subcuenta UTA están escritas y
pendientes de ejecutar** — sección 5.
