# Alertas por Telegram: operaciones hechas fuera del panel

**Panel de Control Bitget (PCB)** · 15 de octubre de 2026

## Qué hace

El PCB revisa en Bitget qué se hizo en cada subcuenta **fuera de él** —desde la app, la web de Bitget u otro programa— y lo manda en un resumen a un grupo de Telegram:

- **al desbloquear el panel**, con todo lo ocurrido mientras estuvo cerrado;
- y, **mientras esté abierto, cada 15 minutos**, con lo de esos 15 minutos.

| Se avisa | No se avisa |
|---|---|
| Abrir y cerrar posiciones | Lo que hace el propio panel |
| Poner o quitar TP/SL | Un TP o SL que se dispara solo |
| Agregar o quitar margen | Una liquidación |
| Cambiar el apalancamiento o el modo de margen | Lo ocurrido antes de activar las alertas |
| Traspasos de saldo | |

Cada aviso nombra la subcuenta con su identificador, por ejemplo `PCB-1-A-1` (panel 1, cuenta A, casilla 1), el mismo que se ve en la pantalla de Historial y en el CSV.

Ejemplo de mensaje:

```
🔔 Operaciones fuera del panel · PCB-1 · Cuenta A
Revisión del 15/10, 09:12

PCB-1-A-1 · Sub-01
• 14/10, 19:05 · Abrió LONG BTCUSDT · 0.01 @ 115230.5 · App
• 14/10, 21:30 · Cerró LONG BTCUSDT · 0.01 @ 116010 · App
• entre 14/10, 18:40 y 15/10, 09:12 · Cambió el apalancamiento de ETHUSDT: 10x → 20x
```

## Cómo activarlo (una sola vez, unos 5 minutos)

**1. Crear el bot.** En Telegram, abra el chat con **@BotFather** (el oficial, con la marca azul), escriba `/newbot`, póngale un nombre (por ejemplo "PCB Alertas") y un usuario que termine en `bot` (por ejemplo `pcb_alertas_daniel_bot`). BotFather responde con un **token**, una línea del tipo `123456789:AAF…`. Ese token es la llave del bot: no lo comparta.

**2. Crear el grupo.** Cree un grupo de Telegram con quienes deban recibir los avisos y **agregue el bot** como miembro. Luego escriba `/start` en el grupo. Sin ese mensaje, el bot no "ve" el grupo.

**3. Configurar el panel.** Desbloquee el PCB y pulse **Alertas** en la barra superior:

1. Pegue el token y pulse **Buscar chats**: aparece el grupo.
2. Elíjalo, escriba la **contraseña de paso** y pulse **Guardar y enviar prueba**.
3. En el grupo debe aparecer "✅ Panel PCB-1 conectado". Si llega, queda guardado en el almacén cifrado del panel.

Desde ese momento el panel revisa y avisa al desbloquearse y cada 15 minutos mientras está abierto. Lo anterior a la activación no se avisa.

## Lo que conviene saber

- **Casi en tiempo real, con el panel abierto.** Una operación del cliente llega como mucho unos 15 minutos después. Con el panel cerrado o bloqueado no se revisa nada: lo de ese tiempo llega todo junto al volver a abrirlo, con la hora exacta de cada operación. **Revisar ahora** no espera a la siguiente vuelta.
- **No compite con el operador.** Si se está ejecutando un lote, la revisión espera a que termine. El apalancamiento y el modo se leen una vez por hora, porque son los que más peticiones cuestan; los cambios de ese tipo pueden tardar hasta una hora en avisarse.
- **Bitget solo guarda 90 días.** Si el panel pasa más de 90 días sin abrirse, lo más viejo ya no se puede revisar y el aviso lo dice.
- **Apalancamiento y modo de margen no tienen hora exacta.** Bitget no registra esos cambios. El panel los nota comparando con la revisión anterior, y el aviso dice "entre tal hora y tal hora".
- **Si Telegram no responde**, los avisos quedan guardados y salen en la siguiente revisión. No se pierden; en un caso muy raro (un corte justo al enviar) uno podría llegar repetido.
- **Ante la duda, el panel avisa.** Prefiere un aviso de más, que se comprueba en la app, a callar una operación del cliente.
- **El botón Alertas** permite ver la última revisión, **Revisar ahora** sin esperar a la próxima apertura, **Enviar prueba** y **Desactivar**. Desactivar pide la contraseña de paso.
- **Seguridad:** el token se guarda cifrado junto a las API Keys. El bot solo envía mensajes; no recibe órdenes ni puede operar. Mantenga el grupo privado: quien esté en él ve las operaciones.
