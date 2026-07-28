# ADR 0004 — Archivos planos, no SQLite

- **Estado:** aceptada
- **Fecha:** 24 de julio de 2026
- **Fase:** 1

## Contexto

La hipótesis inicial del cliente incluía SQLite. Lo que el PCB necesita persistir es:

| Dato | Volumen | Acceso |
|---|---|---|
| Credenciales cifradas | ~100 registros | Lectura al desbloquear, escritura al alta |
| Configuración y layout | ~1 KB | Lectura al inicio, escritura ocasional |
| Órdenes indeterminadas | Decenas como mucho | Escritura antes de cada orden |
| Log de sesión | Append-only | Se escribe siempre, se lee poco |

No hay consultas relacionales. No hay concurrencia de escritores. **El historial
consultable con filtros es un no-objetivo explícito del contrato.**

## Decisión

Archivos planos con escritura atómica: `vault.enc` (AES-256-GCM), `cuentas.json`,
`config.json`, `ordenes/pendientes.jsonl` y `logs/session-*.jsonl`. Esquema completo en
[`../03-modelo-de-datos.md`](../03-modelo-de-datos.md).

## Razones

`better-sqlite3` es un **módulo nativo**: exige recompilación contra las cabeceras de
Electron, reintroduce toolchain de C++ en la máquina de compilación, se rompe en cada
actualización de Electron y complica el empaquetado portable (`asarUnpack`, rutas de
`.node`).

Sin SQLite, el proyecto tiene **cero dependencias nativas** y el ejecutable portable se
compila en cualquier máquina sin preparación previa. Ese es el beneficio real, y es
grande.

La escritura atómica (`tmp` + `fsync` + `rename`) elimina el riesgo de archivo corrupto
por cierre abrupto, que es lo único que SQLite aportaría aquí.

## Consecuencias

- Todo el acceso a disco pasa por `src/main/storage/`, tras una interfaz de repositorio.
- No hay consultas por rango ni índices. No se necesitan.

## Reversión

Si el cliente pide más adelante historial consultable con filtros por fecha, cuenta y
activo, se incorpora `better-sqlite3` y el cambio queda contenido en `src/main/storage/`.
La decisión de hoy es «no pagar por adelantado por una función que el contrato excluye»,
no «nunca usar SQLite».
