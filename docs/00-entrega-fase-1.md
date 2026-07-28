# Entrega de la Fase 1 — Diseño del proyecto y arquitectura

**Panel de Control Bitget (PCB) v1.0**
Fecha de entrega: 27 de julio de 2026 · Presupuesto de referencia: Fase 1, $3,500 MXN, 1 semana

---

## 1. Qué cubre esta fase, según el presupuesto

> *«Diseño del proyecto y arquitectura — arquitectura técnica, diseño de base de datos
> local, wireframes y estructura del proyecto.»*

| Concepto contratado | Entregable | Estado |
|---|---|---|
| Arquitectura técnica | [`01-stack-tecnologico.md`](01-stack-tecnologico.md) · [`02-arquitectura.html`](02-arquitectura.html) | Entregado |
| Diseño de base de datos local | [`03-modelo-de-datos.md`](03-modelo-de-datos.md) | Entregado |
| Wireframes | [`04-wireframes.html`](04-wireframes.html) | Entregado |
| Estructura del proyecto | Repositorio funcional + [`../README.md`](../README.md) | Entregado |
| Decisiones de arquitectura | [`adr/`](adr/) — 6 registros | Entregado |

---

## 2. Cómo verificar la entrega

Los documentos se leen; el proyecto se ejecuta. Cuatro comandos, en una máquina con
Node 22.19 o superior:

```bash
npm install          # instala sin parches ni conflictos
npm run typecheck    # sin errores de tipos
npm run lint         # sin avisos
npm run test:e2e     # compila y arranca la aplicación real
```

La última prueba es la que importa. No comprueba que el código compile: **abre la
aplicación** y verifica cuatro cosas sobre la ventana real:

1. La ventana abre con el título del producto.
2. El preload expone la API tipada al renderer.
3. **El renderer no puede alcanzar Node** — `require` y `process` son `undefined`. Es la
   frontera de seguridad que protege las credenciales, y falla la prueba si alguien la
   rompe en el futuro.
4. La pantalla muestra datos que vienen del proceso principal por el canal de IPC.

Y `npm run dev` abre la aplicación con recarga en caliente.

---

## 3. Lo que se descubrió al construir, y que cambia lo entregado antes

Dos correcciones sobre el entregable 1, ambas detectadas al montar el proyecto de verdad
y no al escribirlo:

**TypeScript 6 en lugar de 7.** `typescript-eslint` rechaza TypeScript 7 en tiempo de
ejecución; sin él, el análisis estático no cubre un solo archivo del proyecto. La ventaja
de TS 7 es la velocidad de compilación, irrelevante a esta escala. Detalle en
[`adr/0003`](adr/0003-typescript-6-no-7.md).

**Vite 7 en lugar de 8.** `electron-vite` —la pieza que orquesta los tres procesos— aún no
soporta Vite 8. Detalle en [`adr/0002`](adr/0002-vite-7-no-8.md).

Ninguna de las dos afecta al plazo, al presupuesto ni a una sola función del producto.
Ambas tienen su condición de reversión escrita.

**Un hallazgo de diseño, que sí importa.** La hoja de cálculo enviada el 27 de julio
muestra LONG y SHORT vivos en la misma cuenta y el mismo activo: el panel opera en **modo
cobertura**. Eso cambia la clave con la que se indexan las posiciones. Se resolvió en la
Fase 1, que es cuando cuesta una línea; en la Fase 4 habría costado tocar el almacén de
posiciones, el reconciliador y los cinco servicios de operación. Detalle en
[`adr/0006`](adr/0006-modo-cobertura.md).

---

## 4. Lo que necesito de tu lado para cerrar

Cuatro decisiones y un acceso. Ninguna bloquea el inicio de la Fase 2, pero las cuatro
primeras se vuelven caras si se responden tarde.

| # | Pregunta | Dónde está el detalle |
|---|---|---|
| P-2 | ¿Confirmas que operas en modo cobertura, con LONG y SHORT abiertos a la vez sobre el mismo activo? | [`adr/0006`](adr/0006-modo-cobertura.md) |
| P-1 | **DISTANCIA L/S**: ¿distancia entre los precios de orden, entre las liquidaciones o entre los Take Profit? | [`03`](03-modelo-de-datos.md) §13.2 |
| P-7 | ¿El porcentaje de Take Profit es sobre ganancia (ROE)? Tu hoja lo respalda, pero conviene confirmarlo | [`04`](04-wireframes.html) §5 |
| P-6 | Cuando una cuenta se queda sin posiciones, ¿la fila **desaparece** o se queda vacía en su sitio? | [`04`](04-wireframes.html) §12 |
| — | **Credenciales de una cuenta demo de Bitget**, para ejecutar las verificaciones técnicas de la Fase 2 | [`01`](01-stack-tecnologico.md) §14 |

Dos más, de menor peso: **P-8** tema claro tipo hoja de cálculo u oscuro, y **P-9** la
resolución y escala de pantalla del equipo donde va a correr el panel.

Y una pregunta que sigue abierta desde la primera semana: **¿cómo se crearon las
subcuentas, desde la web o por API?** Define si hay que registrar ~100 juegos de
credenciales a mano o si se pueden generar programáticamente.

---

## 5. Aprobación

Conforme a la cláusula 4(c) del presupuesto, esta fase se entiende aprobada si no se
manifiestan observaciones dentro de los **7 días naturales** posteriores a la
demostración.

La Fase 2 —integración con la API oficial de Bitget— puede comenzar en cuanto se disponga
de las credenciales de la cuenta demo.
