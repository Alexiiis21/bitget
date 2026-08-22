# Propuesta — Traspaso de saldo entre subcuentas

**Panel de Control Bitget (PCB)** · 18 de agosto de 2026 · segunda versión, ya con sus respuestas
Función adicional, fuera del presupuesto firmado.

---

## 1. Lo que se pide

> *«Quiero mover saldo entre subcuentas, de la misma cuenta principal.»*

Hoy eso se hace entrando a Bitget una por una. Con cien subcuentas, repartir capital antes de
una sesión es la misma tarea repetitiva que el panel vino a resolver con las órdenes.

---

## 2. Sus respuestas, y qué resuelve cada una

| Pregunta | Su respuesta | Qué significa para el desarrollo |
|---|---|---|
| ¿Futuros o spot? | «Está en futuros de cada subcuenta, es el dinero con el que se opera» | **La mejor de las dos.** Bitget admite mover de monedero de futuros a monedero de futuros directamente: un traspaso es **una** operación, no tres. Desaparece el riesgo que encarecía la estimación anterior |
| ¿Entre cuentas principales? | «Dentro de la misma; Bitget no tiene permiso de retiro externo» | Confirmado y acotado. Nada sale de su estructura |
| ¿Sub a sub o pasando por la principal? | «De preferencia sub a sub, pero si no se puede, sin problema» | Bitget expone un endpoint de traspaso **entre subcuentas**, así que se hará directo. Si en la práctica exigiera pasar por la principal, es un paso más por dentro y usted no notaría la diferencia |

---

## 3. Lo que comprobé hoy contra la API real

| Prueba | Resultado |
|---|---|
| Subcuenta intenta traspasar | `40014 · Incorrect permissions, need transfer write permissions` |
| Subcuenta intenta leer su saldo spot | `40014 · needs spot order read permissions` |
| **Cuenta principal lee el saldo de futuros de TODAS las subcuentas** | **Funciona, y en una sola petición**: devolvió las 17 con su disponible y su *máximo transferible* |
| **Bitget admite futuros → futuros** | **Sí**, USDT está en la lista de monedas transferibles entre monederos de futuros |

Dos consecuencias buenas para el precio:

**La pantalla de saldos cuesta una petición, no cien.** Con una sola llamada la cuenta principal
ve el disponible de todas sus subcuentas. Sobre cien cuentas se dibuja al instante y sin acercarse
a los límites de Bitget.

**Bitget dice cuánto se puede sacar de verdad.** Cada subcuenta informa de su *máximo
transferible*, que no es lo mismo que su saldo: el dinero comprometido en posiciones abiertas no
puede salir. El panel enseñará ese número, de modo que no se intenten traspasos que Bitget va a
rechazar.

**Lo que no pude comprobar:** que la clave de la cuenta principal tenga efectivamente activado el
permiso de traspaso. Para saberlo hay que enviar un traspaso, y no lo hice sin su autorización. Se
comprueba en un minuto el día que empecemos, y si faltara se resuelve creando la clave como se
indica en la sección 7.

---

## 4. La decisión importante no es técnica

Esta es la parte que conviene leer despacio, porque cambia una de las promesas del proyecto.

El presupuesto firmado dice, en las condiciones del servicio:

> *«El sistema no solicitará, almacenará ni utilizará permisos de retiro de fondos.»*

Y la propuesta de la Fase 1 lo explicaba así:

> *«Las claves se crean sin permiso de retiro, y el panel rechaza cualquier clave que sí lo tenga.
> Esto significa que, incluso en el peor escenario imaginable, quien obtuviera esas claves no
> podría sacar un solo dólar de sus cuentas.»*

Hoy eso se cumple: el panel **rechaza** cualquier credencial cuyos permisos no reconozca, y solo
reconoce los de futuros. Guardar una clave de la cuenta principal con permiso de traspaso rompe
esa garantía: seguiría sin poder retirar a una cuenta externa, pero sí podría **mover dinero entre
sus cuentas**. Ya no sería cierto que «quien obtuviera las claves no podría mover un dólar».

Es una decisión suya, no mía, y hay dos caminos razonables:

