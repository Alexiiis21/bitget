# Entrega de la Fase 3 — Administración de cuentas

**Panel de Control Bitget (PCB) v1.0**
Fecha de entrega: 12 de agosto de 2026 · Presupuesto de referencia: Fase 3, $3,000 MXN, 1 semana

> Este documento se usa **delante de la pantalla**. La sección 3 es un guion para recorrer
> la fase punto por punto y marcar cada casilla en el momento. Lo que no se pueda marcar,
> no está entregado.

---

## 1. Qué cubre esta fase, según el presupuesto

> *«Administración de cuentas — alta y baja de cuentas, estado de conexión y selección
> múltiple para ejecución individual o en grupo.»*

| Concepto contratado | Entregable | Estado |
|---|---|---|
| Alta de cuentas | Formulario de registro con validación previa contra Bitget | Entregado |
| Baja de cuentas | Botón *Eliminar*: se van a la vez la cuenta y su credencial cifrada | Entregado |
| Estado de conexión | Indicador por subcuenta, por panel, y refresco automático sin intervención | Entregado |
| Selección múltiple | Casilla a casilla, por cuenta principal y sobre todas a la vez | Entregado |
| Estructura de cuentas | Casilla fija por subcuenta y topes de 5 cuentas principales × 20 subcuentas | Entregado |

### 1.1 Las tres ideas que conviene entender antes de mirar la pantalla

**La casilla es fija, y esto es una decisión, no un detalle.** Cada subcuenta ocupa un
número del 1 al 20 dentro de su cuenta principal, y ese número **no cambia nunca**: si se
da de baja la subcuenta 3, la 7 sigue siendo la 7. Una rejilla que se recoloca sola
obligaría a volver a leerla entera justo en el momento en que hay menos tiempo para leer.
Cuando se da de baja una, su hueco queda libre y lo ocupa la siguiente que se registre.

**El estado de conexión se mantiene solo.** El panel comprueba por su cuenta las cuentas
caídas, con esperas crecientes para no castigar a Bitget, y **la pantalla se entera sola**.
No hay que recargar, ni volver a entrar, ni pulsar nada.

**El saldo no cuesta una petición extra.** Bitget lo devuelve en la misma respuesta con la
que confirma que la API Key sirve, así que el panel lo aprovecha. Se actualiza cada vez que
la credencial se comprueba —al reconectar o al pulsar *Probar*—; el refresco continuo,
cada 2 a 5 segundos, es del Centro de Monitoreo (Fase 6).

---

## 2. Antes de empezar la demostración

```bash
npm install
npm run dev            # datos de demostración: 2 cuentas × 20 subcuentas
npm run dev:staging    # Bitget real, con la credencial de la cuenta demo
```

Se recorren los dos. El primero enseña la fase completa —cuarenta subcuentas, unas
conectadas y otras no— sin depender de la red. El segundo demuestra que lo mismo funciona
contra Bitget de verdad.

> **Aviso para no confundir un dato real con un fallo:** la cuenta demo actual **no tiene
> saldo**. En `dev:staging` la matriz mostrará `0,00 USDT` y el panel avisará de que las
> órdenes se rechazarían por fondos. Es el dato correcto y es, precisamente, lo que hay
> pendiente de tu lado (sección 6).

---

## 3. Guion de validación

### A · Alta y baja de cuentas — `npm run dev:staging`

- [ ] **A1.** El panel arranca **bloqueado**. Sin contraseña maestra no hay credenciales.
- [ ] **A2.** Escribir la contraseña maestra. La primera vez, crea el almacén cifrado.
- [ ] **A3.** *API keys* → rellenar el formulario con una credencial **incorrecta** a
      propósito (cambiar un carácter de la Secret Key) → **Guardar y validar**.
      *Debe verse:* un aviso rojo con el motivo en español, y **la fila no aparece**. La
      credencial no llegó a guardarse.
- [ ] **A4.** Repetir con la credencial buena. *Debe verse:* la fila con la clave
      **enmascarada** (`bg••••8b3f`), el distintivo verde *conectada*, y arriba el contador
      `1 de 1 conectadas`.
- [ ] **A5.** Pulsar **Probar**. Vuelve a preguntar a Bitget y confirma en el momento.
- [ ] **A6.** Registrar **la misma subcuenta otra vez**, con otra API Key. *Debe verse:*
      **no se duplica la fila** — se entiende como rotar la clave, no como una cuenta nueva.
- [ ] **A7.** Pulsar **Eliminar**. La fila desaparece y su credencial se borra del almacén.
- [ ] **A8.** Volver a registrarla y **Volver al panel**. *Debe verse:* la subcuenta en la
      matriz, con su número de casilla y su saldo.

### B · Estado de conexión — `npm run dev:staging`

- [ ] **B1.** Mirar el indicador de la cabecera, junto al nombre del panel. Dice **en
      línea**, **N sin conexión** o **sin conexión** según lo que haya. No es un adorno
      fijo: refleja lo que el panel acaba de comprobar.
- [ ] **B2.** **Cerrar sesión** y volver a entrar con la contraseña maestra.
      *Debe verse:* la cuenta aparece primero como no comprobada y, **sin tocar nada**,
      pasa sola a conectada en unos segundos. Esta es la prueba de que la pantalla se
      entera por su cuenta.
- [ ] **B3.** Pasar el cursor por una casilla de la matriz: aparece el estado de esa
      subcuenta y ese lado.

### C · La matriz y la selección múltiple — `npm run dev`

Con datos de demostración, que traen cuarenta subcuentas y algunas caídas a propósito.

- [ ] **C1.** Entrar y mirar la matriz: dos cuentas principales, cada una con sus
      subcuentas numeradas y su saldo.
