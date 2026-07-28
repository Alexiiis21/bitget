# Panel de Control Bitget (PCB) — Entregable 1: Stack Tecnológico

**Fase 1 · Diseño y arquitectura**
Versión 1.0 · Julio 2026

---

## 0. Resumen ejecutivo de decisiones

| Capa | Decisión | Alternativa obvia que se descarta |
|---|---|---|
| Shell de escritorio | **Electron 43** | Tauri 2 |
| Lenguaje | **TypeScript 6.0** (`strict`, sin `any` en fronteras) | JavaScript / C# |
| Build y dev server | **electron-vite 5 + Vite 7** | Next.js, webpack, CRA |
| UI | **React 19 + Tailwind 4 + Radix Primitives + TanStack Table 8** | MUI, Ant Design, AG Grid |
| Estado (renderer) | **Zustand 5**, como proyección de solo lectura | Redux Toolkit, TanStack Query |
| Estado autoritativo | **`PositionStore` en el proceso principal** | Estado en el renderer |
| HTTP | **undici 8** con `Pool` dedicado por host | axios, `fetch` global |
| WebSocket | **ws 8** con pool propio | socket.io, SDK de terceros |
| Cliente Bitget | **Propio, ~10 endpoints** | `bitget-api` (npm) |
| Persistencia | **Archivos: `vault.enc` + `config.json` + JSONL** | SQLite / better-sqlite3 |
| Cifrado | **AES-256-GCM + scrypt(contraseña maestra) + DPAPI** | Solo `safeStorage` |
| Aritmética | **decimal.js + strings extremo a extremo** | `number` (float64) |
| Validación | **Zod 4 en cada frontera de entrada** | Confiar en los tipos de TS |
| Cola de ejecución | **Propia: token buckets por UID + bucket global de IP** | p-queue, Bottleneck |
| Testing | **Vitest 4 + exchange simulado + Playwright** | Jest |
| Empaquetado | **electron-builder, target `portable`** | NSIS con asistente |

Tu hipótesis (Electron + React + TypeScript + SQLite) se confirma en tres de cuatro
elementos. **Descarto SQLite** por razones que desarrollo en §6, y agrego dos decisiones
que no estaban en la hipótesis y que son las que realmente definen si el producto
funciona: el pool de conexiones con presupuesto de IP (§8) y la idempotencia por
`clientOid` (§9).

---

## 1. Dos hallazgos que preceden a cualquier decisión de stack

Antes del stack: la investigación de la API de Bitget arrojó dos restricciones que
contradicen supuestos del pliego. Ninguna invalida el proyecto, pero ambas cambian el
diseño y una cambia el alcance. Las pongo primero porque condicionan todo lo demás.

### Hallazgo 1 — Con 5 juegos de credenciales no se puede operar 100 cuentas

El pliego dice: *"Cada cuenta principal aporta sus propias credenciales (API Key, Secret
Key, Passphrase)"*, es decir 5 juegos. Esto no es suficiente.

En Bitget, **cada subcuenta tiene su propio UID y requiere su propia API key**. Una API
key de cuenta madre no puede colocar órdenes sobre una subcuenta: solo las cuentas de
tipo *broker* tienen esa capacidad, y son un producto institucional distinto. Para
operar ~100 cuentas hacen falta ~100 juegos de credenciales.

Hay dos caminos, y el diseño soporta ambos sin retrabajo:

- **(a) Alta manual de ~100 juegos.** El operador crea las API keys en la interfaz web de
  Bitget y las registra en el PCB. Cargar 100 juegos a mano en un formulario de tres
  campos es inviable en la práctica, así que el diseño incluye **importación por CSV y
  pegado masivo**, con validación en vivo (cada credencial se prueba contra
  `/api/v2/mix/account/accounts` antes de guardarse).
- **(b) Bootstrap por API.** Con la key de la cuenta madre,
  `POST /api/v2/user/create-virtual-subaccount-apikey` genera programáticamente las keys
  de las subcuentas. **Limitación importante:** aplica solo a *subcuentas virtuales*
  creadas por API, y exige que la key madre esté ligada a una IP fija. Si las 20
  subcuentas por cuenta madre ya existen y fueron creadas desde la web, este camino no
  sirve para ellas.

**Acción requerida:** confirmar con Daniel cómo fueron creadas las subcuentas antes de
cerrar el alcance del módulo de credenciales. El modelo de datos ya contempla N
credenciales por cuenta madre, así que la respuesta no genera retrabajo estructural,
pero sí define si (b) entra en el alcance.

Esto también matiza el no-objetivo *"sin detección automática de subcuentas"*: el PCB no
descubrirá subcuentas por su cuenta, pero sí debe ofrecer alta masiva, o el registro
inicial se vuelve una tarea de varias horas propensa a errores de tipeo.

### Hallazgo 2 — El techo de Bitget es de 100 conexiones WebSocket por IP

Límites publicados por Bitget para WebSocket:

| Límite | Valor |
|---|---|
| Conexiones concurrentes por IP | **100** |
| Solicitudes de conexión por IP | 300 cada 5 minutos |
| Suscripciones por conexión | 240/hora, máx. 1000 canales |
| Ping del cliente | cada 30 s |
| Corte del servidor por falta de ping | 120 s |
| Mensajes aceptados por conexión | 10/s |

