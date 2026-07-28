# Panel de Control Bitget (PCB) — Entregable 3: Modelo de datos y persistencia

**Fase 1 · Diseño y arquitectura**
Versión 1.0 · 27 de julio de 2026

> Complementa a [`01-stack-tecnologico.md`](01-stack-tecnologico.md) (§6 Persistencia y §7
> Seguridad de credenciales) y a [`02-arquitectura.html`](02-arquitectura.html). Este
> documento cubre el entregable *"diseño de base de datos local"* del presupuesto y fija
> el esquema exacto de cada archivo antes de escribir código.

---

## 0. Requisitos nuevos que incorpora esta versión

Seis requisitos recibidos del cliente el 26–27 de julio, más la captura del diseño en
Excel. Esta tabla los traduce a impacto sobre el modelo de datos; el detalle está en la
sección indicada.

| # | Requisito del cliente | Impacto en el modelo | §  |
|---|---|---|---|
| 1 | Columna **DISTANCIA L/S** (captura de Excel) | Campo derivado, no persistido. Obliga a definir sobre qué dos precios se calcula | §13.2 |
| 2 | Diseño de Excel **en las pestañas de arriba** | Las pestañas son los grupos (cuenta madre). Se persiste pestaña activa y orden | §9 |
| 3 | Grupos **colapsables** | Se persiste el conjunto de grupos colapsados | §9 |
| 4 | Ver **las 100 cuentas sin mover nada** | Requiere modo de vista y densidad persistidos, y fija un requisito de resolución | §18 |
| 5 | Seleccionar **todas** y **todas las subcuentas** de una madre | La jerarquía madre→subcuenta debe ser explícita y persistente, no inferida | §8 |
| 6 | **PIN de 2 dígitos** + contraseña maestra de recuperación, **una por sistema** | Segunda capa de desbloqueo con envoltura DPAPI y contador de intentos persistido | §6, §7 |
| 7 | **Base de datos local independiente por cada sistema** | Todo el estado vive en una carpeta de instancia, sin nada compartido entre máquinas | §3 |

La captura de Excel obliga además a un hallazgo que cambia la clave primaria de las
posiciones. Va primero porque condiciona todo lo demás.

---

## 1. Hallazgo 3 — El panel opera en modo cobertura (LONG y SHORT a la vez)

En la captura, una misma fila (una cuenta) tiene **columnas de LONG y columnas de SHORT
simultáneamente**, cada una con su propio precio de liquidación, precio de orden y Take
Profit. Eso no es una tabla de "posiciones abiertas" genérica: es una cuenta con las dos
posiciones vivas al mismo tiempo sobre el mismo símbolo.

En Bitget eso solo es posible en **modo cobertura** (`hedge_mode` / doble sentido). Las
consecuencias son concretas:

| Consecuencia | Detalle |
|---|---|
| Clave de posición | Deja de ser `(cuenta, símbolo)` y pasa a ser **`(cuenta, símbolo, lado)`**. Un `Map` con la clave anterior perdería una de las dos posiciones en silencio |
| `holdSide` obligatorio | Cerrar, agregar margen, fijar TP y cambiar apalancamiento requieren indicar el lado. Sin él, la API opera sobre el lado equivocado o rechaza |
| Apalancamiento por lado | En margen aislado, `set-leverage` distingue long y short. El diálogo debe reflejarlo |
| Modo de posición por cuenta | El modo se fija por cuenta con `set-position-mode` y **no puede cambiarse con posiciones abiertas**. Es una precondición a verificar al dar de alta cada credencial, no algo a asumir |
| Fila del monitor | Una fila = una cuenta, con dos bloques (LONG / SHORT) que pueden estar llenos, vacíos o mixtos de forma independiente |

**Acción:** al validar una credencial se consulta y se registra el modo de posición de la
cuenta. Si una cuenta está en modo unilateral, se marca en el panel con el motivo
visible, porque la estrategia del operador no funciona ahí. Se añade como spike S-7
(§19).

---

## 2. Principios del modelo

1. **La autoridad vive en el proceso principal.** El renderer recibe proyecciones de solo
   lectura. Ningún componente de interfaz lee ni escribe disco.
2. **Los secretos están en un solo archivo y nunca salen de él en claro.** El renderer no
   recibe jamás una `apiKey`, `secretKey` o `passphrase` completa, ni siquiera para
   copiar.
3. **Todo lo que no es secreto se guarda en claro**, para que el panel pueda dibujar su
   estructura (cuentas, grupos, layout) **antes** de desbloquear, sin exponer nada.
