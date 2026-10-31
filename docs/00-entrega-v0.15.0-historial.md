# Entrega v0.15.0 — Historial por periodo y resultado neto

**Panel de Control Bitget (PCB)** · 13 de octubre de 2026
Binario: `PCB-0.15.0-REAL-portable.exe` · **Mercado real**

> Continúa la v0.14.0. **Nada de lo que ya existía cambia de comportamiento.** Esta versión
> añade una pantalla de consulta, de solo lectura: no abre, cierra ni modifica ninguna
> operación.

---

## 1. Qué hace

Desde el panel se pueden consultar las operaciones cerradas de una subcuenta en un periodo, y
el panel dice automáticamente cuántas ganaron, cuántas perdieron y cuánto suman, sin entrar a
Bitget ni hacer sumas a mano.

## 2. Cómo se usa

1. Pulse **Historial** en la barra superior, junto a «Saldos».
2. Elija la **cuenta** y la **subcuenta**.
3. Elija la **fecha inicial** y la **fecha final**. Los dos días cuentan completos.

La pantalla muestra:

- **Resultado neto del periodo**: la suma en USDT, en verde si es positiva y en rojo si es negativa, con el número de operaciones, ganadoras y perdedoras.
- **Saldo actual**: el saldo de la subcuenta tal como lo reporta Bitget en ese momento, con la hora de la lectura.
- **La tabla de operaciones cerradas**, con las columnas de la plataforma oficial: par y lado, apalancamiento y modo de margen, apertura, precio de entrada y de salida promedio, cantidad, resultado (verde o rojo), porcentaje y cierre.

Al elegir una subcuenta, lo ya consultado aparece al instante. A la vez, el panel pregunta a
Bitget si hay operaciones nuevas y, si las hay, la tabla se actualiza sola. El botón
**Actualizar** repite esa consulta y vuelve a leer el saldo.

## 3. Cómo se calcula el resultado

- El resultado de cada operación es el que **reporta Bitget**: el movimiento de precio **más** las comisiones de apertura y cierre **más** el financiamiento. Una operación en la que el precio fue a favor puede ser perdedora si las comisiones fueron mayores.
- El resultado del periodo es la **suma** de esos resultados. Una operación entra en el periodo por su **fecha de cierre**.
- El resultado del periodo **no se calcula por diferencia de saldos**: traspasos, depósitos y retiros no lo afectan. Por eso el resultado del periodo y el saldo actual no tienen por qué coincidir.

Se verificó contra la API real de Bitget en cuentas Classic y UTA, con ocho periodos distintos
en cada una, comparando operación por operación. Todos coincidieron (ver
`docs/00-historial-fase-7.md`).

## 4. Lo que conviene saber

**Bitget solo entrega los últimos 90 días.** El panel guarda en el equipo todo lo que
consulta, así que el historial de una subcuenta crece con el tiempo y se ve aunque Bitget ya
no lo entregue. Pero lo que Bitget borra antes de que el panel lo haya consultado no se puede
recuperar.

> **Recomendación:** abra el historial de cada subcuenta **al menos una vez cada 90 días**. Si
> una subcuenta pasa más tiempo sin consultarse, el panel lo avisa: pueden faltar operaciones
> de ese intervalo.

**Apalancamiento y porcentaje aparecen como «—».** El historial de Bitget no informa esos dos
datos por operación, y el panel no los estima.

**Una subcuenta a la vez.** Como en la plataforma oficial, el historial, el resultado y el
saldo se consultan por subcuenta. No hay una vista que sume varias cuentas.

**Si una subcuenta se da de baja del panel, su historial guardado se borra con ella.**

## 5. Otros cambios

- Se retiró el acordeón «Historial de posiciones» que aparecía bajo cada cuenta en la matriz. Era un esbozo anterior sin funcionalidad: al abrirlo mostraba un error. Su lugar lo ocupa la pantalla nueva.
