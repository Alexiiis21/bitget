# Prompt para Claude — Cotización: estrategias por grupos e historiales

Copia todo lo que está debajo de la línea y pégalo en Claude. Adjunta también el archivo
`cotizacion-estrategias-por-grupos-e-historiales.md` (el borrador de la cotización).

---

Necesito tu ayuda para revisar y dejar lista una cotización que le voy a enviar a mi cliente. Te
doy todo el contexto abajo. Adjunto el borrador actual.

## Quién soy y qué es el proyecto

Soy desarrollador independiente en México. Desde julio de 2026 construyo para un cliente (Daniel)
el **Panel de Control Bitget (PCB)**: una aplicación de escritorio (Electron + React + TypeScript)
para operar futuros USDT-M en muchas subcuentas de Bitget a la vez (decenas, hasta ~100). Funciona
con cuentas clásicas (API V2) y con la cuenta unificada (UTA, API V3).

## Lo que el panel ya hace (entregado y probado contra Bitget real)

- Abrir posiciones a mercado y LIMIT en muchas cuentas a la vez, respetando los límites de
  peticiones de Bitget.
- Take Profit por porcentaje (sobre ROE), calculado con la posición real.
- Agregar lotes, cerrar posiciones, margen cruzado/aislado y apalancamiento por cuenta.
- Modo cobertura (hedge): LONG y SHORT abiertos a la vez en la misma cuenta.
- Conexión en tiempo real (WebSocket) con reconexión automática.
- Historial de posiciones cerradas, enlazado con el TP que tenía cada una (lee los planes TP/SL
  de Bitget).
- Una bitácora que registra cada orden y cada cambio que el panel envía a Bitget.
- Alertas por Telegram de lo que se hace fuera del panel.
- Traspasos de saldo entre subcuentas.
- Tope de margen inicial por panel, fijo durante 24 horas (freno contra errores de captura).

## Mis tarifas anteriores (todas en MXN, aceptadas por el cliente)

| Trabajo | Duración | Precio |
|---|---|---|
| Fase 1 | 1 semana | $3,500 |
| Fase 2 | 2–3 semanas | $5,000 |
| Fase 3 | 1 semana | $3,000 |
| Fase 4 (5 funciones de operación: apertura, cierre, TP, margen/apalancamiento, pantalla) | 3–4 semanas | $10,500 |
| Traspasos entre subcuentas (base) | 4–5 días | $2,800 |
| Traspasos, reparto masivo | +3 días | +$1,400 |

En promedio sale a unos **$550–700 MXN por día de trabajo**. Cada precio incluye pruebas
automáticas, pruebas reales contra Bitget y un documento de entrega con guion de validación.

## Lo que el cliente pide ahora (dos cosas)

### Parte A — Historiales

1. **Historial de órdenes TP:** a qué precio quedó configurado el TP de cada posición.
2. **Historial de ejecuciones:** precio, hora y cantidad reales de cada cierre (y apertura).
3. **Historial de modificaciones TP/SL:** si el TP se mantuvo, se modificó, se canceló o se
   ejecutó.

Lo que importa técnicamente:
- El (1) es casi gratis: el panel ya lee los planes TP de Bitget.
- El (2) necesita un endpoint nuevo de Bitget (historial de ejecuciones/fills) en V2 y V3, con
  paginación, almacenamiento y pantalla.
- El (3) tiene un límite real: Bitget **no** entrega un registro de modificaciones. Los cambios
  hechos desde el panel sí quedan completos (gracias a la bitácora). Los hechos directamente en
  la app de Bitget solo se pueden reconstruir parcialmente (creado / cancelado / ejecutado).

### Parte B — Estrategias por grupos con reposicionamiento automático

El cliente mandó estas especificaciones (texto íntegro):

<especificaciones>
# ESPECIFICACIONES DE DESARROLLO
## Panel Multicuentas Bitget — Configuración por grupos y reposicionamiento automático

### 1. OBJETIVO GENERAL
Implementar una nueva funcionalidad en el panel multicuentas de Bitget que permita configurar
estrategias de trading mediante grupos independientes (A, B, C, D, etc.), guardar sus parámetros y
ejecutar cada estrategia mediante un botón de inicio.

El objetivo es que el usuario configure los parámetros una sola vez y que el panel administre
automáticamente la apertura inicial, las órdenes LIMIT preestablecidas, los Take Profit (TP) y los
reposicionamientos sucesivos, respetando los límites definidos para LONG y SHORT.

La estrategia deberá ejecutarse automáticamente sin requerir intervención manual en cada tramo.