Una conexión privada se autentica con **una** credencial. Con el diseño ingenuo —un
socket por cuenta— 100 cuentas consumen exactamente el techo: cero margen. Y lo
verdaderamente peligroso es el segundo límite: si se cae la red y los 100 sockets
reintentan a la vez, se consumen 100 de las 300 solicitudes permitidas en un solo
segundo; tres intentos y la IP queda bloqueada 5 minutos. **Un corte de WiFi de 10
segundos se convertiría en 5 minutos de panel ciego.** Este es el mayor riesgo técnico
del proyecto y está resuelto en §8.

---

## 2. Framework de escritorio: Electron 43

**Elijo Electron. Descarto Tauri 2**, que es la alternativa que un arquitecto debería
plantear en 2026, y explico por qué no aquí.

Tauri gana en lo que suele medirse en los comparativos: binario de ~12 MB contra ~90 MB,
menor consumo de RAM, superficie de ataque más chica al usar el WebView2 del sistema.
Nada de eso decide este proyecto:

1. **El trabajo real no está en la UI, está en el backend embebido.** Este producto es,
   técnicamente, un cliente de red concurrente con ~100 sockets autenticados, firma
   HMAC-SHA256 por request, cola con throttling y una máquina de estados de posiciones.
   En Tauri eso se escribe en Rust. Tu equipo escribe TypeScript. Migrar el componente
   más riesgoso del sistema a un lenguaje que no dominás, en un proyecto con contrato
   firmado, es cambiar riesgo de rendimiento (que no tenés) por riesgo de ejecución
   (que sí importa).
2. **Los recursos no son la restricción.** Una máquina de escritorio moderna corriendo
   una sola aplicación en primer plano, sin ejecución en segundo plano, no tiene
   problema con 200 MB de RAM. Optimizar eso es resolver un problema que no existe.
3. **El código de conectividad se comparte y se testea sin arrancar la app.** Al vivir
   todo en TypeScript, el cliente de Bitget, la cola y el reconciliador se prueban en
   Vitest en milisegundos, sin ventana ni WebView. Con un núcleo en Rust y una UI en TS
   se pierde esa continuidad y aparece una frontera de serialización que hay que
   mantener.
4. **Un dato a favor de Tauri que sí es real:** el exe portable de Electron pesará
   ~90–110 MB. Es feo para distribuir por correo, irrelevante para una herramienta
   interna que se copia una vez a la máquina del operador.

**Descarto también** dos opciones que aparecen en este tipo de proyecto:

- **Servicio Node local + navegador.** Elimina el empaquetado pero deja las credenciales
  al alcance de cualquier pestaña o extensión del navegador, no da control de ventana ni
  arranque limpio, y contradice el requisito de ejecutable portable.
- **.NET WPF / Avalonia.** Es la opción más nativa para Windows y sería la correcta si el
  requisito fuera integración profunda con el sistema operativo. Aquí tira a la basura
  todo el conocimiento del equipo a cambio de una ventana que se ve marginalmente más
  nativa.

### Configuración de seguridad de Electron (no negociable)

```ts
new BrowserWindow({
  webPreferences: {
    contextIsolation: true,      // obligatorio
    nodeIntegration: false,      // obligatorio
    sandbox: true,               // renderer en sandbox del SO
    preload: join(__dirname, '../preload/index.js'),
  },
})
```

Regla de arquitectura que atraviesa todo el proyecto: **el renderer nunca ve una
credencial, nunca abre un socket y nunca hace una request a Bitget.** Todo el I/O vive
en el proceso principal. El renderer recibe estado ya proyectado por IPC y emite
intenciones (`"abrir posición en estas 37 cuentas"`). Si un día una dependencia de UI
resulta comprometida, no hay nada que robar del lado del renderer.

---

## 3. Lenguaje: TypeScript 6.0, modo estricto

> **Corregido el 27 de julio de 2026.** Esta sección declaraba TypeScript 7. Al montar la
> configuración del proyecto, `typescript-eslint` resultó rechazar TS 7 **en tiempo de
> ejecución**, no solo por rango de dependencia: sin él, ESLint no analiza un solo archivo
> `.ts`. Se fija `typescript@~6.0.3`, que es estable y sí está soportado. La ventaja de TS
> 7 es la velocidad de compilación, que en un proyecto de este tamaño no es un cuello de
> botella; perder el análisis estático sobre todo el código sí tiene consecuencias.
> Detalle y plan de reversión en [`adr/0003-typescript-6-no-7.md`](adr/0003-typescript-6-no-7.md).

`typescript@~6.0.3` en modo estricto. Verificado: `npm run typecheck` y `npm run lint`
pasan limpios sobre todo el árbol.

Configuración mínima obligatoria:

```jsonc
{
  "strict": true,
  "noUncheckedIndexedAccess": true,   // arr[i] es T | undefined
  "exactOptionalPropertyTypes": true,
  "noImplicitOverride": true,
  "verbatimModuleSyntax": true
}
```

`noUncheckedIndexedAccess` es el que más molesta y el que más vale: la mayoría de los
crashes en clientes de exchange vienen de asumir que un array de respuesta tiene
elementos.

El riesgo previsto en esta sección —«si algún plugin del ecosistema todavía no soporta TS
7»— se materializó a los tres días, y el reemplazo costó exactamente lo previsto: una
línea del `package.json` y hacer relativas las rutas de `paths`, porque TS 7 había
eliminado `baseUrl`.

---

## 4. UI: React 19 + Tailwind 4 + Radix + TanStack Table

