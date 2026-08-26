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

> **Actualización del 26/08/2026.** Las dos filas centrales ya no existen como operación propia: el
> Take Profit y el margen adicional viajan **dentro de la apertura**, y sus cuatro canales se
> retiraron. Convivir con la apertura que ya los llevaba dentro permitía enviarlos dos veces sobre
> la misma posición. Ver `docs/00-correcciones-26-08.md` § 3.5.

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

La contraseña de paso aparece al **abrir y al cerrar**. La primera compromete dinero nuevo; la
segunda realiza el resultado —convierte en definitiva una pérdida que estaba abierta— y tampoco se
deshace pulsando otra vez: un cierre equivocado no se «reabre», se vuelve a abrir a otro precio.
Tres intentos fallidos cancelan la operación **sin haber enviado nada**.

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
| SUI | 75x | — |
| DOGE | 75x | — |
| XRP | 125x | 50x |

Los topes están leídos del catálogo de Bitget el 25 de agosto de 2026, no escritos de
memoria. El mercado de pruebas solo ofrece tres contratos —BTC, ETH y XRP—: SUI y DOGE no
existen en el trading demo de Bitget, así que ahí no aparecen en el selector.

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
  cancelar no envía, sin contraseña de paso no se abre ni se cierra, y reintentar reenvía el mismo plan dejando
  fuera lo indeterminado. El servicio se sustituye por uno que **cuenta los envíos**, así que «no
  envió nada» se comprueba, no se supone.
- `test/integration/catalogo-activos.test.ts` — que solo se ofrezcan los activos del panel, que los
  topes salgan del contrato y que el prefijo del mercado de pruebas no llegue a la pantalla.
- `test/unit/vault.test.ts` — la contraseña de paso: que sin fijar no deje pasar nada, que
  sobreviva a cerrar el almacén y que no aparezca en claro en el archivo.

**`test/fisica/qa-panel.test.ts`** es la prueba de aceptación: recorre el panel entero por el mismo
camino que la pantalla —vault real, credenciales cifradas, registro de cuentas— y ejecuta los doce
pasos de una sesión de trabajo. Es la que hay que enseñar.

### Estado de la última ejecución, contra Bitget · 25 de agosto de 2026

```
almacen .............. creado y desbloqueado
contrasena de paso ... fijada
alta ................. correcta
UID detectado ........ 7514542716
cuenta principal ..... 7514542716
BTC    SBTCSUSDT    hasta 125x · 1 decimales
ETH    SETHSUSDT    hasta 100x · 2 decimales
XRP    SXRPSUSDT    hasta 50x · 3 decimales
precios .............. BTC 79.260,9 · ETH 2.478,17 · XRP 1,473
precio de referencia . 79.260,9
cantidad ............. 0,0063
margen real .......... 49,934367
apertura ............. 1 correctas · 0 con error · 0 omitidas
take profit .......... 1 correctas · 0 con error · 0 omitidas
quitar take profit ... 1 correctas · 0 con error · 0 omitidas
agregar margen ....... 1 correctas · 0 con error · 0 omitidas
cierre ............... 1 correctas · 0 con error · 0 omitidas
apalancamiento ....... 10x → 20x · 1 correctas
panel bloqueado ...... no admite planificar ni enviar
```

**Los doce pasos pasan, y las seis funciones envían de verdad.** Es la primera ejecución en
la que el envío de órdenes no está bloqueado. Lo que lo desbloqueó no fue código: la
credencial del `.env` pasó a ser la de la **cuenta principal**, que es la única que el
trading demo de Bitget admite —una clave de subcuenta responde `40126`— y que además ya
tiene esta IP en su lista blanca.

Suite completa: **43 de 43** pruebas físicas, en dos ejecuciones seguidas.

---

## 8. Lo que sigue

Los dos puntos que quedaban abiertos se resolvieron el 25 de agosto y ya no bloquean nada:

- ~~Poner en `.env` la API Key de la cuenta principal~~ → hecho: los doce pasos pasan y las
  seis funciones quedan demostradas de extremo a extremo.
- ~~Cambiar la cuenta de pruebas a **margen aislado**~~ → hecho, en los dos mercados y para
  los once símbolos del panel. *Agregar margen* ya se ejecuta en vez de descartarse.

Queda:

- Las posiciones en vivo son de la Fase 6: hasta entonces el área del monitor avisa de que no hay
  datos en lugar de inventarlos.
- Nada pendiente en las suites de red: `test:red` iba en paralelo y se quitaba a sí mismo el cupo
  de la IP —Bitget respondía *«está limitando las peticiones»* y la suite fallaba por el cupo, no
  por el panel—. Ahora corre en serie, igual que `test:staging`, y las tres se pueden encadenar.
