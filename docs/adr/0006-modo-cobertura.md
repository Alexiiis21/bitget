# ADR 0006 — Las posiciones se indexan por cuenta, símbolo y lado

- **Estado:** propuesta — requiere confirmación del cliente (P-2)
- **Fecha:** 27 de julio de 2026
- **Fase:** 1

## Contexto

La captura de la hoja de cálculo que envió el cliente el 27 de julio muestra, en una misma
fila (una cuenta), columnas de LONG **y** de SHORT con sus propios precios de liquidación,
de orden y de Take Profit, más una columna DISTANCIA L/S entre ambos bloques.

Eso significa que una cuenta mantiene las dos posiciones vivas sobre el mismo símbolo al
mismo tiempo. En Bitget solo es posible en **modo cobertura** (doble sentido).

## Decisión

La clave primaria de una posición es `(cuentaId, símbolo, lado)`, no `(cuentaId, símbolo)`.

```ts
export const clavePosicion = (cuentaId: string, simbolo: string, lado: Lado): string =>
  `${cuentaId}|${simbolo}|${lado}`;
```

Hay una prueba unitaria que falla si alguien vuelve a indexar por los dos primeros campos
(`test/unit/paths.test.ts`), porque el síntoma en producción sería perder una de las dos
posiciones **en silencio**.

## Consecuencias

1. **`holdSide` es obligatorio** en cerrar, agregar margen, fijar Take Profit y cambiar
   apalancamiento. Sin él se opera sobre el lado equivocado o la API rechaza.
2. **El apalancamiento se fija por lado** en margen aislado.
3. **El modo de posición se verifica al dar de alta cada credencial.** No se asume: se
   consulta y se guarda en `cuentas.json`. Una cuenta en modo unilateral se marca en el
   panel con el motivo visible, porque la estrategia del operador no funciona ahí.
4. **El modo no se puede cambiar con posiciones abiertas.** Es una precondición del alta,
   no algo que el panel pueda corregir sobre la marcha.
5. La fila del monitor tiene dos bloques independientes, que pueden estar llenos, vacíos o
   mixtos.

## Spikes que abre

| # | Verificación contra la cuenta demo |
|---|---|
| S-7 | Cómo se consulta el modo de posición; confirmar que `set-position-mode` se rechaza con posiciones abiertas |
| S-9 | Con las dos posiciones abiertas, comprobar que `place-tpsl-order` con `planType: pos_profit` aplica al lado indicado y no a la posición neta |

## Riesgo si la confirmación llega tarde

Es la decisión más cara de revertir de todo el proyecto: cambiar la clave de indexación
más adelante toca el almacén de posiciones, el reconciliador, los cinco servicios de
operación y la proyección del monitor. Por eso se pregunta en la Fase 1 y no en la 4.