**React 19 + Vite 7 vía electron-vite 5.** Nada de Next.js: no hay servidor, no hay
enrutamiento por archivos, no hay SEO, no hay SSR. Next.js aportaría exclusivamente
complejidad de build.

**Tailwind 4, no MUI ni Ant Design.** El Centro de Monitoreo es una hoja de cálculo
densa: 100 filas, columnas LONG/SHORT, tres números por celda. Las bibliotecas de
componentes Material están diseñadas para lo contrario (mucho aire, componentes altos) y
pelearías contra sus estilos toda la vida del proyecto. Tailwind da control tipográfico y
de espaciado al pixel, que es exactamente lo que pide una vista tabular de alta densidad.

**Radix Primitives para diálogos, selects y tooltips.** Este producto ejecuta órdenes
reales sobre 100 cuentas: el diálogo de confirmación es un componente crítico de
seguridad, y tiene que tener foco atrapado, cierre por Escape, accesibilidad y estado
predecible. Radix es sin estilos, así que se integra con Tailwind sin fricción.

**TanStack Table 8 (headless), no AG Grid.** AG Grid resuelve agrupación, pinning y
filtros de nivel empresarial; acá solo hacen falta agrupación por cuenta madre y
render denso, y solo se muestran tres datos por posición. TanStack Table pesa una
fracción y no impone marcado. **TanStack Virtual** queda instalado pero desactivado: con
~100 filas no hace falta virtualizar; si en el futuro crecen las cuentas, se activa sin
cambiar el modelo de datos.

### Regla de render para no quemar la CPU

Con ~100 cuentas, los eventos de WebSocket pueden llegar en ráfagas de decenas por
segundo. Renderizar en cada evento produce parpadeo y consumo innecesario.

**El proceso principal acumula cambios y emite un lote cada 250 ms** (coalescencia). El
compromiso contractual de 2–5 segundos se cumple con enorme margen, la UI se actualiza de
forma fluida y predecible, y el número de renders queda acotado a 4/segundo pase lo que
pase.

---

## 5. Estado: Zustand en el renderer, autoridad en el principal

La decisión importante no es *cuál* biblioteca de estado, sino **dónde vive la verdad**.

```
[Bitget] → WS/REST → PositionStore (proceso principal) → IPC (lote cada 250ms) → Zustand (renderer) → React
```

- **`PositionStore` en el proceso principal** es la única fuente de verdad: un `Map`
  normalizado con clave `accountId:symbol:holdSide`, con `lastSeenAt` y `source` (`ws` o
  `rest`) por entrada. Ahí ocurren el merge de eventos, la reconciliación y la detección
  de cierres.
- **Zustand en el renderer** es una proyección de solo lectura. No calcula, no deriva
  precios, no promedia. El pliego es explícito: el panel muestra lo que reporta la API.

Por qué Zustand y no las alternativas obvias:

- **Redux Toolkit:** resuelve el problema de coordinar mutaciones complejas desde muchos
  lugares. Acá hay un solo escritor (el stream IPC). Sería ceremonia sin beneficio.
- **TanStack Query:** es excelente y es la respuesta equivocada. Está construido sobre el
  modelo petición/respuesta con caché e invalidación. Acá los datos llegan *empujados*
  por WebSocket. Forzar push dentro de un modelo pull termina en `queryClient.setQueryData`
  por todos lados, que es Zustand con más pasos.

---

## 6. Persistencia: archivos planos. Descarto SQLite.

Es el punto donde más me aparto de tu hipótesis, así que lo justifico en detalle.

**Qué necesita persistir realmente el PCB:**

| Dato | Volumen | Patrón de acceso |
|---|---|---|
| Credenciales cifradas | ~100 registros | Se leen al desbloquear, se escriben al alta |
| Configuración y layout | ~1 KB | Lectura al inicio, escritura ocasional |
| Log de sesión | Append-only | Se escribe siempre, se lee poco |

No hay consultas relacionales. No hay concurrencia de escritores. **El historial
consultable con filtros es un no-objetivo explícito del pliego.** SQLite resolvería
problemas que este producto no tiene, y a cambio traería uno concreto:

**`better-sqlite3` es un módulo nativo.** Requiere recompilación contra los headers de
Electron (`electron-rebuild`), reintroduce toolchain de C++ en la máquina de build, se
rompe en cada actualización de Electron y complica el empaquetado portable
(`asarUnpack`, rutas de `.node`). Sin SQLite, **el proyecto tiene cero dependencias
nativas** y el build portable es reproducible y trivial. Ese es el beneficio real de esta
decisión, y es grande.

**Diseño elegido:**

```
%APPDATA%\PCB\   (o junto al .exe en modo portable)
├── vault.enc            # credenciales — AES-256-GCM
├── config.json          # ajustes y layout — escritura atómica (tmp + rename)
└── logs/
    └── session-20260724.jsonl   # log de sesión, append-only, rotación diaria
```

La escritura atómica (escribir a `.tmp` y `fs.renameSync`) elimina el riesgo de archivo
corrupto por cierre abrupto, que es lo único que SQLite aportaría aquí.

**Criterio de reversión explícito:** si Daniel pide más adelante historial consultable con
filtros por fecha, cuenta y activo, se incorpora `better-sqlite3`. Todo el acceso a disco
pasa por una interfaz `Repository`, así que el cambio queda contenido en una carpeta. La
decisión de hoy es "no pagar por adelantado por una función que el contrato excluye", no
"nunca usar SQLite".

