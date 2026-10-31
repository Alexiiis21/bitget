# Propuesta — Estrategias por grupos con reposicionamiento automático, e historiales de operación

**Panel de Control Bitget (PCB)** · 30 de octubre de 2026
Funciones adicionales, fuera del presupuesto firmado.

---

## 1. Resumen

| Parte | Qué es | Duración | Costo |
|---|---|---|---|
| **A** | Historiales: órdenes TP, ejecuciones y cambios de TP/SL | 6 a 7 días | **$3,500 MXN** |
| **B** | Estrategias por grupos (A, B, C…) con reposicionamiento automático | 4 a 5 semanas | **$12,500 MXN** |
| | **Las dos juntas** | **5 a 6 semanas** | **$15,500 MXN** |

Contratadas juntas cuestan $500 menos que por separado, porque comparten trabajo. El historial
de ejecuciones (A2) lee de Bitget los mismos datos que el motor de la parte B necesita para
confirmar que un TP se ejecutó de verdad y para detectar las ejecuciones parciales. Se construyen
una sola vez.

---

## 2. Parte A — Historiales de operación

| # | Función | Qué muestra | Duración | Costo |
|---|---|---|---|---|
| A1 | **Historial de órdenes TP** | A qué precio quedó configurado el TP de cada posición | 1 a 1.5 días | $800 |
| A2 | **Historial de ejecuciones** | Precio, hora y cantidad reales de cada apertura y cada cierre | 2 a 3 días | $1,500 |
| A3 | **Historial de cambios de TP/SL** | Cuándo se puso, se cambió, se canceló o se ejecutó cada TP | 2 a 3 días | $1,500 |
| | **Las tres juntas** | | **6 a 7 días** | **$3,500** |

**Por qué A1 es la más barata.** El panel ya lee los planes TP de Bitget para relacionarlos con
cada posición cerrada. Lo que falta es guardarlos y mostrarlos como historial.

**Un límite de A3 que conviene saber.** Los cambios de TP hechos **desde el panel** quedan
completos, porque el panel ya anota cada orden que envía a Bitget. Los cambios hechos
**directamente en la app de Bitget** no quedan registrados de la misma forma, porque Bitget no
entrega un registro de modificaciones. De ellos solo se sabe cuándo se creó, se canceló o se
ejecutó cada plan, pero no los pasos intermedios.

Las tres funciones cubren las cuentas en modo clásico (V2) y en cuenta unificada (UTA).

---

## 3. Parte B — Estrategias por grupos

### 3.1 Lo que se pide

Configurar una estrategia por grupo una sola vez: activo, modo LONG/SHORT/AMBOS, precio de
apertura, MI inicial y de reposicionamiento, margen, TP, niveles LIMIT y límites de
reposicionamiento. Después, el panel la ejecuta solo con un botón INICIAR: abre, coloca las
órdenes LIMIT, vigila los TP y, después de cada TP, reposiciona el siguiente tramo hasta llegar al
límite. Todo con PAUSAR, DETENER, recuperación tras un reinicio y registro de cada acción.

### 3.2 Lo que ya existe y se aprovecha

Buena parte de lo que el motor necesita ya está construido y probado contra Bitget:

- Órdenes de mercado y LIMIT, en V2 y en UTA.
- Take Profit por porcentaje, calculado sobre la posición real.
- Margen cruzado o aislado y apalancamiento por cuenta.
- Modo cobertura (hedge), que es el que permite tener LONG y SHORT abiertos a la vez.
- Ejecución sobre muchas cuentas a la vez, respetando los límites de peticiones de Bitget.
- Conexión en tiempo real con Bitget y reconexión automática.
- Tope de margen inicial: también se aplicará a las aperturas automáticas.

**Lo nuevo** es el motor que decide solo: guardar el estado de cada grupo, saber qué tramo va,
no duplicar órdenes y retomar donde se quedó después de un corte.

### 3.3 Desglose

Sigue las cuatro fases del documento de especificaciones.