4. **Escritura atómica siempre**: se escribe a `.tmp`, se hace `fsync` y luego `rename`.
   Un corte de luz deja el archivo anterior intacto, nunca uno a medias.
5. **Todo archivo lleva `version`.** Sin versión no hay migración posible, y la migración
   se necesita en cuanto exista la primera instalación en producción.
6. **Los números monetarios son cadenas**, nunca `number`. Ver §14.
7. **Nada que el contrato excluya se persiste.** No hay historial consultable, no hay
   métricas, no hay telemetría.

---

## 3. Una base de datos independiente por sistema

Requisito del cliente y, además, lo que ya anticipaba §3.5 del Proyecto Ejecutivo: si la
API no permite gobernar varias cuentas madre desde una instancia, se ejecuta **una
instancia por máquina**. El modelo lo asume desde el día uno.

```
Modo portable (entrega contratada):
  <carpeta del .exe>\datos\

Modo instalado (no contratado, soportado por el mismo código):
  %APPDATA%\PCB\
```

Reglas:

- **Ninguna instancia lee ni escribe fuera de su carpeta.** No hay archivo compartido, ni
  registro de Windows, ni sincronización. Copiar la carpeta a otra máquina copia el
  sistema completo.
- **Cada instancia tiene su propia contraseña maestra y su propio PIN.** No hay
  credencial global.
- **Bloqueo de instancia:** al arrancar se crea `datos\.lock` con el PID. Si existe y el
  proceso sigue vivo, la segunda instancia se niega a abrir esa carpeta y lo explica. Dos
  procesos escribiendo el mismo `vault.enc` es la única forma realista de corromperlo.
- Dos sistemas en la misma máquina = dos copias del portable en carpetas distintas. Cada
  una con su `datos\`.

### `instancia.json`

```json
{
  "version": 1,
  "id": "inst_7Qk3xR",
  "nombre": "Sistema 1",
  "creadoEn": "2026-07-27T15:02:11.004Z",
  "appVersion": "0.1.0"
}
```

`id` se genera una sola vez. Se usa como prefijo de los `clientOid` (§10), de modo que
dos sistemas operando la misma cuenta madre **nunca** generan el mismo identificador de
orden.

---

## 4. Inventario de archivos

```
datos/
├── .lock                          # PID de la instancia viva
├── instancia.json                 # identidad del sistema
├── vault.enc                      # credenciales — AES-256-GCM
├── vault.enc.bak                  # copia de la versión anterior (rotación 1)
├── cuentas.json                   # árbol de cuentas SIN secretos
├── config.json                    # ajustes, layout y preferencias
├── ordenes/
│   └── pendientes.jsonl           # órdenes en estado indeterminado (append-only)
├── cache/
│   └── simbolos.json              # catálogo de contratos (regenerable)
└── logs/
    └── session-20260727.jsonl     # log de sesión, rotación diaria
