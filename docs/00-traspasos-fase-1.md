# Fase 1 — Traspaso de saldo entre subcuentas: diseño y validación de credenciales

**Panel de Control Bitget (PCB)** · Fecha: 3 de septiembre de 2026
Presupuesto de referencia: [`presupuesto-traspaso-subcuentas.md`](presupuesto-traspaso-subcuentas.md), Fase 1, 1 día, $300 MXN

> Cubre lo que pide la Fase 1: *"verificación de los permisos de la API Key de la cuenta
> principal contra la API oficial de Bitget, y diseño del flujo de traspaso y de la
> pantalla de saldos"*. No incluye código de producto — eso empieza en la Fase 2.

---

## 1. Verificación de permisos — hecho, contra la API real

La verificación de permisos que pide esta fase ya estaba construida, para otro motivo (el
cambio de política del 29/08/2026, ver [`presupuesto-traspaso-subcuentas.md` §4](presupuesto-traspaso-subcuentas.md#4-decisi%C3%B3n-de-seguridad-requerida--y-su-estado-real-hoy)).
Solo hacía falta reconfirmarla hoy:

```
$ node scripts/ver-permisos.mjs --env MADRE
  BITGET_MADRE key bg****3f0d  UID 7514542716  parentId 7514542716  authorities [coow, cpow, chow]
```

| Código | Nivel | Qué es |
|---|---|---|
| `coow` | operación | Futuros: órdenes |
| `cpow` | operación | Futuros: posiciones |
| `chow` | operación | Subcuentas: administrar |

**Sin permiso de traspaso.** Mismo resultado que el 29/08/2026 (`[coow, cpow, chow]`, sin
código de traspaso todavía sin catalogar). Confirma lo que ya decía `verificacion.ts`: la
credencial madre actual no puede traspasar, y el traspaso de prueba de esa fecha falló con
`40014 · need transfer write permissions` por esto exactamente.

**Curioso y sin impacto en el diseño:** `parentId` devuelve el mismo valor que `userId`
(`7514542716` los dos). `uidPadreDe()` en `verificacion.ts` lo trataría como *"es
subcuenta de sí misma"* en vez de *"no es subcuenta de nadie"*, que es semánticamente raro
para una cuenta madre. No bloquea nada de esta fase — la credencial madre no pasa por
`verificarCredencial()` del mismo modo que una subcuenta operativa — pero es una anomalía a
tener presente si en Fase 2 se reutiliza esa función para dar de alta la credencial de
traspasos.

**Acción para desbloquear Fase 3 (no bloquea Fase 1 ni Fase 2):** Daniel genera en Bitget
una API Key de la cuenta madre con permiso de traspaso y lectura de subcuentas, IP ligada,
según `presupuesto-traspaso-subcuentas.md` §5. En cuanto exista, `ver-permisos.mjs --env
MADRE` debe devolver un código nuevo — se cataloga ahí mismo en `CATALOGO_PERMISOS`.

---

## 2. Los dos endpoints que hacen falta

El código del panel no llama todavía a ningún endpoint de traspaso ni de saldo agregado de
subcuentas — la propuesta original solo los probó de forma ad hoc, sin integrarlos. Lo que
sigue viene de la documentación oficial de Bitget (`bitget.com/api-doc`, que solo sirve el
esqueleto de la página por JavaScript y no se pudo extraer directo) contrastada con el SDK
comunitario `bitget-api` (el mismo que el proyecto usa como oráculo de firma HMAC, ver
[`01-stack-tecnologico.md` §8](01-stack-tecnologico.md)), que tipa sus parámetros a partir
de esa misma documentación oficial.

**Pendiente antes de Fase 2:** confirmar ambos contra la cuenta demo, con el mismo rigor
que el resto del proyecto (todo endpoint en `rest/endpoints/` cita la fecha en que se
verificó contra una respuesta real).

### 2.1 Saldo de futuros de todas las subcuentas — una petición

```
GET /api/v2/mix/account/sub-account-assets?productType=USDT-FUTURES
```

Respuesta: un array con un elemento por subcuenta —

```ts
{
  userId: number;
  assetList: {
    marginCoin: string;
    locked: string;
    available: string;
    crossedMaxAvailable: string;
    isolatedMaxAvailable: string;
    maxTransferOut: string;      // <- el "máximo transferible real" de la propuesta
    accountEquity: string;
    usdtEquity: string;
    btcEquity: string;
    unrealizedPL: string;
    coupon: string;
  }[];
}[]
```

`maxTransferOut` es exactamente el dato que pide R1 de la propuesta (*"cuánto se puede
sacar de verdad"*): no hay que restar el margen comprometido a mano, Bitget ya lo hace.

Límite documentado: 1 petición / 10 s por UID. Irrelevante aquí — se llama una vez al abrir
la pantalla y al refrescar, no en bucle.

**Permiso que probablemente necesita:** lectura de subcuentas — el mismo `chow` que la
credencial madre **ya tiene hoy**. Si se confirma, la pantalla de saldos (Fase 2) podría
implementarse y probarse contra la cuenta real **sin esperar** a que Daniel entregue la
credencial nueva de traspaso; solo la ejecución (Fase 3) la necesita. Queda como hipótesis
a confirmar al empezar la Fase 2, no como hecho.

### 2.2 Traspaso sub-a-sub

```
POST /api/v2/spot/wallet/subaccount-transfer
```

```ts
{
  fromType: 'usdt_futures';   // mismo valor en origen y destino: futuros -> futuros
  toType: 'usdt_futures';
  amount: string;
  coin: 'USDT';
  fromUserId: string;         // UID de la subcuenta origen
  toUserId: string;           // UID de la subcuenta destino
  clientOid?: string;
}
```

Vive bajo el prefijo `/spot/`, igual que `/api/v2/spot/account/info` ya lo hace para leer
permisos de una key de solo-futuros (`cuenta.ts` línea 19: *"Pese al prefijo spot, es un
endpoint de cuenta"*). Es el mismo patrón de Bitget de agrupar operaciones de cuenta bajo
`/spot/` sin que el nombre describa el producto real que mueven — no es un indicio de que
haga falta permiso de spot.

**`clientOid`.** Opcional en el tipo, pero el proyecto nunca envía una operación que mueve
dinero sin idempotencia (ver `01-stack-tecnologico.md` §9, "es la pieza de seguridad más
importante de todo el sistema"). Fase 3 debe generarlo con el mismo esquema que las
órdenes: `pcb-{instanciaCorta}-{loteId}-{secuencia}`.

**Endpoint alternativo descartado:** existe también `/api/v2/spot/wallet/transfer`, que
mueve saldo *dentro de una misma cuenta* (p. ej. spot → futuros de la propia madre). No
sirve aquí porque no acepta `fromUserId`/`toUserId` — no es sub-a-sub. Queda anotado para
no repetir la confusión si alguien lo encuentra primero en la documentación.

---

## 3. Diseño del flujo de traspaso

### 3.1 Dónde vive la credencial madre

Es una credencial nueva, de un tipo que hoy no existe en `cuentas.json`: no opera un
símbolo, no tiene `modoPosicion` ni `modoMargen`, y su única función es leer saldos de
subcuentas y traspasar entre ellas. Encaja mal en el esquema de "cuenta operable" tal como
está descrito en [`03-modelo-de-datos.md` §8](03-modelo-de-datos.md).

Propuesta: una entrada nueva en el `payload` de `vault.enc`, separada del array
`credenciales` que ya existe —

```jsonc
"credencialTraspasos": {
  "grupoId": "grp_1",              // a qué cuenta madre pertenece
  "apiKey": "...", "secretKey": "...", "passphrase": "...",
  "uid": "7514542716",
  "altaEn": "2026-09-08T00:00:00.000Z",
  "permisos": { "verificadoEn": "...", "authorities": ["coow","cpow","chow","????"] }
}
```

**Pregunta abierta, y de las que bloquean el modelo, no la pantalla:** ¿puede haber más de
una cuenta madre por instancia? `03-modelo-de-datos.md` ya modela varios `grupos` (varias
"Cuenta Madre N"), así que si alguna vez hay dos madres reales en un mismo sistema,
`credencialTraspasos` no puede ser un campo único — tiene que ser un array indexado por
`grupoId`, como arriba. **Para esta Fase 1 se asume una sola cuenta madre por instancia**
(es el caso real de Daniel hoy), y se deja la forma de array-por-grupo para no repetir el
error que ya costó una migración en el hallazgo 3 de `03-modelo-de-datos.md`. Confirmar con
Daniel antes de cerrar Fase 2.

### 3.2 El movimiento en sí

Reutiliza, sin inventar nada nuevo, tres piezas que el proyecto ya tiene:

1. **Confirmación previa** con el mismo componente `DialogoSeguridad` que ya usan las
   cinco acciones de trading: origen, destino, importe, saldo resultante de ambas
   subcuentas. Es literalmente el requisito R3 de la propuesta.
2. **Idempotencia por `clientOid`**, igual que una orden (§2.2).
3. **Clasificación de errores** del catálogo que ya existe en `bitget/errors.ts` — un
   traspaso puede fallar por fondos insuficientes, por `maxTransferOut` superado, o por
   IP no ligada; son variantes de errores que el sistema ya sabe traducir al español.

Lo nuevo es el registro. Seguirá el patrón `ordenes/pendientes.jsonl` (append-only,
escritura antes de enviar) porque un traspaso comparte el mismo riesgo que una orden: si el
proceso muere entre el envío y la respuesta, no se sabe si el dinero se movió. Archivo
propuesto: `traspasos/movimientos.jsonl`, mismo formato intento/resuelta que
`03-modelo-de-datos.md` §10, **sin** reintento automático — un traspaso repetido por error
es dinero mal ubicado, no una orden que Bitget rechaza por duplicada.

### 3.3 Reparto y recogida masiva (Fase 4, diseño anticipado)

Sin nuevo mecanismo: cada reparto/recogida es una lista de traspasos individuales
(origen=madre o destino=madre según el caso), cada uno con su propio `clientOid`,
ejecutados por la misma cola de ejecución que ya reparte lotes de órdenes
(`execution/queue.ts`). El "80 OK · 20 fallidos" que ya existe para posiciones aplica igual
aquí.

---

## 4. Diseño de la pantalla de saldos

Reutiliza `MatrizCuentas.tsx` / el patrón de `AccordeonMonitor.tsx` como referencia visual
(misma familia de tabla densa que ya conoce el operador), no como monitor en vivo:

- Una fila por subcuenta del grupo/cuenta-madre seleccionado.
- Columnas: etiqueta, disponible, **máximo transferible** (`maxTransferOut`), y una
  casilla de selección para reparto/recogida masiva.
- Refresco bajo demanda (botón), no WebSocket — el saldo no necesita empujarse en tiempo
  real como una posición; una petición REST cada vez que se abre la pantalla basta y evita
  gastar presupuesto de IP en algo que Fase 2 no pidió.
- Fila deshabilitada, con motivo visible, si `maxTransferOut === '0'`: mismo patrón que ya
  usa `modoMargen` para deshabilitar "agregar margen" en cruzado.

---

## 5. Qué queda para Fase 2 y Fase 3, explícitamente fuera de esta fase

- Ningún archivo de `src/` se toca en esta fase. Este documento es el entregable.
- No se implementa `rest/endpoints/traspasos.ts` — se diseña aquí, se escribe en Fase 2/3.
- No se verifica `sub-account-assets` ni `subaccount-transfer` contra la cuenta demo
  todavía — ambos están sourceados de documentación de terceros y quedan marcados
  "pendiente de confirmar" en las secciones 2.1 y 2.2.

## 6. Para Daniel

1. Confirmar por escrito la ampliación de política del 29/08 (`presupuesto-traspaso-subcuentas.md` §4) — pendiente desde antes de esta fase, no la bloquea pero sigue abierta.
2. Generar la API Key de traspaso de la cuenta madre (permisos traspaso + lectura de subcuentas, sin retiro, IP ligada) — no bloquea Fase 2 (§2.1), sí Fase 3.
3. Confirmar si existe o se prevé más de una cuenta madre por instancia (§3.1) — de eso depende si `credencialTraspasos` es un objeto único o un array.
