# Panel de Control Bitget (PCB)

Aplicación de escritorio para Windows que centraliza la ejecución de acciones sobre
múltiples cuentas de Bitget (futuros USDT-M) mediante su API oficial, desde una sola
interfaz.

**Estado: Fase 4 operable desde la pantalla.** Las seis funciones —abrir, cerrar, poner y quitar
Take Profit, agregar margen y ajustar apalancamiento— se manejan con el ratón y sobre datos reales
de Bitget: catálogo de activos, precios y saldos. Ninguna envía nada sin que el operador apruebe
antes la lista concreta de lo que va a pasar en cada casilla. Las posiciones en vivo (Fase 6) son
de una fase posterior; ver [`docs/00-fase-4-pantalla.md`](docs/00-fase-4-pantalla.md).

## Requisitos

- **Node.js ≥ 22.19**
- Windows 10/11 para empaquetar el ejecutable portable

## Puesta en marcha

```bash
npm install
npm run dev          # datos de demostración, sin salir a la red
npm run dev:staging  # API real de Bitget, vault real, carpeta de datos propia
```

Las pruebas contra la API real necesitan un `.env` con las claves de la cuenta demo; ver
[`.env.example`](.env.example).

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | Aplicación en desarrollo, con recarga en caliente |
| `npm run dev:staging` | Igual, contra la API real de Bitget, **mercado simulado**. [ADR 0007](docs/adr/0007-entorno-staging-sin-docker.md) |
| `npm run dev:real` | Igual, contra el **mercado real**: es el binario del cliente, pero con terminal donde leer el log. Las órdenes mueven dinero de verdad |
| `npm run typecheck` | `tsc --noEmit` sobre los dos proyectos (node y web) |
| `npm run lint` | ESLint, cero avisos tolerados |
| `npm run format` | Prettier sobre `src/` y `test/` |
| `npm test` | Pruebas unitarias, de integración y del store, sin salir a la red (Vitest) |
| `npm run test:coverage` | Lo anterior más informe de cobertura |
| `npm run test:red` | Pruebas contra `api.bitget.com`. Requiere `.env` |
| `npm run test:staging` | Las mismas, con el código compilado como staging |
| `npm run test:fisica` | **Envía órdenes reales** al mercado simulado de Bitget. QA de aceptación del panel entero: [Fase 4](docs/00-fase-4-pantalla.md) |
| `npm run test:e2e` | Compila y ejecuta la prueba de humo sobre la app real |
| `npm run importar:subcuentas` | Carga al panel las subcuentas de `scripts/crear-subcuentas.mjs` |
| `npm run build` | Typecheck + compilación de los tres bundles |
| `npm run package:portable` | Demostración: `release/PCB-<version>-demo-portable.exe`. Datos inventados |
| `npm run package:portable:staging` | **El binario del cliente, mercado simulado**: `release/PCB-<version>-staging-portable.exe` |
| `npm run package:portable:real` | **El binario del cliente, dinero real**: `release/PCB-<version>-REAL-portable.exe` |

Los dos hablan con la API real de Bitget; lo que cambia es contra cuál de sus dos mercados
operan, y eso va **compilado dentro del ejecutable**, no en un archivo al lado. Se entrega
el `.exe` y nada más. El panel enseña siempre en su barra superior —y en cada
confirmación— contra cuál está operando. Ver
[`docs/cliente/entrega-mercado-real.md`](docs/cliente/entrega-mercado-real.md).

### Depuración temporal

Dos interruptores, apagados por defecto, que vuelcan al terminal lo que normalmente no se
ve. Son andamios: llevan su bloque de comentario diciendo cómo se borran, y no deben
quedarse en el código entregado.

| Variable | Qué imprime |
|---|---|
| `PCB_DEBUG_API=1` | Cada respuesta firmada de Bitget, cruda y redactada. [`rest/client.ts`](src/main/bitget/rest/client.ts) |
| `PCB_DEBUG_SALDO=0` | **Apaga** el recorrido del saldo, que va encendido mientras dure la incidencia. [`debug-saldo.ts`](src/main/debug-saldo.ts) |

```powershell
$env:PCB_DEBUG_API = '1'; npm run dev:real
```

En el `.exe` portable no hay terminal donde leerlo: esto sirve para reproducir en esta
máquina lo que el cliente ve en la suya.

## Estructura