```

| Archivo | Cifrado | Si se pierde |
|---|---|---|
| `vault.enc` | Sí | Se vuelven a registrar las credenciales (las API keys se regeneran en Bitget) |
| `cuentas.json` | No | Se pierde el nombrado y el orden de las cuentas; las credenciales siguen intactas |
| `config.json` | No | Vuelve a valores por defecto |
| `ordenes/pendientes.jsonl` | No | **Se pierde la garantía de no duplicar órdenes.** Es el archivo más crítico después del vault |
| `cache/simbolos.json` | No | Se regenera solo en el siguiente arranque |
| `logs/*.jsonl` | No | Se pierde la traza de la sesión |

---

## 5. `vault.enc`

Sobre JSON con los campos binarios en base64. Se elige JSON sobre un formato binario
propio por una razón práctica: permite inspeccionar la cabecera y migrar de versión sin
descifrar, y hace imposible el tipo de error de desplazamiento de offsets que se paga
caro y tarde.

```json
{
  "formato": "pcb-vault",
  "version": 1,
  "kdf": {
    "algoritmo": "scrypt",
    "N": 131072,
    "r": 8,
    "p": 1,
    "longitudClave": 32,
    "salt": "<base64 32 bytes>"
  },
  "cifrado": { "algoritmo": "aes-256-gcm", "iv": "<base64 12 bytes>", "tag": "<base64 16 bytes>" },
  "verificador": { "iv": "<base64 12 bytes>", "tag": "<base64 16 bytes>", "dato": "<base64>" },
  "payload": "<base64>",
  "desbloqueoRapido": null,
  "actualizadoEn": "2026-07-27T15:40:02.113Z"
}
```

**`verificador`.** Es la constante `"pcb-ok"` cifrada con la misma clave. Sin él,
contraseña incorrecta y archivo corrupto producen el mismo error de autenticación GCM y
el usuario no sabe si escribió mal o si perdió sus datos. Con él:

| verificador | payload | Diagnóstico mostrado |
|---|---|---|
| falla | — | Contraseña incorrecta |
| abre | falla | Archivo dañado → se ofrece restaurar `vault.enc.bak` |
| abre | abre | Desbloqueo correcto |

**Parámetros de `scrypt`.** `N = 2^17`, `r = 8`, `p = 1` → 128 MB de memoria y ~0,5 s por
derivación en una máquina de escritorio actual. Ese coste es irrelevante una vez al abrir
la app y hace inviable la fuerza bruta sobre el archivo robado. Los parámetros van
guardados en el archivo, no fijados en el código: subirlos en una versión futura no
invalida los vaults existentes.

### Contenido descifrado del `payload`

```jsonc
{
  "version": 1,
  "credenciales": [
    {
      "id": "cred_9fK2mA",
      "cuentaId": "acc_3Xz1",
      "apiKey": "bg_xxxxxxxxxxxxxxxx",
      "secretKey": "xxxxxxxxxxxxxxxxxxxxxxxx",
      "passphrase": "xxxxxxxx",
      "altaEn": "2026-07-27T15:39:50.000Z",
      "permisos": {
        "verificadoEn": "2026-07-27T15:39:52.410Z",
        "trading": true,
        "lectura": true,
        "retiro": false,
        "ipsPermitidas": ["189.x.x.x"]
      }
    }
  ]
}
```

Reglas de manejo:

- **`retiro: true` bloquea el alta.** La credencial se rechaza con un mensaje que explica
  cómo corregir el permiso en Bitget. Es una defensa barata contra un error caro.
- El payload en claro vive en memoria del proceso principal mientras la sesión está
  abierta. Al bloquear, los búferes se sobrescriben con ceros.
- Hacia el renderer solo viaja `apiKeyEnmascarada` (§8). El valor completo no cruza el
  IPC en ninguna circunstancia.
- **Rotación:** antes de cada escritura, el `vault.enc` actual se copia a `vault.enc.bak`.
  Una sola generación, suficiente para revertir una escritura fallida.

---

## 6. Desbloqueo rápido: el PIN de 2 dígitos

El cliente pidió un PIN corto para el uso diario y una contraseña maestra para cambiarlo
o recuperarlo. Se implementa, pero con una advertencia que debe quedar por escrito porque
determina qué protege realmente cada cosa.

**Un PIN de 2 dígitos son 100 combinaciones.** No puede ser —y no es— la clave que cifra
el vault: si lo fuera, cualquiera con el archivo lo abriría en un segundo. El PIN es una
**puerta de la aplicación**, no una frontera criptográfica.

### Cómo se implementa

Al activar el desbloqueo rápido, la `claveVault` derivada de la contraseña maestra se
envuelve con `safeStorage` de Electron (DPAPI de Windows, atado a la cuenta de usuario) y
la envoltura se guarda dentro del propio `vault.enc`:

```json
"desbloqueoRapido": {
  "activo": true,
  "longitudPin": 2,
  "pinHash": { "algoritmo": "scrypt", "N": 16384, "r": 8, "p": 1, "salt": "<b64>", "hash": "<b64>" },
  "envoltura": "<base64 — claveVault cifrada con DPAPI>",
  "intentosFallidos": 0,
  "maxIntentos": 5,
  "bloqueadoHasta": null,
  "activadoEn": "2026-07-27T15:41:00.000Z"
}
```

Flujo de desbloqueo con PIN: se compara contra `pinHash` → si coincide, se pide a DPAPI
que descifre `envoltura` y se obtiene la `claveVault` sin escribir la contraseña maestra.

### Política de intentos

- `intentosFallidos` **se persiste**: cerrar y reabrir la aplicación no lo reinicia. Es lo
  que hace que 100 combinaciones no se prueben en un minuto.
- Espera creciente entre intentos: 0 s · 1 s · 3 s · 10 s · 30 s.
- Al llegar a `maxIntentos` (5 por defecto): **se borra `envoltura`** y el desbloqueo
  rápido queda desactivado. Solo la contraseña maestra lo restablece.
- `longitudPin` es configurable de 2 a 8 dígitos. Por defecto 2, como pidió el cliente.

### Qué protege cada capa

| Amenaza | Contraseña maestra | DPAPI | PIN |
|---|---|---|---|
| Roban el archivo `vault.enc` (nube, USB, respaldo) | **Protege** | Protege | No aplica |
| Otro usuario de Windows en la misma máquina | **Protege** | **Protege** | No aplica |
| Malware corriendo bajo la sesión de Windows del operador | **Protege** | No protege | No protege |
| Alguien se sienta frente al equipo desbloqueado | Protege | — | **Protege** |

La lectura honesta: con el desbloqueo rápido **activo**, un proceso malicioso corriendo
como el operador puede pedirle a DPAPI la clave sin conocer el PIN. Con el desbloqueo
rápido **desactivado**, la contraseña maestra nunca toca el disco y ese vector se cierra.
La opción existe (`desbloqueoRapido.activo = false`) y la decisión es del cliente:
comodidad diaria contra superficie de ataque. Recomendación: mantenerlo activo, con
bloqueo automático por inactividad (§9).

---

## 7. Contraseña maestra: cambio y pérdida

**Cambio** (requiere la contraseña actual):

1. Derivar `claveVieja` con el `salt` actual y descifrar el payload.
2. Generar `salt` nuevo y derivar `claveNueva`.
3. Cifrar el payload con `claveNueva`, escribir a `vault.enc.tmp`, `fsync`, `rename`.
4. Rehacer la envoltura DPAPI si el desbloqueo rápido está activo, y reiniciar
   `intentosFallidos`.

Si el paso 3 falla, el archivo anterior sigue siendo válido y la contraseña anterior sigue
funcionando. No hay estado intermedio en el que el vault quede inaccesible.

**Pérdida: no hay recuperación, y es deliberado.** No existe pregunta de seguridad, ni
copia de la clave, ni puerta trasera. Cualquier mecanismo de recuperación sería, por
definición, una segunda forma de abrir el vault sin la contraseña — exactamente lo que se
está evitando.

El plan ante pérdida es operativo y barato: se elimina `vault.enc`, se revocan las API
keys en Bitget y se registran nuevas. `cuentas.json` conserva nombres, grupos y orden, así
que la estructura del panel no se pierde: solo hay que volver a pegar las credenciales.
**Esto debe explicarse a Daniel al entregar la Fase 2**, porque es la única operación del
sistema que no se puede deshacer.

---

## 8. `cuentas.json` — el árbol, sin secretos

Separado del vault a propósito: permite dibujar el panel completo (pestañas, grupos,
filas, nombres) **con la aplicación bloqueada**, sin exponer nada. Las celdas aparecen
vacías hasta desbloquear.

```json
{
  "version": 1,
  "grupos": [
    { "id": "grp_1", "nombre": "Cuenta Madre 1", "orden": 1, "colapsado": false, "color": "#0E7C86" }
  ],
  "cuentas": [
    {
      "id": "acc_3Xz1",
      "grupoId": "grp_1",
      "etiqueta": "Sub 01",
      "uid": "8492013",
      "credencialId": "cred_9fK2mA",
      "apiKeyEnmascarada": "bg••••4f2a",
      "orden": 1,
      "activa": true,
      "modoPosicion": "cobertura",
      "modoMargen": "aislado",
      "ultimoEstadoConexion": "conectada",
      "ultimaVerificacion": "2026-07-27T15:39:52.410Z",
      "altaEn": "2026-07-27T15:39:50.000Z"
    }
  ]
}
```

| Campo | Por qué está |
|---|---|
| `grupoId` + `orden` | Resuelve el requisito 5: *"seleccionar todas y todas las subcuentas"*. La jerarquía es explícita y persistente, no se infiere de un nombre |
| `modoPosicion` | Hallazgo 3 (§1). Si es `unilateral`, la cuenta se marca y se avisa |
| `modoMargen` | `agregar margen` solo existe en aislado. Con este campo el selector puede deshabilitar las cuentas cruzadas **con el motivo visible**, antes de intentar la operación |
| `apiKeyEnmascarada` | Lo único que ve el renderer. Primeros 2 y últimos 4 caracteres |
| `ultimoEstadoConexion` | Solo informativo, para pintar la última foto conocida al arrancar. El estado vivo no se persiste |

**Identificadores.** `acc_*`, `grp_*`, `cred_*` con `nanoid`. Nunca se reutiliza un id
liberado: los registros del log de sesión y las órdenes pendientes apuntan a ellos.

**Alta masiva.** El Hallazgo 1 (~100 juegos de credenciales) hace inviable el alta de una
en una. El formato de importación es CSV con cabecera:

```csv
grupo,etiqueta,apiKey,secretKey,passphrase
Cuenta Madre 1,Sub 01,bg_xxx,yyy,zzz
```

Cada fila se valida contra `/api/v2/mix/account/accounts` antes de guardarse; las que
fallan se reportan con número de línea y motivo, y **no bloquean a las demás**. El archivo
de origen nunca se copia dentro de `datos/`.

---

## 9. `config.json`

```json
{
  "version": 1,
  "seguridad": {
    "minutosInactividadParaBloquear": 30,
    "bloquearAlMinimizar": false
  },
  "monitor": {
    "vista": "mosaico",
    "densidad": "compacta",
    "pestanaActiva": "grp_1",
    "gruposColapsados": ["grp_4", "grp_5"],
    "intervaloRefrescoMs": 3000,
    "columnas": {
      "distanciaLS": { "visible": true, "base": "precioOrden", "formato": "absoluto" }
    }
  },
  "trading": {
    "simboloPorDefecto": "BTCUSDT",
    "modoTakeProfit": "roe",
    "porcentajesRapidosTP": [20, 25, 30, 35, 50, 100],
    "montosRapidosMargen": ["100", "250"],
    "apalancamientoPorDefecto": 150,
    "confirmarSiempre": true
  },
  "actualizadoEn": "2026-07-27T15:44:10.882Z"
}
```

| Campo | Requisito que atiende |
|---|---|
| `monitor.vista` | `pestanas` (una cuenta madre a la vez, como las pestañas de Excel) o `mosaico` (las 100 en pantalla). Requisitos 2 y 4 |
| `monitor.densidad` | `compacta` \| `normal` \| `amplia`. Es lo que hace posible el requisito 4 (§18) |
| `monitor.gruposColapsados` | Requisito 3 |
| `monitor.intervaloRefrescoMs` | Acotado a 2000–5000 ms por contrato. Valores fuera de rango se corrigen al leer |
| `columnas.distanciaLS.base` | `precioOrden` \| `liquidacion` \| `takeProfit`. Requisito 1, pendiente de confirmar (§13.2) |
| `trading.confirmarSiempre` | El pliego exige confirmación previa. **Es de solo lectura: la interfaz no ofrece desactivarla.** Existe como campo para no tener que tocar código si en el futuro se autoriza lo contrario |

`porcentajesRapidosTP` y `montosRapidosMargen` son configurables porque el pliego los
llama *"valores iniciales propuestos"*, no fijos. `confirmarSiempre` no lo es.

**Lectura tolerante:** el archivo se valida con Zod. Campo desconocido → se ignora y se
registra. Campo inválido → se sustituye por el valor por defecto y se avisa. Un
`config.json` roto **nunca** impide arrancar; un `vault.enc` roto sí, y por eso solo el
segundo tiene respaldo.

---

## 10. `ordenes/pendientes.jsonl` — órdenes en estado indeterminado

Este archivo es la implementación concreta de lo que se le respondió a Daniel: *"las
órdenes en estado indeterminado se guardan en disco, no en memoria"*. Es el registro de
intenciones que hace que un cierre inesperado de la aplicación no se convierta en una
orden duplicada.

**Append-only**, una línea JSON por evento. Se escribe **antes** de enviar la orden, no
después: si el proceso muere entre el `write` y la respuesta de Bitget, la intención ya
está en disco.

```jsonl
{"ts":"2026-07-27T16:02:03.101Z","tipo":"intento","clientOid":"pcb-7Qk3-b91-014","loteId":"b91","cuentaId":"acc_3Xz1","accion":"abrir","simbolo":"BTCUSDT","lado":"long","tamano":"0.010","apalancamiento":150}
{"ts":"2026-07-27T16:02:03.788Z","tipo":"resuelta","clientOid":"pcb-7Qk3-b91-014","resultado":"exito","ordenId":"1298374651","fuente":"respuesta-directa"}
```

| Campo | Valores |
|---|---|
| `tipo` | `intento` · `resuelta` |
| `resultado` | `exito` · `fallo` · `omitida` |
| `fuente` | `respuesta-directa` · `order-detail` · `historial-ordenes` · `reconciliacion-posiciones` · `operador` |

### `clientOid` determinista

```
pcb-{instanciaCorta}-{loteId}-{secuenciaCuenta}     ej.  pcb-7Qk3-b91-014
```

- `instanciaCorta`: 4 caracteres del `instancia.id` → dos sistemas operando la misma
  cuenta madre nunca colisionan (§3).
- `loteId`: identificador del lote, único por sesión y monótono.
- `secuenciaCuenta`: posición de la cuenta dentro del lote.

Longitud acotada a 32 caracteres. **El límite real de Bitget para `clientOid` se verifica
en el spike S-8** (§19) antes de fijar el formato.

### Resolución al arrancar

1. Se relee el archivo y se reconstruye el conjunto de `clientOid` con `intento` y sin
   `resuelta`.
2. Por cada uno se consulta `/api/v2/mix/order/detail`. Si responde, se resuelve y se
   anota `fuente: order-detail`.
3. Si esa consulta falla, se recurre al historial de órdenes y, sobre todo, a la
   reconciliación de posiciones: **si hay posición en esa cuenta, la orden entró**, sin
   importar qué diga el endpoint de detalle.
4. Si nada resuelve, la cuenta queda marcada en el panel como **indeterminada** —una fila
   vacía no debe leerse como "sin posición"— y se escala al operador.
5. **Las cuentas con órdenes sin resolver no aceptan operaciones nuevas** hasta cerrar el
   punto. Lo único que el sistema no hace nunca por su cuenta es reenviar.

### Compactación

Al cerrar limpiamente, o cuando el archivo supera 5.000 líneas, se reescribe (atómico)
conservando solo las entradas sin resolver. El archivo tiende a cero en operación normal.

---

## 11. `logs/session-YYYYMMDD.jsonl`

Registro básico de la sesión, tal como lo acota el presupuesto: sin módulo de consulta,
sin filtros, sin persistencia a largo plazo.

```jsonl
{"ts":"2026-07-27T16:02:03.788Z","nivel":"info","evento":"orden.enviada","loteId":"b91","cuentaId":"acc_3Xz1","cuenta":"Sub 01","accion":"abrir","simbolo":"BTCUSDT","lado":"long","resultado":"ok","codigoBitget":null,"mensaje":"Orden aceptada","duracionMs":687}
```

- Rotación diaria; retención 30 días; borrado automático de lo más viejo.
- `evento` es un enum cerrado (`app.arranque`, `vault.desbloqueado`, `cuenta.alta`,
  `orden.enviada`, `orden.indeterminada`, `ws.reconectado`, `deriva.detectada`, …). Lo que
  no está en el enum no se escribe: evita que el log se convierta en texto libre
  inconsultable.
- **Redacción obligatoria:** un serializador elimina `apiKey`, `secretKey`, `passphrase` y
  cabeceras `ACCESS-*` antes de cualquier escritura. Hay un test que falla si un secreto
  conocido aparece en la salida.

---

## 12. `cache/simbolos.json`

Catálogo de contratos, refrescado al arrancar y cada 6 horas. Es caché: si se borra, se
regenera.

```json
{
  "version": 1,
  "obtenidoEn": "2026-07-27T15:38:00.000Z",
  "simbolos": {
    "BTCUSDT": {
      "tickSize": "0.1",
      "pricePlace": 1,
      "minTradeNum": "0.001",
      "sizeMultiplier": "0.001",
      "apalancamientoMax": 150,
      "estado": "normal"
    }
  }
}
```

Sin este catálogo no se puede redondear el precio de Take Profit al tick válido ni validar
el tamaño mínimo, y la orden se rechaza con un error opaco. Se cachea porque hace falta en
cada cálculo y no cambia en horas.

---

## 13. Modelo en memoria (no persistido)

### 13.1 `Position` — fuente de verdad

```ts
type Lado = 'long' | 'short';

interface Position {
  cuentaId: string;
  simbolo: string;
  lado: Lado;                      // clave compuesta: cuentaId + simbolo + lado
  tamano: string;
  precioEntrada: string;           // "PRECIO DE ORDEN" en el Excel
  precioLiquidacion: string;
  apalancamiento: number;
  modoMargen: 'aislado' | 'cruzado';
  margen: string;
  takeProfit: { precio: string; porcentaje: number; planId: string } | null;
  origen: 'ws' | 'rest';
  actualizadoEn: string;
  estado: 'viva' | 'indeterminada';
}
```

Vive en un `Map<string, Position>` con clave `` `${cuentaId}|${simbolo}|${lado}` `` —
Hallazgo 3. El precio de Take Profit **no llega por el canal `positions`**: viene del canal
`orders-algo`, y por eso `takeProfit` es un campo aparte que puede estar ausente aunque la
posición esté completa.

### 13.2 `FilaMonitor` y la columna DISTANCIA L/S

Proyección que se envía al renderer, coalescida cada 250 ms:

```ts
interface FilaMonitor {
  cuentaId: string;
  etiqueta: string;
  grupoId: string;
  long:  { liquidacion: string; entrada: string; takeProfit: string } | null;
  short: { liquidacion: string; entrada: string; takeProfit: string } | null;
  distanciaLS: string | null;
  estado: 'ok' | 'indeterminada' | 'sin-conexion' | 'modo-rest';
}
```

Corresponde una a una con la captura de Excel:

```
        │        LONG                 │ DISTANCIA │        SHORT
CUENTA  │ LIQUIDACIÓN  ORDEN    TP    │    L/S    │ LIQUIDACIÓN  ORDEN    TP
Sub 01  │   95 000    100 000  100 220│    500    │   200 000    99 500  99 280
```

**Definición propuesta:**

```
distanciaLS = | precioEntradaLong − precioEntradaShort |
```

Los números de la captura la respaldan: la orden LONG en ~100 000 y la SHORT en 99 500
dan una distancia de 500, que es una magnitud que un operador usa. Las alternativas
—distancia entre liquidaciones (105 000) o entre TPs— dan cifras que no se leen como
"separación entre las dos puntas".

Reglas: se calcula sobre el mismo símbolo; si falta cualquiera de los dos lados se muestra
`—` y **no** cero, porque cero significaría "las dos puntas se tocan"; se redondea al tick
del símbolo; `columnas.distanciaLS.base` permite cambiar la definición sin tocar código.

**La celda dice `XXXX` en la captura: falta que el cliente confirme la definición.** Es la
pregunta P-1 de §19.

### 13.3 `Lote` y `Job`

```
pendiente → enviando → exito
                     → fallo        (con código y mensaje de Bitget en español)
                     → omitida      (p. ej. cerrar una posición que ya no existe)
                     → indeterminada (timeout después de enviar → §10)
```

Un lote termina con el desglose por cuenta que exige el pliego —aciertos, fallos,
omitidas— y con la opción de **reintentar solo las fallidas**, nunca las indeterminadas.
Los lotes no se persisten: al reabrir la aplicación no hay lotes a medias, solo órdenes
indeterminadas a resolver.

---

## 14. Convenciones numéricas y de tiempo

| Regla | Motivo |
|---|---|
| Precios, tamaños y márgenes son **`string`** de extremo a extremo | `0.1 + 0.2 !== 0.3`. Un float en un precio de liquidación es un error que se descubre con dinero real |
| La aritmética usa **decimal.js**; nunca `parseFloat` | |
| Se formatea solo al pintar, con `Intl.NumberFormat` y cifras tabulares | Alinea las columnas del monitor |
| Redondeo **siempre** al `tickSize` del símbolo antes de enviar | Bitget rechaza precios fuera de tick |
| Fechas en **ISO 8601 UTC** en disco; hora local solo en pantalla | Los logs se leen entre husos horarios |
| Porcentajes como `number` entero | Son de interfaz, no de dinero |

---

## 15. Versionado y migración

Todo archivo abre con `version`. Al leer:

- `version` == esperada → se usa.
- `version` < esperada → migración encadenada (1→2→3), previa copia a
  `<archivo>.v<n>.bak`.
- `version` > esperada → **no se toca el archivo** y la aplicación se detiene con un
  mensaje claro. Es el caso de abrir datos nuevos con un ejecutable viejo, y adivinar ahí
  es la forma más rápida de destruirlos.

Las migraciones viven en `src/main/storage/migrations/` y cada una tiene su prueba con un
archivo real de la versión anterior en `test/fixtures/`.

---

## 16. Integridad, respaldo y errores de disco

- **Escritura atómica** (`tmp` + `fsync` + `rename`) en todos los archivos salvo los
  `.jsonl`, que son append con `fsync` por lote.
- **Respaldo:** solo `vault.enc` tiene copia automática (`.bak`, una generación). El resto
  es reconstruible o irrelevante.
- **Línea corrupta en un `.jsonl`** (corte de luz a mitad de escritura): se descarta esa
  línea, se registra el incidente y se continúa. Un archivo de eventos no se invalida por
  su última línea.
- **Disco lleno o carpeta sin permiso de escritura** (típico al ejecutar el portable desde
  una carpeta protegida): se detecta al arrancar escribiendo `.lock`, y se explica con la
  ruta exacta en vez de fallar en la primera operación.
- **Exportar / importar sistema:** copiar `datos/` completo. Como el desbloqueo rápido
  está atado a DPAPI de esa máquina y usuario, al restaurar en otra el PIN no sirve y se
  pide la contraseña maestra. Correcto, y hay que documentarlo en la guía de uso.

---

## 17. Qué NO se persiste (deliberadamente)

| No se guarda | Motivo |
|---|---|
| Contraseña maestra, en ninguna forma | Solo su derivación efímera en memoria |
| Posiciones, precios o saldos | El estado vivo se reconstruye de Bitget en cada arranque. Un precio guardado es un precio mentiroso |
| Historial consultable de operaciones | Excluido por contrato (Fase 2 del presupuesto, punto 3 de las funciones no incluidas) |
| Estadísticas, PnL, ROI, métricas | Excluido por contrato |
| Cualquier dato en un servidor remoto | No hay red fuera de `api.bitget.com` y `ws.bitget.com` |

---

## 18. Requisito 4: las 100 cuentas en pantalla, con números

*"Que se puedan ver las 100 cuentas sin mover nada"* es un requisito verificable, y
conviene verificarlo en Fase 1 y no descubrirlo en Fase 6.

Cada fila necesita 8 celdas: cuenta · 3 de LONG · distancia · 3 de SHORT. En una pantalla
de 1920×1080 al 100 % de escala quedan ~830 px de alto útil tras la cabecera y la barra de
acciones.

| Disposición | Alto por fila | ¿Cabe? |
|---|---|---|
| 1 columna × 100 filas | 8,3 px | **No.** No hay tipografía legible a esa altura |
| 2 columnas × 50 filas | 16,6 px | **Sí**, en densidad compacta (fila de 16 px, fuente tabular de 11 px). Ancho: 16 columnas × ~110 px = 1 760 px, dentro de 1 920 |
| 4 columnas × 25 filas | 33 px | Cómodo, pero necesita ~3 500 px de ancho: solo en 2560 o 4K |

**Conclusión:** el requisito se cumple en `vista: "mosaico"`, densidad compacta, con dos
condiciones que hay que fijar por escrito con el cliente:

1. **Resolución mínima 1920×1080 con escala de Windows al 100 %.** Al 125 % —el valor por
   defecto de muchos portátiles— el espacio efectivo baja a 1536×864 y solo caben ~70
   cuentas. El panel detecta la escala y lo avisa al arrancar en vez de recortar filas en
   silencio.
2. Los grupos colapsables (requisito 3) son el mecanismo de alivio: colapsar dos cuentas
   madre libera espacio para el resto sin cambiar de vista.

Y la vista `pestañas` —el diseño de Excel del requisito 2— sigue disponible para trabajar
sobre una cuenta madre a la vez, con 20 filas holgadas. Son dos modos del mismo dato, no
dos pantallas distintas.

*El diseño visual de ambos modos va en el Entregable 4 (wireframes).*

---

## 19. Preguntas abiertas y spikes que agrega este documento

**Para Daniel (bloquean el cierre del modelo):**

| # | Pregunta | Qué cambia según la respuesta |
|---|---|---|
| P-1 | **DISTANCIA L/S**: ¿distancia entre los precios de orden, entre las liquidaciones o entre los TPs? La celda dice `XXXX` | El campo `distanciaLS` y la columna del monitor. Se asume "precios de orden" hasta que confirme |
| P-2 | ¿Confirma el **modo cobertura** (LONG y SHORT abiertos a la vez sobre el mismo símbolo)? | Todo el §1. Si fuera unilateral, la mitad de las columnas del Excel sobran |
| P-3 | ¿PIN de 2 dígitos con **bloqueo definitivo a los 5 intentos**, o prefiere más intentos? | Política de §6. 2 dígitos son 100 combinaciones: con 5 intentos el riesgo es 5 % |
| P-4 | ¿Acepta que **la contraseña maestra perdida no se recupera** y obliga a volver a registrar credenciales? | §7. Es la única operación irreversible del sistema |
| P-5 | ¿Cuántos sistemas independientes habrá y con cuántas cuentas cada uno? | Dimensiona el mosaico y el presupuesto de IP, que es **por máquina** |

**Spikes técnicos que se suman a los seis de `01-stack-tecnologico.md` §14:**

| # | Verificación contra la cuenta demo |
|---|---|
| S-7 | Modo de posición por cuenta: cómo se consulta, y confirmar que `set-position-mode` se rechaza con posiciones abiertas |
| S-8 | Longitud y juego de caracteres admitidos en `clientOid`, y comportamiento exacto ante un duplicado (¿código de error o aceptación silenciosa?) |
| S-9 | Con dos posiciones abiertas en cobertura, comprobar que `place-tpsl-order` con `planType: pos_profit` aplica al lado indicado y no a la posición neta |

---

**Estado del entregable:** completo salvo P-1 y P-2, que son decisiones del cliente y no
suposiciones que corresponda tomar aquí. Ninguna de las dos cambia la estructura de los
archivos: P-1 afecta un campo derivado y P-2 una clave de índice ya prevista.