---

## 7. Seguridad de credenciales

Requisitos del pliego: cifradas localmente, nunca visibles completas en la interfaz, sin
permiso de retiro.

### Cifrado en dos capas

```
contraseña maestra ──scrypt(N=2^17, r=8, p=1, salt 32B)──► claveVault (32 B)
                                                              │
vault.enc = AES-256-GCM(claveVault, credenciales) ────────────┘
            │
            └── la claveVault además se envuelve con safeStorage (DPAPI de Windows)
                para la opción "recordar durante esta sesión"
```

**Por qué dos capas y no solo `safeStorage`.** `safeStorage` de Electron usa DPAPI, que
ata el descifrado a la cuenta de Windows: protege contra el robo del archivo, pero
*cualquier proceso corriendo como ese mismo usuario puede pedirle a DPAPI que descifre*.
En una máquina que además navega por internet, eso es una superficie real. La contraseña
maestra cierra ese hueco: sin ella, `vault.enc` es ruido incluso para un proceso local.

**Tensión con el pliego, declarada:** el pliego dice *"sin login ni perfiles"*. Una
contraseña maestra no es un sistema de login (no hay usuarios, ni roles, ni recuperación
por correo): es la llave de una caja fuerte, se pide una vez al abrir la app, y la app
por diseño no corre en segundo plano. **Mi recomendación es incluirla.** Si Daniel
prefiere apertura sin fricción, la alternativa es solo-DPAPI: se documenta el riesgo
residual y se activa por una bandera de configuración. Es una decisión suya, no técnica.

### Reglas operativas

- **`scrypt` nativo de Node**, sin dependencias. Argon2id vía `@noble/hashes` (JS puro,
  auditado, sin módulo nativo) queda como mejora opcional, no como requisito.
- **Enmascaramiento:** la UI solo muestra `BG••••••••4f2a` (primeros 2, últimos 4). El
  valor completo nunca cruza el IPC hacia el renderer, ni siquiera para "copiar".
- **Redacción en logs:** un serializador propio elimina `apiKey`, `secretKey`,
  `passphrase` y cabeceras `ACCESS-*` antes de cualquier escritura o reporte de error.
  Se testea: hay un test que falla si un secreto conocido aparece en la salida de log.
- **Sin telemetría, sin Sentry, sin llamadas de red que no sean a `api.bitget.com` y
  `ws.bitget.com`.** Se aplica una Content-Security-Policy estricta en el renderer.
- **Verificación de permisos al alta:** al registrar una credencial se consulta su
  permiso y **se rechaza cualquier key con permiso de retiro habilitado**, con mensaje
  explicando cómo corregirlo. Es una defensa barata contra un error de configuración
  costoso.
- La memoria que sostiene secretos se sobreescribe (`buffer.fill(0)`) al bloquear.

---

## 8. Conectividad: undici + ws, con pool y presupuesto de IP

### HTTP: undici 8

Un `Pool` dedicado a `api.bitget.com` con `connections: 16`, keep-alive y timeouts
separados de conexión, cabeceras y cuerpo. Frente a axios: axios es una capa de
conveniencia sobre `http` que aquí no aporta nada y esconde el control de agente y
conexiones que sí necesitamos. Frente a `fetch` global: undici es el motor que hay debajo
de `fetch`, pero expuesto con control fino de agentes, timeouts y métricas por request
(latencia por cuenta, que sirve para diagnóstico).

### WebSocket: `ws` 8

Es la implementación estándar de Node y la única con el rendimiento y la estabilidad
requeridos. `socket.io` está descartado de plano: es un protocolo propio, no un cliente
WebSocket.

### Cliente Bitget propio, no el SDK de npm

Existen SDKs comunitarios razonables (`bitget-api`). No los uso como base porque:

1. Necesitamos control total sobre cuándo sale cada request para respetar los buckets de
   rate limit; un SDK que dispara internamente rompe la contabilidad de la cola.
2. Necesitamos los **códigos de error crudos** de Bitget para clasificar fallos por
   cuenta (§9). Los SDKs los envuelven en excepciones genéricas y pierden esa información.
3. Son ~10 endpoints. Es trabajo de días, no de semanas, y queda bajo nuestro control.

El SDK se instala igual **en las pruebas**, como oráculo independiente para contrastar la
firma HMAC y el formato de payloads. Ese es su uso correcto.

### Arquitectura del pool de WebSocket (solución al Hallazgo 2)

```
MAX_WS_CONCURRENTES = 80          # 20% de margen bajo el techo de 100
PRESUPUESTO_CONEXIÓN = 300 / 5min # token bucket global compartido ≈ 1 intento/s
ARRANQUE_ESCALONADO = 5 conexiones/segundo
```

**Niveles de servicio por cuenta:**

- **Caliente (WebSocket).** Cuentas con posiciones abiertas, más las cuentas objetivo de
  la última operación. Suscritas a dos canales: `positions` y `orders-algo` (este último
  es el que entrega los cambios de Take Profit en tiempo real; el canal de posiciones
  **no** trae el precio de TP).
- **Frío (REST).** Cuentas sin posiciones abiertas. Se consultan por REST cada 45 s con
  jitter. Como una cuenta sin posiciones no aporta filas al panel, no se pierde nada
  visible. En cuanto aparece una posición —o el operador opera sobre ella— la cuenta se
  promueve a caliente.

