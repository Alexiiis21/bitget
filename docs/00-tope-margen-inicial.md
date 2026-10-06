# Tope de margen inicial — el freno contra el «dedo gordo»

**Panel de Control Bitget (PCB)** · 6 de octubre de 2026

> *«Que pueda configurar antes de comenzar a operar el valor máximo de margen inicial. Una vez
> configurado, ya no se puede modificar hasta después de 24 horas, y así cada 24 horas te pide
> que antes de operar agregues el valor máximo de margen inicial.»*

---

## 1. Qué problema resuelve

Ningún control anterior sabía cuánto quiere arriesgar el operador. Si escribe **5** donde quería
**0.5**, el saldo alcanza, Bitget acepta la cantidad y la confirmación enseña una cifra correcta:
la que escribió. Con cien casillas y apalancamiento alto, ese dígito de más se multiplica por las
dos cosas.

El tope es un número que se fija **antes** de operar, en frío, y que aplica a **todo el panel**:
ninguna apertura puede llevar más margen inicial por casilla que el tope.

## 2. Las reglas

| Regla | Qué pasa |
|---|---|
| Panel recién instalado | Al entrar pide el tope. Sin tope no se abre nada |
| Tope fijado | Durante **24 horas** no se puede cambiar: **ni subir ni bajar** |
| Margen por encima del tope | Se rechaza la operación **entera**, sin enviar nada a Bitget |
| Pasadas las 24 horas | El tope vence y el panel vuelve a pedirlo antes de dejar abrir |
| Agregar margen | **No** está sujeto al tope |
| Cerrar, Take Profit, apalancamiento | No dependen del tope |

Ejemplo con tope de 1 USDT: escribir 5 en «Margen inicial» da *«Escribió 5 de margen inicial y el
tope de este panel es 1. No se envió ninguna orden.»* Escribir 1 o 0.5 funciona igual que antes.

## 3. En la pantalla

- **Diálogo «Margen inicial máximo»**: aparece al entrar si no hay tope o si venció. El valor se
  escribe **dos veces**, como una contraseña: es justo el número que no se puede corregir durante
  un día. Se puede cerrar con «Ahora no» para cerrar posiciones, pero «Abrir» lo vuelve a traer.
- **Distintivo en la barra superior**, junto a SIMULADO / MERCADO REAL:
  `TOPE 1 USDT · 23 h 59 min` mientras está vigente; `SIN TOPE` o `TOPE VENCIDO` en ámbar cuando
  falta. Si vence con el panel abierto, el diálogo aparece solo.

## 4. Por qué no se puede saltar fácilmente

- **Se comprueba en el proceso principal**, no en la pantalla: antes de planificar y otra vez al
  enviar. Si el tope vence entre las dos, no sale nada.
- **Vive dentro del almacén cifrado** (`vault.enc`), junto a la contraseña de paso. Editarlo a
  mano rompe la autenticación del archivo y el panel no abre.
- **La hora la da Bitget**, no Windows. Adelantar el reloj del equipo hace que el tope *parezca*
  vencido, lo que solo bloquea las aperturas; para fijar otro el panel pregunta la hora a Bitget, y
  Bitget dice que no han pasado 24 horas. Atrasar el reloj antes de fijar tampoco sirve: la fecha
  que se guarda es la de Bitget. Sin conexión con Bitget no se fija ningún tope.

**Lo que no impide:** es un freno contra errores, no contra el dueño del panel. Quien sustituya
`vault.enc` por su respaldo `vault.enc.bak` a mano vuelve al estado anterior del almacén, tope
incluido, y quien borre la carpeta de datos empieza un panel nuevo —sin credenciales—.

## 5. Dónde está

| Pieza | Archivo |
|---|---|
| La regla, pura y probada aparte | [`main/domain/tope-margen.ts`](../src/main/domain/tope-margen.ts) |
| Guardado cifrado | [`main/security/vault.ts`](../src/main/security/vault.ts) |
| Consultar, fijar y la puerta de la apertura | [`main/ipc/sesion.ts`](../src/main/ipc/sesion.ts) · canales `tope:estado` y `tope:fijar` |
| Diálogo y distintivo | [`DialogoTope.tsx`](../src/renderer/src/features/panel/DialogoTope.tsx) · [`Encabezado.tsx`](../src/renderer/src/features/panel/Encabezado.tsx) |

Pruebas: `test/unit/tope-margen.test.ts`, el bloque «tope de margen inicial» de
`test/integration/sesion.test.ts` (incluidos los trucos de reloj), `test/unit/vault.test.ts` y
`test/renderer/store-plan.test.ts`. La prueba física `qa-panel` fija un tope antes de abrir.
