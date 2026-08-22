# Fase 4 · Funciones 4 y 5 — Agregar margen y ajuste de apalancamiento

**Panel de Control Bitget (PCB) v1.0** · 13 de agosto de 2026
Presupuesto de referencia: Fase 4, $10,500 MXN · **con esto quedan construidas las cinco
funciones de operación** en el proceso principal.

> *«Agregar margen (USDT) — cantidades rápidas y valor personalizado sobre posiciones abiertas.»*
> *«Ajuste de apalancamiento — modificación del apalancamiento sobre las cuentas seleccionadas,
> conforme lo permita la API.»*

---

## 1. Lo primero: hay algo que ya se puede enseñar hoy

Las tres funciones anteriores se quedaban a la espera de una API Key de Trading Demo, porque
todas necesitan abrir una posición. **El ajuste de apalancamiento no**: es configuración de la
cuenta, no una orden. Así que su prueba física **funciona ya, contra Bitget, con la credencial
que hay**:

```
apalancamiento actual ... 10x
fuera de rango .......... rechazado sin enviar nada
plan .................... ?x → 20x
enviado ................. exito · Apalancamiento 20x
leído de Bitget ......... 20x
tras repetir ............ 20x
restaurado .............. 10x
```

Siete pasos, todos verdes, y la cuenta queda como estaba. Es la primera demostración de extremo
a extremo del motor de lotes con dinero y cuenta reales: planificar, rechazar lo que no cabe,
enviar, comprobar cómo quedó y restaurar.

---

## 2. Qué se construyó y dónde

| Pieza | Archivo |
|---|---|
| Los dos endpoints | `ajustarMargen` y `fijarApalancamiento` en [`rest/endpoints/cuenta.ts`](../src/main/bitget/rest/endpoints/cuenta.ts) |
| Motor | `planificarMargen` / `ejecutarMargen` y `planificarApalancamiento` / `ejecutarApalancamiento` |
| Conexión con el panel | Canales `margen:*` y `apalancamiento:*` |

Ambas reutilizan el motor de lotes de las funciones anteriores: bloques, informe por cuenta,
reintento de lo transitorio y resolución de lo indeterminado son los mismos. Lo único propio de
cada una es qué se envía y cómo se comprueba el resultado.

---

## 3. Son las dos caras de la misma moneda, y se comportan al revés

**Agregar margen es la más delicada de las cinco.** Usted marcó el margen como lo más crítico, y
aquí eso se traduce en tres puertas antes de que salga una sola petición:

1. **Que exista la posición.** Agregar margen a lo que no hay no es un fallo que arreglar.
2. **Que esté en margen aislado.** Bitget responde `40808 · margin mode == FIXED` en cruzado —
   verificado el 13 de agosto—. Comprobarlo aquí evita la petición y convierte ese texto en
   *«Solo se puede agregar margen en margen aislado, y esta cuenta está en cruzado»*.
3. **Que la cuenta tenga saldo.** Es dinero nuevo saliendo del disponible, y enterarse a mitad de
   un lote de cien es enterarse tarde. Además el saldo **se reparte entre las casillas de la
   misma subcuenta**: si marca long y short con 50 USDT cada uno, hacen falta 100, no 50.

Y una diferencia que obliga a tratarla distinto de las demás: **`set-margin` no acepta
identificador propio.** En las otras cuatro funciones, un reenvío accidental lo rechaza Bitget
porque reconoce el identificador. Aquí no existe esa red, y agregar margen dos veces
comprometería el doble del dinero aprobado. Por eso, cuando la conexión se corta después de
enviar, el panel **no reintenta**: vuelve a leer el margen de la posición y compara con el que
debería haber quedado.

**El ajuste de apalancamiento es la más benigna.** Fijar 150x dos veces deja 150x, así que un
reenvío no tiene consecuencia. Tampoco necesita posición, ni consulta nada antes: un lote de cien
cuentas son cien peticiones y ninguna consulta previa. Lo único que se comprueba es el rango del
activo, que sale del catálogo ya en memoria —fuera de rango Bitget contesta *«Leverage ratio
exceeded the set limit»*, y es una petición que no hace falta gastar para saber la respuesta.

---

## 4. Cómo se prueba

```bash
npm test              # 320 pruebas, sin salir a la red
npm run test:fisica   # el apalancamiento se ejecuta de verdad contra Bitget
```

Las 15 pruebas nuevas cubren, entre otras cosas: las tres puertas del margen; que el saldo se
reparta entre las casillas de una misma cuenta; que un fallo en una cuenta no impida las demás;
el corte de red con el margen ya agregado y sin agregar; 300 cuentas de apalancamiento a la vez;
y que un valor fuera de rango aborte el lote sin gastar peticiones.

Una nota de honestidad sobre estas pruebas: la primera versión del apalancamiento a 300 cuentas
**falló**, y falló bien. El simulador devolvía una respuesta incompleta y la validación de
esquema la rechazó — que es exactamente lo que debe pasar si algún día Bitget cambia ese campo.
El defecto estaba en la prueba, no en el motor.

---

## 5. Sobre el apalancamiento al máximo

Usted opera siempre al máximo de cada activo, y son 754 activos con topes distintos:

| | Real | Demo |
|---|---|---|
| BTC | 150x | 125x |
| ETH | 150x | 100x |
| SOL | 100x | — |
| PEPE | 75x | — |
| PAXG | 50x | — |

(Comprobado el 18/08/2026 contra el catálogo de Bitget. El mercado de pruebas solo ofrece BTC, ETH
y XRP, y de los cinco activos del panel el cliente no opera XRP: la demostración física irá sobre
Bitcoin.)

La propuesta sigue en pie y ahora es trivial de aplicar: **que el campo venga por defecto con el
máximo del activo**, leído del catálogo de Bitget. Acierta solo en cada activo, se ajusta solo al
mercado simulado, y no cuesta ninguna petición. Con esta función ya construida, ponerlas todas al
máximo es una sola acción del panel en lugar de entrar cuenta por cuenta.

---

## 6. Estado de la Fase 4

| Función | Construida | Prueba física |
|---|---|---|
| 1 · Apertura | Sí | Bloqueada por la API Key |
| 2 · Cierre (rápido) | Sí | Bloqueada por la API Key |
| 3 · Take Profit | Sí | Bloqueada por la API Key |
| 3b · Quitar Take Profit | Sí, el 18/08 a petición del cliente | Bloqueada por la API Key |
| 4 · Agregar margen | Sí | Bloqueada por la API Key **y** requiere margen aislado |
| 5 · Apalancamiento | Sí | **Pasa hoy, contra Bitget** |

Lo que falta para desbloquear las cuatro primeras sigue siendo lo mismo: **una API Key creada
desde la sección de Trading Demo** de la cuenta principal de Bitget. No requiere KYC ni fondos.

Para la de margen hace falta además que la cuenta de pruebas esté en **margen aislado**; ahora
mismo está en cruzado. Se puede cambiar desde la propia web de Bitget, y también por API
(comprobado), aunque el panel no lo hace por su cuenta: cambiar el modo de margen de una
subcuenta es una decisión del operador, no algo que deba pasar de lado.

Con las cinco funciones construidas, lo siguiente es **conectarlas a la pantalla**.