Este esquema mantiene el uso de sockets muy por debajo del techo en la operación normal
(rara vez las 100 cuentas tienen posición simultáneamente) y degrada de forma explícita:
si se superan las 80 cuentas calientes, el panel **muestra un aviso de "modo REST" en
las cuentas afectadas**, nunca degrada en silencio.

**Reconexión con presupuesto global:** todos los reintentos pasan por un único
planificador con token bucket compartido. Backoff exponencial 1→2→4→8→16→30 s con jitter
de ±30%, y como máximo un intento por segundo a nivel global. Un corte de red que tira
100 sockets se recupera en ~20 segundos de forma ordenada, en lugar de provocar un
bloqueo de IP de 5 minutos.

**Heartbeat:** `ping` de texto cada 20 s (el corte del servidor es a los 120 s; 20 s da
seis oportunidades antes de perder la conexión). Si no llega `pong` en 10 s, se destruye
el socket y se encola su reconexión. No se confía en el ping/pong del protocolo: Bitget
usa mensajes de aplicación `"ping"`/`"pong"`.

### Reconciliación REST

Cada 45 s (con jitter, escalonado por cuenta: ~2,2 cuentas/s) se consulta
`/api/v2/mix/position/all-position` por cuenta y se compara contra el `PositionStore`:

- Posición en REST y no en el store → alta (se perdió un evento).
- Posición en store y no en REST → cierre (se elimina; la fila desaparece sin mensaje,
  tal como pide el pliego).
- Divergencia de valores → **gana REST**, y se registra en el log de sesión como
  incidente de deriva. Si la deriva es frecuente, hay un bug de merge y el log lo
  evidencia.

El canal `positions` de Bitget se trata de forma defensiva: cualquier push con
`action: "snapshot"` reemplaza el conjunto completo de la cuenta; con `action: "update"`
se aplica upsert por posición y `total == 0` se interpreta como cierre. Así el
comportamiento es correcto sin depender de una sola lectura de la documentación.

---

## 9. Cola de ejecución, rate limits y fallos parciales

### Límites REST relevantes

| Alcance | Límite |
|---|---|
| Colocar orden | 10 req/s **por UID** |
| Global por IP | ~6.000 req/min (≈100/s) |
| Endpoints públicos | 20 req/s por IP |
| Al excederse | HTTP 429 y **recuperación de 5 minutos** |

El dato clave: **el límite de trading es por UID, y cada subcuenta es un UID distinto.**
Operar 100 cuentas en paralelo no satura el límite por cuenta; el que puede saturarse es
el global de IP. La cola se dimensiona en consecuencia.

### Diseño de la cola

```
ExecutionQueue
├── bucketGlobalIP        : token bucket, 40 req/s   (conservador vs. ~100/s permitidos)
├── bucketPorCuenta[uid]  : token bucket, 8 req/s    (conservador vs. 10/s permitidos)
├── concurrencia          : 12 requests en vuelo
└── política de reintento : solo errores seguros, 3 intentos, backoff + jitter
```

Un job solo sale cuando **ambos** buckets tienen token. Ante un 429 se pausa el bucket
implicado durante el `Retry-After` (o 5 s por defecto) y se reencolan los pendientes; el
panel muestra "limitado por el exchange, reintentando" en lugar de fallar.

Se implementa a medida (~200 líneas) en vez de usar `p-queue` o `Bottleneck` porque
ninguno soporta de forma natural **buckets jerárquicos** (por clave + global) con pausa
selectiva ante 429. Es el corazón del producto: nos conviene tenerlo escrito y testeado
por nosotros.

### Fallos parciales: 80 aciertos y 20 fallos

Esta es la pregunta correcta del pliego, y merece un mecanismo, no un mensaje.

**Un lote (`Batch`) es una entidad de dominio de primera clase.** Cada acción masiva crea
un `Batch` con un `AccountJob` por cuenta, cada uno con esta máquina de estados:

```
pending → queued → sent → confirmed
                       ├→ failed        (motivo clasificado)
                       ├→ skipped       (no aplicable: p. ej. margen cruzado)
                       └→ unknown       (timeout tras enviar — se resuelve, no se reintenta)
```

**Idempotencia por `clientOid`.** Cada job genera un identificador determinista
`pcb-{batchId}-{accountId}`. Si un reintento llega a Bitget después de que la orden
original entró, el exchange **rechaza el duplicado** en lugar de abrir una segunda
posición. Sin esto, cualquier reintento automático es una máquina de duplicar órdenes
con dinero real. Es la pieza de seguridad más importante de todo el sistema.

**El estado `unknown` no se reintenta jamás automáticamente.** Un timeout después de
enviar no dice si la orden entró. Se resuelve *consultando*: se busca el `clientOid` en
`/api/v2/mix/order/detail` y el resultado define si fue `confirmed` o `failed`. Consultar
es seguro; reintentar no lo es.

**Clasificación de errores:**

| Clase | Ejemplos | Comportamiento |
|---|---|---|
| `RETRYABLE` | 429, 5xx, timeout de conexión (antes de enviar) | Reintento automático, máx. 3 |
| `FATAL_ACCOUNT` | Key inválida, sin permiso, margen insuficiente, símbolo no habilitado | Falla esa cuenta, el lote continúa |
| `FATAL_BATCH` | Parámetros inválidos, activo inexistente | **Se aborta antes de enviar nada** |
| `SKIPPED` | Cuenta en margen cruzado para "agregar margen" | No cuenta como fallo |
| `UNKNOWN` | Timeout después de enviar | Se resuelve por consulta |

