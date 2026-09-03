# Presupuesto — Traspaso de Saldo entre Subcuentas

**Panel de Control Bitget (PCB)** · Presupuesto estimado, requerimiento adicional
Fecha del documento: 18 de agosto de 2026 · Presenta: Alexis Cárdenas Camacho · Cliente: Daniel Montero Ramírez

> Formaliza en fases, con firma, lo que [`cotizacion-traspasos-entre-subcuentas.md`](cotizacion-traspasos-entre-subcuentas.md)
> propuso el mismo día tras las respuestas de Daniel. Ese documento conserva el porqué
> (preguntas, pruebas contra la API, la disyuntiva camino A/B); este es el que fija fases,
> precios y condiciones contractuales. **Los precios no coinciden entre los dos**: la
> propuesta estimaba $4,200 MXN (base + reparto masivo, sin desglosar pruebas y entrega);
> este presupuesto —la versión formal— los reordena en 5 fases por $3,000 MXN. Este
> documento es el que rige.

---

## 1. Alcance

Mover saldo entre las subcuentas de una misma cuenta principal desde el panel, sin entrar
a Bitget una cuenta a la vez.

| Función | Qué hace |
|---|---|
| **Pantalla de saldos** | Saldo de futuros de cada subcuenta de la cuenta principal seleccionada, en una sola pantalla: disponible y máximo transferible real que reporta Bitget |
| **Traspaso entre subcuentas** | Mueve un importe en USDT de una subcuenta a otra de la misma cuenta principal, en el monedero de futuros |
| **Confirmación previa** | Antes de ejecutar: origen, destino, importe y cómo quedan los dos saldos. Mismo mecanismo que ya usa la apertura de posiciones |
| **Registro de movimientos** | Cada traspaso queda con fecha, importe, origen, destino y resultado |
| **Reparto masivo** | Distribuye un importe total entre las subcuentas seleccionadas: a partes iguales o igualando el saldo de todas |
| **Recogida masiva** | Devuelve el saldo de las subcuentas seleccionadas a la cuenta principal |

## 2. Fuera de alcance

1. Retiro de fondos a cualquier destino externo — no entra en este presupuesto ni en ningún otro.
2. Traspasos entre cuentas principales distintas.
3. Traspasos programados o automáticos — todo movimiento requiere confirmación explícita.
4. Conversión entre monedas — solo USDT.
5. Movimientos hacia o desde el monedero spot — solo entre monederos de futuros.
6. Reglas de reparto condicionadas a rendimiento, riesgo u otro criterio automático.

## 3. Presupuesto por fases

| Fase | Descripción | Duración | Costo |
|---|---|---|---|
| **1** | Diseño y validación de credenciales: permisos de la API Key de la cuenta principal contra la API oficial, diseño del flujo de traspaso y de la pantalla de saldos | 1 día | $300 |
| **2** | Pantalla de saldos por subcuenta: saldo de futuros de todas las subcuentas de una cuenta principal en una sola petición, con disponible y máximo transferible real | 1–2 días | $500 |
| **3** | Traspaso entre subcuentas: ejecución con confirmación previa (origen, destino, importe, saldos resultantes) y registro del movimiento | 2 días | $900 |
| **4** | Reparto y recogida masiva | 2–3 días | $900 |
| **5** | Pruebas y entrega: casos de error automatizados, prueba física contra Bitget, documento de entrega con guion de validación | 1 día | $400 |
| **Total** | | **7–9 días** | **$3,000 MXN** |

Persona física, no incluye IVA. Pago 100% al entregar cada fase; se entiende aprobada si
el cliente no observa nada en 7 días naturales tras la demostración.

## 4. Decisión de seguridad requerida — y su estado real hoy

El presupuesto original del PCB garantiza: *"el sistema no solicitará, almacenará ni
utilizará permisos de retiro de fondos"*, de modo que ninguna credencial guardada puede
mover dinero. Ejecutar traspasos necesita una credencial de la cuenta principal con
permiso de traspaso interno — no retira a un destino externo, pero sí mueve fondos entre
las subcuentas del cliente.

El documento pide una autorización expresa y acotada:

> ☐ Autorizo el traspaso automatizado. Proporcionaré una API Key de la cuenta principal
> con permisos de traspaso y de lectura de subcuentas, **sin permiso de retiro** y con IP
> ligada.

