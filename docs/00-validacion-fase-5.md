# Validación de la Fase 5 — Guion de pruebas

**Panel de Control Bitget (PCB) v0.5.1**
Fecha: 29 de agosto de 2026

> Este documento se usa **delante de la pantalla**. Cada casilla se marca en el momento.
> Lo que no se pueda marcar, no está entregado.

La Fase 4 quedó cerrada y los trece puntos que reportaste están resueltos. Esto es el guion con el
que se comprueba, uno por uno. No hace falta saber nada del código: cada paso dice **qué hacer** y
**qué debe verse**.

Si un paso no sale como dice aquí, no lo des por bueno aunque parezca menor. La sección 6 explica
qué necesito de cada fallo para poder arreglarlo.

---

## 1. Antes de empezar

### Qué ejecutable abrir

Hay dos, y el mercado va dentro de cada uno:

| Archivo | Mercado | Qué mueve |
|---|---|---|
| `PCB-0.5.1-staging-portable.exe` | Simulado | Saldo de prueba de Bitget |
| `PCB-0.5.1-REAL-portable.exe` | Real | **Dinero de verdad** |

**Todo este guion se hace con el de staging.** El de mercado real no se toca hasta que este
documento esté cerrado.

Se comprueba de un vistazo: en la barra de arriba, junto al número de panel, el de dinero real
dice **`MERCADO REAL`** en rojo, y cada confirmación empieza por `REVISAR ANTES DE ENVIAR ·
MERCADO REAL`. Si dice `SIMULADO`, estás en el correcto para probar.

### Dónde quedan los datos