**Sin rollback automático. Nunca.** Cerrar 80 posiciones porque fallaron 20 aperturas es
peor que el problema original. La respuesta correcta es informar con precisión y dejar la
decisión en manos del operador.

**Chequeo previo (preflight):** antes de enviar nada, se validan parámetros y estado por
cuenta. Si el problema es del lote (activo mal escrito, monto inválido), no sale ni una
sola orden. Esto convierte la clase más común de error humano en un diálogo, no en 100
órdenes equivocadas.

**Reporte:** pantalla de resultado con `80 OK · 20 fallidos · 0 omitidos`, lista por
cuenta con el motivo en español, y un botón **"Reintentar solo los fallidos"** que crea un
lote nuevo con `clientOid` nuevos sobre el subconjunto exacto que falló.

---

## 10. Resolución de los tres puntos de trading

### 10.1 Take Profit por porcentaje: ¿ROE o movimiento de precio?

**Ambos, con ROE por defecto, y confirmando siempre el precio resultante.**

En futuros apalancados "+50%" es ambiguo, y la ambigüedad se paga en dinero. Con
apalancamiento 10x, un TP del 50% sobre ROE está a **5%** de movimiento de precio; sobre
precio, a **50%** —diez veces más lejos—. Un malentendido acá vacía una jornada de
operación.

Fórmulas (`E` = `openPriceAvg` reportado por la API, `L` = `leverage` de la posición,
`P` = porcentaje pedido):

| Modo | LONG | SHORT |
|---|---|---|
| **ROE** (por defecto) | `E × (1 + P/(100·L))` | `E × (1 − P/(100·L))` |
| **Movimiento de precio** | `E × (1 + P/100)` | `E × (1 − P/100)` |

Reglas de implementación:

1. **El operador confirma precios, no porcentajes.** El diálogo muestra, por cuenta:
   entrada, apalancamiento, precio de TP calculado y distancia porcentual real. El
   porcentaje es la entrada; el precio es el contrato.
2. **Redondeo obligatorio** al `pricePlace` / `priceEndStep` del símbolo, obtenidos de
   `/api/v2/mix/market/contracts` y cacheados por sesión. Sin redondear al tick válido,
   Bitget rechaza la orden.
3. **Endpoint:** `POST /api/v2/mix/order/place-tpsl-order` con `planType: "pos_profit"`
   (TP a nivel de posición completa, que es lo correcto ante reposicionamientos, porque
   sigue aplicando a la posición fusionada), `holdSide`, `triggerPrice`,
   `triggerType: "mark_price"`, `productType: "USDT-FUTURES"`.
4. **`mark_price` y no `last_price`** como disparador: evita ejecuciones por mechas
   momentáneas del precio de última operación.
5. Si la posición ya tiene un TP de posición vigente, **se modifica**
   (`modify-tpsl-order`) en lugar de crear un segundo plan.
6. El ROE calculado es **antes de comisiones y financiamiento**. Se declara en la UI con
   una nota al pie. No se estiman comisiones: sería inventar precisión.

*Pendiente de verificación en Fase 1 (spike):* la semántica exacta de `pos_profit` frente
a `profit_plan` en la cuenta demo, y su comportamiento tras una fusión de posiciones.

### 10.2 Agregar margen: solo en aislado

`POST /api/v2/mix/account/set-margin` funciona **únicamente** con `marginMode: isolated`.

El dato ya está disponible sin consultas extra: `marginMode` viene en cada posición, tanto
por el canal `positions` como por `all-position`. Por lo tanto:

- El selector de cuentas **deshabilita visualmente** las cuentas en margen cruzado, con el
  motivo visible: *"Margen cruzado — no admite agregar margen"*.
- Si se ejecuta igual sobre una selección mixta, esas cuentas se reportan como
  **`skipped`, no como `failed`**. La distinción importa: un lote "45 OK · 0 fallidos · 12
  omitidos" es un éxito, no un incidente.
- **El PCB nunca cambia el modo de margen automáticamente.** `change-margin-mode` falla
  con posiciones abiertas, y cambiar el modo altera el perfil de riesgo de la cuenta. Eso
  es una decisión del operador en Bitget, fuera del alcance.

### 10.3 Apalancamiento con posiciones abiertas

`POST /api/v2/mix/account/set-leverage`. En margen aislado el apalancamiento se fija por
lado (`holdSide`); en cruzado aplica a ambos.

Con posiciones abiertas, el cambio **recalcula el precio de liquidación** y Bitget puede
rechazarlo: bajar el apalancamiento exige más margen (error de margen insuficiente) y
subirlo puede chocar contra los límites de posición por nivel de riesgo.

Diseño:

- El preflight separa la selección en **"sin posición abierta"** (cambio seguro) y **"con
  posición abierta"** (cambio que mueve la liquidación), y el diálogo lo dice con números:
  *"12 cuentas sin posición · 25 cuentas con posición abierta: su precio de liquidación
  cambiará"*.
- **Nunca hay reintento automático** en esta acción, ni siquiera ante 5xx: un cambio de
  apalancamiento aplicado dos veces sobre estados distintos es imprevisible. Se reporta y
  el operador decide.
- Los códigos de error de Bitget se traducen a mensajes accionables en español
  (*"Margen insuficiente para 5x: la cuenta necesita X USDT adicionales"*).

---

## 11. Testing