**Esto ya no describe el estado del código, y conviene tenerlo escrito.** El
29 de agosto de 2026 —11 días después de la fecha de este documento, y sin que conste aquí
una casilla marcada ni firma— el cliente pidió, por fuera de este flujo formal, ir más
allá de lo que esta sección autoriza: no solo aceptar una credencial con permiso de
traspaso, sino **dejar de rechazar también las que tengan permiso de retiro**. El cambio
está hecho y documentado en el propio código:
[`src/main/bitget/verificacion.ts`](../src/main/bitget/verificacion.ts) y
[`03-modelo-de-datos.md` §5](03-modelo-de-datos.md#5-vaultenc).

Diferencia concreta con lo que dice esta sección 4:

| | Este presupuesto (§4) | Código desde el 29/08/2026 |
|---|---|---|
| Alcance del cambio | Una credencial nueva, específica para traspasos | La política de alta se relajó **para toda credencial**, no solo la de traspasos |
| Permiso de retiro | La credencial de traspaso se pide explícitamente **sin** él | El panel **ya no rechaza** ninguna credencial por tener permiso de retiro; avisa y deja guardarla |
| Códigos sin catalogar | No se menciona | Antes bloqueaban el alta (podían ser el de retiro); ahora se aceptan igual, con aviso |
| Constancia por escrito | Pendiente de casilla marcada y firma | Un comentario extenso en el código, citando la fecha y que fue "a petición expresa del cliente" — no un documento firmado |

No cambia nada de lo técnico para empezar la Fase 1: la verificación de permisos que pide
esa fase ya está construida y en uso. Lo que sí vale la pena es que Daniel confirme por
escrito —aunque sea un mensaje, no hace falta repetir el trámite del PDF— que la ampliación
del 29/08 fue realmente lo que pidió, porque es la garantía de seguridad más fuerte del
proyecto original y ya no es cierta tal como estaba redactada.

## 5. Condiciones del servicio (resumen)

- **Requisito previo.** Se integra sobre el PCB ya entregado; aprovecha su infraestructura de credenciales, conexión y ejecución.
- **Credencial requerida.** La API Key de la cuenta principal la genera y entrega el cliente: permisos de traspaso y lectura de subcuentas, sin retiro, IP del equipo ligada. *(Ver §4: la validación real hoy ya no exige "sin retiro" para aceptar el alta; sigue siendo lo recomendado operativamente.)*
- **IP ligada.** Si la IP del cliente es variable, la credencial deja de funcionar al cambiar — no es falla del software. Corresponde al cliente IP fija o mantener la lista blanca.
- **Máximo transferible.** El saldo de una subcuenta no es lo que se puede sacar: el capital en posiciones abiertas no es transferible. El panel valida contra el máximo transferible real que reporta Bitget.
- **Verificación pendiente al momento del documento.** Confirmado contra la API real: lectura del saldo de futuros de todas las subcuentas en una sola petición, y que Bitget admite futuros→futuros en USDT. **Pendiente:** que la credencial de la cuenta madre tenga el permiso de traspaso activo — se comprueba en la Fase 1 (ver §6).
- **Responsabilidad de uso.** El cliente declara titularidad/autorización sobre todas las cuentas conectadas y asume la responsabilidad de los movimientos ejecutados.
- **Garantía.** Corrección sin costo de errores atribuibles al desarrollo, dentro de 30 días naturales tras la entrega final.
- **Mantenimiento posterior.** No incluido. Cambios futuros en la API de Bitget se atienden por plan mensual (desde $3,000 MXN/mes) o bolsa de horas.
- **Propiedad del código.** Pasa al cliente al liquidar el total.

## 6. Fase 1 — punto de partida

Lo que pide la Fase 1 (verificar permisos de la credencial de la cuenta principal, y
diseñar el flujo de traspaso y la pantalla de saldos) parte de trabajo que ya existe,
hecho para otro motivo (la relajación de permisos del 29/08) pero directamente reutilizable:

- **Catálogo de permisos y niveles** (`operacion` / `traspaso` / `retiro`) ya implementado en `verificacion.ts`.
- **Script de verificación en vivo** contra la API real: `node scripts/ver-permisos.mjs --env MADRE`.
- **Hallazgo ya registrado** (comentario en `verificacion.ts`, 29/08/2026): la credencial de la cuenta madre consultada ese día devolvía `[coow, cpow, chow]` — **sin** permiso de traspaso — y un traspaso de prueba falló con `40014 · need transfer write permissions`.

Lo que falta y es trabajo nuevo de esta fase:

1. Reconfirmar el estado de la credencial madre contra la API real (puede haber cambiado desde el 29/08).
2. Identificar el/los endpoint(s) exactos de Bitget para: saldo de todas las subcuentas en una petición, y traspaso sub-a-sub — el hallazgo de la propuesta dice que existen, pero el código no los usa todavía.
3. Diseño del flujo de traspaso y de la pantalla de saldos (entregable de diseño, no implementación — eso empieza en Fase 2/3).

---

**Estado:** documento de referencia. La firma formal (sección 8 del PDF original) no
consta en el archivo recibido; antes de facturar la Fase 1 conviene que quede, aunque sea
por escrito informal, la confirmación de Daniel sobre §4.