### 2. ORGANIZACIÓN POR GRUPOS
Grupos independientes identificados por letras (A, B, C, D y los que admita la arquitectura).
Cada grupo deberá contar con: configuración independiente de parámetros; guardado y recuperación
de la configuración; botones INICIAR, PAUSAR y DETENER; indicador del estado de ejecución;
visualización de las órdenes y posiciones correspondientes; registro de TP, ejecuciones y
reposicionamientos. Los parámetros de un grupo no deberán modificar los de otro. Cada grupo
ejecuta su propia lógica con sus valores y las cuentas o subcuentas que tenga asignadas.

### 3. PARÁMETROS CONFIGURABLES
| Parámetro | Ejemplo |
|---|---|
| Activo | BTC/USDT |
| Modo operativo | AMBOS: LONG + SHORT |
| Precio de apertura inicial | 82,500 USDT |
| MI inicial | 0.10 USDT |
| MI de reposicionamiento | 0.10 USDT |
| Tipo de margen | Cruzado |
| Take Profit | 35% |
| Tipo de orden | LIMIT |
| Nivel preestablecido de activación LIMIT SHORT | 85,000 USDT |
| Límite inferior de reposicionamiento SHORT | 81,000 USDT |
| Nivel preestablecido de activación LIMIT LONG | 80,000 USDT |
| Límite superior de reposicionamiento LONG | 84,000 USDT |
| Reposicionamiento automático | Activado |

Todos los valores deberán poder editarse antes de iniciar. El sistema deberá distinguir entre el
precio de apertura inicial, los niveles de activación LIMIT y los límites de reposicionamiento.

Nota técnica: deberá conservarse el significado de MI utilizado actualmente en el panel y
validarse cómo se traduce a cantidad, margen y tamaño de posición según Bitget.

### 4. BOTÓN DE INICIO
Al presionar INICIAR: (1) validar parámetros; (2) comprobar conexión con Bitget y cuentas
asignadas; (3) verificar configuración de margen; (4) guardar copia de los parámetros de esa
ejecución; (5) abrir posiciones iniciales LONG y SHORT; (6) registrar las órdenes LIMIT
preestablecidas; (7) activar la supervisión automática del TP y del reposicionamiento; (8) mostrar
el estado del grupo. Si una validación falla, informar y no iniciar parcialmente sin que el
usuario conozca el estado resultante.

### 5. APERTURA INICIAL
Ejemplo grupo A: BTC/USDT con precio de referencia 82,500, modo AMBOS, MI inicial 0.10, margen
cruzado. El 82,500 no deberá confundirse con los niveles LIMIT de 85,000 y 80,000. La apertura
deberá respetar las reglas de Bitget y la definición de entrada del panel.

### 6. LÓGICA SHORT
Parámetros: precio de apertura inicial; LIMIT SHORT 85,000; límite inferior de
reposicionamiento 81,000.
- 6.1 Mercado baja: confirmar cada TP del 35%; después de cada TP, reposicionar el siguiente tramo
  con el MI de reposicionamiento; repetir sin intervención; no generar tramos SHORT por debajo de
  81,000.
- 6.2 Mercado sube: al llegar a 85,000, activar/ejecutar la orden LIMIT SHORT de ese nivel, de
  forma independiente de la secuencia de reposicionamientos y sin duplicar órdenes.

### 7. LÓGICA LONG
Misma estructura, inversa. Parámetros: precio de apertura inicial; LIMIT LONG 80,000; límite
superior de reposicionamiento 84,000.
- 7.1 Mercado sube: confirmar cada TP del 35%, reposicionar el siguiente tramo; no generar tramos
  LONG por encima de 84,000.
- 7.2 Mercado baja: al llegar a 80,000, activar/ejecutar la LIMIT LONG, sin duplicaciones y
  controlando su estado real en Bitget.

### 8. REPOSICIONAMIENTO AUTOMÁTICO POR TRAMOS
El motor deberá: supervisar posiciones; detectar y confirmar el TP; identificar la dirección;
determinar el siguiente tramo permitido; verificar límites; ejecutar con el MI configurado;
registrar y actualizar la interfaz; continuar supervisando. Automático y persistente. LONG y SHORT
independientes; un TP de un lado no autoriza modificar el otro.

### 9. REGLAS DE CONTROL
Confirmar el TP con el estado real en Bitget; evitar que un TP genere varios reposicionamientos;
identificar cada tramo con un registro único; controlar ejecuciones parciales; verificar límites
antes de cada orden; no confundir niveles LIMIT con límites de reposicionamiento; detectar órdenes
y posiciones existentes antes de crear otras; recuperar el estado tras desconexión o reinicio;
registrar errores y conciliar con Bitget. Límites estrictos.