**Camino A — se acepta, con la clave acotada al mínimo.** La clave de la cuenta principal se crea
solo con los permisos de traspaso y lectura de subcuentas, **sin retiro**, y con IP ligada. Se
guarda cifrada igual que las demás. El panel seguiría sin poder sacar dinero a ninguna cuenta
externa; lo que gana es poder repartirlo entre las suyas.

**Camino B — no se acepta.** El traspaso se sigue haciendo a mano en Bitget. El panel podría, si
acaso, **enseñar el reparto** —qué subcuenta tiene cuánto y qué haría falta mover— sin ejecutar
nada. Cuesta bastante menos y no toca la seguridad.

Mi recomendación es el **camino A con la clave acotada**, porque la diferencia real de riesgo es
pequeña frente al trabajo que ahorra; pero conviene que quede por escrito que se decidió a
sabiendas.

### Un detalle práctico del camino A

La clave de la cuenta principal que ya existe tiene **IP ligada**. Hace unos días el panel no
podía usarla porque la IP de este equipo no coincidía; hoy sí. Con una conexión doméstica la IP
suele cambiar sola, y el día que cambie los traspasos dejarán de funcionar con un error de
permisos. Conviene saberlo: o se contrata IP fija, o se asume que hay que actualizar la lista
blanca de vez en cuando.

---

## 5. Requerimientos, para confirmar

Marque los que quiere. Los que se descarten bajan el precio.

**Imprescindibles**

- [ ] **R1.** Ver, en una sola pantalla, el saldo de futuros de cada subcuenta y **cuánto se puede
      sacar de verdad** de cada una.
- [ ] **R2.** Traspasar un importe de una subcuenta a otra de la misma cuenta principal, en el
      monedero de futuros.
- [ ] **R3.** Confirmación previa mostrando origen, destino, importe y **cómo quedan los dos
      saldos** después. El mismo freno que ya tienen las órdenes.
- [ ] **R4.** Registro de lo que se movió, con fecha, importe y resultado por traspaso.

**Opcionales, cada uno suma**

- [ ] **R5. Reparto masivo.** Repartir un importe total entre las subcuentas seleccionadas, a
      partes iguales o dejando a todas con el mismo saldo. *(Es lo que más trabajo ahorra.)*
- [ ] **R6. Recogida masiva.** Devolver el saldo de las subcuentas seleccionadas a la cuenta
      principal, para volver a repartir.
- [ ] **R7.** Contraseña de paso también para los traspasos, como en la apertura de posiciones.

---

## 6. Lo que queda fuera

- Retirar fondos a cualquier destino externo. **No entra, y no entrará.**
- Traspasos entre cuentas principales distintas.
- Traspasos programados o automáticos.
- Conversión entre monedas: se mueve USDT, que es con lo que usted opera.

---

## 7. Estimación

Se calcula con la misma escala del presupuesto firmado, donde cada una de las funciones de
operación salió a unos $2,100.

| Alcance | Duración | Costo estimado |
|---|---|---|
| **Base** — R1 a R4: ver saldos, traspasar de una a otra, confirmar y registrar | 4 a 5 días | **$2,800 MXN** |
| **Con reparto masivo** — añade R5 y R6 sobre las cuentas seleccionadas | +3 días | **+$1,400 MXN** |
| **Camino B** — solo enseñar el reparto, sin ejecutar nada | 2 días | **$1,000 MXN** |

**Total recomendado (base + reparto masivo): $4,200 MXN, poco más de una semana.**

Baja $300 respecto de la estimación anterior, y la razón es su respuesta: al estar el dinero en el
monedero de futuros, el traspaso es una sola operación y la pantalla de saldos se resuelve con una
petición. Aquello valía entre 2 y 3 días de trabajo y ya no hace falta.

El precio incluye, como en las fases anteriores: pruebas automáticas de los casos que salen mal,
prueba física contra Bitget y documento de entrega con guion de validación.

---

## 8. Antes de empezar

Esta función necesita, además de su confirmación:

1. **Una API Key de la cuenta principal** con permiso de traspaso y lectura de subcuentas,
   **sin permiso de retiro**, y con la IP del equipo ligada.
2. Confirmar el camino A o el B de la sección 4, por escrito.

Nada de esto bloquea la Fase 4 ni las siguientes: es un trabajo aparte y se puede hacer cuando
convenga.
