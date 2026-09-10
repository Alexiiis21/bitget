# Fase 4 — Reparto y recogida masiva

**Panel de Control Bitget (PCB)** · Fecha: 3 de septiembre de 2026
Presupuesto de referencia: [`presupuesto-traspaso-subcuentas.md`](presupuesto-traspaso-subcuentas.md), Fase 4, 2–3 días, $900 MXN

> Cubre lo contratado: *"distribución de un importe total entre las subcuentas
> seleccionadas (a partes iguales o igualando saldos) y devolución del saldo de
> las subcuentas seleccionadas a la cuenta principal"*. Continúa
> [`00-traspasos-fase-3.md`](00-traspasos-fase-3.md).

---

## 1. Probado contra Bitget el 05/09/2026

Mueve dinero, y ya se ha movido de verdad: ver §8. Hasta esa fecha todo estaba
probado solo contra el exchange simulado, porque la clave de la cuenta madre no
tenía permiso de traspaso. Un reparto es una lista de los mismos traspasos, así
que la prueba física del traspaso cubre también esta fase.

## 2. Lo que se construyó

| Pieza | Dónde |
|---|---|
| Cálculo del reparto y de la recogida | [`domain/plan-reparto.ts`](../src/main/domain/plan-reparto.ts) |
| Ejecución del lote | [`ipc/sesion.ts`](../src/main/ipc/sesion.ts) · `ejecutarReparto` |
| Canales de IPC | `reparto:planificar` · `recogida:planificar` · `reparto:ejecutar` |
| Confirmación con la lista entera | [`DialogoReparto.tsx`](../src/renderer/src/features/panel/DialogoReparto.tsx) |
| Selección y barra de acciones | [`PantallaSaldos.tsx`](../src/renderer/src/features/panel/PantallaSaldos.tsx) |

## 3. La aritmética, que es donde estaba el riesgo

**La suma de las partes es exactamente el total.** Repartir 100 entre 3 no da tres
cifras exactas; si cada parte se redondea por su cuenta, la suma deja de ser 100 y
sobre cien subcuentas ese resto deja de ser un céntimo. Aquí se trunca hacia abajo
—nunca hacia arriba, que sería intentar mover más de lo aprobado— y el sobrante se
reparte de una unidad en una unidad. Hay pruebas que lo comprueban con nueve
combinaciones distintas de total y número de destinos.

**«Igualando saldos» no es «total entre n».** Es llenar vasos de distinta altura
hasta un mismo nivel: se ordenan los saldos de menor a mayor y se busca el nivel
que consuma exactamente el total. Las subcuentas que ya están por encima no
reciben nada —y **tampoco se les quita**: este reparto solo añade—, y salen
listadas en los descartes con el motivo.

La fórmula ingenua `(suma + total) / n` está mal y se ve en cuanto se prueba: con
18 subcuentas y 5.000 a repartir propone mover 48.724, porque las que están por
encima no devuelven su exceso. Ese error llegó a estar en el servicio de
demostración y se detectó mirando la pantalla, no las pruebas.

## 4. Cómo se envía el lote

**Uno detrás de otro, no en paralelo.** Con cien subcuentas el paralelo ahorraría
segundos y dejaría cien movimientos de dinero en vuelo contra un endpoint cuyo
límite de peticiones no está verificado. Los segundos no valen ese riesgo.

**Un fallo no detiene a los demás**, igual que las seis operaciones del panel:
abortar a la mitad dejaría un reparto hecho a medias sin que nadie hubiera
decidido cuál era la mitad buena. El informe dice cuántos entraron y cuántos no,
con el motivo de cada fallo.

**Sin rollback.** Deshacer los traspasos que ya entraron porque uno falló sería
mover dinero por iniciativa propia, que es justo lo que el contrato prohíbe.

Cada traspaso del lote lleva **su propio `clientOid`** derivado del plan, deja su
intento en disco antes de salir a la red y su desenlace después. Contraseña de
paso una vez para todo el lote, y un plan se envía una sola vez.

## 5. Cómo comprobarlo

```bash
npm run typecheck && npm run lint    # sin errores ni avisos
npm test                             # 714 pruebas, 44 archivos
npm run test:e2e                     # 15 sobre la aplicación compilada
```

Pruebas nuevas: 31 unitarias del cálculo
([`plan-reparto.test.ts`](../test/unit/plan-reparto.test.ts)) y 10 de integración
contra el exchange simulado ([`reparto.test.ts`](../test/integration/reparto.test.ts)),
incluidas las del fallo parcial y la ausencia de rollback.

**A mano, en la demostración:** `npm run dev:demo` → **Saldos** → alta de la cuenta
principal → marcar subcuentas con las casillas → importe y modo → *Revisar
reparto*. La confirmación enseña la lista entera y las descartadas. Uno de cada
cinco traspasos falla a propósito, para poder ver el informe parcial.

## 6. Una corrección que salió de aquí

La suite tenía una prueba que fallaba **de forma intermitente**
(`sesion.test.ts > comprobacion de la maestra`): las pruebas de integración creaban
el almacén con los parámetros reales de scrypt —medio segundo y 128 MB por
derivación— y, con varias suites en paralelo, agotaban el límite de tiempo de
vitest. Los archivos de esta fase añadieron carga y lo hicieron visible.

`Sesion` acepta ahora parámetros de KDF baratos **solo en pruebas**, igual que
`Vault` ya hacía. En producción no se pasan y manda el valor real, que es lo que
hace inviable la fuerza bruta sobre un `vault.enc` robado. La suite pasó de 68 a
35 segundos y de intermitente a estable en cinco pases seguidos.

## 7. Estado del requerimiento

| Fase | Estado |
|---|---|
| 1 · Diseño y validación de credenciales | Entregada |
| 2 · Pantalla de saldos | Entregada |
| 3 · Traspaso entre subcuentas | Entregada y **probada contra Bitget** (05/09/2026) |
| 4 · Reparto y recogida masiva | Entregada y **probada contra Bitget** (05/09/2026) |
| 5 · Pruebas y entrega | Pendiente |

## 8. La prueba física, hecha el 05/09/2026

Se concedieron a la clave de la cuenta madre el permiso de traspaso y la lista
blanca de IP, que era lo único que faltaba. Con eso:

```bash
npx vitest run --config vitest.fisica.config.ts test/fisica/traspaso-real.test.ts
```

Seis pasos, todos en verde: la clave responde y reporta sus 20 subcuentas; se
elige destino y se anota su saldo; se planifica **7514542716 → 4995399641** por
0,5 USDT; Bitget lo acepta y devuelve `transferId 1480333282735431680`; el saldo
de la subcuenta pasa a 0,5; y la vuelta —`transferId 1480333285583388672`— la
deja otra vez a 0. La madre acabó con los mismos 2,27477592 USDT con los que
empezó.

La prueba pasa por el **plan del panel**, no por el endpoint pelado: comprueba
que el panel hace bien el traspaso, no solo que Bitget responde. Cubre las dos
direcciones, que son las mismas que usan el reparto (madre → subcuentas) y la
recogida (subcuentas → madre), así que la Fase 4 queda cubierta por ella tal
como decía el §1 de este documento.

No se ejecuta con `npm run test:fisica`: hay que nombrar el archivo. Mueve
dinero real, y una suite que lo haga sin que nadie lo haya pedido es justo lo
que este proyecto no tiene.
