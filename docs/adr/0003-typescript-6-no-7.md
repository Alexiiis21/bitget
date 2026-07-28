# ADR 0003 — TypeScript 6.0, no TypeScript 7.0

- **Estado:** aceptada
- **Fecha:** 27 de julio de 2026
- **Fase:** 1

## Contexto

El entregable 1 declaraba TypeScript 7 en modo estricto. TypeScript 7.0.2 es la versión
estable publicada, así que la elección parecía obvia. Al montar la configuración de
calidad aparecieron dos problemas, en este orden:

1. **TS 7 eliminó `baseUrl`.** Error `TS5102`. Se corrige haciendo relativas las rutas de
   `paths` (`"./src/main/*"` en vez de `"src/main/*"`). Cambio menor y ya aplicado.
2. **`typescript-eslint` rechaza TS 7 en tiempo de ejecución**, no solo por rango de
   peer dependency:

   ```
   Error: typescript-eslint does not support TS 7.0.
   ```

   No es un aviso: aborta. El seguimiento del soporte para TS ≥ 7.1 es el issue
   typescript-eslint#10940, todavía abierto.

Sin `typescript-eslint`, ESLint no puede analizar un solo archivo `.ts`. El script `lint`
quedaría como decoración sobre un proyecto que es TypeScript en su totalidad.

## Alternativas consideradas

| Opción | Por qué se descarta |
|---|---|
| TS 7 y renunciar al lint | Deja el 100 % del código sin análisis estático más allá del compilador. Inaceptable en un sistema que ejecuta órdenes con dinero real |
| TS 7 y `typescript-eslint` forzado con `legacy-peer-deps` | Probado: el bloqueo es en tiempo de ejecución, no de resolución. No funciona |
| TS 7 para compilar y TS 6 en paralelo solo para el lint | La vía que sugiere el propio mensaje de error. `typescript-eslint` importa `typescript` por especificador desnudo y lo declara como *peer*, así que no se puede anidar una copia distinta con `overrides`. Frágil y sin ganancia |
| **TS 6.0.3 en todo el proyecto** | **Elegida** |

## Decisión

`typescript: ~6.0.3`, fijado con `~` para no saltar a 6.1, que volvería a salirse del
rango soportado por `typescript-eslint` (`>=4.8.4 <6.1.0`).

## Razones

TypeScript 7 es el puerto nativo del compilador y su ventaja es la velocidad de
compilación. En un proyecto de este tamaño eso no es un cuello de botella. Perder el
análisis estático sobre todo el código, en cambio, sí tiene consecuencias: es la
herramienta que detecta el `await` olvidado, la promesa sin manejar y el import prohibido
del renderer hacia Node.

Se cambia una ventaja que no se nota por una protección que sí.

## Consecuencias

- Verificado: `npm run typecheck` y `npm run lint` pasan limpios.
- Se pudo eliminar el `.npmrc` con `legacy-peer-deps`, que había sido necesario mientras
  el proyecto estaba en TS 7. La instalación en una máquina limpia funciona sin parches.
- **El entregable 1 queda corregido** en su tabla de decisiones y en la sección 3.

## Reversión

Cuando `typescript-eslint` publique soporte de TS 7, subir `typescript` a `^7` y revisar
`baseUrl`/`paths`. La anotación está en `package.json` → `comments.typescript`.