| Fase | Contenido | Duración | Costo |
|---|---|---|---|
| **B1. Configuración** | Pantalla de grupos, los 13 parámetros con sus validaciones, cuentas asignadas a cada grupo, guardado y recuperación, botones y estado de cada grupo | 4 a 5 días | $2,500 |
| **B2. Ejecución** | Apertura inicial LONG y SHORT en las cuentas del grupo, órdenes LIMIT preestablecidas, vigilancia de posiciones y TP con datos reales de Bitget | 5 a 6 días | $3,500 |
| **B3. Automatización** | Reposicionamiento por tramos, límites estrictos e independientes por lado, protección contra duplicados, ejecuciones parciales, PAUSAR y DETENER, recuperación tras un reinicio y conciliación con Bitget | 7 a 8 días | $4,500 |
| **B4. Validación** | Pruebas con importes mínimos, cortes de conexión y reinicios a mitad de un tramo, comprobación de que ningún tramo pasa los límites, documento de entrega con guion de validación | 3 a 4 días | $2,000 |
| | **Total parte B** | **4 a 5 semanas** | **$12,500** |

**Por qué B3 es la fase más cara.** Es la que mueve dinero sin que nadie apriete un botón. Un
error ahí no se traduce en una pantalla mal dibujada, sino en una orden duplicada o en un tramo
fuera de límites. Cada caso que puede salir mal lleva su prueba automática.

### 3.4 Lo que hay que definir antes de empezar

El documento de especificaciones deja abiertos algunos puntos que cambian cómo se construye el
motor. Se resuelven en una sola conversación antes de arrancar:

1. **¿A qué distancia va cada tramo?** El documento dice «siguiente tramo», pero no a qué precio
   se reposiciona después de un TP. Por ejemplo: al mismo precio de apertura, al precio del TP
   ejecutado o a un paso fijo en USDT o en %.
2. **¿El TP de 35% es sobre el ROE**, como en el panel hoy, **o sobre el movimiento del precio?**
   Se asume ROE, que es lo que el panel ya calcula.
3. **¿La apertura inicial de 82,500 es una orden LIMIT a ese precio, o se abre a mercado** al
   iniciar si el precio está cerca?
4. **Cuando se ejecuta la LIMIT de 85,000 (SHORT) u 80,000 (LONG)**, ¿esa posición lleva su
   propio TP de 35% y entra en la secuencia de tramos, o queda aparte?
5. **¿Una misma cuenta puede estar en dos grupos con el mismo activo?** Se propone que **no**.
   Bitget suma en una sola posición todo lo que una cuenta tiene en el mismo activo y lado, así
   que dos grupos sobre la misma cuenta y el mismo activo se pisarían los TP entre sí.
6. **Al DETENER, ¿qué opciones se ofrecen?** Se propone: dejar todo como está, cancelar solo las
   órdenes pendientes o cancelar las pendientes y cerrar las posiciones. Las dos últimas, siempre
   con confirmación.

Si alguna respuesta añade comportamiento que no está en el documento, se cotiza aparte antes de
hacerlo.

### 3.5 Una condición importante: el panel tiene que estar abierto

El panel es una aplicación de escritorio. **La estrategia avanza solo mientras el panel está
abierto y el equipo encendido y con internet.** Si se apaga el equipo:

- Lo que ya está en Bitget sigue protegido: los TP y las órdenes LIMIT viven en Bitget y se
  ejecutan aunque el panel esté cerrado.
- Lo que no ocurre son los **reposicionamientos**: los decide el panel. Al volver a abrirlo,
  el panel concilia con Bitget, detecta los TP que se ejecutaron mientras estaba cerrado y
  pregunta antes de reposicionar. Así evita abrir de golpe tramos a precios que ya no tienen
  sentido.

Si se quiere que la estrategia corra las 24 horas sin depender de un equipo encendido, hace
falta un servidor. Eso es un proyecto distinto y **no entra en esta cotización**.

### 3.6 Lo que queda fuera

- Ejecución en un servidor 24/7 (ver 3.5).
- Stop Loss automático por grupo. El documento no lo pide; se puede cotizar aparte.
- Reglas que conecten LONG con SHORT. El documento pide que sean independientes.
- Activos distintos de futuros USDT-M.

---

## 4. Condiciones

- Como en las fases anteriores, el precio incluye pruebas automáticas de los casos que salen
  mal, pruebas reales contra Bitget y documento de entrega con guion de validación.
- Las pruebas de la parte B se hacen **con dinero real en una subcuenta de prueba, con importes
  mínimos**, salvo que se confirme que Bitget ofrece cuenta demo para la cuenta unificada (UTA). Las pérdidas o
  comisiones de esas pruebas corren por cuenta del cliente; con MI de 0.10 USDT son de centavos.
- La parte A se puede entregar primero e independiente: está lista en poco más de una semana.
- La parte B se entrega por fases (B1 → B4), con una demostración al final de cada una.
