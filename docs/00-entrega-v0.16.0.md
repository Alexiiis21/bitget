# Entrega v0.16.5 — Historial, exportación a CSV, identificador de subcuenta y alertas por Telegram

**Panel de Control Bitget (PCB)** · 27 de octubre de 2026
Binario: `PCB-0.16.5-REAL-portable.exe` · **Mercado real**

> Incluye todo lo de la v0.15.0 (historial por periodo y resultado neto, ver
> `00-entrega-v0.15.0-historial.md`), que no llegó a entregarse por separado. **Nada de lo
> que ya existía para operar cambia de comportamiento.**

---

## 1. Historial por periodo y resultado neto

Botón **Historial** en la barra superior. Operaciones cerradas de una subcuenta en un periodo, con ganadoras, perdedoras, resultado neto en USDT y saldo actual. Detalle en `00-entrega-v0.15.0-historial.md`.

## 2. Filtros y exportación a CSV

En la pantalla de Historial:

- **Filtros** por par, lado (Long/Short) y resultado (ganadoras/perdedoras). Se aplican a la tabla, al resumen y al archivo. Cuando hay filtro, el resumen dice "SOLO LO FILTRADO".
- **Exportar CSV** guarda exactamente lo que se ve, en un archivo que Excel abre con los números como números. El panel pregunta dónde guardarlo y propone un nombre como `historial_PCB-1-A-1_2026-08-01_a_2026-08-07.csv`.

## 3. Identificador de subcuenta

Cada subcuenta tiene un identificador interno: `PCB-1-A-1` es el panel 1, la cuenta madre A y la casilla 1.

- Se ve en la barra superior del Historial, de modo que una captura de pantalla dice de qué subcuenta es.
- Es la primera columna del CSV y va en el nombre del archivo.
- Encabeza cada subcuenta en las alertas de Telegram.

## 4. Alertas por Telegram de operaciones hechas fuera del panel

Botón **Alertas** en la barra superior. Avisa en un grupo de Telegram de lo que se hizo en las subcuentas **fuera del panel**: desde la app, la web de Bitget u otro programa. Revisa al desbloquear el panel y, mientras está abierto, cada 15 minutos.

- **Se avisa:** abrir y cerrar posiciones, poner o quitar TP/SL, agregar o quitar margen, cambios de apalancamiento y de modo de margen, y traspasos.
- **No se avisa:** lo que hace el propio panel, lo automático (TP/SL disparado, liquidación) y lo anterior a activar las alertas.
- **Configuración:** cada panel configura su propio bot, guardado cifrado en su almacén. Guardarlo y desactivarlo piden la contraseña de paso.
- **Guía paso a paso:** `00-alertas-telegram.md`.

Es la única comunicación del panel con algo que no es Bitget (`api.telegram.org`), y solo existe si se configura un bot.

## 5. Otros cambios

- Se retiró el acordeón "Historial de posiciones" que aparecía bajo cada cuenta en la matriz. Era un esbozo sin funcionalidad que mostraba un error al abrirlo; lo sustituye la pantalla de Historial.

## 6. v0.16.1 — Ver la contraseña maestra al desbloquear

La pantalla de desbloqueo tiene un botón **Ver / Ocultar** junto al campo de la contraseña maestra, y avisa si **Bloq Mayús** está activado. Cada intento fallido alarga la espera del freno, y un error de tecleo es la causa más común; así se puede comprobar lo escrito antes de enviarlo.

## 7. v0.16.2 — Barra superior en pantallas pequeñas

En laptops de 1280–1366 px, el precio y el selector Claro/Oscuro se encimaban. Ahora, si la barra no cabe en una línea, los botones bajan a una segunda fila y la matriz se recorre hacia abajo; nada queda tapado.

## 8. v0.16.3 — API key y cuenta en cada fila del Historial

La tabla del Historial tiene una primera columna, **API KEY · CUENTA**, con la API key enmascarada —igual que en el registro de API keys— y el nombre de la subcuenta. Así cada fila dice de qué credencial es, también en una captura recortada. La clave nunca se muestra completa.

## 9. v0.16.4 — Take Profit protegido y cuentas clásicas por la API correcta

Nace de la revisión de ELITE LAURA (PEPEUSDT, cobertura) del 19-20/10, donde un Take Profit de short se vio en Bitget por encima de la entrada.

- **Un Take Profit nunca sale del lado de un Stop Loss.** En un long tiene que quedar por encima de la entrada y del precio actual; en un short, por debajo. Si no, la casilla se descarta al planificar con un mensaje que lo explica, y si algo llegara torcido al envío, se rechaza sin mandar nada a Bitget. Vale para el botón Take Profit y para el Take Profit que acompaña a la apertura.
- **Cuentas que Bitget declara clásicas van por la API clásica.** LAURA se trataba como UTA aunque Bitget la declara `classic`, y por eso el Take Profit del short no quedó puesto con la apertura. Una cuenta con un tipo que el panel no reconoce no opera hasta revisarlo, con el motivo en pantalla.
- **En UTA, el Take Profit de la apertura se comprueba.** Tras abrir, el panel mira en Bitget que el Take Profit esté puesto; si falta, lo repone, y si no puede, la fila queda marcada «SIN Take Profit».
- **Tras enviar cualquier lote, la matriz se desmarca** y solo quedan marcadas las casillas que fallaron, para reintentarlas sin buscarlas. Antes solo abrir y cerrar desmarcaban.
- **Diagnóstico:** el registro dice qué versión corre, qué lado y qué cantidad lleva cada Take Profit enviado o modificado, qué órdenes TP/SL tenía puestas Bitget y el resultado de cada revisión y envío de alertas de Telegram. Sirve para responder con datos la próxima vez que algo no cuadre.

## 10. v0.16.5 — Las cuentas UTA vuelven a conectar

Con la v0.16.4, una cuenta UTA (la ELITE) no se podía agregar al panel: salía **«Credenciales inválidas · código 40731»**.

- **Qué pasaba.** Bitget declara algunas cuentas UTA como `classic`. La v0.16.4 las mandaba por eso a la API clásica, y esa API las rechaza. Las claves estaban bien.
- **Qué cambia.** Cuando Bitget dice `classic`, el panel lo comprueba con la API clásica antes de usarla. Si la API clásica la acepta, la cuenta va por ella, como en la v0.16.4. Si la rechaza, la cuenta opera por la API UTA, como hacía antes de la v0.16.4.
- **Se mantiene** la comprobación del Take Profit tras abrir en UTA (sección 9): si falta, se repone, y si no se puede, la fila queda marcada «SIN Take Profit».
- **Diagnóstico.** El registro anota cada alta y cada revalidación de credenciales: por qué API fue, qué contestó Bitget y por qué se aceptó o se rechazó.
- **Qué hacer.** Abra la v0.16.5 y agregue de nuevo la cuenta UTA. Si da cualquier error, envíe el archivo de registro de ese día de la carpeta `datos\logs`.

## 11. Lo que conviene saber

- **Bitget solo entrega 90 días** de historial. El panel guarda lo que consulta; conviene abrir cada subcuenta en el Historial al menos una vez cada 90 días.
- **Apalancamiento y porcentaje por operación** aparecen como "—" en el Historial: Bitget no los informa.
- **Las alertas no son tiempo real con el panel cerrado:** lo de ese tiempo llega al abrirlo.
- **Pendiente de confirmar con una operación manual:** qué origen marca Bitget a lo hecho desde la app ("App"/"Web"), y cómo aparece un TP disparado en una cuenta UTA, que hasta capturar un caso real podría avisarse como cierre.
