# Fase 4 · Función 1 de 5 — Apertura de operaciones

**Panel de Control Bitget (PCB) v1.0** · 12 de agosto de 2026
Presupuesto de referencia: Fase 4, $10,500 MXN, 3–4 semanas · **esta entrega cubre la primera
de las cinco funciones**, en el proceso principal. La pantalla se conecta después, cuando esto
esté revisado.

---

## 1. Qué se construyó y dónde

| Pieza | Archivo | Qué resuelve |
|---|---|---|
| Los dos mercados | [`bitget/mercado.ts`](../src/main/bitget/mercado.ts) | Separa el mercado real del simulado de Bitget. No es una bandera: son dos universos distintos del propio exchange |
| Catálogo de contratos | [`rest/endpoints/simbolos.ts`](../src/main/bitget/rest/endpoints/simbolos.ts) | Paso mínimo, decimales y nocional mínimo de cada activo; y el precio de marca |
| La orden | [`rest/endpoints/ordenes.ts`](../src/main/bitget/rest/endpoints/ordenes.ts) | Envía la apertura y permite recuperarla por el identificador que puso el panel |
| El cálculo | [`domain/dimension-orden.ts`](../src/main/domain/dimension-orden.ts) | Traduce «100 USDT a 10x» a una cantidad que Bitget acepta |
| El motor de lotes | [`execution/motor-lotes.ts`](../src/main/execution/motor-lotes.ts) | Planifica, confirma, envía por bloques, reintenta lo que procede e informa cuenta por cuenta |
| Contra qué mercado opera | [`storage/configuracion.ts`](../src/main/storage/configuracion.ts) | `config.json`, y arranca en `simulado` |
| Conexión con el panel | [`ipc/sesion.ts`](../src/main/ipc/sesion.ts) · [`ipc/handlers.ts`](../src/main/ipc/handlers.ts) | Canales `apertura:planificar` y `apertura:ejecutar`, y el avance por `lote:progreso` |

**Los esquemas no se dedujeron de la documentación: se capturaron de la API real** el 12 de
agosto de 2026, para `BTCUSDT` (mercado real) y `SBTCSUSDT` (simulado). Es la misma regla que
se siguió en la Fase 2.

### Lo que cambió de lo que ya existía

- `Job` gana `lado` y `etiqueta` ([`shared/types`](../src/shared/types/index.ts)): en modo
  cobertura una subcuenta puede recibir una apertura long y otra short en el mismo lote, y sin
  el lado serían dos líneas indistinguibles en el informe. La etiqueta está porque el informe lo
  lee un operador, no una máquina.
- El exchange simulado admite responder **según la petición**, que es lo que permite probar que
  unas cuentas fallen y otras no.

---

## 2. Los seis controles, y qué garantiza cada uno

**Nada sale sin haberse calculado antes.** El motor trabaja en dos tiempos: `planificar()` no
toca ninguna cuenta —consulta catálogo y precio y calcula la cantidad de cada objetivo— y
`ejecutar()` solo envía lo ya aprobado. Es lo que hace posible la confirmación que exige el
contrato: no se aprueba «abrir 100 USDT a 10x», se aprueba «0,0157 BTC en estas 34 cuentas, y
estas 3 no pueden por saldo».

**Si el problema es la operación, no sale ni una orden.** Activo inexistente, precio ilegible o
selección vacía abortan el lote entero en la planificación. Lo que depende de cada cuenta
—saldo, mínimos— no aborta nada: descarta esa cuenta con su motivo.

**El margen se comprueba el primero.** Es la petición explícita del cliente y también lo
correcto: de todos los motivos por los que una apertura puede fallar, quedarse sin margen es el
único que además pone en riesgo lo que ya estaba abierto. Si falta margen, el panel dice eso, y
no un fallo de redondeo que llegaría después.

**No se puede duplicar una posición.** Cada orden lleva un identificador que genera el panel y
que se deriva del plan, no del azar: ejecutar dos veces el mismo plan produce exactamente los
mismos identificadores y Bitget rechaza el repetido. Además, un plan que ya se está enviando
queda marcado, así que el doble clic del operador no lanza dos envíos en paralelo.

