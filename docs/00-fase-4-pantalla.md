# Fase 4 · Las seis funciones, conectadas a la pantalla

**Panel de Control Bitget (PCB) v1.0** · 20 de agosto de 2026
Con esto la Fase 4 deja de vivir en el proceso principal y se opera con el ratón. **Sin datos de
demostración**: en staging todo lo que se ve sale de Bitget.

---

## 1. Lo que cambió, en una frase

La pantalla ya no «envía una operación»: **planifica, enseña y luego envía**.

Antes, pulsar *Abrir* llamaba a una función que enviaba y devolvía un recuento. Ahora pulsar
*Abrir* sale a Bitget, lee el precio del momento y el saldo de cada subcuenta, y devuelve la lista
concreta de lo que va a pasar. Hasta que esa lista no se aprueba, **no ha salido ninguna orden**.

Es el requisito que Daniel aprobó el 18 de agosto, y ahora es lo que hace el programa y no solo lo
que dice el documento.

---

## 2. Qué se conectó

| Función | Botón | Canales |
|---|---|---|
| Abrir | *Abrir* | `apertura:planificar` · `apertura:ejecutar` |
| Cerrar (rápido) | *Cerrar* | `cierre:planificar` · `cierre:ejecutar` |
| Poner Take Profit | campo *Take Profit %* | `tp:planificar` · `tp:ejecutar` |
| **Quitar Take Profit** | *Quitar Take Profit* | `tp:planificar-quitar` · `tp:ejecutar-quitar` |
| Agregar margen | campo *Margen adicional* | `margen:planificar` · `margen:ejecutar` |
| Ajustar apalancamiento | campo *Apalancamiento* | `apalancamiento:planificar` · `apalancamiento:ejecutar` |

Y tres piezas que faltaban para que nada quedara en modo demostración:

**El catálogo de activos** (`mercado:activos`). El selector ya no sale de una lista escrita a mano:
se lee del catálogo de Bitget del mercado activo, con el tope de apalancamiento y los decimales de
precio de cada contrato. En el mercado real son los cinco de Daniel; en el de pruebas, los tres que
Bitget ofrece.

**El precio** (`mercado:precios`). Precio de marca, el mismo con el que se dimensiona una apertura.
Se refresca cada tres segundos. No se opera con él —cada plan trae el suyo, leído al planificar—
pero enseñar uno y calcular con otro haría pensar que el panel calcula mal.

**La contraseña de paso** (`paso:*`). No existía en el proceso principal: vivía solo en la memoria
de la pantalla, lo que significa que en el ejecutable real no habría protegido nada. Ahora se
guarda derivada —nunca en claro— **dentro del almacén cifrado**, con el mismo coste de scrypt que
la maestra. Va ahí y no en un archivo aparte porque protege el envío de órdenes, que solo es
posible con el panel abierto; fuera quedaría legible justo cuando no hay nadie delante.

---

## 3. El diálogo de confirmación

Es la pieza nueva y la que sostiene la promesa del contrato. Enseña, para la operación que sea:

- **de dónde sale**: activo, precio de referencia y la línea de resumen («100 de margen por
  casilla · 150x · a mercado»);
- **qué recibe cada casilla**: nombre de la subcuenta, lado y lo concreto —`0,0157 · margen real
  99,4 · nocional 14 910`—;
- **qué se queda fuera y por qué**, con el mismo detalle que lo que sí sale.

Los descartes se enseñan a propósito: una subcuenta que no operó y que no aparece en ninguna lista
es una subcuenta cuyo estado el operador va a suponer.

La contraseña de paso solo aparece en la apertura, que es la única acción que compromete dinero
nuevo. Tres intentos fallidos cancelan la operación **sin haber enviado nada**.

---

## 4. Un desenlace que antes no se distinguía

El informe del lote pasa de tres estados a cuatro:

```
correcta        entró
con error       no entró, con el motivo exacto de Bitget
omitida         no aplicaba (esa casilla no tenía posición)
sin confirmar   se envió y no se pudo averiguar si entró
```

El cuarto es el que obliga a separarlos. Se llega a él cuando la orden salió, la respuesta no llegó
y el panel tampoco pudo averiguar después qué pasó. **Contarlo como error invitaría a reintentarlo,
y reintentar a ciegas es lo único capaz de duplicar una posición.** Por eso sale en su propia lista,
en ámbar, con el aviso de comprobarlo en Bitget, y **«reintentar solo las fallidas» no lo incluye**.

Ese botón reenvía el mismo plan acotado a lo que falló de verdad. Al ser el mismo plan, son los
mismos identificadores de orden, y Bitget rechaza el repetido: por eso reintentar es inofensivo.

