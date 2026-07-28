# Panel de Control Bitget (PCB)

Aplicación de escritorio para Windows que centraliza la ejecución de acciones sobre
múltiples cuentas de Bitget (futuros USDT-M) mediante su API oficial, desde una sola
interfaz.

**Estado: Fase 1 — diseño y arquitectura.** El esqueleto arranca y la cadena de procesos
está verificada; todavía no hay conexión con Bitget.

## Requisitos

- **Node.js ≥ 22.19**
- Windows 10/11 para empaquetar el ejecutable portable

## Puesta en marcha

```bash
npm install
npm run dev          # abre la aplicación con recarga en caliente
```

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | Aplicación en desarrollo, con recarga en caliente |
| `npm run typecheck` | `tsc --noEmit` sobre los dos proyectos (node y web) |
| `npm run lint` | ESLint, cero avisos tolerados |
| `npm run format` | Prettier sobre `src/` y `test/` |
| `npm test` | Pruebas unitarias y de integración (Vitest) |
| `npm run test:coverage` | Lo anterior más informe de cobertura |
| `npm run test:e2e` | Compila y ejecuta la prueba de humo sobre la app real |
| `npm run build` | Typecheck + compilación de los tres bundles |
| `npm run package:portable` | Genera `release/PCB-<version>-portable.exe` |

## Estructura

```
src/main/       Proceso principal: TODO el I/O, la red y los secretos
src/preload/    Puente tipado, superficie mínima (contextBridge)
src/renderer/   Interfaz React. Sin acceso a Node, a disco ni a la red
src/shared/     Tipos y contrato de IPC compartidos por los tres procesos
test/           unit · integration · e2e · mock-exchange · fixtures
docs/           Entregables de diseño y registro de decisiones (ADR)
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
- **Cero dependencias nativas.** El ejecutable portable se compila en cualquier máquina
  sin toolchain de C++.

## Documentación

| Documento | Contenido |
|---|---|
| [`docs/01-stack-tecnologico.md`](docs/01-stack-tecnologico.md) | Stack, hallazgos sobre la API de Bitget, pool de sockets, cola de ejecución |
| [`docs/02-arquitectura.html`](docs/02-arquitectura.html) | Arquitectura técnica, flujo de una operación, estados de un lote |
| [`docs/03-modelo-de-datos.md`](docs/03-modelo-de-datos.md) | Esquema de cada archivo, cifrado, órdenes indeterminadas |
| [`docs/04-wireframes.html`](docs/04-wireframes.html) | Todas las pantallas a escala real |
| [`docs/adr/`](docs/adr/) | Decisiones de arquitectura, con su reversión |

## Nota sobre el entorno

Algunos entornos (la terminal integrada de VS Code, entre otros) exportan
`ELECTRON_RUN_AS_NODE=1`. Con esa variable, Electron arranca como Node puro y la ventana
nunca abre. `electron.vite.config.ts` y `playwright.config.ts` la eliminan al cargarse.
