# Fase 4 · Función 2 de 5 — Cierre de operaciones

**Panel de Control Bitget (PCB) v1.0** · 12 de agosto de 2026
Presupuesto de referencia: Fase 4, $10,500 MXN · **esta entrega cubre la segunda de las cinco
funciones**, en el proceso principal. La pantalla se conecta cuando las funciones estén
revisadas.

> *«Cierre de operaciones — individual, grupal o masivo sobre posiciones abiertas.»*

---

## 1. Qué se construyó y dónde

| Pieza | Archivo | Qué resuelve |
|---|---|---|
| Posiciones abiertas | [`rest/endpoints/posiciones.ts`](../src/main/bitget/rest/endpoints/posiciones.ts) | Consulta qué hay abierto, para poder confirmar antes de cerrar |
| El cierre | [`rest/endpoints/ordenes.ts`](../src/main/bitget/rest/endpoints/ordenes.ts) | `cerrarPosicion`: cierre a mercado con identificador propio |
| Motor de lotes | [`execution/motor-lotes.ts`](../src/main/execution/motor-lotes.ts) | `planificarCierre` y `ejecutarCierre`, sobre la misma maquinaria de la apertura |
| Conexión con el panel | [`ipc/sesion.ts`](../src/main/ipc/sesion.ts) · [`ipc/handlers.ts`](../src/main/ipc/handlers.ts) | Canales `cierre:planificar` y `cierre:ejecutar` |

**La arquitectura no se duplicó.** Los bloques, el cerrojo contra el doble clic, el informe por
cuenta, el reintento de lo transitorio y la resolución de lo indeterminado se extrajeron a una
sola pieza que ahora comparten las dos funciones —y compartirán las tres que faltan—. Lo único
propio de cada acción es *qué se envía* y *cómo se averigua el desenlace si no llegó respuesta*.
Las 23 pruebas de la apertura siguen pasando sin tocar una línea, que es la comprobación de que
la extracción no cambió su comportamiento.

---

## 2. Las tres decisiones propias del cierre

**Se mira antes de cerrar.** `planificarCierre` consulta las posiciones abiertas de cada cuenta
seleccionada. Así la confirmación no dice «voy a cerrar 34 casillas» sino «34 posiciones, este
tamaño en cada una, y estas 6 casillas ya estaban cerradas». Una sola consulta por subcuenta
devuelve los dos lados, así que cerrar long y short no cuesta el doble.

**Se cierra «lo que haya», no una cantidad fija.** Se podía cerrar indicando el tamaño exacto
leído al planificar. Se descartó a propósito: entre que se lee la posición y que la orden sale
pueden pasar segundos, y en ese hueco el tamaño puede haber cambiado —un Take Profit que se
ejecuta a medias, un reposicionamiento—. Una cantidad fija cerraría de menos y **dejaría un resto
abierto sin que nadie lo note**, que es exactamente el fallo que no se puede permitir en una
función llamada «cerrar». El endpoint de cierre relámpago le dice a Bitget que cierre lo que
tenga en ese momento.

**Lo indeterminado se resuelve mirando la posición, no la orden.** Si la conexión se corta
después de enviar, la apertura pregunta por el número de orden. El cierre no: pregunta si la
posición sigue ahí. Es la verdad de fondo —si ya no está, el cierre ocurrió— y no depende de cómo
el exchange indexe una orden de cierre relámpago.

### Un defecto encontrado por el camino

El catálogo de errores traducía el código `22002` de Bitget como **«Saldo insuficiente»**, y era
un fallo de cuenta. Al probar el cierre contra la API real, el texto que Bitget devuelve resultó
ser **«No position to close»**. Traducido: cerrar una casilla que ya estaba cerrada aparecía en
el informe como un error de saldo. Corregido, y además reclasificado: ahora es **«omitida»**, no
un fallo. No hay nada que arreglar cuando una cuenta no tenía posición abierta, y contarlo como
error mandaría al operador a buscar un problema inexistente.

Esto viene de la petición que hiciste en la apertura —que el informe diga la verdad y señale lo
crítico primero—. En el cierre lo crítico no es el margen: es **no dar por cerrado lo que sigue
abierto**. De ahí las tres decisiones de arriba y esta cuarta:

