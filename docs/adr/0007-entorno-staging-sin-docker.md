# ADR 0007 — El entorno `staging` es una carpeta de datos, no un contenedor

- **Estado:** aceptada
- **Fecha:** 7 de agosto de 2026
- **Fase:** 2

## Contexto

Hasta ahora el panel solo tenía un modo de ejecución: `MockPanelService` inventando
cuentas, posiciones y precios. Sirve para trabajar la interfaz, pero no responde a la
pregunta que toca en la Fase 2 —*¿el vault y el alta de credenciales funcionan contra la
API real de Bitget?*—, y esa pregunta hay que responderla antes de escribir el motor de
órdenes.

La propuesta inicial fue levantar el entorno con Docker: una instancia o, como mínimo, un
perfil de Compose.

## Decisión

**Se añade un entorno `staging` y no se usa Docker.**

Docker no aporta nada aquí, y no por preferencia sino porque no hay nada que contener. El
PCB es una aplicación de escritorio Electron: no hay servidor, no hay base de datos y no
hay estado compartido entre paneles. Lo que [ADR 0004](0004-archivos-planos-no-sqlite.md)
decidió como persistencia —`vault.enc`, `cuentas.json`, `config.json`— son archivos
locales dentro de una carpeta. El aislamiento que se buscaba con un contenedor es, punto
por punto, el aislamiento que da una carpeta distinta.

Y ese mecanismo ya estaba diseñado. `docs/03-modelo-de-datos.md` §3 se titula «Una base de
datos independiente por sistema» y establece que ninguna instancia lee ni escribe fuera de
su carpeta, que cada una tiene su propia contraseña maestra y que *dos sistemas en la
misma máquina son dos carpetas distintas*. **Un entorno es un sistema más.** No hacía
falta un concepto nuevo: hacía falta aplicar el que ya existía.

En contra de Docker, además: meter un Electron con interfaz gráfica en un contenedor sobre
Windows exige X server o VNC, y el resultado sería más frágil que la aplicación que
pretende aislar.

```
dev      %APPDATA%\Panel de Control Bitget\           MockPanelService, sin red
staging  %APPDATA%\Panel de Control Bitget-staging\   API real, vault real
```

El entorno se fija **al construir**, con `--mode staging`, y viaja como un literal
(`__ENTORNO__`) en los tres bundles. No se lee de `process.env` en runtime: una variable
de entorno olvidada de una sesión anterior podría arrancar el panel contra dinero real
creyéndolo demostración. El binario de staging *es* de staging.

## Consecuencias

Lo que este entorno garantiza, y cómo:

| Garantía | Mecanismo |
|---|---|
| El mock no existe en staging | `__ENTORNO__` es literal → Rollup elimina la rama y `MockPanelService` no entra en el bundle. Verificado sobre el `.js` construido |
| Ni por un camino imprevisto | `prohibidoEnStaging()` en el constructor del mock y en el exchange simulado |
| Solo se habla con Bitget | `ClienteBitget` rechaza en staging cualquier `host` distinto de `api.bitget.com` |
| Las pruebas no corren aquí | `vitest.config.ts` y `playwright.config.ts` fallan si `APP_ENV=staging` |
| Los datos no se mezclan | Carpeta propia, incluido el `userData` de Electron —lo que además separa el cerrojo de instancia única y permite tener dev y staging abiertos a la vez |

**Lo que staging *no* resuelve hoy, y conviene no confundir.** `IpcPanelService` solo
implementa lo que el proceso principal expone en la Fase 2: vault, registro de cuentas y
verificación de credenciales. `getAccounts`, `subscribePositions`, las cinco acciones de
trading y la contraseña de paso lanzan `NotImplementedError`. En staging la matriz de
cuentas aparece vacía y cualquier orden falla — **no por un defecto del entorno, sino
porque ese backend es de fases posteriores**. Staging responde hoy la pregunta de la Fase
2 y ninguna más.

**Criterio de reversión.** Si algún día el producto incorpora un componente servidor real
—un relé compartido entre paneles, por ejemplo—, esta decisión deja de aplicar y Docker
vuelve a la mesa. Mientras la persistencia sean archivos locales de un ejecutable de
escritorio, no.

**Modo `production`.** `npm run build` sigue produciendo el panel de demostración, igual
que antes de existir staging, porque el único backend completo hoy es el del mock. Cuando
la Fase 6 cierre posiciones y órdenes, el mapeo de modos en `electron.vite.config.ts` es
la línea que hay que revisar.