**Un fallo no arrastra a los demás.** Cada objetivo es independiente. La cuenta que falla queda
registrada con su motivo, su código de Bitget y su nombre; las otras terminan. Lo que salió bien
nunca se deshace: cerrar 31 posiciones válidas porque 3 fallaron sería un daño mayor que el
problema original.

**No se satura la API.** Los envíos van por bloques y cada uno pasa por el limitador de
peticiones de la Fase 2, que reparte el cupo por IP y por cuenta. Un fallo transitorio se
reintenta solo, hasta tres veces con espera creciente, reusando el mismo identificador —por eso
reintentar no puede duplicar—. Un fallo de cuenta no se reintenta: reintentarlo no lo arreglaría.

**Lo enviado sin respuesta se consulta, nunca se reintenta a ciegas.** Si la conexión se corta
después de enviar, no se sabe si la orden entró. El motor pregunta por el identificador: si
Bitget la conoce, la da por buena; si no la conoce, la marca como fallo reintentable; y si ni
siquiera puede preguntar, la deja como **indeterminada** y no la toca. Es la única etiqueta
honesta, y es la que impide acabar con el doble de posición.

### Dos controles más, en la frontera con la pantalla

**La pantalla no decide contra qué mercado se opera.** Sale de `config.json`, en el equipo, y
un panel recién instalado arranca en **simulado**. Pasar a dinero real exige editarlo a
propósito. Si la pantalla pudiera elegirlo, un fallo de la página podría mandar al mercado real
algo que se creía una prueba. Hay una prueba de arranque que falla si algún día el valor por
defecto deja de ser el simulado.

**La pantalla nunca envía cantidades.** `apertura:planificar` devuelve el plan solo para
mirarlo; para ejecutarlo se manda de vuelta **su identificador**, no su contenido. El plan de
verdad se queda en el proceso principal, así que ninguna cantidad ni ningún precio pueden
alterarse entre lo que el operador aprueba y lo que sale hacia Bitget. Los planes caducan a los
dos minutos: pasado ese plazo el precio con el que se calcularon ya no es el de ahora, y hay que
volver a revisar la operación.

---

## 3. Cómo se prueba

```bash
npm test              # 234 pruebas, sin salir a la red
npm run test:e2e      # arranca la aplicación real y comprueba los canales nuevos
npm run test:fisica   # abre una posición de verdad en el mercado simulado de Bitget
```

**En desarrollo (`npm test`) se prueba lo que sale mal**, que es lo que Bitget no sabe producir
a petición: rechazos, cortes a mitad de envío, respuestas que no llegan. El reloj y las esperas
se inyectan, así que un lote de **300 cuentas** se ejecuta entero en milisegundos y de forma
determinista. Las 49 pruebas nuevas cubren, entre otras cosas:

- 300 cuentas: todas salen, ninguna se repite, ninguna se queda sin enviar.
- 300 cuentas con saldos desiguales: 200 abren y 100 se descartan, cada una con su motivo.
- Nunca hay más peticiones en vuelo que el tamaño del bloque.
- Doble clic: la segunda ejecución se rechaza y solo salen las órdenes de la primera.
- Corte de red tras enviar, con y sin la orden registrada en Bitget.
- El cálculo de la cantidad, con el contrato real de BTCUSDT y aritmética decimal exacta.
- Que un plan desconocido o caducado no se ejecuta, y que bloquear el panel los tira.
- Que la credencial solo sale del almacén con el panel abierto.

**En `test:fisica` se opera de verdad**, contra el mercado simulado —dinero simulado pero
oficial de Bitget, con precios y motor de emparejamiento reales—. Mismo código, misma firma,
mismo limitador. El símbolo `SBTCSUSDT` no existe en el mercado real, así que esta prueba **no
puede** tocar dinero de nadie ni por un error de configuración.

---

## 4. Lo que hoy bloquea la prueba física

La prueba física recorre todo el camino correctamente y se detiene en el último paso, por un
motivo que **no está en el código**. Esto es lo que Bitget responde hoy, comprobado el 12 de
agosto:

| Intento | Respuesta de Bitget | Qué significa |
|---|---|---|
| Subcuenta → mercado **simulado** | `40126 · The current account type is not allowed to perform this operation` | El trading demo no admite claves de subcuenta |
| Subcuenta → mercado **real** | `40035 · you are required to complete KYC first` | La cuenta no tiene el KYC completado |
| Cuenta principal → cualquiera | `40018 · Invalid IP, Current request IP 148.220.190.13` | Esa clave tiene lista blanca de IP y no incluye este equipo |