**Un rechazo escondido dentro de una respuesta de éxito cuenta como fallo.** El endpoint de
cierre responde con dos listas —lo que aceptó y lo que rechazó— y la petición puede traer código
de éxito con la posición dentro de la lista de rechazos. Darlo por bueno dejaría al operador
creyendo que ya no tiene riesgo abierto. El motor lo trata como fallo de esa cuenta.

---

## 3. Cómo se prueba

```bash
npm test              # 258 pruebas, sin salir a la red
npm run test:fisica   # abre y cierra de verdad en el mercado simulado de Bitget
```

Las 34 pruebas nuevas cubren, entre otras cosas:

- 300 cuentas: todas se cierran, ninguna se repite.
- Una casilla sin posición se descarta con su motivo y **aparece en el informe** como omitida.
- Se distingue el lado: no se cierra un long cuando lo abierto es un short.
- Si no se pueden leer las posiciones de una cuenta, esa cuenta **no se toca**.
- Un rechazo dentro de la respuesta de éxito cuenta como fallo.
- Corte de red tras enviar, con la posición cerrada y con la posición aún abierta.
- Doble clic: la segunda ejecución se rechaza.

---

## 4. Guía de la prueba física

`npm run test:fisica` ejecuta **un recorrido completo de las dos funciones** contra Bitget, en el
mercado de dinero simulado. Imprime cada paso, así que sirve para enseñarla en pantalla:

| Paso | Qué hace | Qué se ve |
|---|---|---|
| 1 | Lee el saldo simulado | `3000 SUSDT` |
| 2 | Abre una posición de 50 SUSDT a 10x | Cantidad calculada con el precio real |
| 3 | Pregunta a Bitget si existe | Tamaño, precio de entrada y margen comprometido |
| 4 | Planifica el cierre | Qué se va a cerrar y cuánto margen se libera |
| 5 | Cierra | Confirmación del exchange |
| 6 | Vuelve a preguntar | Ya no hay posición |
| 7 | Intenta cerrar otra vez | *«No había ninguna posición que cerrar»* — omitida, no fallo |

El paso 7 es el que conviene enseñar con calma: es el caso de pulsar dos veces sin estar seguro,
y el panel responde que no había nada que hacer en lugar de dar un error.

**Por qué abre antes de cerrar.** Un cierre no se puede demostrar sobre una cuenta vacía: lo
único que se vería es el paso 7, que es precisamente el caso que no hay que enseñar.

**Estado hoy.** Los pasos 1, 6 y 7 pasan. Los pasos 2 a 5 se detienen en el mismo muro que la
apertura: Bitget responde `40126 · The current account type is not allowed to perform this
operation`, porque **el mercado simulado no admite claves de subcuenta**. Hace falta una API Key
creada desde la sección de *Trading Demo* de la cuenta principal. No requiere KYC ni fondos, y
desbloquea de golpe la demostración de las cinco funciones.

Lo que ya se puede enseñar hoy, con datos reales: el saldo simulado, el precio de marca, la
cantidad calculada, la consulta de posiciones y el caso «no había nada que cerrar».

---

## 5. Lo que necesito de tu lado

Sin cambios respecto a la apertura, por orden de utilidad:

1. **Una API Key desde Trading Demo** de la cuenta principal de Bitget.
2. **KYC de la cuenta principal** — sin él, Bitget no acepta ninguna orden real de ninguna
   subcuenta, y bloquea toda la Fase 4 en producción.
3. **La IP del equipo en la lista blanca** de la clave de la cuenta principal, si se va a usar.

Y una pregunta nueva, propia del cierre:

**¿El cierre debe cancelar también el Take Profit que quedara puesto?** Cuando se cierra una
posición, la orden de Take Profit asociada puede quedar viva en Bitget. Normalmente el exchange
la retira sola, pero conviene confirmarlo en la prueba física antes de darlo por hecho. Si no lo
hiciera, el panel tendría que cancelarla, y eso son peticiones adicionales por cuenta.

---

## 6. Qué sigue

Con la apertura y el cierre construidos y compartiendo motor, quedan tres funciones: Take Profit
por porcentaje, agregar margen y ajuste de apalancamiento. Las tres son más cortas: reutilizan
todo lo de arriba y solo aportan su endpoint y su forma de planificar.

Las dos preguntas de la entrega anterior están resueltas: el apalancamiento se fija una vez y la
apertura no lo cambia, y el margen inicial es por casilla. Ver
[`00-fase-4-apertura.md`](00-fase-4-apertura.md) sección 5.
