# Entrega v0.7.0 — Traspaso de saldo entre subcuentas

**Panel de Control Bitget (PCB)** · 4 de septiembre de 2026
Binario: `PCB-0.7.0-REAL-portable.exe` · **Mercado real**

> Incorpora el requerimiento adicional de traspasos, fases 1 a 4 de
> [`presupuesto-traspaso-subcuentas.md`](presupuesto-traspaso-subcuentas.md). El panel
> anterior (v0.6.1) no cambia en nada de lo que ya hacía: esto se añade encima.

---

## 1. Qué es nuevo

Un botón **Saldos** en la barra superior, y detrás de él:

| Función | Qué hace |
|---|---|
| **Pantalla de saldos** | El saldo de futuros de cada subcuenta de una cuenta principal, en una sola petición. Dos columnas: lo que tiene y **lo que de verdad puede salir** |
| **Traspaso** | Mueve un importe de una subcuenta a otra. Confirmación previa con origen, destino, importe y cómo quedan los dos saldos |
| **Reparto masivo** | Distribuye un total entre las subcuentas marcadas: a partes iguales, o igualando sus saldos |
| **Recogida masiva** | Devuelve a la cuenta principal el saldo de las subcuentas marcadas |
| **Registro** | Cada movimiento queda con fecha, importe, origen, destino y resultado |

Todo lo que mueve dinero pide la **contraseña de paso**, la misma que ya exige abrir
posiciones.

## 2. Lo que hay que saber antes de usarlo

**«Transferible» no es «disponible».** El capital comprometido en posiciones abiertas no se
puede mover. El panel enseña los dos números por separado y valida contra el transferible,
de modo que no propone traspasos que Bitget vaya a rechazar.

**La API Key de la cuenta principal necesita permiso de traspaso e IP ligada.** Bitget
**exige** IP ligada para las funciones de subcuentas: una clave sin restricción de IP
devuelve error de permisos. Si la conexión es doméstica, la IP cambia sola y ese día habrá
que actualizarla en Bitget. No es un fallo del panel.

**Nada se mueve solo.** No hay traspasos programados ni automáticos. Cada movimiento sale
de una lista que se aprueba antes.

## 3. Un caso que conviene entender: «sin confirmar»

Un traspaso puede terminar de tres formas, no de dos:

| | Qué significa | Qué hacer |
|---|---|---|
| **Enviado** | Bitget lo aceptó | Nada |
| **Falló** | Bitget lo rechazó y dijo por qué | Corregir y repetir |
| **Sin confirmar** | Se envió y Bitget no contestó si entró | **Mirar el saldo antes de repetir** |

El tercero es el que importa. **Repetir un «sin confirmar» puede mover el dinero dos
veces**, porque un envío nuevo lleva un identificador nuevo y la protección contra
duplicados del primero deja de aplicar. El panel lo marca en amarillo, lo deja registrado
como pendiente y lo dice con esas palabras. En un reparto se cuentan aparte: «18 enviados ·
2 sin confirmar» pide comprobar dos saldos, no reenviar dos traspasos.

## 4. Estado honesto de la entrega

**Verificado contra la API real de Bitget** el 3 y 4 de septiembre:

- La lectura de saldos de todas las subcuentas en una sola petición, con datos reales.
- Que leer saldos **no** necesita permiso de traspaso.
- El alta de subcuentas y sus claves (20 creadas con el script).

**Pendiente: la prueba física del traspaso.** Ningún traspaso ha movido dinero real
todavía. Está cubierto por pruebas automáticas contra un exchange simulado —incluidos el
fallo parcial y el envío sin respuesta—, pero eso no sustituye a mover 1 USDT de verdad.
**Es lo primero que hay que hacer con este binario, y con el importe mínimo.**

**Tres bordes sin terminar**, ninguno bloqueante:

1. No hay pantalla para **dar de baja** una cuenta principal. Rotar su clave sí funciona:
   volver a darla de alta la reemplaza.
2. Con **dos o más cuentas principales** registradas, la pantalla de saldos pide que se
   indique cuál y todavía no hay selector para hacerlo. Con una, no se nota.
3. La lista de traspasos pendientes existe por dentro pero no tiene pantalla propia; se ven
   igualmente en el historial, marcados «SIN CONFIRMAR».

## 5. Cómo probarlo

1. Abrir el binario y desbloquear con la contraseña maestra.
2. **Saldos** → dar de alta la API Key de la cuenta principal.
3. Comprobar que aparecen las subcuentas con sus dos columnas.
4. **Un traspaso de 1 USDT** entre dos subcuentas. Revisar la confirmación antes de enviar.
5. Comprobar en Bitget que el movimiento existe, y en el historial del panel que figura.
6. Solo entonces, probar un reparto pequeño.

---

**Verificación de esta versión:** 720 pruebas automáticas, 15 de extremo a extremo sobre la
aplicación compilada, typecheck y lint sin avisos. El binario se comprobó tras empaquetar:
arranca, se identifica como versión 0.7.0 y **mercado real**.