- [ ] **C2.** Buscar una casilla con el aviso **⚠**: es una subcuenta **sin conexión**. Se
      distingue a simple vista de una que simplemente no tiene posición abierta. Son dos
      situaciones distintas y piden reacciones opuestas.
- [ ] **C3.** Marcar **una** casilla suelta. Abajo a la derecha: *1 casilla seleccionada*.
- [ ] **C4.** Pulsar **Todas** en la barra azul de una cuenta principal: se marcan sus
      cuarenta casillas (veinte subcuentas × long y short).
- [ ] **C5.** Pulsar **Todas** en la barra lateral: se marcan **las de todas las cuentas
      principales** de una vez → *80 casillas seleccionadas*.
- [ ] **C6.** Pulsar **Ninguna**: la selección se vacía por completo.
- [ ] **C7.** Cambiar el alcance a **Long** y luego a **Short**: el contador cambia,
      porque el alcance decide sobre qué lado se aplicaría la acción.

### D · Estructura y límites

Estas dos reglas no se pueden provocar cómodamente en una demostración —haría falta
registrar seis cuentas principales reales— y están cubiertas por pruebas automáticas:

- [ ] **D1.** El panel admite **hasta 5 cuentas principales**; la sexta se rechaza con un
      mensaje claro, y **sin gastar una sola petición** contra Bitget.
- [ ] **D2.** Cada cuenta principal admite **hasta 20 subcuentas**; la 21 se rechaza igual.
- [ ] **D3.** Se puede comprobar en cualquier momento con `npm test`.

---

## 4. Cómo verificar sin mirar la pantalla

```bash
npm run typecheck    # sin errores de tipos
npm run lint         # cero avisos tolerados
npm test             # 185 pruebas, sin salir a la red
npm run test:red     # 14 pruebas contra api.bitget.com  (requiere .env)
npm run test:staging # las mismas, con el código compilado como staging
npm run test:e2e     # compila y arranca la aplicación real
```

Resultado de esta entrega: **todo en verde**. Las pruebas pasaron de 169 a **185**: las
dieciséis nuevas cubren exactamente lo de esta fase —reparto y estabilidad de las casillas,
lectura del formato anterior, topes del contrato, proyección de la matriz, saldo y avisos
de cambio—.

---

## 5. Lo que esta fase **no** incluye

Para que no haya sorpresas durante la demostración:

- **Las posiciones abiertas no se ven todavía.** El Centro de Monitoreo dirá *sin datos de
  posiciones*. Llegan por conexión en vivo en la **Fase 6**.
- **Las cinco acciones de operación no envían nada.** Se pueden seleccionar casillas y
  pulsar *Abrir*, pero no sale ninguna orden: es la **Fase 4**.
- **No se puede editar una subcuenta ya registrada** —renombrarla o moverla a otra cuenta
  principal—. Hoy se da de baja y se vuelve a dar de alta. Ver sección 6.
- **El alta en tanda desde la interfaz** no existe: la carga masiva funciona por
  herramienta aparte, con el panel cerrado. La importación por planilla la descartaste.

Nada de esto es una limitación técnica: es el reparto por fases del presupuesto.

---

## 6. Dos defectos que encontró la verificación, y que ya están corregidos

Se listan porque se detectaron **probando la aplicación de verdad**, no leyendo el código:

**La matriz se cargaba y se borraba sola.** El listado de cuentas y el flujo de posiciones
—que es de la Fase 6 y todavía no existe— compartían el mismo camino, así que la ausencia
del segundo dejaba la pantalla vacía con un error que no le correspondía. Ahora son dos
fuentes independientes.

**«0 de 20 con posición abierta» cuando no hay datos.** No es lo mismo *no hay posiciones*
que *no se sabe si las hay*, y piden reacciones opuestas del operador. Ahora dice *sin
datos de posiciones*.

---

## 7. Lo que necesito de tu lado

| # | Asunto | Por qué importa |
|---|---|---|
| 1 | **Saldo y margen aislado** en la cuenta demo | Sin saldo la matriz muestra `0,00` y no se puede probar «agregar margen», que Bitget solo permite en margen aislado. Bloquea la Fase 4 |
| 2 | ¿Hace falta **editar** una subcuenta registrada —renombrarla o cambiarla de cuenta principal—? | Hoy es dar de baja y volver a dar de alta. Mover cuentas entre grupos roza la función que el presupuesto excluye en §2.2, así que conviene acotarlo antes de construirlo |
| 3 | ¿Hace falta **dar de alta varias a la vez desde la pantalla**? | La herramienta existe por fuera y exige cerrar el panel |
| 4 | **P-7 · Take Profit por porcentaje**: ¿sobre la ganancia de lo invertido (ROE) o sobre el movimiento del precio? | Con apalancamiento 10x la diferencia es de **diez veces**. Sigue sin respuesta y bloquea la Fase 4 |

---

## 8. Aprobación

Conforme a la cláusula 4(c) del presupuesto, esta fase se entiende aprobada si no se
manifiestan observaciones dentro de los **7 días naturales** posteriores a esta
demostración.

Casillas marcadas en la sección 3: ______ de 21.

Observaciones:

_______________________________________________________________________________

_______________________________________________________________________________

_______________________________________________________________________________

<br>

| | |
|---|---|
| ____________________________ | ____________________________ |
| **Alexis Cárdenas Camacho** · Desarrollador | **Daniel Montero Ramírez** · Cliente |
| Fecha: ____ / ____ / 2026 | Fecha: ____ / ____ / 2026 |

<br>

La **Fase 4 —las cinco funciones de operación: apertura, cierre, Take Profit por
porcentaje, agregar margen y ajuste de apalancamiento—** puede comenzar en cuanto se
resuelvan los puntos 1 y 4 de la sección 7.