**Vitest 4** como corredor único (mismo pipeline que Vite, sin configuración duplicada).
Jest queda descartado: en un proyecto Vite es infraestructura paralela sin beneficio.

Tres niveles, con el peso en el segundo:

1. **Unitarios.** Cálculo de TP (tabla de casos por modo, lado, apalancamiento y
   redondeo), token buckets, backoff, firma HMAC, redacción de secretos, cifrado del
   vault.
2. **Integración contra un exchange simulado.** Un servidor local (REST + WebSocket) que
   imita a Bitget y —esto es lo importante— **sabe portarse mal**: corta sockets a
   mitad de un push, devuelve 429 con `Retry-After`, responde con latencia de 8 segundos,
   entrega snapshots inconsistentes, acepta la orden pero corta antes de responder (el
   caso `unknown`). Los escenarios difíciles del pliego —caída y reconexión, fallo
   parcial 80/20, deriva entre WS y REST— se testean aquí, de forma determinista y en
   segundos. **Este es el conjunto de pruebas que decide si el producto es confiable.**
3. **E2E con Playwright** (soporte nativo de Electron): abrir la app, desbloquear el
   vault, ver el panel poblado, ejecutar un lote, verificar el diálogo de confirmación y
   la pantalla de resultado.

**Validación en producción con Zod 4** en cada frontera: toda respuesta de Bitget se
valida antes de entrar al `PositionStore`. Si Bitget cambia un campo, el sistema falla
con un mensaje claro en vez de mostrar `undefined` donde va un precio de liquidación.

**Trading demo antes que dinero real.** Toda la Fase 3 se prueba contra el entorno demo
de Bitget, y la primera operación real se hace con el monto mínimo del contrato en una
sola cuenta antes de habilitar ejecución masiva.

---

## 12. Empaquetado

**electron-builder con target `portable`**: un único `.exe` sin asistente de instalación,
tal como pide el pliego.

Dos detalles que hay que resolver desde el inicio:

1. **El target `portable` se autoextrae en una carpeta temporal en cada arranque.** Si se
   guardan los datos en la ruta de la app, se pierden al cerrar. El PCB usa la variable
   `PORTABLE_EXECUTABLE_DIR` para guardar `vault.enc`, `config.json` y los logs **junto al
   `.exe`**. Así la carpeta del programa es también la copia de seguridad: se copia
   entera a un pendrive y las credenciales viajan con ella (y siguen cifradas).
2. **Firma de código.** Un `.exe` sin firmar dispara la advertencia de Windows SmartScreen
   ("Windows protegió su PC"), lo que en una herramienta que administra credenciales de
   trading es una mala primera impresión. Recomiendo un certificado OV de firma de código
   (~200–400 USD/año). Si Daniel prefiere no incurrir en ese costo, se documenta el
   procedimiento para el primer arranque; es una decisión comercial suya.

Como no hay dependencias nativas, el empaquetado es determinista: `asar` completo, sin
`asarUnpack`, sin recompilaciones.

---

## 13. Estructura de carpetas