En una carpeta `datos-staging\` **junto al `.exe`**. No hay instalador, ni registro de Windows, ni
nada que configurar: se copia el archivo y se abre. Las credenciales se guardan cifradas ahí.

- [ ] **P1.** Copiar el `.exe` a una carpeta propia (por ejemplo `D:\PCB\`) y abrirlo desde ahí.
      *Debe verse:* la pantalla de contraseña maestra, con el panel bloqueado.
- [ ] **P2.** Escribir una contraseña maestra. La primera vez, crea el almacén cifrado.
- [ ] **P3.** Registrar al menos **dos subcuentas** con sus API Keys, en la misma cuenta principal.
      Dos hacen falta para poder probar lo de las casillas y los saldos.
- [ ] **P4.** *Seguridad* → fijar una **contraseña de paso**. Es la que se pide al abrir y al
      cerrar posiciones, y hace falta para varios pasos de este guion.

---

## 2. Los trece puntos que reportaste

Uno por punto. Los seis últimos son los de la última tanda.

### Puntos 1 al 7

> **Pendiente de completar antes de enviar este documento.** Estos siete se reportaron en tandas
> anteriores y no quedaron escritos en el proyecto. Hay que redactar aquí qué se reportó y cómo se
> comprueba cada uno, con el mismo formato que los seis de abajo.

- [ ] **1.** *(por completar)*
- [ ] **2.** *(por completar)*
- [ ] **3.** *(por completar)*
- [ ] **4.** *(por completar)*
- [ ] **5.** *(por completar)*
- [ ] **6.** *(por completar)*
- [ ] **7.** *(por completar)*

### Punto 8 · La `l` minúscula en la contraseña de la API

Lo reportado: que el campo no aceptaba la `l` minúscula y daba error de contraseña, «como si fuera
otra letra».

Se revisó el recorrido completo del dato y **no había ningún filtro**: la letra viaja intacta desde
el campo hasta la cabecera que se firma, comprobado con una prueba que guarda y recupera una
passphrase con `l`, `L`, `1` e `I` mezcladas. Lo que sí se corrigió es lo único del camino que
podía rechazar una credencial bien escrita: la passphrase era el único de los tres campos que no se
recortaba, así que un espacio pegado al copiar y pegar —o el espacio duro que arrastran las notas y
los PDF— llegaba dentro de la cabecera y Bitget contestaba «la passphrase no coincide».

- [ ] **8a.** *API keys* → escribir una passphrase que contenga una `l` minúscula y pulsar
      **Mostrar**. *Debe verse:* el carácter, en una tipografía donde la `l` lleva rabito y no se
      confunde con la `I` mayúscula ni con el `1`.
- [ ] **8b.** Dar de alta esa credencial. *Debe verse:* se valida y aparece en la lista.
- [ ] **8c.** Repetir pegando la passphrase **con un espacio al final**. *Debe verse:* se valida
      igual; el espacio se recorta solo.

### Punto 9 · Permisos de retiro en las API Keys

Lo reportado: que el panel debía admitir claves con permiso de retiro, porque la función de
traspasos entre cuentas va a necesitarlo.

Hecho, y conviene que quede claro lo que cuesta: **el panel ya no rechaza ninguna clave por sus
permisos**. Antes rechazaba cualquier permiso que no reconociera, y eso era lo que sostenía la
frase del presupuesto —«quien obtuviera esas claves no podría sacar un solo dólar»—. Esa frase ha
dejado de ser cierta, a petición tuya y por escrito.

A cambio, ninguna clave entra en silencio:

- [ ] **9a.** Dar de alta una clave normal, de solo futuros. *Debe verse:* entra sin ningún aviso
      sobre permisos.
- [ ] **9b.** Dar de alta una clave con permisos de más *(si tienes alguna a mano)*. *Debe verse:*
      entra, y sale un aviso nombrando los permisos que el panel no sabe interpretar.
- [ ] **9c.** Si la clave puede **sacar fondos**, el aviso es rojo, dice *Esta API Key puede sacar
      fondos*, y **se queda fijo en pantalla** hasta que se cierra a mano. Los demás avisos se van
      solos a los cuatro segundos; ese no.

### Punto 10 · El saldo se actualiza solo, sin pulsar *Probar*

- [ ] **10a.** Anotar el saldo que muestra una subcuenta en la matriz.
- [ ] **10b.** Desde la **web de Bitget**, mover saldo a esa subcuenta.
- [ ] **10c.** Volver al panel y **no tocar nada**. *Debe verse:* el saldo cambia solo en menos de
      un minuto. No hay que pulsar *Probar* en ninguna fila.
- [ ] **10d.** Abrir una posición y mirar el informe. *Debe verse:* el saldo de la matriz baja **en
      el mismo momento**, no un minuto después. Cuando es el propio panel el que mueve el dinero,
      no espera su turno.

### Punto 11 · Cambiar los colores rojo · verde · amarillo

- [ ] **11a.** Botón **Colores** en la barra de arriba. *Debe verse:* los tres, con una muestra de
      cómo queda la casilla de la matriz —la barra fina del pie, que es donde el color se lee de
      verdad—.
- [ ] **11b.** Cambiar el verde. *Debe verse:* la matriz de detrás cambia **al instante**, sin
      pulsar guardar y sin que la pantalla parpadee.
- [ ] **11c.** Cerrar el panel y volver a abrirlo. *Debe verse:* el color elegido sigue puesto.
- [ ] **11d.** Pulsar **Restablecer**. *Debe verse:* vuelven el verde, rojo y amarillo originales.

> Un detalle: el amarillo pinta también los rótulos *SUSP* y *SUSPENDIDO* de la barra lateral y del
> buscador de activos. Es el mismo significado —«esto no se puede operar»— y por eso se mueve con
> él.

### Punto 12 *(por completar)*

- [ ] **12.** *(por completar)*

### Punto 13 · Las casillas se desmarcan solas, y el margen adicional que no cabe

Dos cosas que se pidieron juntas.

**Desmarcar tras abrir y tras cerrar:**

- [ ] **13a.** Marcar varias casillas y abrir. *Debe verse:* al terminar, **ninguna queda marcada**.
      La siguiente acción ya no puede caer sobre ellas por descuido.
- [ ] **13a-bis.** Marcar varias casillas **con posición abierta** y cerrar. *Debe verse:* al
      terminar, **ninguna queda marcada** —tampoco si el lote salió a medias: las fallidas se
      recuperan con «Reintentar solo las fallidas», no con las casillas tildadas—. Añadido el
      11/09/2026: hasta entonces solo desmarcaba la apertura y había que destildar a mano tras cada
      cierre.
- [ ] **13b.** Marcar casillas y usar otra operación —poner Take Profit, o apalancamiento—. *Debe
      verse:* la selección **se conserva**. Solo abrir y cerrar la deshacen, para poder encadenar
      dos ajustes sobre las mismas casillas.

**Margen adicional sin saldo:**

- [ ] **13c.** Marcar varias casillas, entre ellas una de una subcuenta **sin saldo suficiente**
      para el margen inicial más el adicional. Escribir un margen adicional y pulsar **Abrir**.
- [ ] **13d.** *Debe verse:* la confirmación se abre con un recuadro rojo arriba del todo,
      **NO SE VA A ENVIAR NADA**, explicando cuántas casillas van cortas y las tres salidas: bajar
      los importes, añadir saldo o desmarcar esas casillas.
- [ ] **13e.** *Debe verse:* **no pide la contraseña de paso**, y el botón de confirmar está
      apagado diciendo *Corrija los valores para continuar*.
- [ ] **13f.** *Debe verse:* más abajo, en *SE QUEDAN FUERA*, está nombrada la casilla que va corta
      con su motivo.
- [ ] **13g.** Desmarcar esa casilla y volver a pulsar **Abrir**. *Debe verse:* ahora sí pide la
      contraseña y el botón vuelve a estar activo.

### Punto 14 · Corregir una posición que ya está abierta

Lo que pediste: poder **agregar o quitar margen adicional** en una posición abierta —o en varias— y
lo mismo con el Take Profit. Está en la barra lateral, en su propia sección: **SOBRE POSICIONES
ABIERTAS**, debajo de los parámetros de la orden.

Los campos son **otros** que los de arriba, y no es un descuido de diseño: el *Take Profit %* y el
*Margen adicional* de PARÁMETROS salen con la orden al pulsar *Abrir*, y compartirlos con estos
botones es lo que el 26/08/2026 dejó una posición con 2 USDT de margen donde se había escrito 1.

**Margen, en los dos sentidos:**

- [ ] **14a.** Abrir una posición en margen **Aislado**. Marcar su casilla, escribir `5` en el campo
      *Margen* de la sección y pulsar **Agregar**. *Debe verse:* la confirmación dice, casilla por
      casilla, `margen X → X+5`, con la **X leída de Bitget en ese momento**.
- [ ] **14b.** Confirmar y comprobar el margen en Bitget. *Debe verse:* subió exactamente 5.
- [ ] **14c.** Volver a pulsar **Agregar** con la misma casilla marcada. *Debe verse:* el campo está
      **vacío** —no hereda el importe anterior— y hay que volver a escribirlo. Al escribirlo, la
      confirmación parte de `X+5`, no de `X`: un envío repetido se ve **antes** de enviarlo.
- [ ] **14d.** Escribir `5` y pulsar **Quitar**. *Debe verse:* `margen X+5 → X`, y tras confirmar,
      el margen en Bitget vuelve a X.
- [ ] **14e.** Intentar quitar **todo** el margen de una posición. *Debe verse:* la casilla se queda
      fuera con el motivo: quitarlo entero la liquidaría, y para eso está *Cerrar*.
- [ ] **14f.** Escribir `-5` y pulsar **Agregar**. *Debe verse:* no se planifica nada, y el aviso
      dice que el número va sin signo porque el sentido lo decide el botón.
- [ ] **14g.** Repetir 14a sobre una posición en margen **Cruzado**. *Debe verse:* la casilla se
      queda fuera explicando que en cruzado no hay margen por posición —Bitget lo toma del saldo
      total de la cuenta—.

**Take Profit, sobre lo ya abierto:**

- [ ] **14h.** Sobre una posición **sin** Take Profit, escribir un porcentaje en el campo *Take
      Profit* de la sección y pulsar **Poner Take Profit**. *Debe verse:* la confirmación enseña el
      **precio concreto** de cada casilla, no el porcentaje.
- [ ] **14i.** Con esa misma posición ya protegida, poner otro porcentaje distinto. *Debe verse:* la
      confirmación dice `TP <precio viejo> → <precio nuevo> (sustituye el puesto)`.
- [ ] **14j.** Confirmar y mirar la posición en Bitget. *Debe verse:* hay **un solo** Take Profit, el
      nuevo. El anterior se quitó; nunca quedan dos órdenes de cierre sobre la misma posición.
- [ ] **14k.** Pulsar **Quitar Take Profit** sobre esas casillas. *Debe verse:* la confirmación
      nombra el precio que se va a quitar, y tras confirmar la posición queda sin él.

---

## 3. Las seis operaciones

No hace falta repetirlas enteras: el guion de la demostración anterior sigue valiendo, paso por
paso. Está en [`00-aceptacion-fases-3-y-4.md`](00-aceptacion-fases-3-y-4.md), sección **E**, y son
los pasos E1 a E12.

- [ ] **O1.** Recorrer los pasos **E1 a E12** de ese documento, con el ejecutable de staging.

Los dos que más conviene no saltarse, porque son los que frenan una operación mal parametrizada:

- [ ] **O2.** **E8** — margen adicional con el modo en **Cruzado**: no se abre nada y se dice por
      qué.
- [ ] **O3.** **E11** — dejar la confirmación abierta **más de dos minutos** y confirmar: el plan
      ha caducado y hay que volver a revisarlo. El precio con el que se calculó ya no es el de
      ahora.

---

## 4. Lo que **no** entra en esta ronda

Dos cosas que vas a ver y que no hay que probar todavía. Si aparece algo raro en cualquiera de las
dos, no es un fallo de esta entrega.

**El Centro de Monitoreo con posiciones en vivo.** Lo vas a ver funcionando: el panel pinta las
posiciones abiertas de cada subcuenta, con su Take Profit y su margen. Está construido y probado,
pero **es la Fase 6 y no está abierta**: no se ha revisado contra el uso real ni entra en esta
validación. Se dice aquí en lugar de callarlo, para que no se reporte contra una fase sin empezar.

**La primera operación con dinero real.** Necesita el KYC de la cuenta principal de Bitget. Sin él,
Bitget no acepta ni una orden real de ninguna subcuenta. Cuando esté, la primera se hace **a mano y
con el monto mínimo**, antes de usar la ejecución sobre muchas casillas: es la comprobación de que
la cuenta está en el modo de margen y el apalancamiento que el panel supone.

---

## 5. Lo que se comprobó por nuestro lado

Antes de generar el ejecutable que estás probando:

- [ ] **V1.** `npm run typecheck` — sin errores de tipos.
- [ ] **V2.** `npm run lint` — sin avisos.
- [ ] **V3.** `npx vitest run` — 562 pruebas, todas en verde.
- [ ] **V4.** `npm run test:fisica` — la batería de aceptación contra el mercado simulado de
      Bitget, con almacén cifrado y credenciales de verdad. Es el recorrido completo del panel.
- [ ] **V5.** `npm run test:red` y `npm run test:staging` — que las respuestas de Bitget siguen
      teniendo la forma que el panel espera.
- [ ] **V6.** `npm run test:e2e` — la aplicación compilada arranca.
- [ ] **V7.** El ejecutable **no imprime trazas de depuración**. El código que volcaba al terminal
      identificadores de cuenta, saldos y márgenes se retiró entero antes de compilar.

---

## 6. Si algo falla

Con estos tres datos lo arreglo; sin ellos hay que investigar a ciegas, que es lo que pasó con el
punto 8 y costó una revisión entera del recorrido de la contraseña.

1. **En qué pantalla.** No es lo mismo la de desbloqueo, la de API keys o la confirmación de una
   operación: cada una da errores distintos y vienen de sitios distintos.
2. **El texto exacto del error**, tal cual sale. Copiado o en captura. Un mensaje que empieza por
   «La API Key no existe» viene de Bitget; uno que dice «No se pudo preparar» viene del panel, y
   eso ya acota la mitad del problema.
3. **Qué estabas haciendo justo antes.** Qué casillas había marcadas, qué valores estaban escritos
   y qué botón se pulsó.

Y una cosa que ayuda más que las tres juntas cuando el fallo va y viene: **si se repite siempre o
solo a veces**.