Lo que sí funciona hoy con la credencial actual: leer el saldo simulado (**3.000 SUSDT**), leer
el catálogo, leer el precio, **fijar el apalancamiento** y consultar órdenes por identificador.
Es decir: la credencial firma bien y el panel habla bien. Lo único cerrado es la puerta de
enviar órdenes.

### Qué hace falta, en orden de utilidad

1. **Una API Key creada desde la sección de Trading Demo** de la cuenta principal de Bitget.
   Es lo que desbloquea la prueba física con dinero simulado, y no requiere ni KYC ni fondos.
2. **KYC de la cuenta principal.** Sin él, Bitget no acepta ni una orden real de ninguna
   subcuenta. Bloquea toda la Fase 4 en producción y también la Fase 5.
3. **La IP de este equipo en la lista blanca** de la clave de la cuenta principal, si se va a
   usar esa clave.

---

## 5. Dos decisiones, ya resueltas por el cliente

*Respondidas por Daniel el 12 de agosto de 2026.*

**El apalancamiento se fija una vez y queda fijo; la apertura no lo cambia.** Es lo que el motor
ya hacía: valida que el valor pedido esté dentro del rango del símbolo, pero no lo modifica en la
cuenta. Ajustarlo es la función 5, que ya está contratada. Así un lote de 100 cuentas son 100
peticiones y no 200.

Esto trae una consecuencia que sí hubo que cubrir: **el margen comprometido depende del
apalancamiento de la cuenta**. La misma cantidad a 20x consume la mitad de margen que a 10x, así
que si una cuenta está en un apalancamiento distinto al del campo, el margen que se enseña en la
confirmación no sería el que de verdad se compromete. El plan ahora lo avisa por cuenta, con la
cifra concreta:

> *La cuenta está a 20x y la operación se calculó a 10x: comprometería 49,75 en vez de 99,50.*

No bloquea el envío —la orden es válida— pero el operador lo lee antes de confirmar. El dato sale
de la última verificación de la credencial, así que **no cuesta ninguna petición adicional**.

**El margen inicial es por casilla.** Cada subcuenta tiene su casilla long y su casilla short, y
cada una es un objetivo independiente: marcar las dos de una subcuenta con 100 USDT compromete
200. Es lo que el motor ya hacía.

**La unidad de operación queda fija en Costo-USDT.** El operador escribe el margen que
compromete y el panel hace la conversión. Con su ejemplo:

```
10 USDT × 150x            = 1.500 USDT de posición
1.500 ÷ 63.378 (BTC)      = 0,0236 BTC
                          → se envía 0,0236 a Bitget
```

Dos precisiones que conviene tener claras:

- **La API de Bitget no tiene esa opción.** `place-order` recibe el tamaño siempre en moneda
  base. Las tres opciones de «Configuración de la unidad de futuros» son de la *web* de Bitget y
  solo cambian lo que se ve al operar a mano allí: no viajan en ninguna petición y **no hay que
  configurarlas en cada subcuenta** para que el panel funcione.
- La unidad queda nombrada en un solo sitio —`UNIDAD_OPERACION` en
  [`dimension-orden.ts`](../src/main/domain/dimension-orden.ts)— y viaja en el plan, para que la
  confirmación pueda mostrarla bloqueada. No se expone como interruptor: un modo que nadie usa es
  un modo que nadie prueba.

El ejemplo de arriba está escrito como prueba, así que si alguien cambia la fórmula, lo que falla
nombra la regla de negocio y no un número suelto.

---

## 6. Qué sigue

Esta entrega deja la apertura construida, probada y **alcanzable desde el panel**: los canales
existen, la sesión alimenta al motor con las credenciales y los saldos, y el avance del lote
viaja a la ventana. Lo que falta es la pantalla —que la barra lateral llame a estos canales y
enseñe el plan antes de confirmar— y después la función 2, cierre de operaciones. Las cinco
funciones comparten el mismo motor de lotes, así que las siguientes son sensiblemente más
cortas que esta.