```
pcb/
├── electron.vite.config.ts
├── electron-builder.yml
├── package.json
├── tsconfig.json  ·  tsconfig.node.json  ·  tsconfig.web.json
├── eslint.config.mjs  ·  .prettierrc  ·  vitest.config.ts  ·  playwright.config.ts
│
├── src/
│   ├── main/                          # Proceso principal — TODO el I/O y los secretos
│   │   ├── index.ts                   # arranque, ventana, ciclo de vida
│   │   ├── ipc/
│   │   │   ├── handlers.ts            # handlers tipados (invoke)
│   │   │   └── publisher.ts           # push al renderer, coalescido a 250 ms
│   │   ├── bitget/
│   │   │   ├── rest/
│   │   │   │   ├── client.ts          # undici Pool, timeouts, métricas
│   │   │   │   ├── signer.ts          # HMAC-SHA256, cabeceras ACCESS-*
│   │   │   │   └── endpoints/         # positions, orders, plan, account, market
│   │   │   ├── ws/
│   │   │   │   ├── connection.ts      # un socket: login → suscripción → heartbeat
│   │   │   │   ├── pool.ts            # presupuesto de IP, niveles caliente/frío
│   │   │   │   ├── heartbeat.ts
│   │   │   │   └── backoff.ts         # exponencial + jitter, bucket compartido
│   │   │   ├── schemas/               # esquemas Zod de todas las respuestas
│   │   │   └── errors.ts              # códigos Bitget → clases de error + español
│   │   ├── execution/
│   │   │   ├── queue.ts               # cola con buckets jerárquicos
│   │   │   ├── rate-limiter.ts        # token bucket (por UID y global de IP)
│   │   │   ├── retry.ts               # política por clase de error
│   │   │   └── batch-runner.ts        # ciclo de vida del lote y de cada job
│   │   ├── domain/
│   │   │   ├── position-store.ts      # fuente de verdad, Map normalizado
│   │   │   ├── reconciler.ts          # cotejo REST ↔ WS cada 45 s
│   │   │   ├── tp-calculator.ts       # ROE vs. precio, redondeo a tick
│   │   │   ├── account-registry.ts    # cuentas madre, subcuentas, niveles
│   │   │   └── symbol-catalog.ts      # contratos, pricePlace, tamaños mínimos
│   │   ├── security/
│   │   │   ├── vault.ts               # AES-256-GCM, apertura y cierre
│   │   │   ├── kdf.ts                 # scrypt + safeStorage
│   │   │   └── redact.ts              # saneamiento de secretos en logs
│   │   ├── storage/
│   │   │   ├── config-repo.ts
│   │   │   ├── session-log.ts         # JSONL con rotación
│   │   │   ├── atomic-write.ts
│   │   │   └── paths.ts               # PORTABLE_EXECUTABLE_DIR vs. APPDATA
│   │   └── services/                  # un caso de uso por función del pliego
│   │       ├── open-position.service.ts
│   │       ├── close-position.service.ts
│   │       ├── take-profit.service.ts
│   │       ├── add-margin.service.ts
│   │       └── set-leverage.service.ts
│   │
│   ├── preload/
│   │   ├── index.ts                   # contextBridge, superficie mínima
│   │   └── api.ts                     # API tipada expuesta al renderer
│   │
│   ├── renderer/
│   │   ├── index.html
│   │   └── src/
│   │       ├── main.tsx  ·  App.tsx
│   │       ├── features/
│   │       │   ├── monitor/           # Centro de Monitoreo (pantalla principal)
│   │       │   │   ├── MonitorGrid.tsx
│   │       │   │   ├── AccountGroup.tsx
│   │       │   │   ├── PositionCell.tsx    # liquidación · entrada · TP
│   │       │   │   └── useMonitorStream.ts
│   │       │   ├── accounts/          # alta de credenciales, import CSV, estado
│   │       │   ├── actions/           # las 5 acciones + selector + confirmación
│   │       │   │   ├── ActionBar.tsx
│   │       │   │   ├── AccountSelector.tsx
│   │       │   │   ├── ConfirmDialog.tsx   # componente crítico de seguridad
│   │       │   │   └── BatchResult.tsx     # OK · fallidos · omitidos
│   │       │   └── log/               # log de sesión
│   │       ├── components/ui/         # primitivos sobre Radix + Tailwind
│   │       ├── store/                 # slices de Zustand (proyección)
│   │       ├── lib/                   # formateo de números, atajos de teclado
│   │       └── styles/
│   │
│   └── shared/                        # compartido entre los tres procesos
│       ├── types/                     # Position, Account, Batch, JobResult…
│       ├── ipc-contract.ts            # canales y payloads tipados
│       └── constants.ts               # límites, intervalos, umbrales
│
├── test/
│   ├── unit/
│   ├── integration/
│   ├── e2e/
│   ├── mock-exchange/                 # Bitget simulado, incluye modo "portarse mal"
│   └── fixtures/                      # respuestas reales capturadas (anonimizadas)
│
├── resources/                         # íconos, activos del build
└── docs/
    ├── 01-stack-tecnologico.md
    ├── 02-arquitectura.html
    ├── 03-modelo-de-datos.md
    ├── 04-wireframes.html
    ├── cliente/                       # documentos entregados al cliente
    └── adr/                           # registro de decisiones de arquitectura
```

**Lógica de la estructura:** `src/main/` está organizado por *capacidad técnica*
(bitget, execution, domain, security, storage) porque ahí el riesgo es técnico;
`src/renderer/src/features/` está organizado por *función del producto* porque ahí el
riesgo es de producto. `src/shared/` contiene solo tipos y contratos: si algo con
comportamiento aparece ahí, es una señal de que se filtró lógica hacia el renderer.

---

## 14. Riesgos abiertos y spikes de Fase 1

Trabajo de verificación a ejecutar contra la cuenta demo de Bitget **antes** de cerrar la
arquitectura. Cada uno tiene una respuesta que cambia decisiones, y por eso son spikes y
no supuestos:

| # | Pregunta | Impacto si la respuesta es la desfavorable |
|---|---|---|
| 1 | ¿Las subcuentas ya existentes fueron creadas por web o por API? | Define si el bootstrap de keys entra al alcance o hay que cargar ~100 juegos a mano |
| 2 | ¿Una conexión WS admite `login` con varias credenciales? | Si admite, la capacidad de sockets deja de ser un problema; si no, el esquema caliente/frío es obligatorio |
| 3 | Semántica exacta de `pos_profit` vs. `profit_plan` tras una fusión de posiciones | Define el endpoint del Take Profit por porcentaje |
| 4 | ¿El canal `positions` empuja cierres explícitos o solo omite la posición? | Ajusta la regla de eliminación de filas (la reconciliación cubre ambos casos) |
| 5 | Límite real de IP medido con cabeceras de respuesta bajo carga de 100 cuentas | Calibra los buckets de la cola |
| 6 | ¿`set-leverage` con posición abierta se rechaza o se acepta? | Define el texto y la severidad de la advertencia previa |

---

## 15. Dependencias iniciales

Ver [`package.json`](../package.json). Criterios aplicados:

- **Cero dependencias nativas.** Ningún paquete requiere compilación de C++; el build
  portable es reproducible en cualquier máquina.
- **Runtime mínimo en `dependencies`.** Solo lo que ejecuta el proceso principal sin
  empaquetar (`ws`, `undici`, `zod`, `decimal.js`, `electron-log`, `nanoid`). Todo lo del
  renderer va en `devDependencies` porque Vite lo empaqueta: mantiene el `.exe` chico y el
  árbol de `node_modules` fuera del artefacto final.
- **Sin biblioteca de fechas, sin lodash, sin axios.** `Intl.DateTimeFormat`, los métodos
  nativos de array y `undici` cubren todo lo necesario.
