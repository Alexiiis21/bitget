# ADR 0001 — Electron, no Tauri

- **Estado:** aceptada
- **Fecha:** 24 de julio de 2026
- **Fase:** 1

## Contexto

El PCB es una aplicación de escritorio para Windows. En 2026 la alternativa obvia a
Electron es Tauri 2, que produce binarios de ~12 MB frente a ~90 MB, consume menos RAM y
reduce la superficie de ataque al usar el WebView2 del sistema.

## Decisión

Electron 43.

## Razones

1. **El trabajo real no está en la interfaz.** Técnicamente esto es un cliente de red
   concurrente: ~100 sockets autenticados, firma HMAC-SHA256 por petición, cola con
   control de límites y una máquina de estados de posiciones. En Tauri ese núcleo se
   escribe en Rust. Cambiar el componente más riesgoso del sistema a un lenguaje que el
   equipo no domina, con contrato firmado y plazo cerrado, es cambiar un riesgo de
   rendimiento que no existe por un riesgo de ejecución que sí.
2. **Los recursos no son la restricción.** Una máquina de escritorio dedicada, con una
   sola aplicación en primer plano, no tiene problema con 200 MB de RAM.
3. **El núcleo se prueba sin arrancar la aplicación.** Al vivir todo en TypeScript, el
   cliente de Bitget, la cola y el reconciliador se ejecutan en Vitest en milisegundos.

## Consecuencias

- El ejecutable portable pesará ~90 MB. Aceptable: se entrega una vez.
- Obliga a una configuración de seguridad estricta que en Tauri viene de fábrica:
  `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` y CSP estricta. Está
  aplicada en `src/main/index.ts` y verificada por la prueba de humo `test/e2e/arranque.spec.ts`,
  que falla si el renderer llega a ver `require` o `process`.

## Reversión

Si en una versión futura el núcleo se estabiliza y el tamaño del binario pasa a importar,
la lógica de dominio es portable: está en TypeScript puro, sin dependencias de Electron
salvo en los bordes (`storage/paths.ts`, `ipc/`).