### 10. INTERFAZ
Configuración (todos los parámetros), supervisión en tiempo real (precio actual, estado LONG y
SHORT, LIMIT pendientes, posiciones abiertas, TP confirmados, tramos por dirección, último
reposicionamiento, próximo nivel, errores y alertas) y controles (INICIAR, PAUSAR, DETENER,
EDITAR). Los cambios a una estrategia activa solo bajo reglas explícitas y con conciliación previa.

### 11. PAUSA Y DETENCIÓN
PAUSAR suspende nuevas acciones automáticas y conserva el estado. DETENER detiene el avance
automático sin cerrar posiciones ni cancelar órdenes sin instrucción expresa; el panel deberá
permitir definir qué hacer con lo existente.

### 12. RESULTADO ESPERADO
Estrategias independientes por grupos, iniciadas con un botón, que operan por tramos
automáticamente respetando límites y registrando todo.

### 13. ORDEN RECOMENDADO
Fase 1 Configuración (grupos, parámetros, guardado, botones) · Fase 2 Ejecución (apertura
inicial, LIMIT preestablecidas, supervisión de posiciones y TP) · Fase 3 Automatización
(reposicionamiento, límites, anti-duplicados, recuperación) · Fase 4 Validación (demo o
simulación, parciales, desconexión y recuperación, límites). Integrarse con la arquitectura
multicuentas existente sin comprometer lo actual.
</especificaciones>

## Mi análisis técnico (ya considerado en el borrador)

- **Se reutiliza mucho:** órdenes LIMIT, TP, margen, modo hedge, ejecución multicuenta, WebSocket,
  tope de margen. Lo nuevo es el motor autónomo con estado persistente, anti-duplicados,
  recuperación y conciliación.
- **El panel es de escritorio:** la estrategia solo avanza mientras el panel está abierto. Los TP y
  LIMIT viven en Bitget y se ejecutan igual con el equipo apagado, pero los reposicionamientos los
  decide el panel. Al reabrir, concilia y pregunta antes de reposicionar. Correr 24/7 requiere un
  servidor: queda fuera.
- **Puntos que el documento no define** y que cambian el diseño:
  1. A qué precio va cada tramo después de un TP (el documento nunca lo dice).
  2. Si el TP de 35% es sobre ROE (como el panel hoy) o sobre el precio.
  3. Si la apertura inicial de 82,500 es LIMIT a ese precio o a mercado.
  4. Si la posición abierta por la LIMIT de 85,000 / 80,000 lleva TP y entra en la secuencia.
  5. Si una cuenta puede estar en dos grupos con el mismo activo (propongo que no: Bitget suma la
     posición y los TP se pisarían).
  6. Qué opciones ofrece DETENER (dejar todo / cancelar pendientes / cancelar y cerrar).
- **Pruebas:** con dinero real e importes mínimos en una subcuenta de prueba, salvo que se confirme
  que hay demo para UTA (no está verificado).

## Precios que propongo

| Parte | Duración | Precio |
|---|---|---|
| A1 Historial de órdenes TP | 1–1.5 días | $800 |
| A2 Historial de ejecuciones | 2–3 días | $1,500 |
| A3 Historial de cambios TP/SL | 2–3 días | $1,500 |
| **A completa** | 6–7 días | **$3,500** |
| B1 Configuración | 4–5 días | $2,500 |
| B2 Ejecución | 5–6 días | $3,500 |
| B3 Automatización | 7–8 días | $4,500 |
| B4 Validación | 3–4 días | $2,000 |
| **B completa** | 4–5 semanas | **$12,500** |
| **A + B juntas** | 5–6 semanas | **$15,500** ($500 menos, porque A2 y el motor de B leen los mismos datos de ejecuciones) |

## Lo que te pido

1. Revisa si los precios y tiempos son coherentes con mis tarifas anteriores y con la complejidad
   real (sobre todo B3, que mueve dinero sin intervención). Dime si estoy cobrando de menos o de
   más, con números concretos.
2. Revisa el borrador adjunto: que sea claro para el cliente (no es programador, opera trading),
   que no prometa nada que dependa de las seis preguntas abiertas y que deje bien fijado lo que
   queda fuera.
3. Devuélveme la cotización final en español, lista para enviar, con la misma estructura del
   borrador.

Respóndeme en español, con la conclusión primero.