---

## 5. El apalancamiento, ya al máximo del activo

La propuesta que quedó pendiente de confirmar está aplicada: **elegir un activo pone el campo de
apalancamiento en el máximo de ese activo**, leído del catálogo de Bitget.

| | Real | Demo |
|---|---|---|
| BTC | 150x | 125x |
| ETH | 150x | 100x |
| SOL | 100x | — |
| PEPE | 75x | — |
| PAXG | 50x | — |

Acierta solo en cada activo y se ajusta al mercado sin que nadie recuerde nada. Es un valor de
partida, no una imposición: el campo se sigue pudiendo escribir, y con «valores fijos» activado no
se toca —ese interruptor significa justamente «no me cambies lo que escribí»—.

---

## 6. Un fallo que encontró la prueba de QA

Merece contarse porque es exactamente para lo que se escribió esa prueba.

`verificarCredencial` leía el saldo de la cuenta **siempre en el mercado real**, aunque el panel
estuviera operando en el simulado. El saldo guardado era entonces cero, y toda apertura se
descartaba con *«saldo insuficiente: hacen falta 50 y hay 0»*, teniendo la cuenta 3.000 SUSDT
disponibles.

Ninguna prueba del motor podía verlo: todas le pasan el mercado a mano. Solo apareció al recorrer
el panel entero, que es lo que hace `test/fisica/qa-panel.test.ts`. Corregido: la verificación
ocurre en el mercado en el que el panel va a operar, y el mercado dejó de ser un valor implícito.

---

## 7. Cómo se prueba

```bash
npm test              # 363 pruebas, sin salir a la red
npm run test:e2e      # 10 pruebas sobre la aplicación real ya compilada
npm run test:fisica   # opera de verdad contra el mercado simulado de Bitget
```

**Lo nuevo en la suite sin red** (31 pruebas más):

- `test/renderer/store-plan.test.ts` — las cuatro invariantes de la pantalla: planificar no envía,
  cancelar no envía, sin contraseña de paso no se abre, y reintentar reenvía el mismo plan dejando
  fuera lo indeterminado. El servicio se sustituye por uno que **cuenta los envíos**, así que «no
  envió nada» se comprueba, no se supone.
- `test/integration/catalogo-activos.test.ts` — que solo se ofrezcan los activos del panel, que los
  topes salgan del contrato y que el prefijo del mercado de pruebas no llegue a la pantalla.
- `test/unit/vault.test.ts` — la contraseña de paso: que sin fijar no deje pasar nada, que
  sobreviva a cerrar el almacén y que no aparezca en claro en el archivo.

**`test/fisica/qa-panel.test.ts`** es la prueba de aceptación: recorre el panel entero por el mismo
camino que la pantalla —vault real, credenciales cifradas, registro de cuentas— y ejecuta los doce
pasos de una sesión de trabajo. Es la que hay que enseñar.

### Estado de la última ejecución, contra Bitget

```
almacen .............. creado y desbloqueado
contrasena de paso ... fijada
alta ................. correcta
UID detectado ........ 5476143713
cuenta principal ..... 1513226215
BTC    SBTCSUSDT    hasta 125x · 1 decimales
ETH    SETHSUSDT    hasta 100x · 2 decimales
XRP    SXRPSUSDT    hasta 50x · 3 decimales
precios .............. BTC 74.693 · ETH 2.343,24 · XRP 1,316
precio de referencia . 74.690,9
cantidad ............. 0,0066
margen real .......... 49,295994
apertura ............. 1 con error · 40126
apalancamiento ....... 10x → 20x · 1 correcta
panel bloqueado ...... no admite planificar ni enviar
```

Once de los doce pasos pasan. El único que falla es el envío de la orden, y por lo mismo de
siempre: **`40126`, la credencial del `.env` sigue siendo la de una subcuenta**, y el mercado
simulado solo admite claves creadas desde *Trading Demo* de la cuenta principal. Se ve en la propia
salida: el UID detectado tiene cuenta principal, es decir, es una subcuenta.

Todo lo que rodea a ese envío —catálogo, precios, planificación con cantidades reales, informe por
casilla, apalancamiento de ida y vuelta, panel bloqueado— **ya funciona contra Bitget**.

---

## 8. Lo que sigue

- Poner en `.env` la API Key de *Trading Demo* de la cuenta principal. Con eso los doce pasos pasan
  y las seis funciones quedan demostradas de extremo a extremo.
- Cambiar la cuenta de pruebas a **margen aislado**, para el paso del margen adicional.
- Las posiciones en vivo son de la Fase 6: hasta entonces el área del monitor avisa de que no hay
  datos en lugar de inventarlos.