```
src/main/       Proceso principal: TODO el I/O, la red y los secretos
src/preload/    Puente tipado, superficie mínima (contextBridge)
src/renderer/   Interfaz React. Sin acceso a Node, a disco ni a la red
src/shared/     Tipos y contrato de IPC compartidos por los tres procesos
test/           unit · integration · renderer · red · fisica · e2e · mock-exchange
docs/           Entregables de diseño y registro de decisiones (ADR)
scripts/        Herramientas de alta masiva de subcuentas (no entran en el bundle)
```

`src/main/` está organizado por **capacidad técnica** (bitget, execution, domain,
security, storage) porque ahí el riesgo es técnico. `src/renderer/src/features/` se
organiza por **función del producto** porque ahí el riesgo es de producto. En
`src/shared/` solo hay tipos: si aparece algo con comportamiento, es señal de que se
filtró lógica hacia el renderer.

## Reglas que el proyecto hace cumplir

- **El renderer nunca toca Node, disco ni red.** Lo impide `contextIsolation`, lo verifica
  la prueba de humo y lo bloquea una regla de ESLint (`no-restricted-imports`).
- **Las cantidades monetarias son cadenas**, nunca `number`. La aritmética pasa por
  decimal.js.
- **Los secretos no cruzan el IPC.** El renderer solo ve `bg••••4f2a`.
- **Ninguna credencial se guarda sin que Bitget la acepte antes**, y cualquier permiso que
  el panel no reconozca la rechaza: se falla cerrado.
- **Cero dependencias nativas.** El ejecutable portable se compila en cualquier máquina
  sin toolchain de C++.

## Documentación

| Documento | Contenido |
|---|---|
| [`docs/00-entrega-fase-1.md`](docs/00-entrega-fase-1.md) | Entrega de la Fase 1: diseño y arquitectura |
| [`docs/00-entrega-fase-2.md`](docs/00-entrega-fase-2.md) | Entrega de la Fase 2: integración con la API de Bitget |
| [`docs/00-entrega-fase-3.md`](docs/00-entrega-fase-3.md) | Entrega de la Fase 3: administración de cuentas, con guion de validación |
| [`docs/00-fase-4-apertura.md`](docs/00-fase-4-apertura.md) | Fase 4, función 1: apertura de operaciones |
| [`docs/00-fase-4-cierre.md`](docs/00-fase-4-cierre.md) | Fase 4, función 2: cierre de operaciones, con guía de prueba física |
| [`docs/00-fase-4-take-profit.md`](docs/00-fase-4-take-profit.md) | Fase 4, función 3: Take Profit por porcentaje |
| [`docs/00-fase-4-margen-apalancamiento.md`](docs/00-fase-4-margen-apalancamiento.md) | Fase 4, funciones 4 y 5: agregar margen y apalancamiento |
| [`docs/00-fase-4-pantalla.md`](docs/00-fase-4-pantalla.md) | Fase 4: las seis funciones conectadas a la pantalla, con la prueba de QA |
| [`docs/00-resumen-para-daniel.md`](docs/00-resumen-para-daniel.md) | Resumen para el cliente: lo que dijo y cómo quedó |
| [`docs/cliente/entrega-mercado-real.md`](docs/cliente/entrega-mercado-real.md) | Los dos binarios del cliente, cómo se generan y cómo se distinguen |
| [`docs/cotizacion-traspasos-entre-subcuentas.md`](docs/cotizacion-traspasos-entre-subcuentas.md) | Propuesta y estimación: traspaso de saldo entre subcuentas |
| [`docs/01-stack-tecnologico.md`](docs/01-stack-tecnologico.md) | Stack, hallazgos sobre la API de Bitget, pool de sockets, cola de ejecución |
| [`docs/02-arquitectura.html`](docs/02-arquitectura.html) | Arquitectura técnica, flujo de una operación, estados de un lote |
| [`docs/03-modelo-de-datos.md`](docs/03-modelo-de-datos.md) | Esquema de cada archivo, cifrado, órdenes indeterminadas |
| [`docs/04-wireframes.html`](docs/04-wireframes.html) | Todas las pantallas a escala real |
| [`docs/adr/`](docs/adr/) | Decisiones de arquitectura, con su reversión |

## Nota sobre el entorno

Algunos entornos (la terminal integrada de VS Code, entre otros) exportan
`ELECTRON_RUN_AS_NODE=1`. Con esa variable, Electron arranca como Node puro y la ventana
nunca abre. `electron.vite.config.ts` y `playwright.config.ts` la eliminan al cargarse.
