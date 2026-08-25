# Entregar el panel que opera con dinero real

Hay **dos ejecutables distintos**, y el mercado va dentro de cada uno. No hay nada que
copiar al lado, ninguna carpeta que crear y ningún archivo que editar: se abre y opera.

| Ejecutable | Mercado | Órdenes |
|---|---|---|
| `PCB-<version>-staging-portable.exe` | Simulado (`SUSDT-FUTURES`) | Saldo de prueba de Bitget |
| `PCB-<version>-REAL-portable.exe` | Real (`USDT-FUTURES`) | **Dinero de verdad** |

Los dos hablan con la API real de Bitget y guardan las credenciales cifradas igual. Lo
único que cambia es contra cuál de los dos mercados de Bitget se envían las órdenes.

## Generar el de dinero real

```powershell
npm run package:portable:real
```

Sale en `release\PCB-<version>-REAL-portable.exe`. Ese archivo es todo lo que se le manda
al cliente.

## Qué ve el cliente

Al abrirlo, en la barra superior, junto al número de panel:

> **`MERCADO REAL`** en rojo

Y en la primera línea de cada confirmación, antes de aprobar nada:

> `REVISAR ANTES DE ENVIAR · MERCADO REAL`

Si en algún momento eso dijera `SIMULADO`, es que está abierto el ejecutable de pruebas.

## Cambiar de mercado

Se cambia de ejecutable. No hay interruptor dentro del panel, ni configuración que tocar:
el mercado es un literal compilado en el binario, igual que el entorno
([`src/shared/entorno.ts`](../../src/shared/entorno.ts)). Un ejecutable de mercado real es
de mercado real y no hay nada que el operador pueda mover para que deje de serlo.

## Los dos comparten los datos

Ambos guardan en la misma carpeta, junto al `.exe`:

```
D:\PCB\
├── PCB-0.4.0-REAL-portable.exe
├── PCB-0.4.0-staging-portable.exe
└── datos-staging\
    ├── instancia.json
    ├── cuentas.json
    └── vault.enc
```

Es deliberado: son el mismo sistema, con el mismo vault y las mismas subcuentas dadas de
alta. Probar en simulado y luego pasar a real no obliga a registrar cien API keys otra
vez — se abre el otro `.exe` y ya está. Lo que distingue a los dos es el nombre del
archivo y el distintivo rojo de la barra, no la carpeta.

No se pueden tener los dos abiertos a la vez: el panel permite una sola instancia por
equipo.

## Antes de la primera operación real

**La primera se hace a mano y con el monto mínimo**, antes de usar la ejecución sobre
muchas casillas. No es una formalidad: es la comprobación de que la cuenta está en el modo
de margen y el apalancamiento que el panel supone.

Y conviene recordar que los símbolos no son los mismos: en simulado se opera `SBTCSUSDT`
con margen `SUSDT`; en real, `BTCUSDT` con margen `USDT`. El panel lo resuelve solo —el
selector de activo dice `BTC` en los dos—, pero las posiciones abiertas en uno no existen
en el otro.
